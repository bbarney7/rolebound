import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readObservation } from "../../../.pi/extensions/lib/submission-policy";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
} from "./extensionHarness";

const AUTO_SUBMIT_POLICY_VERSION = "auto-submit-v1";

type RunEnv = {
  runId?: string;
  runDir?: string;
  kind?: string;
  applySlug?: string;
};

function setRunEnv(_ws: { root: string }, partial: RunEnv): string | undefined {
  for (const k of ["PI_JOBS_RUN_ID", "PI_JOBS_RUN_DIR", "PI_JOBS_RUN_KIND", "PI_JOBS_APPLY_SLUG"]) {
    delete process.env[k];
  }
  if (partial.runId) process.env.PI_JOBS_RUN_ID = partial.runId;
  if (partial.runDir) process.env.PI_JOBS_RUN_DIR = partial.runDir;
  if (partial.kind) process.env.PI_JOBS_RUN_KIND = partial.kind;
  if (partial.applySlug) process.env.PI_JOBS_APPLY_SLUG = partial.applySlug;
  return partial.runDir;
}

function clearRunEnv(): void {
  for (const k of ["PI_JOBS_RUN_ID", "PI_JOBS_RUN_DIR", "PI_JOBS_RUN_KIND", "PI_JOBS_APPLY_SLUG"]) {
    delete process.env[k];
  }
}

function ackedState(overrides: Record<string, unknown> = {}) {
  return {
    acknowledged_at: "2026-01-01T00:00:00.000Z",
    acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
    applications: [],
    addresses: {},
    ...overrides,
  };
}

async function loadGuard(ws: { root: string }) {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "submission-guard.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  return api;
}

function ctx(ws: { root: string }) {
  return { cwd: ws.root };
}

describe("extension harness — submission-guard", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    clearRunEnv();
    for (const c of cleanups.splice(0)) await c();
  });

  async function setupRunDir(ws: { root: string }, runId = "run-1") {
    const runDir = path.join(ws.root, ".pi-jobs", "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    setRunEnv(ws, { runId, runDir, kind: "apply", applySlug: "acme-role" });
    return runDir;
  }

  it("stop marker blocks mutating call and solve_captcha; read-only screenshot still allowed", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    const runDir = await setupRunDir(ws);
    await fs.writeFile(path.join(runDir, "stop.json"), JSON.stringify({ runId: "run-1" }), "utf8");
    await fs.mkdir(path.join(ws.root, "screenshots"), { recursive: true });
    const api = await loadGuard(ws);

    const click = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: { element: "Submit", ref: "e1" },
      },
      ctx(ws),
    );
    // boundary: B3
    expect(click).toMatchObject({ block: true, reason: /RUN_STOPPED/ });

    const captcha = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c2",
        toolName: "solve_captcha",
        input: { slug: "acme-role" },
      },
      ctx(ws),
    );
    // boundary: B3
    expect(captcha).toMatchObject({ block: true, reason: /RUN_STOPPED/ });

    const shot = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c3",
        toolName: "mcp__job_playwright__browser_take_screenshot",
        input: { filename: "screenshots/x.png" },
      },
      ctx(ws),
    );
    // boundary: B3
    expect(shot).toBeUndefined();
  });

  it("missing run dir with PI_JOBS_RUN_DIR set blocks mutating calls", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    const missing = path.join(ws.root, ".pi-jobs", "runs", "gone");
    setRunEnv(ws, { runId: "gone", runDir: missing, kind: "apply", applySlug: "acme-role" });
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B3
    expect(out).toMatchObject({ block: true, reason: /RUN_STOPPED/ });
  });

  it("no ack blocks apply-kind browser mutating call", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }),
      "utf8",
    );
    await setupRunDir(ws);
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B1
    expect(out).toMatchObject({ block: true, reason: /ACK_REQUIRED/ });
  });

  it("legacy ack without policy blocks solve_captcha", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        acknowledged_at: "2020-01-01T00:00:00.000Z",
        applications: [],
        addresses: {},
      }),
      "utf8",
    );
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "solve_captcha",
        input: { slug: "x" },
      },
      ctx(ws),
    );
    // boundary: B1
    expect(out).toMatchObject({ block: true, reason: /ACK_REQUIRED/ });
  });

  it("removed queue file blocks submit script", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "acme-role";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [{ slug, status: "in_progress" }],
        }),
      ),
      "utf8",
    );
    await setupRunDir(ws);
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    // boundary: B5
    expect(out).toMatchObject({ block: true, reason: /QUEUE_ITEM_REMOVED/ });
  });

  it("submitted app blocks submit script and click but allows screenshot", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "acme-role";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [{ slug, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        }),
      ),
      "utf8",
    );
    await fs.mkdir(path.join(ws.root, "screenshots"), { recursive: true });
    await setupRunDir(ws);
    const api = await loadGuard(ws);

    const script = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(script).toMatchObject({ block: true, reason: /ALREADY_SUBMITTED/ });

    const click = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B7
    expect(click).toMatchObject({ block: true, reason: /ALREADY_SUBMITTED/ });

    const shot = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "sh1",
        toolName: "mcp__job_playwright__browser_take_screenshot",
        input: { filename: "screenshots/ok.png" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(shot).toBeUndefined();
  });

  it("rate limit blocks a different slug inside 10 minutes", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    const submittedAt = new Date(now - 60_000).toISOString();
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [
            { slug: "first", status: "submitted", submitted_at: submittedAt },
            { slug: "second", status: "in_progress" },
          ],
        }),
      ),
      "utf8",
    );
    await fs.writeFile(path.join(ws.root, "jobs", "queue", "second.md"), "url: x\n", "utf8");
    await setupRunDir(ws);
    setRunEnv(ws, {
      runId: "run-1",
      runDir: path.join(ws.root, ".pi-jobs", "runs", "run-1"),
      kind: "apply",
      applySlug: "second",
    });
    const api = await loadGuard(ws);
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const blocked = await api.invokeToolCall(
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "mcp__job_playwright__browser_click",
          input: {},
        },
        ctx(ws),
      );
      // boundary: B8
      expect(blocked).toMatchObject({ block: true, reason: /RATE_LIMITED/ });

      Date.now = () => now + 600_000;
      const allowed = await api.invokeToolCall(
        {
          type: "tool_call",
          toolCallId: "c2",
          toolName: "mcp__job_playwright__browser_click",
          input: {},
        },
        ctx(ws),
      );
      // boundary: B8
      expect(allowed).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it("corrupt state.json blocks gated call", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), "{not json", "utf8");
    await setupRunDir(ws);
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B7
    expect(out).toMatchObject({ block: true, reason: /STATE_CORRUPT/ });
  });

  it("terminal context still enforces ack and slug rules for scripts", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    clearRunEnv();
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }),
      "utf8",
    );
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      },
      ctx(ws),
    );
    // boundary: B1
    expect(out).toMatchObject({ block: true, reason: /ACK_REQUIRED/ });
  });

  it("tool_result persists submitted observation; fresh import still sees it", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    const slug = "persist-me";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "submit-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    await api.invokeToolResult(
      {
        type: "tool_result",
        toolCallId: "submit-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: {},
        content: [{ type: "text", text: '### Result\n{"state":"submitted","detail":"ok"}' }],
        isError: false,
      },
      ctx(ws),
    );
    // boundary: B9
    const obs = await readObservation(ws.root, slug);
    expect(obs).toMatchObject({ status: "ok", value: { slug, state: "submitted" } });

    const mod2 = await import(
      path.join(ws.root, ".pi", "extensions", "submission-guard.ts") + `?t=${Date.now()}`
    );
    expect(mod2).toBeDefined();
    const obs2 = await readObservation(ws.root, slug);
    // boundary: B9
    expect(obs2).toMatchObject({ status: "ok", value: { slug, state: "submitted" } });
  });

  it("serializes submit scripts and maps only allowed results to the right slug", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    for (const slug of ["alpha", "beta", "gamma"]) {
      await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    }
    const call = (toolCallId: string, slug: string, parentToolCallId?: string) => api.invokeToolCall({
      type: "tool_call", toolCallId, parentToolCallId,
      toolName: "mcp__job_playwright__browser_run_code_unsafe",
      input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
    }, ctx(ws));
    const result = (toolCallId: string, state = "submitted", parentToolCallId?: string) => api.invokeToolResult({
      type: "tool_result", toolCallId, parentToolCallId,
      toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {}, isError: false,
      content: [{ type: "text", text: `### Result\n${JSON.stringify({ state })}` }],
    }, ctx(ws));
    expect(await call("a", "alpha")).toBeUndefined();
    expect(await call("b-blocked", "beta")).toMatchObject({ block: true, reason: /BROWSER_BUSY/ });
    await result("b-blocked");
    // boundary: B9
    expect(await readObservation(ws.root, "beta")).toEqual({ status: "missing" });
    expect(await call("still-blocked", "beta")).toMatchObject({ block: true, reason: /BROWSER_BUSY/ });
    await result("a");
    expect(await readObservation(ws.root, "alpha")).toMatchObject({ status: "ok", value: { slug: "alpha", state: "submitted" } });
    expect(await call("b", "beta")).toBeUndefined();
    await result("b");
    expect(await readObservation(ws.root, "beta")).toMatchObject({ status: "ok", value: { slug: "beta", state: "submitted" } });
    expect(await call("call_code/1", "gamma", "call_code")).toBeUndefined();
    await result("call_code/1", "otp_required", "call_code");
    expect(await readObservation(ws.root, "gamma")).toMatchObject({
      status: "ok", value: { slug: "gamma", state: "otp_required", source: "greenhouse_submit_script" },
    });
    expect(await result("unknown-id")).toBeUndefined();
  });

  it("write to .pi-jobs/observed is blocked", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: ".pi-jobs/observed/x.json", content: "{}" },
      },
      ctx(ws),
    );
    // boundary: B9
    expect(out).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it("after stop marker state tools allowed while click blocked", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    const runDir = await setupRunDir(ws);
    await fs.writeFile(path.join(runDir, "stop.json"), "{}", "utf8");
    const api = await loadGuard(ws);

    const update = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "u1",
        toolName: "update_application_state",
        input: { slug: "acme-role", status: "paused_for_user" },
      },
      ctx(ws),
    );
    // boundary: B3
    expect(update).toBeUndefined();

    const complete = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "u2",
        toolName: "complete_application",
        input: { slug: "acme-role" },
      },
      ctx(ws),
    );
    // boundary: B3
    expect(complete).toBeUndefined();

    const click = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B3
    expect(click).toMatchObject({ block: true, reason: /RUN_STOPPED/ });
  });

  it("after stop marker override_submitted is blocked", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [{ slug: "acme-role", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        }),
      ),
      "utf8",
    );
    const runDir = await setupRunDir(ws);
    await fs.writeFile(path.join(runDir, "stop.json"), "{}", "utf8");
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "o1",
        toolName: "update_application_state",
        input: { slug: "acme-role", status: "in_progress", override_submitted: true },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(out).toMatchObject({ block: true, reason: /RUN_STOPPED/ });
  });

  it("STATE_DIRECT_WRITE blocks state.json write in UI run and terminal", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    await setupRunDir(ws);
    const api = await loadGuard(ws);
    const ui = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "state.json", content: "{}" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(ui).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });

    clearRunEnv();
    const term = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w2",
        toolName: "edit",
        input: { path: "settings.json", oldText: "a", newText: "b" },
      },
      ctx(ws),
    );
    // boundary: B15
    expect(term).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it("blocks @state.json symlinked path and new file under symlinked directory", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);

    const at = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "@state.json", content: "{}" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(at).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });

    const link = path.join(ws.root, "link-state.json");
    await fs.symlink(path.join(ws.root, "state.json"), link);
    const sym = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w2",
        toolName: "write",
        input: { path: "link-state.json", content: "{}" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(sym).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });

    const jobsLink = path.join(ws.root, "jobs-link");
    await fs.symlink(path.join(ws.root, "jobs"), jobsLink);
    const nested = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w3",
        toolName: "write",
        input: { path: path.join("jobs-link", "queue", "new.md"), content: "x" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(nested).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it.skipIf(process.platform !== "darwin")("blocks STATE.JSON on darwin", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "STATE.JSON", content: "{}" },
      },
      ctx(ws),
    );
    // boundary: B7
    expect(out).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it("bash curl to loopback session API is blocked", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "curl http://127.0.0.1:4747/api/session" },
      },
      ctx(ws),
    );
    // boundary: B15
    expect(out).toMatchObject({ block: true, reason: /OFF_PIPELINE_BROWSER/ });
  });

  it("forged queue_file still yields QUEUE_ITEM_REMOVED", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const victim = "victim";
    const other = "other";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${other}.md`), "url: x\n", "utf8");
    await fs.writeFile(path.join(ws.root, "jobs", "applied", `${other}.md`), "url: y\n", "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [
            {
              slug: victim,
              status: "in_progress",
              queue_file: `jobs/applied/${other}.md`,
            },
          ],
        }),
      ),
      "utf8",
    );
    await setupRunDir(ws);
    setRunEnv(ws, {
      runId: "run-1",
      runDir: path.join(ws.root, ".pi-jobs", "runs", "run-1"),
      kind: "apply",
      applySlug: victim,
    });
    const api = await loadGuard(ws);
    const appliedForge = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${victim}-submit.js` },
      },
      ctx(ws),
    );
    // boundary: B5
    expect(appliedForge).toMatchObject({ block: true, reason: /QUEUE_ITEM_REMOVED/ });

    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [
            {
              slug: victim,
              status: "in_progress",
              queue_file: `jobs/queue/${other}.md`,
            },
          ],
        }),
      ),
      "utf8",
    );
    const queueForge = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s2",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${victim}-submit.js` },
      },
      ctx(ws),
    );
    // boundary: B5
    expect(queueForge).toMatchObject({ block: true, reason: /QUEUE_ITEM_REMOVED/ });
  });

  it("terminal session allows generic click without ack but blocks submit script and solve_captcha", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }),
      "utf8",
    );
    clearRunEnv();
    const api = await loadGuard(ws);

    const click = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B1
    expect(click).toBeUndefined();
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "c1", toolName: "mcp__job_playwright__browser_click",
      content: [], isError: false,
    }, ctx(ws));

    const script = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      },
      ctx(ws),
    );
    // boundary: B1
    expect(script).toMatchObject({ block: true, reason: /ACK_REQUIRED/ });

    const captcha = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "cap1",
        toolName: "solve_captcha",
        input: { slug: "x" },
      },
      ctx(ws),
    );
    // boundary: B5
    expect(captcha).toMatchObject({ block: true, reason: /ACK_REQUIRED/ });
  });

  it("gather-kind UI run allows browser click without ack", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }),
      "utf8",
    );
    const runDir = path.join(ws.root, ".pi-jobs", "runs", "gather-1");
    await fs.mkdir(runDir, { recursive: true });
    setRunEnv(ws, { runId: "gather-1", runDir, kind: "gather" });
    const api = await loadGuard(ws);
    const click = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "mcp__job_playwright__browser_click",
        input: {},
      },
      ctx(ws),
    );
    // boundary: B1
    expect(click).toBeUndefined();
  });

  it("blocks write under screenshots", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    await fs.mkdir(path.join(ws.root, "screenshots"), { recursive: true });
    clearRunEnv();
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write",
        input: { path: "screenshots/forged.png", content: "x" },
      },
      ctx(ws),
    );
    // boundary: B9
    expect(out).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it("matched but unparseable submit result appends a warning", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const slug = "warn-me";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    const api = await loadGuard(ws);
    await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "warn-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    const result = await api.invokeToolResult(
      {
        type: "tool_result",
        toolCallId: "warn-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: {},
        content: [{ type: "text", text: "clicked but no result json" }],
        isError: false,
      },
      ctx(ws),
    );
    // boundary: B9
    expect(result).toBeDefined();
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/warning: could not parse submit script result/);
  });

  it("blocks unresolvable browser screenshot filename with STATE_DIRECT_WRITE", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "shot-bad",
        toolName: "mcp__job_playwright__browser_take_screenshot",
        input: { filename: "file:///no%zz" },
      },
      ctx(ws),
    );
    expect(out).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it("blocks unresolvable generated script filename with UNSAFE_CODE", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const slug = "acme-role";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s-bad",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `file:///no%zz-${slug}-submit.js` },
      },
      ctx(ws),
    );
    expect(out).toMatchObject({ block: true, reason: /UNSAFE_CODE/ });
  });

  it("falls through to slug queue file when recorded queue path is missing", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "renamed-role";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        ackedState({
          applications: [
            {
              slug,
              status: "in_progress",
              queue_file: `jobs/queue/0-old-name.md`,
            },
          ],
        }),
      ),
      "utf8",
    );
    await setupRunDir(ws);
    setRunEnv(ws, {
      runId: "run-1",
      runDir: path.join(ws.root, ".pi-jobs", "runs", "run-1"),
      kind: "apply",
      applySlug: slug,
    });
    const api = await loadGuard(ws);
    const out = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "s1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    expect(out).toBeUndefined();
  });

  it("reports writeObservation failure in tool_result content", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()), "utf8");
    clearRunEnv();
    const slug = "obs-fail";
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: x\n", "utf8");
    const api = await loadGuard(ws);
    const allowed = await api.invokeToolCall(
      {
        type: "tool_call",
        toolCallId: "obs-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: { filename: `.pi-jobs/scripts/${slug}-submit.js` },
      },
      ctx(ws),
    );
    expect(allowed).toBeUndefined();
    await fs.mkdir(path.join(ws.root, ".pi-jobs"), { recursive: true });
    await fs.rm(path.join(ws.root, ".pi-jobs", "observed"), { recursive: true, force: true });
    await fs.writeFile(path.join(ws.root, ".pi-jobs", "observed"), "not-a-dir", "utf8");
    const result = await api.invokeToolResult(
      {
        type: "tool_result",
        toolCallId: "obs-1",
        toolName: "mcp__job_playwright__browser_run_code_unsafe",
        input: {},
        content: [{ type: "text", text: '### Result\n{"state":"submitted","detail":"ok"}' }],
        isError: false,
      },
      ctx(ws),
    );
    expect(result).toBeDefined();
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/failed to persist observation/);
  });
  it.each(["submitted", "otp_required"])("observes real MCP %s result with braces in echoed code", async (state) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()));
    await fs.writeFile(path.join(ws.root, "jobs/queue/acme-role.md"), "url: x\n");
    const api = await loadGuard(ws);
    const toolName = "mcp__job_playwright__browser_run_code_unsafe";
    const fixture = await fs.readFile(new URL("./fixtures/playwright-submit-result.txt", import.meta.url), "utf8");
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "real", toolName,
      input: { filename: ".pi-jobs/scripts/acme-role-submit.js" },
    }, ctx(ws))).toBeUndefined();
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "real", toolName, input: {}, isError: false,
      content: [{ type: "text", text: fixture.replace('{"state":"submitted"}', JSON.stringify({ state })) }],
    }, ctx(ws));
    // boundary: B9
    expect(await readObservation(ws.root, "acme-role")).toMatchObject({ status: "ok", value: { state } });
  });

  it("allows a requeued reopened application with an old applied queue_file", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({
      applications: [{ slug: "acme-role", status: "in_progress", queue_file: "jobs/applied/acme-role.md" }],
    })));
    await fs.writeFile(path.join(ws.root, "jobs/queue/acme-role.md"), "url: x\n");
    await setupRunDir(ws);
    const api = await loadGuard(ws);
    // boundary: B5
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "requeue", toolName: "browser_click", input: {},
    }, ctx(ws))).toBeUndefined();
  });

  it.each([".pi", "ui", "scripts", "node_modules"])("protects runtime directory %s even through an outward symlink", async (dir) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    const outside = path.join(ws.root, "notes");
    await fs.mkdir(outside);
    // Load the extension first, then replace its protected directory with a link.
    await fs.rm(path.join(ws.root, dir), { recursive: true, force: true });
    await fs.symlink(outside, path.join(ws.root, dir));
    const out = await api.invokeToolCall({
      type: "tool_call", toolCallId: "runtime-link", toolName: "write",
      input: { path: `${dir}/new.ts`, content: "disable guard" },
    }, ctx(ws));
    expect(out).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
    const uri = new URL(`file://${ws.root}/${dir}/new.ts`).href;
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "runtime-uri", toolName: "edit",
      input: { path: uri, oldText: "", newText: "disable guard" },
    }, ctx(ws))).toMatchObject({ block: true, reason: /STATE_DIRECT_WRITE/ });
  });

  it.each([
    ["http://127.0.0.1:4747/", false],
    ["http://localhost:4747/setup", false],
    ["http://[::ffff:7f00:1]:4747/", false],
    ["http://127.0.0.1:4747/", true],
    ["http://localhost:4747/setup", true],
    ["http://[::ffff:7f00:1]:4747/", true],
  ])("blocks dashboard actions after Page URL %s (UI run: %s)", async (url, uiRun) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()));
    await fs.writeFile(path.join(ws.root, "jobs/queue/acme-role.md"), "url: x\n");
    if (uiRun) await setupRunDir(ws);
    const api = await loadGuard(ws);
    const result = (text: string, toolName = "mcp__job_playwright__browser_navigate") => api.invokeToolResult({
      type: "tool_result", toolCallId: "redirect", toolName, input: {}, isError: false,
      content: [{ type: "text", text }],
    }, ctx(ws));
    const call = (tool: string, input = {}) => api.invokeToolCall({
      type: "tool_call", toolCallId: tool, toolName: `mcp__job_playwright__${tool}`, input,
    }, ctx(ws));
    await result(`### Page\n- Page URL: https://example.invalid/\n- Page URL: ${url}\n### Snapshot\n- Page URL: https://ignored.invalid/`);
    await result("### Snapshot\nNo Page URL");
    for (const [tool, input] of [
      ["browser_click", { element: "Acknowledge", ref: "e1" }],
      ["browser_type", { text: "ACKNOWLEDGE", ref: "e1" }],
      ["browser_evaluate", { function: "() => document.title" }],
      ["browser_run_code_unsafe", { filename: ".pi-jobs/scripts/acme-role-fill.js" }],
      ["browser_snapshot", {}], ["browser_resize", { width: 800, height: 600 }],
      ["browser_tabs", { action: "new" }],
    ] as const) {
      // boundary: B15
      expect(await call(tool, input)).toMatchObject({ block: true, reason: /OFF_PIPELINE_BROWSER.*the controlled browser is on the local Rolebound dashboard; navigate away; never operate the dashboard from the agent browser/ });
    }
    for (const [tool, input] of [
      ["browser_navigate", { url: "https://job-boards.greenhouse.io/fixture" }],
      ["browser_navigate_back", {}], ["browser_close", {}],
      ...["select", "close", "list"].map(action => ["browser_tabs", { action }] as const),
    ] as const) {
      expect(await call(tool, input)).toBeUndefined();
      await api.invokeToolResult({
        type: "tool_result", toolCallId: tool, toolName: `mcp__job_playwright__${tool}`,
        content: [], isError: false,
      }, ctx(ws));
    }
    await result("### Page\n- Page URL: https://job-boards.greenhouse.io/fixture");
    expect(await call("browser_click")).toBeUndefined();
    await result(`### Page\n- Page URL: ${url}`);
    await api.invokeSessionShutdown({}, ctx(ws));
    expect(await call("browser_click")).toBeUndefined();
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "browser_click", toolName: "browser_click", content: [], isError: false,
    }, ctx(ws));
    await result(`### Page\n- Page URL: ${url}`, "unrelated_tool");
    expect(await call("browser_click")).toBeUndefined();
  });

  it("allows portfolio localhost text in a browser form field", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "portfolio", toolName: "browser_type",
      input: { text: "http://localhost:3000", ref: "e1" },
    }, ctx(ws))).toBeUndefined();
  });

  it.each(["terminal", "gather"])("rejects case and prefix slug aliases in %s", async (kind) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({
      applications: [{ slug: "foo", status: "in_progress", captcha_paid_tasks: 2, queue_file: "jobs/queue/foo.md" }],
    })));
    await fs.writeFile(path.join(ws.root, "jobs/queue/foo.md"), "url: x\n");
    if (kind === "gather") {
      const runDir = await setupRunDir(ws);
      setRunEnv(ws, { runDir, kind });
    }
    const api = await loadGuard(ws);
    const call = (slug: string) => api.invokeToolCall({
      type: "tool_call", toolCallId: slug, toolName: "solve_captcha", input: { slug },
    }, ctx(ws));
    for (const slug of ["FOO", "01-foo", "02-foo"]) {
      // boundary: B13
      expect(await call(slug)).toMatchObject({ block: true, reason: /QUEUE_ITEM_REMOVED/ });
    }
    expect(await call("foo")).toMatchObject({ block: true, reason: /CAPTCHA_BUDGET/ });
    await fs.rename(path.join(ws.root, "jobs/queue/foo.md"), path.join(ws.root, "jobs/queue/01-foo.md"));
    expect(await call("foo")).toMatchObject({ block: true, reason: /CAPTCHA_BUDGET/ });
    expect(await call("02-foo")).toMatchObject({ block: true, reason: /QUEUE_ITEM_REMOVED/ });
  });

  it.each([false, true])("serializes browser calls and releases on tool_result (error: %s)", async (isError) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    const call = (toolCallId: string, toolName = "browser_snapshot", input = {}) => api.invokeToolCall({
      type: "tool_call", toolCallId, toolName, input,
    }, ctx(ws));
    expect(await call("first")).toBeUndefined();
    for (const [toolName, input] of [
      ["browser_click", {}],
      ["mcp__job_playwright__browser_evaluate", { function: "() => document.title" }],
      ["mcp__job_playwright__browser_run_code_unsafe", { filename: ".pi-jobs/scripts/acme-role-fill.js" }],
      ["mcp", { server: "job-playwright", tool: "browser_snapshot", args: "{}" }],
    ] as const) {
      // boundary: B15
      expect(await call("blocked", toolName, input)).toEqual({
        block: true,
        reason: "BROWSER_BUSY: another browser action is still running; retry this call after it completes",
        terminate: false,
      });
    }
    for (const toolName of ["read", "read_application_state", "update_application_state"]) {
      expect(await call(toolName, toolName)).toBeUndefined();
    }
    for (const [toolName, input, code] of [
      ["browser_snapshot", { filename: "state.json" }, "STATE_DIRECT_WRITE"],
      ["browser_run_code_unsafe", { code: "() => 1" }, "UNSAFE_CODE"],
      ["browser_navigate", { url: "http://127.0.0.1:4747/" }, "OFF_PIPELINE_BROWSER"],
    ] as const) expect(await call("forbidden", toolName, input)).toMatchObject({ block: true, reason: new RegExp(code) });
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "blocked", toolName: "browser_click", content: [], isError: true,
    }, ctx(ws));
    expect(await call("still-busy")).toMatchObject({ block: true, reason: /BROWSER_BUSY/ });
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "first", toolName: "browser_snapshot", content: [], isError,
    }, ctx(ws));
    expect(await call("next")).toBeUndefined();
  });

  it("serializes concurrently prepared codemode inner browser calls", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    const results = await Promise.all([1, 2].map(n => api.invokeToolCall({
      type: "tool_call", toolCallId: `codemode/${n}`, parentToolCallId: "codemode",
      toolName: "mcp__job_playwright__browser_snapshot", input: {},
    }, ctx(ws))));
    // boundary: B15
    expect(results.filter(result => result === undefined)).toHaveLength(1);
    expect(results.filter(result => result !== undefined)).toEqual([{
      block: true,
      reason: "BROWSER_BUSY: another browser action is still running; retry this call after it completes",
      terminate: false,
    }]);
  });

  it.each(["turn_end", "agent_end", "session_shutdown"])("releases an aborted browser call on %s", async (event) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    const call = (toolCallId: string) => api.invokeToolCall({
      type: "tool_call", toolCallId, toolName: "browser_snapshot", input: {},
    }, ctx(ws));
    expect(await call("first")).toBeUndefined();
    expect(await call("busy")).toMatchObject({ block: true, reason: /BROWSER_BUSY/, terminate: false });
    await api.invokeEvent(event, { type: event }, ctx(ws));
    expect(await call("next")).toBeUndefined();
  });

  it("blocks a same-batch evaluate before a dashboard redirect lands", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "navigate", toolName: "browser_navigate",
      input: { url: "https://example.invalid/redirect" },
    }, ctx(ws))).toBeUndefined();
    const evaluate = (toolCallId: string) => api.invokeToolCall({
      type: "tool_call", toolCallId, parentToolCallId: "codemode", toolName: "mcp__job_playwright__browser_evaluate",
      input: { function: "async () => { const s = await fetch('/api/session'); await fetch('/api/runs', { method: 'POST' }); }" },
    }, ctx(ws));
    // boundary: B15
    expect(await evaluate("codemode/1")).toMatchObject({ block: true, reason: /BROWSER_BUSY/, terminate: false });
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "navigate", toolName: "browser_navigate", isError: false,
      content: [{ type: "text", text: "### Page\n- Page URL: http://127.0.0.1:4747/" }],
    }, ctx(ws));
    expect(await evaluate("codemode/2")).toMatchObject({ block: true, reason: /OFF_PIPELINE_BROWSER/ });
  });

  it("uses the landing page when a navigation result arrives during gate preparation", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    expect(await api.invokeToolCall({
      type: "tool_call", toolCallId: "navigate", toolName: "browser_navigate",
      input: { url: "https://example.invalid/redirect" },
    }, ctx(ws))).toBeUndefined();
    const pending = api.invokeToolCall({
      type: "tool_call", toolCallId: "snapshot", toolName: "browser_snapshot", input: {},
    }, ctx(ws));
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "navigate", toolName: "browser_navigate", isError: false,
      content: [{ type: "text", text: "### Page\n- Page URL: http://127.0.0.1:4747/" }],
    }, ctx(ws));
    // boundary: B15
    expect(await pending).toMatchObject({ block: true, reason: /OFF_PIPELINE_BROWSER/ });
  });

  it("asks for the apply slug when a tool uses the prefixed queue filename", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState()));
    await fs.writeFile(path.join(ws.root, "jobs/queue/2024-summer.md"), "url: x\n");
    const runDir = await setupRunDir(ws);
    setRunEnv(ws, { runDir, kind: "apply", applySlug: "summer" });
    const api = await loadGuard(ws);
    const call = (slug: string) => api.invokeToolCall({
      type: "tool_call", toolCallId: slug, toolName: "greenhouse_prepare_submit", input: { slug },
    }, ctx(ws));
    // The guard and the tools must key state, CAPTCHA counts and scripts by one slug.
    expect(await call("2024-summer")).toEqual({
      block: true,
      reason: 'STATE_INVALID: "2024-summer" is the queue filename; use slug "summer" in tool calls and retry',
      terminate: false,
    });
    expect(await call("summer")).toBeUndefined();
    expect(await call("2025-summer")).toMatchObject({ block: true, reason: /STATE_INVALID/, terminate: true });
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({
      applications: [{ slug: "summer", status: "submitted" }],
    })));
    expect(await call("summer")).toMatchObject({ block: true, reason: /ALREADY_SUBMITTED/ });
  });

  it.each(["example.com", "example.com/jobs", "127.0.0.1:4747", "localhost:4747"])("normalizes scheme-less dashboard navigation to %s", async (url) => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const api = await loadGuard(ws);
    await api.invokeToolResult({
      type: "tool_result", toolCallId: "redirect", toolName: "browser_navigate", isError: false,
      content: [{ type: "text", text: "### Page\n- Page URL: http://127.0.0.1:4747/" }],
    }, ctx(ws));
    const result = await api.invokeToolCall({
      type: "tool_call", toolCallId: "escape", toolName: "browser_navigate", input: { url },
    }, ctx(ws));
    if (url.startsWith("example.com")) expect(result).toBeUndefined();
    else expect(result).toMatchObject({ block: true, reason: /OFF_PIPELINE_BROWSER/ });
  });

});

it("chat selecting an application passes the apply start gate, including the duplicate-URL check", async () => {
  const ws = await createExtensionHarnessWorkspace();
  try {
    const runDir = path.join(ws.root, ".pi-jobs/runs/chat"); await fs.mkdir(runDir, { recursive: true });
    setRunEnv(ws, { runId: "chat", runDir, kind: "chat" });
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({ applications: [
      { slug: "old", status: "submitted", url: "https://example.com/same" },
      { slug: "dup", status: "in_progress" },
    ] })));
    await fs.writeFile(path.join(ws.root, "jobs/queue/dup.md"), "url: https://example.com/same");
    const api = await loadGuard(ws);
    const click = () => api.invokeToolCall({ toolName: "mcp__job_playwright__browser_click", toolCallId: "click", input: {} }, ctx(ws));
    const result = await api.invokeToolResult({ toolName: "update_application_state", toolCallId: "state", input: { slug: "dup" }, content: [], isError: false }, ctx(ws));
    expect(JSON.stringify(result)).toContain("ALREADY_SUBMITTED");
    expect(await click()).toMatchObject({ block: true });
  } finally { clearRunEnv(); await ws.cleanup(); }
});

it("chat selects applications through successful state updates and preserves per-job gates", async () => {
  const ws = await createExtensionHarnessWorkspace();
  try {
    const runDir = path.join(ws.root, ".pi-jobs/runs/chat"); await fs.mkdir(runDir, { recursive: true });
    setRunEnv(ws, { runId: "chat", runDir, kind: "chat" });
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({ applications: [{ slug: "first", status: "in_progress" }] })));
    await fs.writeFile(path.join(ws.root, "jobs/queue/first.md"), "url: https://example.com/first");
    const api = await loadGuard(ws);
    const click = () => api.invokeToolCall({ toolName: "mcp__job_playwright__browser_click", toolCallId: "click", input: {} }, ctx(ws));
    expect(await click()).toMatchObject({ block: true, reason: expect.stringContaining("STATE_INVALID") });
    await api.invokeToolResult({ toolName: "update_application_state", toolCallId: "state", input: { slug: "first" }, content: [], isError: true }, ctx(ws));
    expect(await click()).toMatchObject({ block: true });
    await api.invokeToolResult({ toolName: "update_application_state", toolCallId: "state", input: { slug: "first" }, content: [], isError: false }, ctx(ws));
    expect(await click()).toBeUndefined();
    await api.invokeEvent("agent_end", {}, ctx(ws));
    await fs.unlink(path.join(ws.root, "jobs/queue/first.md"));
    expect(await click()).toMatchObject({ block: true, reason: expect.stringContaining("QUEUE_ITEM_REMOVED") });
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify(ackedState({ applications: [{ slug: "first", status: "submitted" }, { slug: "second", status: "in_progress" }] })));
    expect(await click()).toMatchObject({ block: true, reason: expect.stringContaining("ALREADY_SUBMITTED") });
    await fs.writeFile(path.join(ws.root, "jobs/queue/second.md"), "url: https://example.com/second");
    await api.invokeToolResult({ toolName: "update_application_state", toolCallId: "state2", input: { slug: "second" }, content: [] }, ctx(ws));
    expect(await click()).toBeUndefined();
    await api.invokeEvent("session_shutdown", {}, ctx(ws));
    expect(await click()).toMatchObject({ block: true, reason: expect.stringContaining("STATE_INVALID") });
  } finally { clearRunEnv(); await ws.cleanup(); }
});
