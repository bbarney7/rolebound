/**
 * `profile.md` is the single source of truth for both the LLM and the code.
 *
 * The agent already reads this file as prose before every application; this
 * module makes the same file machine-readable so the extensions carry no
 * personal constants. Nothing here is required — every section is optional and
 * a missing one produces a warning plus a neutral default, never a crash. The
 * parser is deliberately tolerant (headings matched by substring, values
 * stripped of markdown decoration) because a human hand-edits this file.
 *
 * Sections consumed:
 *   ## Identity                      — bullets: full name, email, fallback email
 *   ## Resume                        — bullet: resume path (optional override)
 *   ### Resume region rules          — table: resume_key | match terms
 *   ## City → Address rules          — table: key | "City, ST" | terms | ZIPs
 *   ## Job search preferences        — bullets: target roles/levels/topics/locations, title blocklist
 *   ## Candidate summary             — free text, used for LLM job scoring
 *   ## Work history                  — ### headings, used to compose a summary
 */

import fs from "node:fs/promises";
import { wsPath } from "./workspace";

export interface Identity {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  fallbackEmail: string | null;
  phone: string | null;
}

export interface CityRule {
  key: string;
  city: string;
  state: string;
  /** Lowercased location substrings that resolve to this key. */
  terms: string[];
  zips: string[];
}

export interface ResumeRegionRule {
  key: string;
  terms: string[];
}

export interface Profile {
  identity: Identity;
  /** Explicit resume override from `## Resume`; workspace-relative or absolute. */
  resumePath: string | null;
  resumeRegionRules: ResumeRegionRule[];
  cityRules: CityRule[];
  /** null means "no preference stated" — callers keep their built-in default. */
  topics: string[] | null;
  titleBlocklist: string[] | null;
  /** When set, gatherer matches titles against these role terms instead of engineering heuristics. */
  targetRoles: string[] | null;
  targetLevels: string[] | null;
  /** When set, gatherer location filter uses these terms instead of US-only defaults. */
  targetLocations: string[] | null;
  /** Compact candidate summary for LLM job scoring. */
  candidateSummary: string | null;
  /** Non-fatal problems worth showing the user in /status and /gather-status. */
  warnings: string[];
}

export type ProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: string };

const PROFILE_FILE = wsPath("profile.md");

// ── Markdown helpers ────────────────────────────────────────────────────────

interface Section {
  level: number;
  heading: string;
  /** Body lines up to the next heading of any level. */
  body: string[];
  /** Body lines up to the next heading of the same or higher level. */
  bodyWithSubsections: string[];
}

function splitSections(md: string): Section[] {
  const lines = md.split("\n");
  const heads: Array<{ level: number; heading: string; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m) heads.push({ level: m[1].length, heading: m[2].trim(), start: i });
  }
  return heads.map((h, idx) => {
    const nextAny = heads[idx + 1]?.start ?? lines.length;
    let nextSameOrHigher = lines.length;
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        nextSameOrHigher = heads[j].start;
        break;
      }
    }
    return {
      level: h.level,
      heading: h.heading,
      body: lines.slice(h.start + 1, nextAny),
      bodyWithSubsections: lines.slice(h.start + 1, nextSameOrHigher),
    };
  });
}

/** Headings are matched loosely: lowercased, markdown decoration removed. */
function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findSection(sections: Section[], match: (normalized: string) => boolean): Section | null {
  return sections.find((s) => match(normalizeHeading(s.heading))) ?? null;
}

const PLACEHOLDER = /^(n\/a|none|tbd|<fill in>|fill in)$/i;

/** True when a parsed profile field is present and not a template placeholder. */
export function isFilledProfileValue(value: string | null | undefined): boolean {
  if (value == null) return false;
  const v = value.trim();
  return v.length > 0 && !PLACEHOLDER.test(v);
}

/** Identity email shape used by readiness and the applier. */
export function isValidProfileEmail(value: string | null | undefined): boolean {
  if (!isFilledProfileValue(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value!.trim());
}

/** Strip backticks, bold/italic markers, and parenthetical italic asides. */
function cleanValue(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  // A value that is only an italic aside — "*(none — skip if optional)*" — is unset.
  if (/^\*+\(.*\)\*+$/.test(v)) return null;
  v = v.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "").trim();
  // Trailing italic aside after a real value: "Jane *(preferred)*".
  v = v.replace(/\s*\*+\(.*?\)\*+\s*$/, "").trim();
  if (!v || PLACEHOLDER.test(v)) return null;
  return v;
}

/** `- **Key:** value` bullets → { key: value }. Keys are lowercased. */
function parseBullets(body: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body) {
    const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*[:：]?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].replace(/[:：]\s*$/, "").trim().toLowerCase();
    const value = cleanValue(m[2]);
    if (value !== null) out.set(key, value);
  }
  return out;
}

/** First bullet whose key contains any of `needles`. */
function bulletLike(bullets: Map<string, string>, ...needles: string[]): string | null {
  for (const [key, value] of bullets) {
    if (needles.some((n) => key.includes(n))) return value;
  }
  return null;
}

/** Markdown table → rows of cleaned cells (header row dropped). */
function parseTable(body: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    // Separator row: every cell is dashes/colons.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.length > 1 ? rows.slice(1) : [];
}

const termRegexCache = new Map<string, RegExp>();

/**
 * Match a rule term against an already-normalized location on word boundaries.
 *
 * Plain substring matching is wrong here and quietly so: a two-letter state
 * term like `co` is inside "san fran-cis-co", and `ca` is inside "chi-ca-go",
 * so a Bay Area posting would resolve to a Colorado rule. Terms are tokens.
 */
export function matchesTerm(normalizedLocation: string, term: string): boolean {
  let re = termRegexCache.get(term);
  if (!re) {
    re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    termRegexCache.set(term, re);
  }
  return re.test(normalizedLocation);
}

function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((s) => cleanValue(s) ?? "")
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length > 0);
}

function slugifyKey(raw: string): string {
  return (cleanValue(raw) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Section parsers ─────────────────────────────────────────────────────────

function parseIdentity(sections: Section[], warnings: string[]): Identity {
  const section = findSection(sections, (h) => h === "identity" || h.startsWith("identity"));
  const empty: Identity = {
    fullName: null,
    firstName: null,
    lastName: null,
    email: null,
    fallbackEmail: null,
    phone: null,
  };
  if (!section) {
    warnings.push("profile.md has no `## Identity` section — emails and name are unavailable to the extensions.");
    return empty;
  }
  const bullets = parseBullets(section.body);
  const fullName = bulletLike(bullets, "full name", "name");
  const preferred = bulletLike(bullets, "preferred name", "first name");
  // "Fallback email" must be checked before the looser "email" match.
  const fallbackEmail = bulletLike(bullets, "fallback email", "alternate email", "secondary email");
  let email: string | null = null;
  for (const [key, value] of bullets) {
    if (key.includes("email") && !/fallback|alternate|secondary/.test(key)) {
      email = value;
      break;
    }
  }
  const nameParts = (fullName ?? "").split(/\s+/).filter(Boolean);
  if (!email) {
    warnings.push("profile.md `## Identity` has no `- **Email:**` bullet — ATS account creation cannot pick an address.");
  }
  return {
    fullName,
    firstName: preferred ?? (nameParts[0] ?? null),
    lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : null,
    email,
    fallbackEmail,
    phone: bulletLike(bullets, "phone"),
  };
}

function parseResumePath(sections: Section[]): string | null {
  // Exact heading only: `### Resume region rules` must not be mistaken for it.
  const section = findSection(sections, (h) => h === "resume");
  if (!section) return null;
  return bulletLike(parseBullets(section.body), "resume path", "path");
}

function parseResumeRegionRules(sections: Section[]): ResumeRegionRule[] {
  const section = findSection(sections, (h) => h.includes("resume region rules") || h.includes("resume key"));
  if (!section) return [];
  const out: ResumeRegionRule[] = [];
  for (const row of parseTable(section.body)) {
    const key = slugifyKey(row[0] ?? "");
    const terms = splitList(row[1]);
    if (key && terms.length > 0) out.push({ key, terms });
  }
  return out;
}

function parseCityRules(sections: Section[], warnings: string[]): CityRule[] {
  const section = findSection(sections, (h) => h.includes("address rules") || h.includes("city address"));
  if (!section) {
    warnings.push("profile.md has no `## City → Address rules` section — only Remote roles will resolve a location.");
    return [];
  }
  const out: CityRule[] = [];
  for (const row of parseTable(section.body)) {
    const key = slugifyKey(row[0] ?? "");
    if (!key || key === "default") continue; // `default` = remote, handled in code
    const display = cleanValue(row[1] ?? "") ?? "";
    const dm = display.match(/^(.*?)\s*,\s*([A-Za-z]{2})\b/);
    const city = dm ? dm[1].trim() : display;
    const state = dm ? dm[2].toUpperCase() : "";
    // Match terms are optional — the display city is always a term.
    const declared = splitList(row[2]);
    const terms = Array.from(new Set([city.toLowerCase(), ...declared].filter(Boolean)));
    // ZIPs live in prose ("one of {98101, 98103}") — take every 5-digit token.
    const zips = ((row[3] ?? row[2] ?? "").match(/\b\d{5}\b/g) ?? []) as string[];
    if (!city) continue;
    out.push({ key, city, state, terms, zips });
  }
  if (out.length === 0) {
    warnings.push("profile.md `## City → Address rules` table has no usable rows — only Remote roles will resolve a location.");
  }
  return out;
}

function parseSearchPreferences(sections: Section[]): {
  topics: string[] | null;
  titleBlocklist: string[] | null;
  targetRoles: string[] | null;
  targetLevels: string[] | null;
  targetLocations: string[] | null;
} {
  const section = findSection(sections, (h) => h.includes("job search preferences") || h.includes("search preferences"));
  if (!section) return { topics: null, titleBlocklist: null, targetRoles: null, targetLevels: null, targetLocations: null };
  const bullets = parseBullets(section.body);
  const topics = splitList(bulletLike(bullets, "target topics", "topics"));
  const blocklist = splitList(bulletLike(bullets, "title blocklist", "blocklist", "exclude titles"));
  const roles = splitList(bulletLike(bullets, "target roles", "roles"));
  const levels = splitList(bulletLike(bullets, "target level", "target levels", "levels"));
  const locations = splitList(bulletLike(bullets, "target locations", "locations"));
  return {
    topics: topics.length > 0 ? topics : null,
    titleBlocklist: blocklist.length > 0 ? blocklist : null,
    targetRoles: roles.length > 0 ? roles : null,
    targetLevels: levels.length > 0 ? levels : null,
    targetLocations: locations.length > 0 ? locations : null,
  };
}

/**
 * The scoring prompt wants a compact candidate summary. Prefer an explicit
 * `## Candidate summary` section; otherwise compose one from the identity,
 * the `###` headings under `## Work history`, and the stated target topics —
 * enough for a 1-5 fit score without shipping the whole profile to the model.
 */
function parseCandidateSummary(sections: Section[], identity: Identity, topics: string[] | null): string | null {
  const explicit = findSection(sections, (h) => h.includes("candidate summary") || h.includes("gatherer summary"));
  if (explicit) {
    const text = explicit.bodyWithSubsections.join("\n").trim();
    if (text) return text;
  }

  const work = findSection(sections, (h) => h.includes("work history") || h.includes("experience"));
  const roles = work
    ? work.bodyWithSubsections
        .filter((l) => /^#{3,6}\s+/.test(l))
        .map((l) => l.replace(/^#{3,6}\s+/, "").replace(/[`*]/g, "").trim())
        .filter(Boolean)
    : [];

  const parts: string[] = [];
  if (identity.fullName) parts.push(`Candidate: ${identity.fullName}`);
  if (roles.length > 0) {
    parts.push(`Current: ${roles[0]}`);
    if (roles.length > 1) parts.push(`Previous: ${roles.slice(1).join("; ")}`);
  }
  if (topics && topics.length > 0) parts.push(`Target topics: ${topics.join(", ")}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function parseProfile(md: string): Profile {
  // HTML comments are guidance for the human, never data: stripping them first
  // is what makes a commented-out bullet genuinely inactive and keeps the
  // template's instructions out of the candidate summary sent to the model.
  const sections = splitSections(md.replace(/<!--[\s\S]*?-->/g, ""));
  const warnings: string[] = [];
  const identity = parseIdentity(sections, warnings);
  const { topics, titleBlocklist, targetRoles, targetLevels, targetLocations } = parseSearchPreferences(sections);
  return {
    identity,
    resumePath: parseResumePath(sections),
    resumeRegionRules: parseResumeRegionRules(sections),
    cityRules: parseCityRules(sections, warnings),
    topics,
    titleBlocklist,
    targetRoles,
    targetLevels,
    targetLocations,
    candidateSummary: parseCandidateSummary(sections, identity, topics),
    warnings,
  };
}

let cache: { mtimeMs: number; profile: Profile } | null = null;

/**
 * Read and parse `profile.md`, re-parsing only when the file changes on disk.
 * Never throws — a missing or unreadable file comes back as `{ ok: false }` so
 * each tool can report it in its own voice instead of taking pi down at load.
 */
export async function loadProfile(): Promise<ProfileResult> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(PROFILE_FILE);
  } catch {
    return {
      ok: false,
      error:
        `No profile.md in the workspace (${PROFILE_FILE}). ` +
        "Copy templates/profile.template.md to profile.md and fill it in.",
    };
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return { ok: true, profile: cache.profile };
  try {
    const md = await fs.readFile(PROFILE_FILE, "utf-8");
    const profile = parseProfile(md);
    cache = { mtimeMs: stat.mtimeMs, profile };
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: `Could not read profile.md: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Profile with neutral empty values, for code paths that must not hard-fail. */
export function emptyProfile(error: string): Profile {
  return {
    identity: { fullName: null, firstName: null, lastName: null, email: null, fallbackEmail: null, phone: null },
    resumePath: null,
    resumeRegionRules: [],
    cityRules: [],
    topics: null,
    titleBlocklist: null,
    targetRoles: null,
    targetLevels: null,
    targetLocations: null,
    candidateSummary: null,
    warnings: [error],
  };
}

/** `loadProfile()` collapsed to a Profile, folding any error into `warnings`. */
export async function loadProfileOrEmpty(): Promise<Profile> {
  const result = await loadProfile();
  return result.ok ? result.profile : emptyProfile(result.error);
}
