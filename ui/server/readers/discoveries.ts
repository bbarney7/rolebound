import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { listJobFiles, readJobFile, type JobFileRecord } from "./jobFiles";
import { paths, isSafeSlug } from "../workspace";
import type { DiscoveryDetailPayload, DiscoveryListItem, DiscoveryListPayload, DiscoveryListQuery } from "../../shared/discovery";
import { parseDiscoveryLimit } from "../../shared/discovery";
import { assertRegularDiscoveredJobFile, withDiscoveredJobFileLock } from "../../../.pi/extensions/lib/job-file-lock";

export class DiscoveryNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

export class DiscoveryMalformedError extends Error {
  readonly code = "MALFORMED" as const;
}

export class DiscoveryLockedError extends Error {
  readonly code = "LOCKED" as const;
}

export class DiscoveryWriteError extends Error {
  readonly code = "WRITE_FAILED" as const;
}

interface DuplicateIndex {
  slugs: { queue: Set<string>; applied: Set<string> };
  urls: { queue: Set<string>; applied: Set<string> };
}

function isDismissed(record: JobFileRecord, raw?: string): boolean {
  if (raw) {
    try {
      const parsed = matter(raw, {});
      const value = parsed.data.dismissed;
      return value === true || value === "true";
    } catch {
      return false;
    }
  }
  return false;
}

export async function buildDuplicateIndex(root: string): Promise<DuplicateIndex> {
  const [queue, applied] = await Promise.all([listJobFiles(root, "queue"), listJobFiles(root, "applied")]);
  return {
    slugs: {
      queue: new Set(queue.map((item) => item.slug)),
      applied: new Set(applied.map((item) => item.slug)),
    },
    urls: {
      queue: new Set(queue.map((item) => item.url).filter((value): value is string => Boolean(value))),
      applied: new Set(applied.map((item) => item.url).filter((value): value is string => Boolean(value))),
    },
  };
}

function duplicateOfIndexed(slug: string, url: string | null, index: DuplicateIndex): "queue" | "applied" | null {
  if (index.slugs.queue.has(slug)) return "queue";
  if (index.slugs.applied.has(slug)) return "applied";
  if (url && index.urls.queue.has(url)) return "queue";
  if (url && index.urls.applied.has(url)) return "applied";
  return null;
}

function toListItem(record: JobFileRecord, dismissed: boolean, duplicate: "queue" | "applied" | null, raw?: string): DiscoveryListItem {
  let llmScoredAt: string | null = null;
  if (raw) {
    try {
      const parsed = matter(raw, {});
      llmScoredAt = typeof parsed.data.llm_scored_at === "string" ? parsed.data.llm_scored_at : null;
    } catch {}
  }
  return {
    slug: record.slug,
    url: record.url,
    company: record.company,
    title: record.title,
    location: record.location,
    source: record.source,
    match: record.match,
    llmScore: record.llmScore,
    llmReasoning: record.llmReasoning,
    llmScoreTemplate: record.llmScoreTemplate,
    llmScoredAt,
    discoveredAt: record.discoveredAt,
    dismissed,
    duplicateOf: duplicate,
  };
}

function scoreValue(record: JobFileRecord): number {
  return record.llmScore ?? -1;
}

function compareRecords(a: JobFileRecord, b: JobFileRecord, sort: DiscoveryListQuery["sort"]): number {
  if (sort === "company") {
    const left = (a.company ?? a.slug).toLowerCase();
    const right = (b.company ?? b.slug).toLowerCase();
    return left.localeCompare(right) || a.slug.localeCompare(b.slug);
  }
  if (sort === "recent") {
    return (b.discoveredAt ?? b.mtime).localeCompare(a.discoveredAt ?? a.mtime) || a.slug.localeCompare(b.slug);
  }
  return scoreValue(b) - scoreValue(a) || a.slug.localeCompare(b.slug);
}

function matchesQuery(record: JobFileRecord, query: DiscoveryListQuery, dismissed: boolean): boolean {
  if (query.source && record.source?.toLowerCase() !== query.source) return false;
  if (query.scored === "true" && record.llmScore == null) return false;
  if (query.scored === "false" && record.llmScore != null) return false;
  if (query.dismissed === "true" && !dismissed) return false;
  if (query.dismissed === "false" && dismissed) return false;
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const haystack = `${record.company ?? ""} ${record.title ?? ""} ${record.location ?? ""} ${record.slug}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export async function listDiscoveries(root: string, query: DiscoveryListQuery = {}): Promise<DiscoveryListPayload> {
  const limit = parseDiscoveryLimit(query.limit);
  const sort = query.sort ?? "score";
  const [records, duplicateIndex] = await Promise.all([listJobFiles(root, "discovered"), buildDuplicateIndex(root)]);
  const enriched: Array<{ record: JobFileRecord; dismissed: boolean; duplicate: "queue" | "applied" | null; raw: string }> = await Promise.all(records.map(async (record) => {
    const raw = await fs.readFile(record.filePath, "utf8").catch(() => "");
    const dismissed = isDismissed(record, raw);
    const duplicate = duplicateOfIndexed(record.slug, record.url, duplicateIndex);
    return { record, dismissed, duplicate, raw };
  }));
  const filtered = enriched.filter(({ record, dismissed }) => matchesQuery(record, query, dismissed));
  filtered.sort((a, b) => compareRecords(a.record, b.record, sort));
  const total = filtered.length;
  let start = 0;
  if (query.cursor) {
    const index = filtered.findIndex(({ record }) => record.slug === query.cursor);
    start = index >= 0 ? index + 1 : 0;
  }
  const page = filtered.slice(start, start + limit);
  const nextCursor = start + limit < total ? page.at(-1)?.record.slug ?? null : null;
  return {
    total,
    nextCursor,
    items: page.map(({ record, dismissed, duplicate, raw }) => toListItem(record, dismissed, duplicate, raw)),
  };
}

export async function readDiscoveryDetail(root: string, slug: string): Promise<DiscoveryDetailPayload | null> {
  if (!isSafeSlug(slug)) return null;
  const record = await readJobFile(root, "discovered", slug);
  if (!record) return null;
  const raw = await fs.readFile(record.filePath, "utf8");
  const dismissed = isDismissed(record, raw);
  const duplicateIndex = await buildDuplicateIndex(root);
  const duplicate = duplicateOfIndexed(slug, record.url, duplicateIndex);
  let scoreError: string | null = null;
  try {
    const parsed = matter(raw, {});
    if (typeof parsed.data.llm_score_error === "string") scoreError = parsed.data.llm_score_error;
  } catch {}
  return {
    ...toListItem(record, dismissed, duplicate, raw),
    body: record.body,
    descriptionExcerpt: record.descriptionExcerpt,
    scoreError,
  };
}

export async function setDiscoveryDismissed(root: string, slug: string, dismissed: boolean): Promise<DiscoveryDetailPayload> {
  if (!isSafeSlug(slug)) throw new DiscoveryNotFoundError("discovery not found");
  const file = paths.jobFile(root, "discovered", slug);
  try {
    await fs.access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DiscoveryNotFoundError("discovery not found");
    throw new DiscoveryWriteError("could not access discovery file");
  }
  try {
    await withDiscoveredJobFileLock(file, async () => {
      await assertRegularDiscoveredJobFile(file);
      const raw = await fs.readFile(file, "utf8");
      let data: Record<string, unknown>;
      let content: string;
      try {
        const parsed = matter(raw, {});
        data = { ...(parsed.data as Record<string, unknown>) };
        content = parsed.content;
      } catch {
        throw new DiscoveryMalformedError("discovered job frontmatter is malformed");
      }
      if (dismissed) data.dismissed = "true";
      else delete data.dismissed;
      const next = matter.stringify(content, data);
      const tmp = path.join(path.dirname(file), `.discovered.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmp, next);
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof DiscoveryMalformedError) throw error;
    if (error instanceof Error && /lock/i.test(error.message)) throw new DiscoveryLockedError("discovery file is locked");
    throw new DiscoveryWriteError("could not update discovery file");
  }
  const detail = await readDiscoveryDetail(root, slug);
  if (!detail) throw new DiscoveryWriteError("discovery update could not be read back");
  return detail;
}
