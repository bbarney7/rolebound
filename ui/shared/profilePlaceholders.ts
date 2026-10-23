import type { ProfileSectionId } from "./types";

/** Scoring prompt caps the summary at 8_000 characters (`.pi/extensions/lib/scoring.ts`). */
export const CANDIDATE_SUMMARY_MAX_LENGTH = 8_000;

export const PROFILE_PLACEHOLDERS_CODE = "PROFILE_PLACEHOLDERS";
export const TARGETS_PLACEHOLDER_CODE = "TARGETS_PLACEHOLDER";
export const TARGETS_TEMPLATE_EXAMPLE_SLUG = "example-co";

export type PlaceholderBlockKind = "apply" | "score" | "neither" | "both";

export interface ProfilePlaceholderCatalogRow {
  token: string;
  section: ProfileSectionId;
  blocks: PlaceholderBlockKind;
}

/**
 * Every angle-bracket template token in `templates/profile.template.md`, except
 * instructional `<address_city_key>` / `<resume_key>` mentions in the address
 * policy (not applicant fill-ins). HTML `<!-- -->` comments are stripped before
 * detection.
 */
export const PROFILE_PLACEHOLDER_CATALOG: readonly ProfilePlaceholderCatalogRow[] = [
  { token: "<FILL IN>", section: "identity", blocks: "both" },
  { token: "<FILL IN name>", section: "candidateSummary", blocks: "score" },
  { token: "<FILL IN current title and company>", section: "candidateSummary", blocks: "score" },
  { token: "<FILL IN prior roles>", section: "candidateSummary", blocks: "score" },
  { token: "<FILL IN stack>", section: "candidateSummary", blocks: "score" },
  { token: "<FILL IN — a paragraph you'd be happy to submit unedited>", section: "qaBank", blocks: "apply" },
  {
    token: "<FILL IN — e.g. product designer, design systems, staff engineer>",
    section: "searchPreferences",
    blocks: "neither",
  },
  { token: "<FILL IN — e.g. senior, staff, director>", section: "searchPreferences", blocks: "neither" },
  { token: "<Job title>", section: "workHistory", blocks: "apply" },
  { token: "<Company>", section: "workHistory", blocks: "apply" },
  { token: "<YYYY-MM>", section: "workHistory", blocks: "apply" },
  { token: "<One-paragraph summary of the role.>", section: "workHistory", blocks: "apply" },
  { token: "<Project or theme>", section: "workHistory", blocks: "apply" },
  { token: "<what you did and what it produced>", section: "workHistory", blocks: "apply" },
  { token: "<Previous job title>", section: "workHistory", blocks: "apply" },
  { token: "<Accomplishment.>", section: "workHistory", blocks: "apply" },
  { token: "<Degree>", section: "education", blocks: "apply" },
  { token: "<Institution>", section: "education", blocks: "apply" },
  { token: "<Honors, GPA, or other detail — delete if not applicable>", section: "education", blocks: "apply" },
  {
    token: "<Two or three sentences about what you want to work on and why this kind of company. >",
    section: "qaBank",
    blocks: "apply",
  },
];

const APPLY_SECTIONS = new Set<ProfileSectionId>([
  "identity",
  "workHistory",
  "education",
  "authorization",
  "qaBank",
]);

const SCORE_SECTIONS = new Set<ProfileSectionId>(["identity", "candidateSummary", "workHistory"]);

const SECTION_MATCHERS: Record<ProfileSectionId, (normalized: string) => boolean> = {
  identity: (h) => h === "identity" || h.startsWith("identity"),
  resume: (h) => h === "resume",
  resumeRegionRules: (h) => h.includes("resume region rules") || h.includes("resume key"),
  cityRules: (h) => h.includes("address rules") || h.includes("city address"),
  cityNormalization: (h) => h.includes("city normalization"),
  workHistory: (h) => h.includes("work history") || h.includes("experience"),
  education: (h) => h.includes("education"),
  authorization: (h) => h.includes("authorization"),
  qaBank: (h) => h.includes("q a bank") || h.includes("qa bank"),
  searchPreferences: (h) => h.includes("job search preferences") || h.includes("search preferences"),
  candidateSummary: (h) => h.includes("candidate summary") || h.includes("gatherer summary"),
  addressPolicy: (h) => h.includes("address policy"),
};

function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface MarkdownSection {
  id: ProfileSectionId | null;
  text: string;
}

function stripHtmlComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function splitProfileSections(md: string): MarkdownSection[] {
  const lines = md.split("\n");
  const heads: Array<{ level: number; heading: string; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m) heads.push({ level: m[1].length, heading: m[2].trim(), start: i });
  }
  const sections: MarkdownSection[] = [];
  if (heads.length === 0 || heads[0].start > 0) {
    sections.push({ id: null, text: lines.slice(0, heads[0]?.start ?? lines.length).join("\n") });
  }
  for (let idx = 0; idx < heads.length; idx++) {
    const h = heads[idx];
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].start;
        break;
      }
    }
    const normalized = normalizeHeading(h.heading);
    const id =
      (Object.entries(SECTION_MATCHERS).find(([, match]) => match(normalized))?.[0] as ProfileSectionId | undefined) ??
      null;
    const text = lines.slice(h.start + 1, end).join("\n");
    sections.push({ id, text });
  }
  return sections;
}

const KNOWN_TOKENS = PROFILE_PLACEHOLDER_CATALOG.map((row) => row.token);

export function textContainsProfilePlaceholder(text: string): boolean {
  const hay = text.replace(/\s+/g, " ");
  return KNOWN_TOKENS.some((token) => hay.includes(token.replace(/\s+/g, " ")));
}

export function sectionsContainingPlaceholders(md: string): ProfileSectionId[] {
  const stripped = stripHtmlComments(md);
  const found = new Set<ProfileSectionId>();
  for (const section of splitProfileSections(stripped)) {
    if (!section.id) continue;
    if (textContainsProfilePlaceholder(section.text)) found.add(section.id);
  }
  return [...found];
}

/** True when `## Candidate summary` has non-comment body text on disk. */
export function hasExplicitCandidateSummaryBody(md: string): boolean {
  const stripped = stripHtmlComments(md);
  for (const section of splitProfileSections(stripped)) {
    if (section.id !== "candidateSummary") continue;
    return section.text.trim().length > 0;
  }
  return false;
}

export interface ProfilePlaceholderAnalysis {
  applySections: ProfileSectionId[];
  scoreSections: ProfileSectionId[];
}

export function analyzeProfilePlaceholders(md: string): ProfilePlaceholderAnalysis {
  const present = sectionsContainingPlaceholders(md);
  const applySections = present.filter((id) => APPLY_SECTIONS.has(id));
  const explicitSummary = hasExplicitCandidateSummaryBody(md);
  const scoreSections: ProfileSectionId[] = [];
  for (const id of present) {
    if (!SCORE_SECTIONS.has(id)) continue;
    if (id === "workHistory") {
      if (!explicitSummary) scoreSections.push(id);
      continue;
    }
    scoreSections.push(id);
  }
  return { applySections, scoreSections };
}

const SECTION_TAB_HREF: Partial<Record<ProfileSectionId, string>> = {
  identity: "/profile?tab=identity",
  workHistory: "/profile?tab=workHistory",
  education: "/profile?tab=workHistory",
  authorization: "/profile?tab=workHistory",
  qaBank: "/profile?tab=qaBank",
  candidateSummary: "/profile?tab=candidateSummary",
};

const SECTION_LABEL: Partial<Record<ProfileSectionId, string>> = {
  identity: "Identity",
  workHistory: "Work history",
  education: "Education",
  authorization: "Authorization",
  qaBank: "Q&A bank",
  candidateSummary: "Candidate summary",
};

export function profilePlaceholderHref(sections: ProfileSectionId[]): string {
  if (sections.length === 1 && SECTION_TAB_HREF[sections[0]]) return SECTION_TAB_HREF[sections[0]]!;
  return "/profile";
}

export function formatPlaceholderSectionList(sections: ProfileSectionId[]): string {
  return sections.map((id) => SECTION_LABEL[id] ?? id).join(", ");
}

export function profilePlaceholderApplyMessage(sections: ProfileSectionId[]): string {
  return `Replace template placeholders in ${formatPlaceholderSectionList(sections)}.`;
}

export function profilePlaceholderScoreMessage(sections: ProfileSectionId[]): string {
  return `Replace template placeholders in ${formatPlaceholderSectionList(sections)} before scoring.`;
}

export function scoringBlockedByPlaceholders(md: string): string | null {
  const { scoreSections } = analyzeProfilePlaceholders(md);
  if (scoreSections.length === 0) return null;
  return `${PROFILE_PLACEHOLDERS_CODE}: ${profilePlaceholderScoreMessage(scoreSections)}`;
}

export function targetsArePlaceholderOnly(entries: Array<{ slug: string }>): boolean {
  return entries.length > 0 && entries.every((entry) => entry.slug === TARGETS_TEMPLATE_EXAMPLE_SLUG);
}
