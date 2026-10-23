import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_SUBMIT_POLICY_VERSION } from "../../../.pi/extensions/lib/submission-policy";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
} from "./extensionHarness";

const SLUG = "gh-role";

function ackedState(overrides: Record<string, unknown> = {}) {
  return {
    acknowledged_at: "2026-01-01T00:00:00.000Z",
    acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
    applications: [],
    addresses: {},
    ...overrides,
  };
}

async function loadAdapters(ws: { root: string }) {
  process.env.PI_JOBS_ATS_ADAPTERS = "greenhouse";
  const mod = await import(path.join(ws.root, ".pi", "extensions", "ats-adapters.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  return api;
}

async function writeSidecar(ws: { root: string }, slug: string) {
  const scriptsDir = path.join(ws.root, ".pi-jobs", "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(
    path.join(scriptsDir, `${slug}.json`),
    JSON.stringify({ url: "https://boards.greenhouse.io/acme/jobs/123", board: "acme", jobId: "123" }),
    "utf8",
  );
}

async function writeStaleScripts(ws: { root: string }, slug: string) {
  const scriptsDir = path.join(ws.root, ".pi-jobs", "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, `${slug}-submit.js`), "// stale submit", "utf8");
  await fs.writeFile(path.join(scriptsDir, `${slug}-otp.js`), "// stale otp", "utf8");
}

describe("extension harness — greenhouse prepare (T7)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    delete process.env.PI_JOBS_ATS_ADAPTERS;
    for (const c of cleanups.splice(0)) await c();
  });

  async function prepCtx(ws: { root: string }) {
    await writeSidecar(ws, SLUG);
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${SLUG}.md`), "url: https://example.com\n", "utf8");
    const api = await loadAdapters(ws);
    const prepareSubmit = api.tools.get("greenhouse_prepare_submit")!;
    const prepareOtp = api.tools.get("greenhouse_prepare_otp")!;
    const ctx = { cwd: ws.root };
    return { prepareSubmit, prepareOtp, ctx };
  }

  for (const tool of ["submit", "otp"] as const) {
    it(`${tool}: refuses without versioned ack and deletes stale script`, async () => {
      const ws = await createExtensionHarnessWorkspace();
      cleanups.push(ws.cleanup);
      await writeStaleScripts(ws, SLUG);
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(ackedState({ acknowledged_policy: null })),
        "utf8",
      );
      const { prepareSubmit, prepareOtp, ctx } = await prepCtx(ws);
      const run = tool === "submit" ? prepareSubmit : prepareOtp;
      const out = await run(
        "t",
        tool === "submit" ? { slug: SLUG } : { slug: SLUG, code: "ABCD1234" },
        undefined,
        undefined,
        ctx,
      );
      expect(out.details?.ok).toBe(false);
      expect(String(out.content[0].text)).toMatch(/ACK_REQUIRED/);
      await expect(fs.stat(path.join(ws.root, ".pi-jobs", "scripts", `${SLUG}-${tool}.js`))).rejects.toThrow();
    });

    it(`${tool}: refuses when application already submitted and deletes stale script`, async () => {
      const ws = await createExtensionHarnessWorkspace();
      cleanups.push(ws.cleanup);
      await writeStaleScripts(ws, SLUG);
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(
          ackedState({
            applications: [{ slug: SLUG, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
          }),
        ),
        "utf8",
      );
      const { prepareSubmit, prepareOtp, ctx } = await prepCtx(ws);
      const run = tool === "submit" ? prepareSubmit : prepareOtp;
      const out = await run(
        "t",
        tool === "submit" ? { slug: SLUG } : { slug: SLUG, code: "ABCD1234" },
        undefined,
        undefined,
        ctx,
      );
      expect(out.details?.ok).toBe(false);
      expect(String(out.content[0].text)).toMatch(/ALREADY_SUBMITTED/);
      await expect(fs.stat(path.join(ws.root, ".pi-jobs", "scripts", `${SLUG}-${tool}.js`))).rejects.toThrow();
    });

    it(`${tool}: refuses when queue file removed and deletes stale script`, async () => {
      const ws = await createExtensionHarnessWorkspace();
      cleanups.push(ws.cleanup);
      await writeStaleScripts(ws, SLUG);
      await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
      await writeSidecar(ws, SLUG);
      const api = await loadAdapters(ws);
      const prepareSubmit = api.tools.get("greenhouse_prepare_submit")!;
      const prepareOtp = api.tools.get("greenhouse_prepare_otp")!;
      const ctx = { cwd: ws.root };
      const run = tool === "submit" ? prepareSubmit : prepareOtp;
      const out = await run(
        "t",
        tool === "submit" ? { slug: SLUG } : { slug: SLUG, code: "ABCD1234" },
        undefined,
        undefined,
        ctx,
      );
      expect(out.details?.ok).toBe(false);
      expect(String(out.content[0].text)).toMatch(/QUEUE_ITEM_REMOVED/);
      await expect(fs.stat(path.join(ws.root, ".pi-jobs", "scripts", `${SLUG}-${tool}.js`))).rejects.toThrow();
    });

    it(`${tool}: refuses under rate limit and deletes stale script`, async () => {
      const ws = await createExtensionHarnessWorkspace();
      cleanups.push(ws.cleanup);
      await writeStaleScripts(ws, SLUG);
      const recentSubmit = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(
          ackedState({
            applications: [
              { slug: "other", status: "submitted", submitted_at: recentSubmit },
              { slug: SLUG, status: "queued" },
            ],
          }),
        ),
        "utf8",
      );
      const { prepareSubmit, prepareOtp, ctx } = await prepCtx(ws);
      const run = tool === "submit" ? prepareSubmit : prepareOtp;
      const out = await run(
        "t",
        tool === "submit" ? { slug: SLUG } : { slug: SLUG, code: "ABCD1234" },
        undefined,
        undefined,
        ctx,
      );
      expect(out.details?.ok).toBe(false);
      expect(String(out.content[0].text)).toMatch(/RATE_LIMITED/);
      await expect(fs.stat(path.join(ws.root, ".pi-jobs", "scripts", `${SLUG}-${tool}.js`))).rejects.toThrow();
    });
  }

  it("prepare_submit allowed writes submit script", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    const { prepareSubmit, ctx } = await prepCtx(ws);
    const out = await prepareSubmit("t", { slug: SLUG }, undefined, undefined, ctx);
    expect(out.details?.ok).toBe(true);
    const scriptPath = path.join(ws.root, ".pi-jobs", "scripts", `${SLUG}-submit.js`);
    const st = await fs.stat(scriptPath);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBeGreaterThan(0);
  });
});
