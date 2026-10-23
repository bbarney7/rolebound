import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseSettingsText,
  resolveCaptchaSettings,
  readCaptchaSettings,
  SettingsShapeError,
  PROVIDERS,
  supportedKinds,
  solveCaptcha,
  checkBalance,
  type CaptchaSettings,
} from "../../../.pi/extensions/lib/captcha";

/**
 * The library lives in .pi/extensions/lib because the pi extension is its
 * first consumer, but the UI package owns the only vitest in the repo, so the
 * tests reach across the package boundary on purpose (a probe confirmed
 * vitest resolves the relative import without an fs.allow change).
 */

describe("parseSettingsText", () => {
  it("reads an empty or whitespace-only file as the defaults, without warnings", () => {
    for (const text of ["", "   \n"]) {
      const parsed = parseSettingsText(text);
      expect(parsed.captcha).toEqual({ provider: "off", api_key: "", max_paid_tasks_per_day: 20 });
      expect(parsed.warnings).toEqual([]);
      expect(parsed.raw).toEqual({});
    }
  });

  it("keeps a valid block verbatim and preserves unknown top-level keys in raw", () => {
    const parsed = parseSettingsText(
      JSON.stringify({ captcha: { provider: "2captcha", api_key: "k".repeat(32) }, future: { x: 1 } }),
    );
    expect(parsed.captcha).toEqual({ provider: "2captcha", api_key: "k".repeat(32), max_paid_tasks_per_day: 20 });
    expect(parsed.raw.future).toEqual({ x: 1 });
    expect(parsed.warnings).toEqual([]);
  });

  it("falls back to off with a warning on an unknown provider, and to an empty key on a non-string key", () => {
    const parsed = parseSettingsText(JSON.stringify({ captcha: { provider: "anticaptcha", api_key: 42 } }));
    expect(parsed.captcha).toEqual({ provider: "off", api_key: "", max_paid_tasks_per_day: 20 });
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toMatch(/provider "anticaptcha"/);
    expect(parsed.warnings[1]).toMatch(/api_key/);
  });

  it("throws SyntaxError on bad JSON and SettingsShapeError on a non-object document", () => {
    expect(() => parseSettingsText("{ nope")).toThrow(SyntaxError);
    expect(() => parseSettingsText("[]")).toThrow(SettingsShapeError);
    expect(() => parseSettingsText("null")).toThrow(SettingsShapeError);
    expect(() => parseSettingsText(JSON.stringify({ captcha: "yes" }))).toThrow(SettingsShapeError);
  });
});

describe("resolveCaptchaSettings", () => {
  it("is off with no file and no env", () => {
    expect(resolveCaptchaSettings(null, {})).toEqual({ provider: "off", apiKey: "", keySource: "none", warnings: [] });
  });

  it("takes the file's provider and key", () => {
    const s = resolveCaptchaSettings({ provider: "capsolver", api_key: " CAP-file-key " }, {});
    expect(s).toMatchObject({ provider: "capsolver", apiKey: "CAP-file-key", keySource: "file" });
  });

  it("lets the provider's env var beat the file key, and ignores the other provider's env var", () => {
    const env = { CAPSOLVER_API_KEY: "CAP-env-key", TWOCAPTCHA_API_KEY: "two-env-key" };
    const s = resolveCaptchaSettings({ provider: "2captcha", api_key: "two-file-key" }, env);
    expect(s).toMatchObject({ provider: "2captcha", apiKey: "two-env-key", keySource: "env" });
  });

  it("stays off when the file says off or is missing, even if a provider's env var is exported", () => {
    expect(resolveCaptchaSettings({ provider: "off", api_key: "" }, { TWOCAPTCHA_API_KEY: "two" })).toEqual({
      provider: "off",
      apiKey: "",
      keySource: "none",
      warnings: [],
    });
    expect(
      resolveCaptchaSettings(null, { CAPSOLVER_API_KEY: "cap", TWOCAPTCHA_API_KEY: "two" }),
    ).toEqual({ provider: "off", apiKey: "", keySource: "none", warnings: [] });
  });

  it("warns, with keySource none, when a provider is selected but no key resolves", () => {
    const s = resolveCaptchaSettings({ provider: "2captcha", api_key: "   " }, { TWOCAPTCHA_API_KEY: "" });
    expect(s).toMatchObject({ provider: "2captcha", apiKey: "", keySource: "none" });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/TWOCAPTCHA_API_KEY/);
  });
});

describe("readCaptchaSettings", () => {
  async function tmpFile(contents: string | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "captcha-settings-"));
    const file = path.join(dir, "settings.json");
    if (contents !== null) await fs.writeFile(file, contents);
    return file;
  }

  it("treats a missing file as off, with no warnings", async () => {
    const s = await readCaptchaSettings(await tmpFile(null), {});
    expect(s).toEqual({ provider: "off", apiKey: "", keySource: "none", warnings: [] });
  });

  it("turns a corrupt file into a warning rather than a throw", async () => {
    const s = await readCaptchaSettings(await tmpFile("{ nope"), {});
    expect(s.provider).toBe("off");
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/settings\.json is not valid JSON/);
  });

  it("carries parse warnings through", async () => {
    const s = await readCaptchaSettings(await tmpFile(JSON.stringify({ captcha: { provider: "nope", api_key: "" } })), {});
    expect(s.provider).toBe("off");
    expect(s.warnings[0]).toMatch(/provider "nope"/);
  });
});

/** A scripted fetch: each call pops the next handler, which sees the parsed body. */
function scriptedFetch(handlers: Array<(url: string, body: any) => unknown>) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    const out = handler(url, body);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const twoCaptcha: CaptchaSettings = { provider: "2captcha", apiKey: "two-key-1234", keySource: "file", warnings: [] };
const capSolver: CaptchaSettings = { provider: "capsolver", apiKey: "CAP-key-1234", keySource: "file", warnings: [] };
const noSleep = async () => {};

describe("provider specs", () => {
  it("names hCaptcha as unsupported on CapSolver and supported on 2Captcha", () => {
    expect(PROVIDERS.capsolver.taskTypes("hcaptcha")).toEqual([]);
    expect(PROVIDERS["2captcha"].taskTypes("hcaptcha")).toEqual(["HCaptchaTaskProxyless"]);
    expect(supportedKinds("capsolver")).toEqual(["recaptcha_v2", "recaptcha_v3", "turnstile"]);
    expect(supportedKinds("2captcha")).toEqual(["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile"]);
  });

  it("builds a 2Captcha hCaptcha task with the invisible flag and enterprise rqdata only when given", () => {
    const spec = PROVIDERS["2captcha"];
    expect(spec.buildTask("HCaptchaTaskProxyless", "hcaptcha", "https://x/apply", "sk", {})).toEqual({
      type: "HCaptchaTaskProxyless",
      websiteURL: "https://x/apply",
      websiteKey: "sk",
    });
    expect(spec.buildTask("HCaptchaTaskProxyless", "hcaptcha", "https://x/apply", "sk", { invisible: true, rqdata: "rq" })).toEqual({
      type: "HCaptchaTaskProxyless",
      websiteURL: "https://x/apply",
      websiteKey: "sk",
      isInvisible: true,
      enterprisePayload: { rqdata: "rq" },
    });
  });

  it("builds a v3 task with a default pageAction on both providers", () => {
    expect(PROVIDERS.capsolver.buildTask("ReCaptchaV3TaskProxyLess", "recaptcha_v3", "u", "k", {})).toMatchObject({ pageAction: "submit" });
    expect(PROVIDERS["2captcha"].buildTask("RecaptchaV3TaskProxyless", "recaptcha_v3", "u", "k", { action: "login" })).toMatchObject({
      pageAction: "login",
      minScore: 0.3,
    });
  });
});

describe("solveCaptcha", () => {
  const req = { kind: "hcaptcha" as const, sitekey: "sk-1", page_url: "https://jobs.lever.co/acme/1/apply" };

  it("is disabled when the provider is off or the key is empty, without calling fetch", async () => {
    const { impl, calls } = scriptedFetch([]);
    const off: CaptchaSettings = { provider: "off", apiKey: "", keySource: "none", warnings: [] };
    const keyless: CaptchaSettings = { ...twoCaptcha, apiKey: "", keySource: "none" };
    for (const settings of [off, keyless]) {
      const res = await solveCaptcha(settings, req, { fetch: impl, sleep: noSleep });
      expect(res).toMatchObject({ ok: false, code: "disabled" });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a kind the provider cannot solve and names the alternative", async () => {
    const { impl, calls } = scriptedFetch([]);
    const res = await solveCaptcha(capSolver, req, { fetch: impl, sleep: noSleep });
    expect(res).toMatchObject({ ok: false, code: "unsupported_kind" });
    expect((res as { error: string }).error).toMatch(/CapSolver.*hcaptcha.*2Captcha/);
    expect(calls).toHaveLength(0);
  });

  it("creates a task, polls until ready, and returns the token with the provider's user agent", async () => {
    const { impl, calls } = scriptedFetch([
      () => ({ errorId: 0, taskId: 777 }),
      () => ({ errorId: 0, status: "processing" }),
      () => ({ errorId: 0, status: "ready", solution: { token: "tok-abc", userAgent: "UA/1" } }),
    ]);
    let t = 0;
    const res = await solveCaptcha(twoCaptcha, { ...req, extras: { invisible: true } }, { fetch: impl, sleep: noSleep, now: () => (t += 1000) });
    expect(res).toMatchObject({ ok: true, provider: "2captcha", task_type: "HCaptchaTaskProxyless", token: "tok-abc", user_agent: "UA/1" });
    expect(calls[0].url).toBe("https://api.2captcha.com/createTask");
    expect(calls[0].body).toEqual({
      clientKey: "two-key-1234",
      task: { type: "HCaptchaTaskProxyless", websiteURL: req.page_url, websiteKey: "sk-1", isInvisible: true },
    });
    expect(calls[1].url).toBe("https://api.2captcha.com/getTaskResult");
    expect(calls[1].body).toEqual({ clientKey: "two-key-1234", taskId: 777 });
    expect(calls).toHaveLength(3);
  });

  it("prefers gRecaptchaResponse over token when both are present", async () => {
    const { impl } = scriptedFetch([
      () => ({ errorId: 0, taskId: 1 }),
      () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "g-tok", token: "other" } }),
    ]);
    const res = await solveCaptcha(capSolver, { ...req, kind: "recaptcha_v2" }, { fetch: impl, sleep: noSleep });
    expect(res).toMatchObject({ ok: true, token: "g-tok", task_type: "ReCaptchaV2TaskProxyLess" });
  });

  it("falls through the task-type chain when the first type is refused", async () => {
    const { impl, calls } = scriptedFetch([
      () => ({ errorId: 1, errorCode: "ERROR_TASK_TYPE_NOT_SUPPORTED", errorDescription: "nope" }),
      () => ({ errorId: 0, taskId: 2 }),
      () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "g2" } }),
    ]);
    const res = await solveCaptcha(capSolver, { ...req, kind: "recaptcha_v2" }, { fetch: impl, sleep: noSleep });
    expect(res).toMatchObject({ ok: true, task_type: "ReCaptchaV2EnterpriseTaskProxyLess", token: "g2" });
    expect(calls[1].body.task.type).toBe("ReCaptchaV2EnterpriseTaskProxyLess");
  });

  it("reports a provider error with the code and description, and a failed status", async () => {
    const { impl } = scriptedFetch([
      () => ({ errorId: 0, taskId: 3 }),
      () => ({ errorId: 12, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "gave up" }),
    ]);
    const res = await solveCaptcha(twoCaptcha, req, { fetch: impl, sleep: noSleep });
    expect(res).toMatchObject({ ok: false, code: "provider_error" });
    expect((res as { error: string }).error).toContain("ERROR_CAPTCHA_UNSOLVABLE");

    const failed = scriptedFetch([() => ({ errorId: 0, taskId: 4 }), () => ({ errorId: 0, status: "failed" })]);
    expect(await solveCaptcha(twoCaptcha, req, { fetch: failed.impl, sleep: noSleep })).toMatchObject({ ok: false, code: "provider_error" });
  });

  it("times out on the injected clock without a real wait", async () => {
    const { impl } = scriptedFetch([
      () => ({ errorId: 0, taskId: 5 }),
      () => ({ errorId: 0, status: "processing" }),
      () => ({ errorId: 0, status: "processing" }),
    ]);
    let t = 0;
    const res = await solveCaptcha(twoCaptcha, req, { fetch: impl, sleep: noSleep, now: () => (t += 70_000), timeoutMs: 120_000 });
    expect(res).toMatchObject({ ok: false, code: "timeout" });
  });

  it("reports a thrown fetch as a network error", async () => {
    const { impl } = scriptedFetch([() => new Error("ECONNRESET")]);
    const res = await solveCaptcha(twoCaptcha, req, { fetch: impl, sleep: noSleep });
    expect(res).toMatchObject({ ok: false, code: "network" });
    expect((res as { error: string }).error).toContain("ECONNRESET");
  });

  it("stops the task-type chain when beforeTask returns false", async () => {
    const { impl, calls } = scriptedFetch([
      () => ({ errorId: 1, errorCode: "ERROR_TASK_TYPE_NOT_SUPPORTED", errorDescription: "nope" }),
      () => ({ errorId: 0, taskId: 9 }),
      () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "g2" } }),
    ]);
    let attempts = 0;
    const res = await solveCaptcha(
      capSolver,
      { ...req, kind: "recaptcha_v2" },
      {
        fetch: impl,
        sleep: noSleep,
        beforeTask: async () => {
          attempts += 1;
          return attempts === 1;
        },
        getBudgetError: () => "test budget cap",
      },
    );
    expect(res).toMatchObject({ ok: false, code: "budget_exhausted", error: "test budget cap" });
    expect(calls).toHaveLength(1);
  });

  it("calls onTaskCreated for each accepted provider task", async () => {
    const { impl } = scriptedFetch([
      () => ({ errorId: 1, errorCode: "ERROR_TASK_TYPE_NOT_SUPPORTED", errorDescription: "nope" }),
      () => ({ errorId: 0, taskId: 2 }),
      () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "g2" } }),
    ]);
    let created = 0;
    const res = await solveCaptcha(capSolver, { ...req, kind: "recaptcha_v2" }, {
      fetch: impl,
      sleep: noSleep,
      onTaskCreated: () => {
        created += 1;
      },
    });
    expect(res).toMatchObject({ ok: true });
    expect(created).toBe(1);
  });
});

describe("checkBalance", () => {
  it("posts the key to the provider's getBalance and returns the number", async () => {
    const { impl, calls } = scriptedFetch([() => ({ errorId: 0, balance: 4.25 })]);
    expect(await checkBalance("capsolver", "CAP-key", impl)).toEqual({ ok: true, balance: 4.25 });
    expect(calls[0].url).toBe("https://api.capsolver.com/getBalance");
    expect(calls[0].body).toEqual({ clientKey: "CAP-key" });
  });

  it("surfaces a provider error, a missing balance, and a network failure as ok:false", async () => {
    const bad = scriptedFetch([() => ({ errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST", errorDescription: "bad key" })]);
    expect(await checkBalance("2captcha", "x", bad.impl)).toMatchObject({ ok: false, error: expect.stringContaining("ERROR_KEY_DOES_NOT_EXIST") });
    const odd = scriptedFetch([() => ({ errorId: 0 })]);
    expect(await checkBalance("2captcha", "x", odd.impl)).toMatchObject({ ok: false });
    const down = scriptedFetch([() => new Error("ENOTFOUND")]);
    expect(await checkBalance("2captcha", "x", down.impl)).toMatchObject({ ok: false, error: expect.stringContaining("ENOTFOUND") });
  });
});
