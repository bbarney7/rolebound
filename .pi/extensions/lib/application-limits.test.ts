import { describe, expect, it } from "vitest";
import { MAX_SOLVES_PER_APPLICATION, solveAttemptAllowed, validateManualVerificationRequest } from "./application-limits";

describe("application limits", () => {
  it("preserves paid solve attempt limits", () => {
    expect(solveAttemptAllowed(0)).toBe(true);
    expect(solveAttemptAllowed(MAX_SOLVES_PER_APPLICATION - 1)).toBe(true);
    expect(solveAttemptAllowed(MAX_SOLVES_PER_APPLICATION)).toBe(false);
  });

  it("validates structured manual OTP/CAPTCHA requests without Gmail dependency", () => {
    expect(validateManualVerificationRequest({ kind: "otp", message: "Paste the code from your email provider" })).toEqual({
      kind: "otp",
      message: "Paste the code from your email provider",
    });
    const captcha = validateManualVerificationRequest({ kind: "captcha", message: "Complete the challenge in the browser" });
    expect("kind" in captcha && captcha.kind).toBe("captcha");
    expect(validateManualVerificationRequest({ kind: "gmail", message: "nope" })).toHaveProperty("error");
    expect(validateManualVerificationRequest({ kind: "otp", message: "  " })).toHaveProperty("error");
  });
});
