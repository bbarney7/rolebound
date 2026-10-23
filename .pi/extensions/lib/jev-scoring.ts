import { promises as fs } from "node:fs";
import path from "node:path";
import { JEV_SCORE_TEMPLATE } from "../../../ui/shared/jevModels";

export const JEV_FIT_CRITERIA = [
  "very poor fit, wrong field or level",
  "weak fit, major gaps",
  "partial fit, some relevant overlap",
  "good fit, most requirements met",
  "excellent fit, strong match on role, level and skills",
] as const;

const JEV_STATE_MAX_CHARS = 60_000;

export type JevJobInput = {
  title: string;
  company: string;
  location: string;
  description: string;
};

export function buildJevQuestions() {
  return {
    fit: {
      type: "score",
      instructions: "How well does this job fit this candidate?",
      criteria: [...JEV_FIT_CRITERIA],
    },
    level: {
      type: "noul",
      instructions: "Does the seniority level of this job match the candidate?",
      criteria: { true: "Seniority matches the candidate", false: "Seniority does not match" },
    },
    skills: {
      type: "noul",
      instructions: "Do the candidate's skills and stack overlap the job requirements?",
      criteria: { true: "Skills overlap the requirements", false: "Skills do not overlap" },
    },
    location: {
      type: "noul",
      instructions: "Does the location or remote policy fit the candidate's preferences?",
      criteria: { true: "Location or remote policy fits", false: "Location or remote policy does not fit" },
    },
  };
}

export function buildJevState(candidate: string, job: JevJobInput): { candidate: string; job: JevJobInput } {
  let description = job.description;
  const base = {
    candidate,
    job: {
      title: job.title,
      company: job.company,
      location: job.location,
      description,
    },
  };
  let serialized = JSON.stringify(base);
  while (serialized.length > JEV_STATE_MAX_CHARS && description.length > 0) {
    description = description.slice(0, Math.max(0, Math.floor(description.length * 0.9)));
    base.job.description = description;
    serialized = JSON.stringify(base);
  }
  return base;
}

type BoolAnswer = number;
type ScoreAnswer = { score: number; probabilities: number[] };
type ParsedJevAnswers = {
  fit: ScoreAnswer;
  level: BoolAnswer;
  skills: BoolAnswer;
  location: BoolAnswer;
};

function readBoolAnswer(raw: unknown): BoolAnswer | null {
  if (typeof raw === "number" && raw >= 0 && raw <= 1) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { type?: unknown; noul?: unknown; probability?: unknown };
    if (obj.type === "noul" && typeof obj.noul === "number" && obj.noul >= 0 && obj.noul <= 1) return obj.noul;
    if (typeof obj.probability === "number" && obj.probability >= 0 && obj.probability <= 1) return obj.probability;
  }
  return null;
}

/**
 * A `score` answer carries `probabilities` keyed by option index ("0".."4"; an array is also
 * accepted) and a continuous `score` (the expected index, e.g. 3.99). The prediction is the most
 * probable option, as in the owner's jev-bench harness; `score` itself is not used.
 */
function readScoreAnswer(raw: unknown): ScoreAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const typed = raw as { type?: unknown; score?: unknown; probabilities?: unknown };
  if (typed.type === "score" && typeof typed.score === "number" && typed.score >= 0 && typed.score <= 4) {
    const fitIndex = Math.min(4, Math.max(0, Math.round(typed.score)));
    const probabilities = [0, 0, 0, 0, 0];
    probabilities[fitIndex] = 1;
    return { score: fitIndex, probabilities };
  }
  const rawProbs = typed.probabilities;
  const probabilities = [0, 0, 0, 0, 0];
  const entries: Array<[string, unknown]> = Array.isArray(rawProbs)
    ? rawProbs.map((p, i) => [String(i), p])
    : rawProbs && typeof rawProbs === "object"
      ? Object.entries(rawProbs as Record<string, unknown>)
      : [];
  if (entries.length === 0) return null;
  for (const [key, value] of entries) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > 4) return null;
    if (typeof value !== "number" || value < 0 || value > 1) return null;
    probabilities[index] = value;
  }
  let best = 0;
  for (let i = 1; i < probabilities.length; i++) if (probabilities[i] > probabilities[best]) best = i;
  return { score: best, probabilities };
}

export function parseJevDecisionsResponse(body: string): { ok: true; answers: ParsedJevAnswers; usageCost?: number } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "Model returned invalid scoring response" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "Model returned invalid scoring response" };
  const answersRaw = (parsed as { answers?: unknown }).answers;
  if (!answersRaw || typeof answersRaw !== "object") return { ok: false, error: "Model returned invalid scoring response" };
  const answers = answersRaw as Record<string, unknown>;
  const fit = readScoreAnswer(answers.fit);
  const level = readBoolAnswer(answers.level);
  const skills = readBoolAnswer(answers.skills);
  const location = readBoolAnswer(answers.location);
  if (!fit || level === null || skills === null || location === null) {
    return { ok: false, error: "Model returned invalid scoring response" };
  }
  const usage = (parsed as { usage?: { cost?: unknown } }).usage;
  const usageCost = usage && typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
  return { ok: true, answers: { fit, level, skills, location }, usageCost };
}

const FIT_SHORT = ["very poor fit", "weak fit", "partial fit", "good fit", "excellent fit"];

export function formatJevReasoning(answers: ParsedJevAnswers): string {
  const fitIdx = answers.fit.score;
  const fitP = answers.fit.probabilities[fitIdx] ?? 0;
  const parts = [
    `Jev: ${FIT_SHORT[fitIdx] ?? "unknown fit"} (p=${fitP.toFixed(2)}).`,
    `Level match ${answers.level >= 0.5 ? "likely" : "unlikely"} (${answers.level.toFixed(2)});`,
    `skills overlap ${answers.skills >= 0.5 ? "likely" : "unlikely"} (${answers.skills.toFixed(2)});`,
    `location fit ${answers.location >= 0.5 ? "likely" : "unlikely"} (${answers.location.toFixed(2)}).`,
  ];
  let text = parts.join(" ");
  if (text.length > 1000) text = text.slice(0, 1000);
  return text;
}

export function jevScoreFromFitIndex(fitIndex: number): number {
  return fitIndex + 1;
}

export type JevScoringKind = "jev-openrouter" | "jev-typesafe";

export function resolveJevScoringConfig(env: NodeJS.ProcessEnv): { ok: true; kind: JevScoringKind; model: string; alias: string } | { ok: false; error: string } {
  const kind = env.PI_JOBS_SCORING_KIND;
  if (kind !== "jev-openrouter" && kind !== "jev-typesafe") return { ok: false, error: "Scoring model is not configured" };
  if (env.PI_JOBS_SCORING_READY !== "1") return { ok: false, error: "Scoring connection credential is not configured" };
  const model = env.PI_JOBS_SCORING_JEV_MODEL?.trim();
  const alias = env.PI_JOBS_SCORING_AUTH_ALIAS?.trim();
  if (!model || !alias) return { ok: false, error: "Scoring model is not configured" };
  return { ok: true, kind, model, alias };
}

export async function readScoringApiKey(env: NodeJS.ProcessEnv, alias: string): Promise<string | null> {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) return null;
  try {
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<string, { key?: string }>;
    const key = auth[alias]?.key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Test-only endpoint override. Loopback only, like PI_JOBS_ATS_FIXTURE_ORIGIN: the scoring
 * key is sent to this URL, so anything else fails closed instead of falling back.
 */
function loopbackDecisionsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid PI_JOBS_JEV_DECISIONS_BASE_URL: not a URL");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid PI_JOBS_JEV_DECISIONS_BASE_URL: only plain http loopback URLs are allowed");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Invalid PI_JOBS_JEV_DECISIONS_BASE_URL: host must be 127.0.0.1 or localhost");
  }
  return url.toString().replace(/\/$/, "");
}

export function jevDecisionsUrl(kind: JevScoringKind, env: NodeJS.ProcessEnv): string {
  const override = env.PI_JOBS_JEV_DECISIONS_BASE_URL;
  if (override !== undefined) return loopbackDecisionsUrl(override.trim());
  if (kind === "jev-typesafe") return "https://api.typesafe.ai/v1/systemone";
  return "https://openrouter.ai/api/alpha/decisions";
}

export { JEV_SCORE_TEMPLATE };
