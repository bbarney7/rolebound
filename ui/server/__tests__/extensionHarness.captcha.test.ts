import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCaptchaInjectFunction, CAPTCHA_INJECT_SRC } from "../../../.pi/extensions/lib/captcha";
import { MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION } from "../../../.pi/extensions/lib/submission-policy";
import { createExtensionHarnessWorkspace, createRecordingExtensionApi } from "./extensionHarness";

function scriptedFetch(handlers: Array<() => unknown>) {
  const impl = (async () => {
    const handler = handlers.shift();
    if (!handler) throw new Error("unexpected fetch");
    const out = handler();
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return impl;
}

async function loadJobApplier(ws: { root: string }) {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  return api;
}

describe("extension harness — captcha (T8)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.resetModules();
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(ws: { root: string }) {
    await fs.writeFile(
      path.join(ws.root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [],
        agent: null,
        scoring: null,
        captcha: { provider: "capsolver", api_key: "CAP-key-12345678", max_paid_tasks_per_day: 20 },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [{ slug: "acme-role", status: "in_progress" }], addresses: {} }),
      "utf8",
    );
    await fs.mkdir(path.join(ws.root, ".pi-jobs"), { recursive: true });
  }


  it.each(["./foo", "x/../foo"])("solve tool itself refuses unsafe slug %s without spending", async (slug) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadJobApplier(ws);
    const solve = api.tools.get("solve_captcha")!;
    const result = await solve("alias", { slug, kind: "recaptcha_v2", sitekey: "sk", page_url: "https://example.invalid" },
      undefined, undefined, { cwd: ws.root });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("STATE_INVALID");
  });
  it("persists captcha_paid_tasks across a module re-import", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);

    const fetch = scriptedFetch([
      () => ({ errorId: 0, taskId: 1 }),
      () => ({ errorId: 0, status: "ready", solution: { token: "tok-1" } }),
    ]);

    vi.stubGlobal(
      "fetch",
      scriptedFetch([
        () => ({ errorId: 0, taskId: 1 }),
        () => ({ errorId: 0, status: "processing" }),
        () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "tok-1" } }),
      ]),
    );

    const api1 = await loadJobApplier(ws);
    const solve = api1.tools.get("solve_captcha");
    expect(solve).toBeDefined();
    const first = await solve!(
      "x",
      {
        slug: "acme-role",
        kind: "recaptcha_v2",
        sitekey: "sk",
        page_url: "https://jobs.example/apply",
      },
      undefined,
      undefined,
      {
        ui: { confirm: async () => false },
      },
    );
    expect((first as { details: { ok: boolean } }).details.ok).toBe(true);

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      scriptedFetch([
        () => ({ errorId: 0, taskId: 2 }),
        () => ({ errorId: 0, status: "processing" }),
        () => ({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "tok-2" } }),
      ]),
    );
    const api2 = await loadJobApplier(ws);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].captcha_paid_tasks).toBe(1);

    const solve2 = api2.tools.get("solve_captcha")!;
    const out = await solve2("x", {
      slug: "acme-role",
      kind: "recaptcha_v2",
      sitekey: "sk",
      page_url: "https://jobs.example/apply",
    }, undefined, undefined, {
      ui: { confirm: async () => false },
    });
    const details = (out as { details: { ok: boolean } }).details;
    expect(details.ok).toBe(true);
    const state2 = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state2.applications[0].captcha_paid_tasks).toBe(2);
    vi.unstubAllGlobals();
  }, 15_000);

  it("fallback dialog is cancelled when Stop aborts the confirm signal", async () => {
    // boundary: B14 — manual CAPTCHA/OTP dialogs end on Stop.
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    await fs.writeFile(
      path.join(ws.root, "settings.json"),
      JSON.stringify({ schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: { provider: "off", api_key: "" } }),
      "utf8",
    );
    const api = await loadJobApplier(ws);
    const solve = api.tools.get("solve_captcha")!;
    const ac = new AbortController();
    ac.abort();
    const out = await solve(
      "x",
      { slug: "acme-role", kind: "hcaptcha", sitekey: "sk", page_url: "https://x" },
      ac.signal,
      undefined,
      {
        ui: {
          confirm: async (_t: string, _m: string, opts?: { signal?: AbortSignal }) => {
            if (opts?.signal?.aborted) return false;
            return true;
          },
        },
      },
    );
    const parsed = JSON.parse((out as { content: [{ text: string }] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("disabled");
    expect(parsed.manual_completed).toBe(false);
  });

  it("inject_function parses and fills g-recaptcha-response", () => {
    const token = 'tok"with\nquotes';
    const expr = buildCaptchaInjectFunction(token, "recaptcha_v2");
    const fn = new Function(`return ${expr}`)() as () => { ok: boolean };
    const el = { name: "g-recaptcha-response", value: "", innerHTML: "" };
    const doc = {
      querySelector: (sel: string) => {
        if (sel.includes("data-callback")) return null;
        if (sel.includes("g-recaptcha-response") || sel === ".g-recaptcha") return el;
        return null;
      },
      querySelectorAll: (sel: string) => (sel.includes("g-recaptcha-response") ? [el] : []),
      createElement: () => el,
      body: { appendChild: () => {} },
    };
    const g = globalThis as { document?: unknown; window?: unknown };
    g.document = doc;
    g.window = globalThis;
    fn();
    expect(el.value).toBe(token);
    expect(CAPTCHA_INJECT_SRC).toContain("g-recaptcha-response");
  });

  it("refunds per-application reservation when the daily cap refuses", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const now = Date.now();
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      at: now - i * 1000,
      slug: `other-${i}`,
      provider: "capsolver",
    }));
    await fs.writeFile(
      path.join(ws.root, ".pi-jobs", "captcha-spend.json"),
      JSON.stringify({ tasks }),
      "utf8",
    );

    const api = await loadJobApplier(ws);
    const solve = api.tools.get("solve_captcha")!;
    const out = await solve(
      "x",
      { slug: "acme-role", kind: "recaptcha_v2", sitekey: "sk", page_url: "https://x" },
      undefined,
      undefined,
      { ui: { confirm: async () => false } },
    );
    const parsed = JSON.parse((out as { content: [{ text: string }] }).content[0].text);
    expect(parsed.code).toBe("budget_exhausted");
    expect(parsed.error).toMatch(/Daily paid CAPTCHA/);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].captcha_paid_tasks ?? 0).toBe(0);
  });

  it("stops at per-application paid task cap", async () => {
    // boundary: B13 — per-application paid CAPTCHA task cap.
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug: "acme-role", status: "in_progress", captcha_paid_tasks: MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION }],
        addresses: {},
      }),
      "utf8",
    );
    const api = await loadJobApplier(ws);
    const solve = api.tools.get("solve_captcha")!;
    const out = await solve(
      "x",
      { slug: "acme-role", kind: "recaptcha_v2", sitekey: "sk", page_url: "https://x" },
      undefined,
      undefined,
      { ui: { confirm: async () => false } },
    );
    const parsed = JSON.parse((out as { content: [{ text: string }] }).content[0].text);
    expect(parsed.code).toBe("budget_exhausted");
    expect(parsed.error).toMatch(/Per-application/);
  });
});
