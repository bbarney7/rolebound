export type TargetSource = "greenhouse" | "ashby" | "lever";

export const TARGET_SOURCES: readonly TargetSource[] = ["greenhouse", "ashby", "lever"];

/** ATS board slug: lowercase alphanumerics with . _ - */
export const TARGET_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface TargetEntry {
  source: TargetSource;
  slug: string;
}

export interface TargetsPayload {
  revision: string | null;
  entries: TargetEntry[];
  /** Full targets.md text for lossless round-trip editing. */
  text: string;
}

export interface TargetsUpdateBody {
  revision: string | null;
  entries: TargetEntry[];
}

export type DiscoverySort = "score" | "recent" | "company";

export interface DiscoveryListQuery {
  q?: string;
  source?: TargetSource;
  scored?: "true" | "false";
  dismissed?: "true" | "false" | "all";
  limit?: number;
  cursor?: string;
  sort?: DiscoverySort;
}

export interface DiscoveryListItem {
  slug: string;
  url: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  source: string | null;
  match: string | null;
  llmScore: number | null;
  llmReasoning: string | null;
  llmScoredAt: string | null;
  llmScoreTemplate: string | null;
  discoveredAt: string | null;
  dismissed: boolean;
  duplicateOf: "queue" | "applied" | null;
}

export interface DiscoveryListPayload {
  items: DiscoveryListItem[];
  nextCursor: string | null;
  total: number;
}

export interface DiscoveryDetailPayload extends DiscoveryListItem {
  body: string;
  descriptionExcerpt: string | null;
  scoreError: string | null;
}

export interface DiscoveryDismissBody {
  revision?: string | null;
}

export interface DiscoveryMutationResult {
  item: DiscoveryDetailPayload | null;
}

export function isValidTargetSlug(slug: string): boolean {
  return TARGET_SLUG_PATTERN.test(slug.trim().toLowerCase());
}

export function normalizeTargetSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function parseDiscoveryLimit(raw: unknown, fallback = 50, max = 100): number {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}
