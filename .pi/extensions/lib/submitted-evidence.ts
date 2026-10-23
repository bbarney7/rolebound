import { promises as fs } from "node:fs";
import path from "node:path";
import { readObservation } from "./submission-policy";

const GREENHOUSE_SOURCES = new Set(["greenhouse_submit_script", "greenhouse_otp_script"]);

export type SubmittedEvidenceParams = {
  confirmation_source?: string;
  confirmation_evidence?: string;
  screenshot?: string;
  screenshot_error?: string;
};

export async function validateSubmittedTransition(
  root: string,
  slug: string,
  prior: { status?: string; reopened_at?: string } | undefined,
  params: SubmittedEvidenceParams & { status?: string },
): Promise<{ ok: true; submitted_at: string } | { ok: false; code: "SUBMITTED_EVIDENCE_REQUIRED"; message: string }> {
  const priorStatus = prior?.status;
  if (params.status !== "submitted" || priorStatus === "submitted") {
    return { ok: true, submitted_at: new Date().toISOString() };
  }

  const source = params.confirmation_source;
  const evidence = params.confirmation_evidence?.trim() ?? "";
  if (!source || evidence.length < 10) {
    return {
      ok: false,
      code: "SUBMITTED_EVIDENCE_REQUIRED",
      message:
        "SUBMITTED_EVIDENCE_REQUIRED: set status to paused_for_user and ask the user. To record submitted you need confirmation_source, confirmation_evidence (≥10 chars), and a screenshot under screenshots/ or screenshot_error.",
    };
  }

  if (!params.screenshot_error) {
    const rel = params.screenshot?.trim();
    if (!rel) {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message:
          "SUBMITTED_EVIDENCE_REQUIRED: provide screenshot (under screenshots/) or screenshot_error describing why capture failed.",
      };
    }
    if (rel.includes("..") || path.isAbsolute(rel)) {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message: "SUBMITTED_EVIDENCE_REQUIRED: screenshot path must be relative under screenshots/.",
      };
    }
    const shotsRoot = path.resolve(root, "screenshots");
    const resolved = path.resolve(root, rel);
    if (resolved !== shotsRoot && !resolved.startsWith(shotsRoot + path.sep)) {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message: "SUBMITTED_EVIDENCE_REQUIRED: screenshot must resolve inside screenshots/.",
      };
    }
    try {
      const st = await fs.stat(resolved);
      if (!st.isFile() || st.size === 0) {
        return {
          ok: false,
          code: "SUBMITTED_EVIDENCE_REQUIRED",
          message: "SUBMITTED_EVIDENCE_REQUIRED: screenshot file must exist and be non-empty.",
        };
      }
    } catch {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message: "SUBMITTED_EVIDENCE_REQUIRED: screenshot file must exist and be non-empty.",
      };
    }
  }

  if (GREENHOUSE_SOURCES.has(source)) {
    const obs = await readObservation(root, slug);
    if (obs.status !== "ok" || obs.value.state !== "submitted") {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message:
          "SUBMITTED_EVIDENCE_REQUIRED: Greenhouse confirmation_source requires a persisted observation of state submitted from the submit/OTP script.",
      };
    }
    const reopenedAt = typeof prior?.reopened_at === "string" ? Date.parse(prior.reopened_at) : NaN;
    const obsAt = Date.parse(obs.value.at);
    if (!Number.isNaN(reopenedAt) && !Number.isNaN(obsAt) && obsAt <= reopenedAt) {
      return {
        ok: false,
        code: "SUBMITTED_EVIDENCE_REQUIRED",
        message:
          "SUBMITTED_EVIDENCE_REQUIRED: observation is older than reopened_at; re-run the submit script after reopening.",
      };
    }
  }

  return { ok: true, submitted_at: new Date().toISOString() };
}

export async function unlinkObservation(root: string, slug: string): Promise<string | undefined> {
  const file = path.join(root, ".pi-jobs", "observed", `${slug}.json`);
  try {
    await fs.unlink(file);
    return undefined;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    return err instanceof Error ? err.message : String(err);
  }
}
