import { promises as fs } from "node:fs";
import {
  buildJevQuestions,
  buildJevState,
  formatJevReasoning,
  jevDecisionsUrl,
  jevScoreFromFitIndex,
  JEV_SCORE_TEMPLATE,
  parseJevDecisionsResponse,
  readScoringApiKey,
  resolveJevScoringConfig,
  type JevJobInput,
} from "./jev-scoring";

export const SCORE_TEMPLATE_VERSION = "job-fit-v1";

export interface LLMScore {
  score: number;
  reasoning: string;
  usageCost?: number;
  templateVersion?: string;
}

export function classifyScoringError(message: string): "auth" | "retryable" | "fatal" {
  const lower = message.toLowerCase();
  if (/401|403|unauthorized|invalid.*key|authentication|api key|auth rejected/.test(lower)) return "auth";
  if (/redirect/i.test(lower)) return "fatal";
  if (/429|rate limit|5\d\d|timeout|timed out|network|fetch failed|econnreset|enotfound|upstream/.test(lower)) return "retryable";
  return "fatal";
}

export function buildScoringPrompt(summary: string, job: {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
}, instructions?: string): string {
  const descExcerpt = job.description.slice(0, 20_000);
  const instructionBlock =
    instructions && instructions.trim()
      ? `\n\nScoring instructions from the candidate (follow these):\n${instructions.trim().slice(0, 4000)}`
      : "";
  return `You are a technical recruiter scoring job fit. Score how well this job matches the candidate's profile on a 1-5 scale.

5 = Perfect fit (right role level, strong topic match, good location)
4 = Strong fit (minor gap in topic, level, or location)
3 = Decent fit (some alignment but notable gap)
2 = Weak fit (wrong level, wrong domain, or mostly unrelated)
1 = No fit

Candidate profile:
${summary.slice(0, 8_000)}${instructionBlock}

Job to score:
- Title: ${job.title.slice(0, 500)}
- Company: ${job.company.slice(0, 300)}
- Location: ${(job.location || "Unknown").slice(0, 500)}
- URL: ${job.url.slice(0, 2000)}
- Description excerpt:
${descExcerpt || "(no description available)"}

Reply with ONLY valid JSON, no markdown fences, no preamble:
{"score":<1-5>,"reason":"<one sentence explaining the score>"}`;
}

export function parseScoringJson(content: string): { ok: true; result: LLMScore } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(content) as { score?: unknown; reason?: unknown };
    if (!Number.isInteger(parsed.score) || Number(parsed.score) < 1 || Number(parsed.score) > 5) {
      return { ok: false, error: "Model returned invalid scoring JSON" };
    }
    if (typeof parsed.reason !== "string" || !parsed.reason.trim() || parsed.reason.length > 1000) {
      return { ok: false, error: "Model returned invalid scoring JSON" };
    }
    return { ok: true, result: { score: Number(parsed.score), reasoning: parsed.reason.trim(), templateVersion: SCORE_TEMPLATE_VERSION } };
  } catch {
    return { ok: false, error: "Model returned invalid scoring JSON" };
  }
}

export function resolveScoringModel(env: NodeJS.ProcessEnv = process.env): { ok: true; modelName: string } | { ok: false; error: string } {
  if (resolveJevScoringConfig(env).ok) return { ok: false, error: "Scoring model is not configured" };
  const modelName = env.PI_JOBS_SCORING_MODEL?.trim();
  if (!modelName?.includes("/")) return { ok: false, error: "Scoring model is not configured" };
  if (env.PI_JOBS_SCORING_READY !== "1") return { ok: false, error: "Scoring connection credential is not configured" };
  return { ok: true, modelName };
}

function upsertScoreFields(raw: string, llmScore: LLMScore): string {
  const now = new Date().toISOString();
  const reason = JSON.stringify(llmScore.reasoning);
  const template = llmScore.templateVersion ?? SCORE_TEMPLATE_VERSION;
  const fields: Record<string, string> = {
    llm_score: String(llmScore.score),
    llm_reasoning: reason,
    llm_scored_at: now,
    llm_score_template: template,
  };
  if (!/^llm_score:/m.test(raw)) {
    const delimiters = [...raw.matchAll(/^---\s*$/gm)];
    if (delimiters.length < 2 || delimiters[1].index === undefined) throw new Error("job frontmatter is malformed");
    const at = delimiters[1].index;
    const block = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n");
    return `${raw.slice(0, at)}${block}\n${raw.slice(at)}`;
  }
  let updated = raw;
  const delimiters = [...raw.matchAll(/^---\s*$/gm)];
  const insertAt = delimiters.length >= 2 && delimiters[1].index !== undefined ? delimiters[1].index : raw.length;
  for (const [key, value] of Object.entries(fields)) {
    const pattern = new RegExp(`^${key}:.*$`, "m");
    if (pattern.test(updated)) updated = updated.replace(pattern, `${key}: ${value}`);
    else updated = `${updated.slice(0, insertAt)}${key}: ${value}\n${updated.slice(insertAt)}`;
  }
  return updated;
}

/** Lossless frontmatter score writer with shared discovered-job lock and compare-and-swap. */
export async function writeScoreToFrontmatter(
  filePath: string,
  llmScore: LLMScore,
  expectedRaw?: string,
): Promise<void> {
  const { assertRegularDiscoveredJobFile, withDiscoveredJobFileLock } = await import("./job-file-lock");
  await withDiscoveredJobFileLock(filePath, async () => {
    await assertRegularDiscoveredJobFile(filePath);
    const raw = await fs.readFile(filePath, "utf-8");
    if (expectedRaw !== undefined && raw !== expectedRaw) throw new Error("job changed while scoring");
    const updated = upsertScoreFields(raw, llmScore);
    const temp = `${filePath}.${process.pid}.${Date.now()}.score-tmp`;
    try {
      const out = await fs.open(temp, "wx", 0o600);
      try { await out.writeFile(updated); await out.sync(); } finally { await out.close(); }
      await fs.rename(temp, filePath);
    } finally {
      await fs.rm(temp, { force: true });
    }
  });
}

async function scoringBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, attempt === 0 ? 1000 : 3000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
  }).catch(() => {});
}

export async function completeJevScoringRequest(
  summary: string,
  job: JevJobInput,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; result: LLMScore; attempts: number } | { ok: false; error: string; attempts: number }> {
  const resolved = resolveJevScoringConfig(env);
  if (!resolved.ok) return { ...resolved, attempts: 0 };
  const apiKey = await readScoringApiKey(env, resolved.alias);
  if (!apiKey) return { ok: false, error: "Scoring connection credential is not configured", attempts: 0 };
  const url = jevDecisionsUrl(resolved.kind, env);
  const body = JSON.stringify({
    model: resolved.model,
    state: buildJevState(summary, job),
    questions: buildJevQuestions(),
  });
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return { ok: false, error: "Scoring cancelled", attempts };
    attempts++;
    try {
      const timeout = AbortSignal.timeout(60_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
        redirect: "error",
        signal: combined,
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "Scoring provider rejected the credential", attempts };
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 2) {
          await scoringBackoff(attempt, signal);
          continue;
        }
        return { ok: false, error: "Scoring provider request failed", attempts };
      }
      if (!response.ok) return { ok: false, error: "Scoring provider request failed", attempts };
      const text = await response.text();
      const parsed = parseJevDecisionsResponse(text);
      if (!parsed.ok) return { ...parsed, attempts };
      const result: LLMScore = {
        score: jevScoreFromFitIndex(parsed.answers.fit.score),
        reasoning: formatJevReasoning(parsed.answers),
        templateVersion: JEV_SCORE_TEMPLATE,
        ...(parsed.usageCost !== undefined ? { usageCost: parsed.usageCost } : {}),
      };
      return { ok: true, result, attempts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (signal?.aborted || message === "cancelled") return { ok: false, error: "Scoring cancelled", attempts };
      const kind = classifyScoringError(message);
      if (kind === "auth") return { ok: false, error: "Scoring provider rejected the credential", attempts };
      if (kind === "retryable" && attempt < 2) {
        await scoringBackoff(attempt, signal);
        continue;
      }
      return { ok: false, error: "Scoring provider request failed", attempts };
    }
  }
  return { ok: false, error: "Scoring provider request failed", attempts };
}

/** Production scoring path: complete provider request then persist parsed fields. */
export async function scoreDiscoveredJobFile(
  filePath: string,
  prompt: string,
  options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; jev?: { summary: string; job: JevJobInput } },
): Promise<{ ok: true; result: LLMScore; attempts: number } | { ok: false; error: string; attempts: number }> {
  const env = options?.env ?? process.env;
  const raw = await fs.readFile(filePath, "utf-8");
  const result = options?.jev
    ? await completeJevScoringRequest(options.jev.summary, options.jev.job, options?.signal, env)
    : await completeScoringRequest(prompt, options?.signal, env);
  if (!result.ok) return { ok: false, error: result.error, attempts: result.attempts };
  await writeScoreToFrontmatter(filePath, result.result, raw);
  return result;
}

export async function completeScoringRequest(
  prompt: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; result: LLMScore; attempts: number } | { ok: false; error: string; attempts: number }> {
  if (resolveJevScoringConfig(env).ok) {
    return { ok: false, error: "Jev scoring requires job context", attempts: 0 };
  }
  const resolved = resolveScoringModel(env);
  if (!resolved.ok) return { ...resolved, attempts: 0 };
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return { ok: false, error: "Scoring cancelled", attempts };
    attempts++;
    try {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const agentDir = env.PI_CODING_AGENT_DIR;
      if (!agentDir) return { ok: false, error: "Configured scoring runtime is unavailable", attempts };
      const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`, refreshOnCreate: false });
      const split = resolved.modelName.indexOf("/");
      const model = runtime.getModel(resolved.modelName.slice(0, split), resolved.modelName.slice(split + 1));
      if (!model) return { ok: false, error: "Configured scoring model is unavailable", attempts };
      const timeout = AbortSignal.timeout(60_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await runtime.complete(model, {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, { signal: combined });
      if (response.stopReason === "aborted") return { ok: false, error: "Scoring cancelled", attempts };
      if (response.stopReason === "error") {
        const kind = classifyScoringError(response.errorMessage || "error");
        if (kind === "auth") return { ok: false, error: "Scoring provider rejected the credential", attempts };
        if (kind === "retryable" && attempt < 2) {
          await scoringBackoff(attempt, signal);
          continue;
        }
        return { ok: false, error: "Scoring provider request failed", attempts };
      }
      const content = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("");
      if (!content) return { ok: false, error: "Model returned no scoring JSON", attempts };
      const parsed = parseScoringJson(content);
      if (!parsed.ok) return { ...parsed, attempts };
      return { ...parsed, attempts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (signal?.aborted || message === "cancelled") return { ok: false, error: "Scoring cancelled", attempts };
      const kind = classifyScoringError(message);
      if (kind === "auth") return { ok: false, error: "Scoring provider rejected the credential", attempts };
      if (kind === "retryable" && attempt < 2) {
        await scoringBackoff(attempt, signal);
        continue;
      }
      return { ok: false, error: "Scoring provider request failed", attempts };
    }
  }
  return { ok: false, error: "Scoring provider request failed", attempts };
}
