import type { CityRule, Profile } from "./profile";

export const DEFAULT_TOPIC_KEYWORDS = [
  "ai", "agentic", "agent", "ml", "machine learning", "llm", "platform",
  "ai products", "applied ai", "ml platform", "inference", "ai agent", "agents",
];

export const DEFAULT_TITLE_BLOCKLIST = [
  "intern", "new grad", "early career", "distinguished", "vp ", "chief", "cto",
  "director of product", "director of data", "director of design", "director of marketing",
  "director of sales", "director of operations", "director of finance", "director of people",
  "director of talent", "sales", "presales", "pre-sales", "business development",
  "account executive", "solutions architect", "customer success",
];

const ROLE_ENGINEERING_TERMS = ["engineering", "ml", "ai", "machine learning"];
const ROLE_MANAGER_TERMS = ["engineering", "software"];
const MANAGER_EXCLUDE = [
  "program manager", "product manager", "project manager", "technical program manager",
  "chief of staff", "office manager", "account manager", "customer success manager",
  "manager, program", "manager, product", "manager, project", "sales manager",
  "presales manager", "business development manager",
];

const NON_US_COUNTRIES = [
  "india", "united kingdom", "uk", "ireland", "canada", "germany", "france",
  "spain", "italy", "netherlands", "switzerland", "sweden", "norway", "denmark",
  "finland", "poland", "portugal", "belgium", "austria", "czech republic",
  "hungary", "romania", "bulgaria", "croatia", "slovenia", "slovakia",
  "lithuania", "latvia", "estonia", "luxembourg", "malta", "cyprus",
  "greece", "serbia", "bosnia", "montenegro", "north macedonia", "albania",
  "ukraine", "moldova", "belarus", "russia", "kazakhstan", "turkey",
  "israel", "uae", "saudi arabia", "qatar", "kuwait", "bahrain", "oman",
  "jordan", "lebanon", "egypt", "south africa", "nigeria", "kenya",
  "morocco", "tunisia", "algeria", "ghana", "ethiopia", "tanzania",
  "uganda", "zambia", "zimbabwe", "botswana", "namibia", "mozambique",
  "madagascar", "mauritius", "seychelles",
  "china", "japan", "south korea", "north korea", "taiwan", "hong kong",
  "singapore", "malaysia", "thailand", "vietnam", "indonesia", "philippines",
  "myanmar", "cambodia", "laos", "brunei", "mongolia", "nepal", "bhutan",
  "bangladesh", "sri lanka", "pakistan", "afghanistan", "iran", "iraq",
  "syria", "yemen", "azerbaijan", "armenia", "georgia", "uzbekistan",
  "turkmenistan", "kyrgyzstan", "tajikistan",
  "australia", "new zealand", "fiji", "papua new guinea",
  "brazil", "argentina", "chile", "colombia", "peru", "venezuela", "ecuador",
  "bolivia", "paraguay", "uruguay", "guyana", "suriname", "french guiana",
  "mexico", "guatemala", "belize", "el salvador", "honduras", "nicaragua",
  "costa rica", "panama", "cuba", "haiti", "dominican republic", "jamaica",
  "trinidad and tobago", "barbados", "saint lucia", "grenada", "saint vincent",
  "antigua and barbuda", "saint kitts", "dominica", "bahamas",
];

export function wordRegex(keyword: string): RegExp {
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

export function normalizeLocation(loc: string): string {
  return (loc || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface FilterRules {
  topicRegexes: Array<{ kw: string; re: RegExp }>;
  blockRegexes: Array<{ kw: string; re: RegExp }>;
  roleRegexes: Array<{ kw: string; re: RegExp }>;
  levelRegexes: Array<{ kw: string; re: RegExp }>;
  locationRegexes: Array<{ kw: string; re: RegExp }>;
  cityMappings: Array<{ key: string; terms: string[] }>;
  acceptableKeys: Set<string>;
  requireConfiguredRole: boolean;
  warnings: string[];
}

export function filterRulesFromProfile(profile: Profile): FilterRules {
  const topics = profile.topics ?? DEFAULT_TOPIC_KEYWORDS;
  const blocklist = profile.titleBlocklist ?? DEFAULT_TITLE_BLOCKLIST;
  return {
    topicRegexes: topics.map((k) => ({ kw: k, re: wordRegex(k) })),
    blockRegexes: blocklist.map((k) => ({ kw: k, re: wordRegex(k) })),
    roleRegexes: (profile.targetRoles ?? []).map((k) => ({ kw: k, re: wordRegex(k) })),
    levelRegexes: (profile.targetLevels ?? []).map((k) => ({ kw: k, re: wordRegex(k) })),
    locationRegexes: (profile.targetLocations ?? []).map((k) => ({ kw: k, re: wordRegex(k) })),
    cityMappings: profile.cityRules.map((rule) => ({ key: rule.key, terms: rule.terms })),
    acceptableKeys: new Set([...profile.cityRules.map((rule) => rule.key), "default"]),
    requireConfiguredRole: Boolean(profile.targetRoles && profile.targetRoles.length > 0),
    warnings: profile.warnings,
  };
}

const MANAGER_EXCLUDE_REGEXES = MANAGER_EXCLUDE.map((k) => ({ kw: k, re: wordRegex(k) }));

export function detectEngineeringRole(titleLower: string): string | null {
  if (/\bhead of\b/.test(titleLower) && ROLE_ENGINEERING_TERMS.some((t) => wordRegex(t).test(titleLower))) return "head of engineering";
  if (/\bdirector\b/.test(titleLower) && ROLE_ENGINEERING_TERMS.some((t) => wordRegex(t).test(titleLower))) return "director of engineering";
  if (/\bmanager\b/.test(titleLower) && ROLE_MANAGER_TERMS.some((t) => wordRegex(t).test(titleLower))) {
    if (!MANAGER_EXCLUDE_REGEXES.some((x) => x.re.test(titleLower))) return "engineering manager";
  }
  if (/\bstaff\b/.test(titleLower) && (/\bengineer\b/.test(titleLower) || /\bdeveloper\b/.test(titleLower))) return "staff engineer";
  if (/\bprincipal\b/.test(titleLower) && (/\bengineer\b/.test(titleLower) || /\bdeveloper\b/.test(titleLower))) return "principal engineer";
  return null;
}

function detectConfiguredRole(titleLower: string, rules: FilterRules): string | null {
  const hit = rules.roleRegexes.find((r) => r.re.test(titleLower));
  return hit?.kw ?? null;
}

function detectRole(titleLower: string, rules: FilterRules): string | null {
  if (rules.requireConfiguredRole) return detectConfiguredRole(titleLower, rules);
  return detectEngineeringRole(titleLower);
}

function matchesTerm(norm: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (t.includes(" ")) return norm.includes(t);
  return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(norm);
}

export function resolveLocationKey(location: string | undefined, rules: FilterRules): { key: string; remote: boolean } {
  const norm = normalizeLocation(location || "");
  if (!norm) return { key: "default", remote: true };

  if (rules.locationRegexes.length > 0) {
    const remoteWanted = rules.locationRegexes.some((r) => /\bremote\b/.test(r.kw));
    if (remoteWanted && /\b(remote|anywhere|fully remote|work from anywhere)\b/.test(norm)) return { key: "default", remote: true };
    if (rules.locationRegexes.some((r) => r.re.test(norm))) return { key: "default", remote: /\bremote\b/.test(norm) };
    return { key: "__unknown__", remote: false };
  }

  for (const country of NON_US_COUNTRIES) {
    if (norm.includes(country)) return { key: "__non_us__", remote: false };
  }
  if (/\b(remote us|remote-us|remote, us|remote, united states|united states \(remote|usa remote)\b/.test(norm)) {
    return { key: "default", remote: true };
  }
  if (/\b(remote|anywhere|fully remote|work from anywhere)\b/.test(norm)) return { key: "default", remote: true };

  let best: { key: string; length: number } | null = null;
  for (const mapping of rules.cityMappings) {
    for (const term of mapping.terms) {
      if (matchesTerm(norm, term) && (!best || term.length > best.length)) best = { key: mapping.key, length: term.length };
    }
  }
  if (best) return { key: best.key, remote: false };

  if (/\b(united states|us|usa)\b/.test(norm) && !norm.includes("san ") && !norm.includes("new york")) {
    return { key: "default", remote: true };
  }
  return { key: "__unknown__", remote: false };
}

export interface MatchResult {
  pass: boolean;
  match: "strong" | "weak" | "skip";
  roleHit?: string;
  topicHit?: string;
  locationKey: string;
  remote: boolean;
  blockHit?: string;
  levelHit?: string;
}

export function matchJob(title: string, description: string, location: string | undefined, rules: FilterRules): MatchResult {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const loc = resolveLocationKey(location, rules);

  for (const blocked of rules.blockRegexes) {
    if (blocked.re.test(t)) return { pass: false, match: "skip", locationKey: loc.key, remote: loc.remote, blockHit: blocked.kw };
  }

  const roleHit = detectRole(t, rules) ?? undefined;
  if (rules.levelRegexes.length > 0) {
    const levelHit = rules.levelRegexes.find((r) => r.re.test(t))?.kw;
    if (!levelHit) return { pass: false, match: "skip", roleHit, locationKey: loc.key, remote: loc.remote };
  }

  const topicInTitle = rules.topicRegexes.find((r) => r.re.test(t))?.kw;
  const topicInDesc = d.length > 0 ? rules.topicRegexes.find((r) => r.re.test(d))?.kw : undefined;
  const topicHit = topicInTitle ?? topicInDesc;

  const locAcceptable = rules.acceptableKeys.has(loc.key);

  if (rules.requireConfiguredRole && !roleHit) {
    return { pass: false, match: "skip", locationKey: loc.key, remote: loc.remote };
  }
  if (!rules.requireConfiguredRole && !roleHit) {
    return { pass: false, match: "skip", locationKey: loc.key, remote: loc.remote };
  }

  if (loc.key === "__non_us__" || loc.key === "__unknown__") {
    return { pass: false, match: "skip", roleHit, topicHit, locationKey: loc.key, remote: loc.remote };
  }

  if (!topicHit || !locAcceptable) {
    return { pass: false, match: "weak", roleHit, topicHit, locationKey: loc.key, remote: loc.remote };
  }

  return { pass: true, match: "strong", roleHit, topicHit, locationKey: loc.key, remote: loc.remote };
}

export function cityRulesFromProfile(cityRules: CityRule[]): Array<{ key: string; terms: string[] }> {
  return cityRules.map((rule) => ({ key: rule.key, terms: rule.terms }));
}
