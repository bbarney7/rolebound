import type { TargetEntry, TargetSource } from "../shared/discovery";
import { TARGET_SOURCES } from "../shared/discovery";

const BOARD_HOSTS: Record<string, TargetSource> = {
  "boards.greenhouse.io": "greenhouse",
  "job-boards.greenhouse.io": "greenhouse",
  "jobs.ashbyhq.com": "ashby",
  "jobs.lever.co": "lever",
};

export const PARSE_COMPANY_TARGET_ERROR =
  "Paste a Greenhouse, Ashby or Lever job-board link, like jobs.lever.co/acme.";

export type ParseCompanyTargetResult =
  | { ok: true; entry: TargetEntry }
  | { ok: false; error: string };

export function sourceLabel(source: TargetSource): string {
  if (source === "greenhouse") return "Greenhouse";
  if (source === "ashby") return "Ashby";
  return "Lever";
}

export function entriesToTargetText(entries: TargetEntry[]): string {
  return entries.map((entry) => `${entry.source}:${entry.slug}`).join("\n");
}

export function parseCompanyTargetInput(raw: string): ParseCompanyTargetResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: PARSE_COMPANY_TARGET_ERROR };

  const colon = trimmed.indexOf(":");
  if (colon > 0 && !trimmed.includes("://")) {
    const source = trimmed.slice(0, colon).trim().toLowerCase();
    const slug = trimmed.slice(colon + 1).trim();
    if (TARGET_SOURCES.includes(source as TargetSource) && slug && !trimmed.includes("/")) {
      return { ok: true, entry: { source: source as TargetSource, slug } };
    }
  }

  let urlStr = trimmed;
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = `https://${urlStr}`;
  }
  try {
    const url = new URL(urlStr);
    const source = BOARD_HOSTS[url.hostname.toLowerCase()];
    if (!source) return { ok: false, error: PARSE_COMPANY_TARGET_ERROR };
    const segment = url.pathname.split("/").filter(Boolean)[0];
    const slug = segment?.split("?")[0]?.trim();
    if (!slug) return { ok: false, error: PARSE_COMPANY_TARGET_ERROR };
    return { ok: true, entry: { source, slug } };
  } catch {
    return { ok: false, error: PARSE_COMPANY_TARGET_ERROR };
  }
}

export function parseTargetTextToEntries(draft: string): TargetEntry[] {
  return draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0) throw new Error(`invalid target line: ${line}`);
      const source = line.slice(0, colon).trim();
      const slug = line.slice(colon + 1).trim();
      if (!TARGET_SOURCES.includes(source as TargetSource)) {
        throw new Error(`unsupported target source: ${source}`);
      }
      if (!slug) throw new Error(`missing slug in target line: ${line}`);
      return { source: source as TargetSource, slug };
    });
}
