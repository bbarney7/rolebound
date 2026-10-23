import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseTargets } from "../../../.pi/extensions/lib/targets";
import {
  type TargetEntry,
  type TargetSource,
  isValidTargetSlug,
  normalizeTargetSlug,
  TARGET_SOURCES,
} from "../../shared/discovery";
import { paths } from "../workspace";

const SECTION_HEADING = /^#{1,6}\s*(greenhouse|ashby|lever)\b/i;
const LIST_ITEM = /^-\s+(\S+)/;

export interface ParsedTargets {
  revision: string | null;
  text: string;
  entries: TargetEntry[];
}

function sourceFromHeading(line: string): TargetSource | null {
  const match = line.match(SECTION_HEADING);
  if (!match) return null;
  const source = match[1].toLowerCase() as TargetSource;
  return TARGET_SOURCES.includes(source) ? source : null;
}

/** Shared parser from `.pi/extensions/lib/targets.ts` with slug validation for writes. */
export function parseTargetsMarkdown(text: string): TargetEntry[] {
  return parseTargets(text)
    .map((entry) => ({ source: entry.source, slug: normalizeTargetSlug(entry.slug) }))
    .filter((entry) => isValidTargetSlug(entry.slug));
}

export function renderTargetsMarkdown(text: string, entries: TargetEntry[]): string {
  const grouped = Object.fromEntries(TARGET_SOURCES.map((source) => [source, new Set<string>()])) as Record<TargetSource, Set<string>>;
  for (const entry of entries) grouped[entry.source].add(entry.slug);
  const lines = text.split("\n");
  let current: TargetSource | null = null;
  const kept: string[] = [];
  const seenSections = new Set<TargetSource>();
  for (const line of lines) {
    const trimmed = line.trim();
    const section = sourceFromHeading(trimmed);
    if (section) {
      current = section;
      seenSections.add(section);
      kept.push(line);
      for (const slug of [...grouped[section]].sort()) kept.push(`- ${slug}`);
      continue;
    }
    if (trimmed.startsWith("#")) {
      current = null;
      kept.push(line);
      continue;
    }
    if (current && LIST_ITEM.test(trimmed)) continue;
    kept.push(line);
  }
  for (const source of TARGET_SOURCES) {
    if (seenSections.has(source) || grouped[source].size === 0) continue;
    kept.push("", `## ${source[0].toUpperCase()}${source.slice(1)}`, "");
    for (const slug of [...grouped[source]].sort()) kept.push(`- ${slug}`);
  }
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

export async function readTargets(root: string): Promise<ParsedTargets> {
  const file = paths.targets(root);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw Object.assign(new Error("targets.md must not be a symlink"), { code: "UNSAFE_TARGETS" });
    const text = await fs.readFile(file, "utf8");
    return {
      text,
      entries: parseTargetsMarkdown(text),
      revision: createHash("sha256").update(text).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      const template = path.join(root, "templates", "targets.template.md");
      const text = await fs.readFile(template, "utf8").catch(() => "");
      return { text, entries: parseTargetsMarkdown(text), revision: null };
    }
    throw error;
  }
}
