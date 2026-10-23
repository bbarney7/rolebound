import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { paths, toIsoOrNull, type JobDir } from "../workspace";
import type { QueueItem, RawJobFrontmatter } from "../../shared/types";

const EXCERPT_LIMIT = 2000;

export interface JobFileRecord {
  slug: string;
  dir: JobDir;
  filePath: string;
  /** file mtime ISO — last-resort date for synthesized entries */
  mtime: string;
  /**
   * File ctime ISO — inode-change time, surfaced as the queue's "In queue
   * since". Distinct from mtime and birthtime, and it has to be: the gatherer
   * promotes a posting with `fs.rename`, which preserves both of those, so on a
   * promoted file they still describe when it was DISCOVERED. ctime is the only
   * stamp that moves on the promote. It also moves on any later inode change,
   * so it is an upper bound on "when this entered the queue", never an exact
   * record — the UI labels it by provenance for that reason.
   */
  ctime: string;
  url: string | null;
  company: string | null;
  title: string | null;
  /** location ?? location_raw */
  location: string | null;
  source: string | null;
  match: string | null;
  discoveredAt: string | null;
  llmScore: number | null;
  llmReasoning: string | null;
  llmScoreTemplate: string | null;
  status: string | null;
  submittedAt: string | null;
  appliedAt: string | null;
  resume: string | null;
  resumeKey: string | null;
  addressCityKey: string | null;
  screenshot: string | null;
  /** parsed from body "ATS: x" line */
  ats: string | null;
  /** parsed from body "Req ID: x" line */
  reqId: string | null;
  body: string;
  descriptionExcerpt: string | null;
}

function parseBodyLine(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function excerpt(body: string): string | null {
  const afterLabel = body.split(/^Description excerpt:\s*$/m)[1] ?? body;
  const cleaned = afterLabel.trim();
  if (!cleaned) return null;
  return cleaned.length > EXCERPT_LIMIT ? `${cleaned.slice(0, EXCERPT_LIMIT)}…` : cleaned;
}

/**
 * Tolerant fallback for files whose frontmatter isn't valid YAML (seen in the
 * wild: `location: Remote - US: Select locations` — unquoted colon). Line-based
 * `key: value` extraction; values stay strings.
 */
function parseFrontmatterTolerant(rawContent: string): {
  data: RawJobFrontmatter;
  content: string;
} {
  const m = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, content: rawContent };
  const [, fmBlock, content] = m;
  const data: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data: data as RawJobFrontmatter, content };
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

export function normalizeJobFile(
  slug: string,
  dir: JobDir,
  filePath: string,
  rawContent: string,
  mtime: Date,
  ctime: Date,
): JobFileRecord {
  let fm: RawJobFrontmatter;
  let content: string;
  try {
    // The `{}` is load-bearing and must not be removed. gray-matter 4.0.3
    // memoizes by input string and writes the cache entry BEFORE parsing
    // (index.js:35-47), so a file whose frontmatter throws leaves behind an
    // entry whose `data` is {}. Every later parse of those same bytes then
    // returns that empty object INSTEAD OF THROWING — the tolerant fallback
    // below never runs, and every field comes back null. Measured in-session
    // on the pinned 4.0.3 via this very function:
    //
    //   call 1 -> company: "Render"  location: "Remote: United States"
    //   call 2 -> company: null      location: null
    //
    // That is not hypothetical: 9 live job files carry an unquoted colon, and
    // `refresh()` re-lists on every SSE event, so such a row rendered once and
    // then blanked on every refresh afterwards. `if (!options)` (index.js:36)
    // guards both the cache read and the cache write, and `defaults({})` is
    // identical to `defaults(undefined)`, so passing `{}` opts out of the memo
    // while changing nothing about how the content is parsed.
    const parsed = matter(rawContent, {});
    fm = parsed.data as RawJobFrontmatter;
    content = parsed.content;
  } catch {
    const parsed = parseFrontmatterTolerant(rawContent);
    fm = parsed.data;
    content = parsed.content;
  }
  return {
    slug,
    dir,
    filePath,
    mtime: mtime.toISOString(),
    ctime: ctime.toISOString(),
    url: fm.url ?? null,
    company: fm.company ?? null,
    title: fm.title ?? null,
    location: fm.location ?? fm.location_raw ?? null,
    source: fm.source ?? null,
    match: fm.match ?? null,
    discoveredAt: toIsoOrNull(fm.discovered_at),
    llmScore: toNumberOrNull(fm.llm_score),
    llmReasoning: fm.llm_reasoning ?? null,
    llmScoreTemplate: typeof fm.llm_score_template === "string" ? fm.llm_score_template : null,
    status: fm.status ?? null,
    submittedAt: toIsoOrNull(fm.submitted_at),
    appliedAt: toIsoOrNull(fm.applied_at),
    resume: fm.resume ?? null,
    resumeKey: fm.resume_key ?? null,
    addressCityKey: fm.address_city_key ?? null,
    screenshot: fm.screenshot ?? null,
    ats: parseBodyLine(content, "ATS"),
    reqId: parseBodyLine(content, "Req ID"),
    body: content,
    descriptionExcerpt: excerpt(content),
  };
}

/**
 * List a jobs directory, sorted by SLUG. This is NOT the applier's order — the
 * applier sorts filenames including the ".md" suffix — and the two disagree
 * whenever one slug is a prefix of another (measured: 195 such pairs across the
 * live corpus, all 195 disagreeing). `listQueue` re-sorts for that reason; this
 * function keeps slug order because `listApplications` depends on it and no
 * caller of it claims to mirror the applier.
 *
 * A file that vanishes between the readdir and the read is skipped rather than
 * failing the whole listing: the applier and gatherer move files in and out of
 * these directories continuously, so losing that race is routine, not
 * exceptional. Only ENOENT is tolerated — any other error still throws, so a
 * genuine fault (EISDIR, EACCES) is not silently swallowed.
 */
export async function listJobFiles(root: string, dir: JobDir): Promise<JobFileRecord[]> {
  const dirPath = paths.jobsDir(root, dir);
  let files: string[];
  try {
    files = await fs.readdir(dirPath);
  } catch (err) {
    // ENOENT only, matching the per-file rule below: a jobs/ subdirectory that
    // does not exist yet is an empty listing, which is the correct answer on a
    // fresh workspace. Anything else — EACCES, EIO, ENOTDIR — is a real fault,
    // and reporting it as "the queue is empty" would tell the user pi-jobs has
    // nothing to do when in fact we could not look.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const slugs = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const records = await Promise.all(
    slugs.map(async (slug) => {
      const filePath = paths.jobFile(root, dir, slug);
      try {
        const [rawContent, stat] = await Promise.all([
          fs.readFile(filePath, "utf-8"),
          fs.stat(filePath),
        ]);
        return normalizeJobFile(slug, dir, filePath, rawContent, stat.mtime, stat.ctime);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      }
    }),
  );
  return records.filter((r): r is JobFileRecord => r !== null);
}

export async function readJobFile(
  root: string,
  dir: JobDir,
  slug: string,
): Promise<JobFileRecord | null> {
  const filePath = paths.jobFile(root, dir, slug);
  try {
    const [rawContent, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
    return normalizeJobFile(slug, dir, filePath, rawContent, stat.mtime, stat.ctime);
  } catch {
    return null;
  }
}

/**
 * Project one queue record onto the wire shape at a known position. Shared by
 * `listQueue` and the DELETE route, which must describe the file it removed
 * using the same projection the listing uses — a second hand-written copy of
 * these eighteen fields would drift.
 *
 * `filePath` is rebuilt from the slug rather than copied from `f.filePath`:
 * the reader's value is ABSOLUTE (`paths.jobFile` joins it onto `root`), and
 * publishing the server's local filesystem layout to the browser serves no
 * purpose the slug does not already serve.
 */
export function toQueueItem(f: JobFileRecord, position: number): QueueItem {
  return {
    slug: f.slug,
    filePath: `jobs/queue/${f.slug}.md`,
    url: f.url,
    company: f.company,
    title: f.title,
    location: f.location,
    source: f.source,
    match: f.match,
    discoveredAt: f.discoveredAt,
    queuedAt: f.ctime,
    llmScore: f.llmScore,
    llmReasoning: f.llmReasoning,
    ats: f.ats,
    reqId: f.reqId,
    resume: f.resume,
    resumeKey: f.resumeKey,
    addressCityKey: f.addressCityKey,
    descriptionExcerpt: f.descriptionExcerpt,
    position,
  };
}

/**
 * Queue listing in the applier's OWN consumption order, with position.
 *
 * `listJobFiles` sorts bare slugs; the applier sorts filenames INCLUDING the
 * ".md" suffix — `files.filter((f) => f.endsWith(".md")).sort()` at
 * job-applier.ts:669 and :897, with /apply-next taking mdFiles[0] at :902.
 * Those two orders are not the same. Whenever one slug is a prefix of another,
 * the suffix decides: "acme-engineer" vs "acme-engineer-finops" sorts one way
 * on the bare slugs and the other way once ".md" is appended, because "." (0x2E)
 * sorts before "-" (0x2D)... and in fact after it, which is exactly why this is
 * settled by construction rather than by intuition. Measured across the live
 * corpus: 195 prefix pairs, all 195 disagreeing.
 *
 * So this re-sorts on the reconstructed filename. The reconstruction is
 * LOSSLESS: `listJobFiles` admits only names passing `.endsWith(".md")` and
 * derives the slug with `.replace(/\.md$/, "")`, so `${slug}.md` is the
 * original filename, byte for byte. Zero extra I/O.
 *
 * The comparator is explicit and compares UTF-16 code units, matching
 * `Array.prototype.sort`'s default — which is what the applier uses.
 * `String.prototype.localeCompare` is a DIFFERENT algorithm and the two
 * disagree: on ["Zeta.md","alpha.md"] and ["a_b.md","a-b.md"] they give
 * opposite answers, and `isSafeSlug` admits both uppercase and "_", so both are
 * reachable. Faithfulness here has to come from construction, not from the
 * happy accident that they agree on today's data.
 */
export async function listQueue(root: string): Promise<QueueItem[]> {
  const files = await listJobFiles(root, "queue");
  const ordered = [...files].sort((a, b) => {
    const x = `${a.slug}.md`;
    const y = `${b.slug}.md`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return ordered.map(toQueueItem);
}
