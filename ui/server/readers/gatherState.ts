import { promises as fs } from "node:fs";
import { paths } from "../workspace";

export interface GatherStateSummary {
  seenUrlCount: number;
  perCompanyCount: number;
  lastFullGather: string | null;
  autoPromote: boolean;
  status?: "ok" | "corrupt";
}

/**
 * Extract the first complete JSON document from a string, tolerating trailing
 * garbage (the gather_state.json trailing-`}` incident, repaired 2026-07-24).
 * Returns the parsed object, or null if no balanced document is found.
 */
export function lenientParseFirstDocument(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    // fall through to scanner
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      depth++;
      started = true;
    } else if (ch === "}") {
      depth--;
      if (started && depth === 0) {
        try {
          return JSON.parse(content.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function readGatherStateSummary(root: string): Promise<GatherStateSummary> {
  let data: any = null;
  let status: "ok" | "corrupt" = "ok";
  try {
    const content = await fs.readFile(paths.gatherState(root), "utf-8");
    if (content.trim() === "") {
      status = "corrupt";
    } else {
      data = lenientParseFirstDocument(content);
      if (data === null) status = "corrupt";
    }
  } catch {
    // missing file → empty summary
  }
  return {
    seenUrlCount: data?.seen_urls ? Object.keys(data.seen_urls).length : 0,
    perCompanyCount: data?.per_company ? Object.keys(data.per_company).length : 0,
    lastFullGather: data?.last_full_gather ?? null,
    autoPromote: data?.auto_promote === true,
    status,
  };
}

/** Identifying metadata copied into a newly created seen_urls entry. */
export interface SeenUrlMeta {
  company: string | null;
  title: string | null;
  source: string | null;
}

export interface MarkSeenUrlResult {
  ok: boolean;
  /** null on success; a user-facing sentence on every expected failure */
  warning: string | null;
}

/**
 * Raised when gather_state.json parses as JSON but is not a shape we can write
 * back. Distinct from SyntaxError so the caller can say which of the two
 * happened, and distinct from a generic Error so it is not mistaken for a real
 * fault: like a parse failure, it degrades to a warning and leaves the file
 * untouched.
 */
class ShapeError extends Error {}

/**
 * Re-export of the shared gather-store implementation (`lib/gather-store.ts`).
 * URL-keyed upserts, strict parse on write, spread-merge of existing entries,
 * and warning-only failures after the queue file is already on disk — see
 * `docs/workspace.md` and the comment on `markSeenUrlPromoted` in gather-store.
 */
export { markSeenUrlPromoted } from "../../../.pi/extensions/lib/gather-store";
