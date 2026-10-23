import { MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION } from "./submission-policy";

/** @deprecated Use MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION from submission-policy (T8 completes the rename). */
export const MAX_SOLVES_PER_APPLICATION = MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION;

export function solveAttemptAllowed(used: number): boolean {
  return used < MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION;
}

export type ManualVerificationKind = "otp" | "link" | "captcha";

export interface ManualVerificationRequest {
  kind: ManualVerificationKind;
  message: string;
}

export function validateManualVerificationRequest(input: {
  kind?: unknown;
  message?: unknown;
}): ManualVerificationRequest | { error: string } {
  if (input.kind !== "otp" && input.kind !== "link" && input.kind !== "captcha") {
    return { error: "manual verification kind must be otp, link, or captcha" };
  }
  if (typeof input.message !== "string" || !input.message.trim()) {
    return { error: "manual verification message is required" };
  }
  return { kind: input.kind, message: input.message.trim() };
}
