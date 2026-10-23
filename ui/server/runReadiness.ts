import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunKind, ReadinessBlocker, ReadinessPayload, SetupStepId } from "../shared/types";
import { computeReadiness } from "./readiness";
import { readProfile } from "./readers/profile";
import { readResumes } from "./readers/library";
import { normalizeJobFile } from "./readers/jobFiles";
import { resolveQueueJob } from "../../.pi/extensions/lib/queue-slug";
import { matchesTerm } from "../../.pi/extensions/lib/profile";
import { ProviderServiceError } from "./providers/providerService";
import type { ProviderRuntime } from "./providers/hostDeps";

/** HTTP 422 run-start refusal codes (readiness + prepareAgentRun). */
export const RUN_START_REFUSAL_CODES = new Set([
  "CREDENTIAL_MISSING",
  "CREDENTIAL_EXPIRED",
  "AGENT_MODEL_MISSING",
  "MODEL_UNAVAILABLE",
  "TOOLS_UNSUPPORTED",
  "CONFIG_INVALID",
  "PROFILE_PLACEHOLDERS",
  "TARGETS_PLACEHOLDER",
  "TARGETS_MISSING",
  "NAME_MISSING",
  "EMAIL_MISSING",
  "RESUME_MISSING",
  "PROFILE_MISSING",
  "CANDIDATE_SUMMARY_MISSING",
  "SCORING_MODEL_MISSING",
  "CURSOR_NODE_VERSION",
]);

export function isRunStartRefusalCode(code: string): boolean {
  return RUN_START_REFUSAL_CODES.has(code);
}

const PREPARE_PREFIX =
  /^(CREDENTIAL_MISSING|CREDENTIAL_EXPIRED|AGENT_MODEL_MISSING|MODEL_UNAVAILABLE|TOOLS_UNSUPPORTED|CONFIG_INVALID|CONNECTION_MISSING|SCORING_MODEL_MISSING):\s*(.*)$/;

export function parseRunPrepareError(err: unknown): { code: string; message: string } | null {
  if (err instanceof ProviderServiceError) {
    const code = err.code === "CONNECTION_MISSING" ? "AGENT_MODEL_MISSING" : err.code;
    if (isRunStartRefusalCode(code) || code === "AGENT_MODEL_MISSING") {
      return { code, message: err.message };
    }
    return null;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(PREPARE_PREFIX);
  if (!match) return null;
  const code = match[1] === "CONNECTION_MISSING" ? "AGENT_MODEL_MISSING" : match[1];
  const message = match[2]?.trim() || raw;
  if (!isRunStartRefusalCode(code) && code !== "AGENT_MODEL_MISSING") return null;
  return { code, message };
}

function firstBlockerFromSteps(payload: ReadinessPayload, stepIds: SetupStepId[]): ReadinessBlocker | null {
  for (const id of stepIds) {
    const step = payload.steps.find((s) => s.id === id);
    if (step && !step.complete && step.blockers[0]) return step.blockers[0];
  }
  return null;
}

const REMOTE_PATTERN = /\b(remote|anywhere|hybrid with no office|fully remote)\b/;

function normalizeLocation(loc: string): string {
  return loc.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function resumeKeyForLocation(norm: string, regionRules: readonly { key: string; terms: string[] }[]): string {
  if (REMOTE_PATTERN.test(norm)) return "default";
  for (const rule of regionRules) {
    if (rule.terms.some((term) => matchesTerm(norm, term))) return rule.key;
  }
  return "default";
}

/** Whether the applier's `resolveResumePath` would find a PDF for this location. */
export async function resumeReadyForApplyLocation(root: string, location: string): Promise<boolean> {
  const [profile, resumes] = await Promise.all([readProfile(root), readResumes(root)]);
  if (profile.resume?.overridePath) return profile.resume.overrideExists === true;
  const resumeKey = resumeKeyForLocation(normalizeLocation(location), profile.resume?.regionRules ?? []);
  const keyed = `${resumeKey}.pdf`;
  if (resumes.files.some((file) => file.name === keyed && file.reachability !== "orphan")) return true;
  return resumes.files.some((file) => file.reachability === "default");
}

export async function resumeReadyForQueueSlug(root: string, slug: string): Promise<boolean> {
  const { filename } = resolveQueueJob(root, slug);
  const filePath = path.join(root, "jobs", "queue", filename);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const stat = await fs.stat(filePath);
  const record = normalizeJobFile(slug, "queue", filePath, raw, stat.mtime, stat.ctime);
  const location = record.location?.trim();
  if (!location) {
    const [profile, resumes] = await Promise.all([readProfile(root), readResumes(root)]);
    if (profile.resume?.overridePath) return profile.resume.overrideExists === true;
    return resumes.files.some((file) => file.reachability === "default");
  }
  return resumeReadyForApplyLocation(root, location);
}

/** First readiness blocker for starting a run of this kind, or null when allowed. */
export async function readinessBlockerForRunKind(
  root: string,
  kind: RunKind,
  slug?: string | null,
  runtime: Partial<ProviderRuntime> = {},
): Promise<ReadinessBlocker | null> {
  const payload = await computeReadiness(root, runtime);
  switch (kind) {
    case "status":
      return null;
    case "gather":
      if (payload.discoverReady) return null;
      return firstBlockerFromSteps(payload, ["targets"]);
    case "score":
      if (payload.scoreReady) return null;
      return payload.scoreBlockers[0] ?? null;
    case "apply":
    case "apply-next":
      // With a known queue slug, the resume check uses the resume chosen for that job's location.
      return applyReadinessBlocker(root, slug ? { slug } : {}, runtime);
    default:
      return null;
  }
}

/**
 * Apply gate: connection, profile (incl. placeholders), and resume — not acknowledgement (409).
 * The pi `/apply-next` command passes `includeConnection: false`: in a terminal session pi's own
 * selected model drives the run, so a Rolebound connection is not required there.
 */
export async function applyReadinessBlocker(
  root: string,
  opts: { includeConnection?: boolean; slug?: string } = {},
  runtime: Partial<ProviderRuntime> = {},
): Promise<ReadinessBlocker | null> {
  const payload = await computeReadiness(root, runtime);
  const steps: SetupStepId[] = opts.includeConnection === false ? ["profile", "resume"] : ["connection", "profile", "resume"];
  for (const id of steps) {
    if (id === "resume" && opts.slug) {
      if (!(await resumeReadyForQueueSlug(root, opts.slug))) {
        const step = payload.steps.find((s) => s.id === "resume");
        return step?.blockers[0] ?? {
          code: "RESUME_MISSING",
          message: "Upload and select a default or global PDF resume.",
          href: "/profile?tab=resumes",
        };
      }
      continue;
    }
    const step = payload.steps.find((s) => s.id === id);
    if (step && !step.complete && step.blockers[0]) return step.blockers[0];
  }
  return null;
}
