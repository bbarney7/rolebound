import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTO_SUBMIT_POLICY_VERSION } from "../../shared/autoSubmitPolicy";
import { ApplicationsSettingsSection } from "../ApplicationsSettingsSection";
import { hcaptchaNote, keyStatusLine, providerLabel, solverLabel } from "../settings";
import type { CaptchaSettingsPayload } from "../../shared/types";

/** Node environment, no rendering — pure helpers only, like accounts.test.ts. */
function payload(overrides: Partial<CaptchaSettingsPayload> = {}): CaptchaSettingsPayload {
  return {
    provider: "off",
    hasApiKey: false,
    keyHint: null,
    keySource: "none",
    fileHasKey: false,
    warnings: [],
    providers: [
      { id: "capsolver", label: "CapSolver", envVar: "CAPSOLVER_API_KEY", supports: ["recaptcha_v2", "recaptcha_v3", "turnstile"] },
      { id: "2captcha", label: "2Captcha", envVar: "TWOCAPTCHA_API_KEY", supports: ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile"] },
    ],
    maxPaidTasksPerDay: 20,
    dailyPaidTasksCount: 0,
    ...overrides,
  };
}

describe("keyStatusLine", () => {
  it("names the source without ever including the key", () => {
    expect(keyStatusLine(payload())).toBe("No key set");
    expect(keyStatusLine(payload({ provider: "2captcha", hasApiKey: true, keyHint: "…ABCD", keySource: "file" }))).toBe("Key set in settings.json (…ABCD)");
    expect(keyStatusLine(payload({ provider: "capsolver", hasApiKey: true, keySource: "env" }))).toBe("Key from CAPSOLVER_API_KEY (overrides settings.json)");
    expect(keyStatusLine(payload({ provider: "off", fileHasKey: true, keyHint: "…ABCD" }))).toBe(
      "Key stored in settings.json (…ABCD) — not used while the provider is Off",
    );
  });
});

describe("providerLabel / solverLabel", () => {
  it("maps ids to labels and off to Off", () => {
    expect(providerLabel(payload(), "2captcha")).toBe("2Captcha");
    expect(providerLabel(payload(), "off")).toBe("Off");
    expect(solverLabel(null, "capsolver")).toBe("capsolver");
    expect(solverLabel(payload(), "off")).toBe("Off");
  });
});

describe("hcaptchaNote", () => {
  it("warns only for a provider that cannot solve hCaptcha", () => {
    expect(hcaptchaNote(payload(), "capsolver")).toMatch(/CapSolver cannot solve hCaptcha/);
    expect(hcaptchaNote(payload(), "2captcha")).toBeNull();
    expect(hcaptchaNote(payload(), "off")).toBeNull();
  });
});

describe("ApplicationsSettingsSection", () => {
  it("renders submission policy and versioned acknowledgement", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationsSettingsSection, {
        acknowledgement: {
          at: "2026-01-01T00:00:00.000Z",
          policy: AUTO_SUBMIT_POLICY_VERSION,
          current: AUTO_SUBMIT_POLICY_VERSION,
        },
        captchaProvider: "off",
        captchaDailyPaidTasksCount: null,
      }),
    );
    expect(html).toContain("Applications");
    expect(html).toContain("Automatic (no per-application confirmation)");
    expect(html).toContain("You turned on automatic submission on");
    expect(html).not.toContain(AUTO_SUBMIT_POLICY_VERSION);
    expect(html).toContain("At most one application every 10 minutes");
  });

  it("links to Setup when the submission policy changed", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationsSettingsSection, {
        acknowledgement: {
          at: "2025-06-01T00:00:00.000Z",
          policy: "auto-submit-v0",
          current: AUTO_SUBMIT_POLICY_VERSION,
        },
        captchaProvider: "off",
        captchaDailyPaidTasksCount: null,
      }),
    );
    expect(html).toContain("The submission policy changed since you turned this on.");
    expect(html).toContain('href="/setup"');
    expect(html).not.toContain("auto-submit-v0");
  });
});
