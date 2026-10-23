import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createExtensionHarnessWorkspace, createRecordingExtensionApi } from "./extensionHarness";

async function loadJobApplier(ws: { root: string }) {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
  const { pi, tools } = createRecordingExtensionApi();
  mod.default(pi);
  return { tools };
}

describe("extension harness — request_manual_verification", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("puts otp and link values in model-visible content", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const { tools } = await loadJobApplier(ws);
    const verify = tools.get("request_manual_verification");
    expect(verify).toBeDefined();

    const otpOut = await verify!("t", { kind: "otp", message: "Enter the code" }, undefined, undefined, {
      ui: {
        input: async () => "123456",
        confirm: async () => true,
      },
    });
    const otpText = String(otpOut.content?.[0]?.text ?? "");
    expect(otpText).toContain("Verification code: 123456");
    expect(otpText).toMatch(/current verification step/i);

    const linkOut = await verify!("t", { kind: "link", message: "Paste link" }, undefined, undefined, {
      ui: {
        input: async () => "https://verify.example.invalid/token",
        confirm: async () => true,
      },
    });
    const linkText = String(linkOut.content?.[0]?.text ?? "");
    expect(linkText).toContain("Verification link: https://verify.example.invalid/token");
    expect(linkText).toMatch(/current verification step/i);
  });

  it("leaves captcha confirmation wording unchanged", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const { tools } = await loadJobApplier(ws);
    const verify = tools.get("request_manual_verification");
    expect(verify).toBeDefined();

    const out = await verify!("t", { kind: "captcha", message: "Solve it" }, undefined, undefined, {
      ui: {
        input: async () => "",
        confirm: async () => true,
      },
    });
    const text = String(out.content?.[0]?.text ?? "");
    expect(text).toMatch(/User confirmed manual CAPTCHA completion/i);
    expect(text).not.toMatch(/Verification code:/i);
  });
});
