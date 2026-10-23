import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_SUBMIT_POLICY_VERSION,
  MIN_SUBMIT_INTERVAL_MS,
  MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION,
  evaluateApplyRunGate,
  classifyToolCall,
  defaultResolvePath,
  evaluateGate,
  latestRealSubmissionAt,
  readObservation,
  writeObservation,
  type ClassifyOptions,
  type GateContext,
} from "./submission-policy";
import { browserRunCodeCallLine } from "../ats-adapters";
import { parseStateText } from "./workspace-files";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "submission-policy-"));
  tmpRoots.push(root);
  await fs.mkdir(path.join(root, ".pi-jobs", "observed"), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function classifyOpts(root: string, cwd = root, platform: NodeJS.Platform = "linux"): ClassifyOptions {
  return {
    root,
    cwd,
    platform,
    home: "/home/tester",
    resolvePath: (p) => defaultResolvePath(p, { root, cwd, platform, home: "/home/tester" }),
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return parseStateText(
    JSON.stringify({
      acknowledged_at: "2026-01-01T00:00:00.000Z",
      acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
      applications: [],
      addresses: {},
      ...overrides,
    }),
  );
}

function gateCtx(partial: Partial<GateContext> & { root: string }): GateContext {
  const {
    root,
    state = { ok: true, value: baseState() },
    now = Date.parse("2026-06-01T12:00:00.000Z"),
    queueFileExists = () => true,
    observationForSlug = () => ({ status: "missing" }),
    runDir,
    ...rest
  } = partial;
  const platform = partial.platform ?? "linux";
  const cwd = partial.cwd ?? root;
  return {
    root,
    cwd,
    platform,
    runId: "run-1",
    runDir,
    kind: "apply",
    applySlug: "acme-role",
    stopMarkerExists: false,
    runDirExists: true,
    state,
    queueFileExists,
    observationForSlug,
    now,
    resolvePath: (p) => defaultResolvePath(p, { root, cwd, platform, home: "/home/tester" }),
    ...rest,
  };
}

describe("classifyToolCall", () => {
  it("classifies spike direct MCP names", () => {
    const o = classifyOpts("/ws");
    // boundary: B3
    expect(classifyToolCall("mcp__job_playwright__browser_snapshot", {}, o).kind).toBe("read_only");
    // boundary: B7
    expect(classifyToolCall("mcp__job_playwright__browser_click", { element: "x", ref: "e1" }, o).kind).toBe(
      "browser_mutating",
    );
    expect(classifyToolCall("mcp__job_playwright__browser_navigate", { url: "https://example.com" }, o).kind).toBe(
      "browser_navigation",
    );
  });

  it("ignores readOnlyHint for non-allowlisted tools", () => {
    const o = classifyOpts("/ws");
    // boundary: B7
    expect(
      classifyToolCall("mcp__job_playwright__browser_click", {}, o, { readOnlyHint: true, destructiveHint: false }).kind,
    ).toBe("browser_mutating");
  });

  it("fail-closed unknown job-playwright tools as browser_mutating", () => {
    const o = classifyOpts("/ws");
    // boundary: B3
    expect(classifyToolCall("mcp__job_playwright__browser_future_tool", {}, o).kind).toBe("browser_mutating");
  });

  it("classifies bare and adapter-prefixed browser names", () => {
    const o = classifyOpts("/ws");
    expect(classifyToolCall("browser_snapshot", {}, o).kind).toBe("read_only");
    expect(classifyToolCall("job_playwright_browser_click", {}, o).kind).toBe("browser_mutating");
  });

  it("classifies state tools and override", () => {
    const o = classifyOpts("/ws");
    // boundary: B1
    expect(classifyToolCall("read_application_state", {}, o).kind).toBe("state");
    expect(classifyToolCall("update_application_state", { slug: "x", status: "queued" }, o).kind).toBe("state");
    expect(
      classifyToolCall("update_application_state", { slug: "x", status: "queued", override_submitted: true }, o).kind,
    ).toBe("state_override");
    expect(classifyToolCall("solve_captcha", { slug: "x" }, o).kind).toBe("paid");
    expect(classifyToolCall("greenhouse_prepare_submit", { slug: "acme" }, o).slug).toBe("acme");
    expect(classifyToolCall("greenhouse_prepare_submit", { slug: "acme" }, o).kind).toBe("greenhouse_submit_prep");
  });

  it("unwraps mcp proxy form", () => {
    const o = classifyOpts("/ws");
    const proxy = {
      server: "job-playwright",
      tool: "browser_click",
      args: JSON.stringify({ element: "btn", ref: "e1" }),
    };
    // boundary: B7
    expect(classifyToolCall("mcp", proxy, o).kind).toBe("browser_mutating");
    const snap = {
      server: "job-playwright",
      tool: "browser_take_screenshot",
      args: JSON.stringify({ filename: "screenshots/x.png" }),
    };
    expect(classifyToolCall("mcp", snap, o).kind).toBe("read_only");
  });

  it("blocks unparseable mcp proxy args", () => {
    const o = classifyOpts("/ws");
    expect(
      classifyToolCall("mcp", { server: "job-playwright", tool: "browser_click", args: "not-json" }, o).kind,
    ).toBe("unsafe_code");
  });

  it("classifies submit scripts from generated filenames (direct)", () => {
    const o = classifyOpts("/ws");
    const filename = ".pi-jobs/scripts/acme-role-submit.js";
    const r = classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename }, o);
    // boundary: B7
    expect(r.kind).toBe("submit_script");
    expect(r.slug).toBe("acme-role");
  });

  it("classifies codemode-inner style names like direct MCP", () => {
    const o = classifyOpts("/ws");
    expect(
      classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", {
        filename: ".pi-jobs/scripts/foo-otp.js",
      }, o).kind,
    ).toBe("submit_script");
  });

  it("classifies fill script as browser_mutating with slug", () => {
    const o = classifyOpts("/ws");
    const r = classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", {
      filename: ".pi-jobs/scripts/acme-fill.js",
    }, o);
    expect(r.kind).toBe("browser_mutating");
    expect(r.slug).toBe("acme");
  });

  describe("browser_file_write", () => {
    const root = "/ws";
    const o = classifyOpts(root);

    it("blocks screenshot to queue path as state_direct_write", () => {
      // boundary: B5
      expect(
        classifyToolCall("mcp__job_playwright__browser_take_screenshot", { filename: "jobs/queue/x.md" }, o).kind,
      ).toBe("state_direct_write");
    });

    it("blocks snapshot to state.json as state_direct_write", () => {
      // boundary: B9
      expect(classifyToolCall("mcp__job_playwright__browser_snapshot", { filename: "state.json" }, o).kind).toBe(
        "state_direct_write",
      );
    });

    it("allows screenshot under screenshots/", () => {
      // boundary: B3
      expect(
        classifyToolCall("mcp__job_playwright__browser_take_screenshot", { filename: "screenshots/x.png" }, o).kind,
      ).toBe("read_only");
    });

    it("allows browser_file_upload and browser_drop without path check", () => {
      // boundary: B4
      expect(
        classifyToolCall("mcp__job_playwright__browser_file_upload", { paths: ["/tmp/resume.pdf"] }, o).kind,
      ).toBe("browser_mutating");
      expect(classifyToolCall("mcp__job_playwright__browser_drop", { paths: ["/tmp/resume.pdf"] }, o).kind).toBe(
        "browser_mutating",
      );
    });

    it("blocks unknown tool path argument outside allowed dirs", () => {
      // boundary: B15
      expect(classifyToolCall("mcp__job_playwright__browser_future_tool", { path: "jobs/queue/x.md" }, o).kind).toBe(
        "state_direct_write",
      );
    });

    it("allows browser_cookie_set URL path", () => {
      expect(classifyToolCall("mcp__job_playwright__browser_cookie_set", { path: "/" }, o).kind).toBe("browser_mutating");
    });

    it("checks proxy args JSON filename", () => {
      const proxy = {
        server: "job-playwright",
        tool: "browser_take_screenshot",
        args: JSON.stringify({ filename: "state.json" }),
      };
      // boundary: B9
      expect(classifyToolCall("mcp", proxy, o).kind).toBe("state_direct_write");
    });

    it("generated submit script passes file_write then unsafe_code", () => {
      const filename = ".pi-jobs/scripts/acme-submit.js";
      expect(classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename }, o).kind).toBe("submit_script");
    });
  });

  describe("unsafe_code", () => {
    const o = classifyOpts("/ws");

    it("blocks inline code in direct form", () => {
      // boundary: B15
      expect(classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { code: "1+1" }, o).kind).toBe(
        "unsafe_code",
      );
    });

    it("blocks filename under screenshots", () => {
      expect(
        classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename: "screenshots/x.js" }, o).kind,
      ).toBe("unsafe_code");
    });

    it("allows generated scripts in all three call forms", () => {
      const filename = ".pi-jobs/scripts/acme-submit.js";
      expect(classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename }, o).kind).toBe("submit_script");
      const proxy = {
        server: "job-playwright",
        tool: "browser_run_code_unsafe",
        args: JSON.stringify({ filename: ".pi-jobs/scripts/acme-otp.js" }),
      };
      expect(classifyToolCall("mcp", proxy, o).kind).toBe("submit_script");
      expect(
        classifyToolCall("browser_run_code_unsafe", { filename: ".pi-jobs/scripts/acme-fill.js" }, o).kind,
      ).toBe("browser_mutating");
    });
  });

  it("classifies write/edit to protected paths as state_direct_write", () => {
    const root = "/ws";
    const o = classifyOpts(root);
    // boundary: B1
    expect(classifyToolCall("write", { path: "state.json", content: "{}" }, o).kind).toBe("state_direct_write");
    expect(classifyToolCall("edit", { path: ".pi-jobs/observed/x.json", old: "a", new: "b" }, o).kind).toBe(
      "state_direct_write",
    );
  });

  it("darwin case-insensitive protected path on write", () => {
    const root = "/ws";
    const o = classifyOpts(root, root, "darwin");
    // boundary: B7
    expect(classifyToolCall("write", { path: "STATE.JSON", content: "{}" }, o).kind).toBe("state_direct_write");
  });

  it("linux case-sensitive allows STATE.JSON as other when not under protected name", () => {
    const root = "/ws";
    const o = classifyOpts(root, root, "linux");
    expect(classifyToolCall("write", { path: "STATE.JSON", content: "{}" }, o).kind).toBe("other");
  });
});

describe("evaluateGate", () => {
  it("blocks STATE_DIRECT_WRITE before other codes", () => {
    const root = "/ws";
    const call = classifyToolCall("write", { path: "state.json", content: "{}" }, classifyOpts(root));
    const ctx = gateCtx({
      root,
      runDir: "/ws/.pi-jobs/runs/r1",
      stopMarkerExists: false,
    });
    const r = evaluateGate({ ...call, toolName: "write", input: {} }, ctx);
    // boundary: B1
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.code).toBe("STATE_DIRECT_WRITE");
      expect(r.reason).toContain("STATE_DIRECT_WRITE");
      expect(r.reason).toContain("stop; do not retry through another tool");
    }
  });

  it("blocks UNSAFE_CODE for inline browser code", () => {
    const root = "/ws";
    const call = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { code: "evil()" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {} },
      gateCtx({ root }),
    );
    // boundary: B15
    expect(r).toMatchObject({ allow: false, code: "UNSAFE_CODE" });
  });

  it("blocks OFF_PIPELINE bash patterns", () => {
    const root = "/ws";
    const call = classifyToolCall("bash", { command: "curl http://127.0.0.1:4747/api/session" }, classifyOpts(root));
    const r = evaluateGate({ ...call, toolName: "bash", input: { command: "curl http://127.0.0.1:4747/api/session" } }, gateCtx({ root }));
    // boundary: B15
    expect(r).toMatchObject({ allow: false, code: "OFF_PIPELINE_BROWSER" });
  });

  it("RUN_STOPPED blocks mutating browser after stop marker", () => {
    const root = "/ws";
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, runDir: "/ws/.pi-jobs/runs/r1", stopMarkerExists: true }),
    );
    // boundary: B3
    expect(r).toMatchObject({ allow: false, code: "RUN_STOPPED" });
  });

  it("RUN_STOPPED still allows read-only screenshot to screenshots", () => {
    const root = "/ws";
    const call = classifyToolCall(
      "mcp__job_playwright__browser_take_screenshot",
      { filename: "screenshots/x.png" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_take_screenshot", input: {} },
      gateCtx({ root, runDir: "/ws/.pi-jobs/runs/r1", stopMarkerExists: true }),
    );
    // boundary: B3
    expect(r).toEqual({ allow: true });
  });

  it("RUN_STOPPED allows state tools", () => {
    const root = "/ws";
    const call = classifyToolCall("update_application_state", { slug: "x", status: "submitted" }, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "update_application_state", input: {} },
      gateCtx({ root, runDir: "/ws/.pi-jobs/runs/r1", stopMarkerExists: true }),
    );
    // boundary: B3
    expect(r).toEqual({ allow: true });
  });

  it("RUN_STOPPED blocks state_override after stop", () => {
    const root = "/ws";
    const call = classifyToolCall(
      "update_application_state",
      { slug: "x", status: "queued", override_submitted: true },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "update_application_state", input: {} },
      gateCtx({ root, runDir: "/ws/.pi-jobs/runs/r1", stopMarkerExists: true }),
    );
    // boundary: B7
    expect(r).toMatchObject({ allow: false, code: "RUN_STOPPED" });
  });

  it("STATE_CORRUPT blocks gated calls", () => {
    const root = "/ws";
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, state: { ok: false, corrupt: true } }),
    );
    // boundary: B7
    expect(r).toMatchObject({ allow: false, code: "STATE_CORRUPT" });
  });

  it("ACK_REQUIRED for apply UI without versioned ack", () => {
    const root = "/ws";
    const state = baseState({ acknowledged_policy: null });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, runDir: "/ws/r", kind: "apply", state: { ok: true, value: state } }),
    );
    // boundary: B1
    expect(r).toMatchObject({ allow: false, code: "ACK_REQUIRED" });
  });

  it("legacy ack without policy field requires re-ack", () => {
    const root = "/ws";
    const state = baseState({ acknowledged_policy: undefined });
    const call = classifyToolCall("solve_captcha", { slug: "x" }, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "solve_captcha", input: {} },
      gateCtx({ root, state: { ok: true, value: state } }),
    );
    // boundary: B1
    expect(r).toMatchObject({ allow: false, code: "ACK_REQUIRED" });
  });

  it("terminal generic click without slug allowed without ack", () => {
    const root = "/ws";
    const state = baseState({ acknowledged_at: null, acknowledged_policy: null });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, runDir: undefined, kind: undefined, applySlug: undefined, state: { ok: true, value: state } }),
    );
    // boundary: B1
    expect(r).toEqual({ allow: true });
  });

  it("ALREADY_SUBMITTED blocks click but allows navigation", () => {
    const root = "/ws";
    const state = baseState({
      applications: [{ slug: "acme-role", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
    });
    const click = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const nav = classifyToolCall("mcp__job_playwright__browser_navigate", { url: "https://mail.example" }, classifyOpts(root));
    const ctx = gateCtx({ root, applySlug: "acme-role", state: { ok: true, value: state } });
    // boundary: B7
    expect(evaluateGate({ ...click, toolName: "mcp__job_playwright__browser_click", input: {} }, ctx)).toMatchObject({
      allow: false,
      code: "ALREADY_SUBMITTED",
    });
    expect(evaluateGate({ ...nav, toolName: "mcp__job_playwright__browser_navigate", input: {} }, ctx)).toEqual({
      allow: true,
    });
  });

  it("SUBMIT_OBSERVED_UNRECORDED when observation is newer than reopened_at", () => {
    const root = "/ws";
    const state = baseState({
      applications: [
        {
          slug: "acme-role",
          status: "in_progress",
          reopened_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({
        root,
        applySlug: "acme-role",
        state: { ok: true, value: state },
        observationForSlug: () => ({
          status: "ok",
          value: {
            slug: "acme-role",
            state: "submitted",
            source: "greenhouse_submit_script",
            at: "2026-06-01T00:00:00.000Z",
            runId: "r1",
          },
        }),
      }),
    );
    // boundary: B9
    expect(r).toMatchObject({ allow: false, code: "SUBMIT_OBSERVED_UNRECORDED" });
  });

  it("ignores observation older than reopened_at", () => {
    const root = "/ws";
    const state = baseState({
      applications: [
        {
          slug: "acme-role",
          status: "in_progress",
          reopened_at: "2026-06-02T00:00:00.000Z",
        },
      ],
    });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({
        root,
        applySlug: "acme-role",
        state: { ok: true, value: state },
        observationForSlug: () => ({
          status: "ok",
          value: {
            slug: "acme-role",
            state: "submitted",
            source: "greenhouse_submit_script",
            at: "2026-06-01T00:00:00.000Z",
            runId: "r1",
          },
        }),
      }),
    );
    // boundary: B7
    expect(r).toEqual({ allow: true });
  });

  it("QUEUE_ITEM_REMOVED when queue file missing and not submitted", () => {
    const root = "/ws";
    const call = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {} },
      gateCtx({
        root,
        applySlug: "acme-role",
        queueFileExists: (s) => s !== "acme-role",
      }),
    );
    // boundary: B5
    expect(r).toMatchObject({ allow: false, code: "QUEUE_ITEM_REMOVED" });
  });

  it("RATE_LIMITED inside ten-minute window", () => {
    const root = "/ws";
    const now = Date.parse("2026-06-01T12:05:00.000Z");
    const state = baseState({
      applications: [
        { slug: "other", status: "submitted", submitted_at: "2026-06-01T12:00:00.000Z" },
        { slug: "acme-role", status: "queued" },
      ],
    });
    const call = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {} },
      gateCtx({ root, applySlug: "acme-role", now, state: { ok: true, value: state } }),
    );
    // boundary: B8
    expect(r).toMatchObject({ allow: false, code: "RATE_LIMITED" });
  });

  it("allows rate limit at exactly ten minutes", () => {
    const root = "/ws";
    const submittedAt = "2026-06-01T12:00:00.000Z";
    const now = Date.parse(submittedAt) + MIN_SUBMIT_INTERVAL_MS;
    const state = baseState({
      applications: [{ slug: "other", status: "submitted", submitted_at: submittedAt }],
    });
    const call = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {} },
      gateCtx({ root, applySlug: "acme-role", now, state: { ok: true, value: state } }),
    );
    // boundary: B8
    expect(r).toEqual({ allow: true });
  });

  it("STATE_INVALID when submitted_at is more than 60s in the future", () => {
    const root = "/ws";
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    const state = baseState({
      applications: [{ slug: "acme-role", status: "queued", submitted_at: "2026-06-01T12:02:00.000Z" }],
    });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, applySlug: "acme-role", now, state: { ok: true, value: state } }),
    );
    // boundary: B8
    expect(r).toMatchObject({ allow: false, code: "STATE_INVALID" });
  });

  it("CAPTCHA_BUDGET when paid tasks exhausted", () => {
    const root = "/ws";
    const state = baseState({
      applications: [{ slug: "acme-role", status: "in_progress", captcha_paid_tasks: MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION }],
    });
    const call = classifyToolCall("solve_captcha", { slug: "acme-role" }, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "solve_captcha", input: {} },
      gateCtx({ root, applySlug: "acme-role", state: { ok: true, value: state } }),
    );
    // boundary: B13
    expect(r).toMatchObject({ allow: false, code: "CAPTCHA_BUDGET" });
  });

  it("corrupt observation fails closed as SUBMIT_OBSERVED_UNRECORDED", () => {
    const root = "/ws";
    const state = baseState({ applications: [{ slug: "acme-role", status: "in_progress" }] });
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({
        root,
        applySlug: "acme-role",
        state: { ok: true, value: state },
        observationForSlug: () => ({ status: "corrupt" }),
      }),
    );
    // boundary: B9
    expect(r).toMatchObject({ allow: false, code: "SUBMIT_OBSERVED_UNRECORDED" });
  });
});

describe("latestRealSubmissionAt", () => {
  it("ignores demo entries", () => {
    const state = baseState({
      applications: [{ slug: "demo", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z", demo: "true" }],
    });
    // boundary: B16
    expect(latestRealSubmissionAt(state, null)).toBeNull();
  });

  it("skips except slug submitted_at only while status is submitted", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const state = baseState({
      applications: [{ slug: "acme", status: "submitted", submitted_at: t }],
    });
    // boundary: B8
    expect(latestRealSubmissionAt(state, "acme")).toBeNull();
    const reopened = baseState({
      applications: [{ slug: "acme", status: "in_progress", submitted_at: t, reopened_from_submitted_at: t }],
    });
    expect(latestRealSubmissionAt(reopened, "acme")).toBe(Date.parse(t));
  });

  it("always counts reopened_from_submitted_at for judged slug", () => {
    const orig = "2026-06-01T12:00:00.000Z";
    const state = baseState({
      applications: [
        {
          slug: "acme",
          status: "in_progress",
          reopened_from_submitted_at: orig,
          reopened_at: "2026-06-01T12:01:00.000Z",
        },
      ],
    });
    const now = Date.parse("2026-06-01T12:05:00.000Z");
    // boundary: B8
    expect(latestRealSubmissionAt(state, "acme")).toBe(Date.parse(orig));
    expect(now - (latestRealSubmissionAt(state, "acme") ?? 0)).toBeLessThan(MIN_SUBMIT_INTERVAL_MS);
  });
});

describe("observations", () => {
  it("writes and reads observation with safe slug", async () => {
    const root = await tempRoot();
    const obs = {
      slug: "acme-role",
      state: "submitted",
      source: "greenhouse_submit_script",
      at: "2026-06-01T00:00:00.000Z",
      runId: "run-1",
    };
    await writeObservation(root, obs);
    const read = await readObservation(root, "acme-role");
    // boundary: B9
    expect(read).toEqual({ status: "ok", value: obs });
  });

  it("corrupt observation reads as corrupt", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, ".pi-jobs", "observed", "acme.json"), "not json", "utf8");
    const read = await readObservation(root, "acme");
    // boundary: B9
    expect(read).toEqual({ status: "corrupt" });
  });

  it("rejects unsafe slug on write", async () => {
    const root = await tempRoot();
    await expect(
      writeObservation(root, {
        slug: "../evil",
        state: "submitted",
        source: "page",
        at: "2026-01-01T00:00:00.000Z",
        runId: "r",
      }),
    ).rejects.toThrow();
  });
});

describe("constants", () => {
  it("exports policy version and captcha alias", () => {
    expect(AUTO_SUBMIT_POLICY_VERSION).toBe("auto-submit-v1");
    expect(MIN_SUBMIT_INTERVAL_MS).toBe(600_000);
    expect(MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION).toBe(2);
  });
});

describe("PJR-15 T2 review: parseGeneratedScript paths (F-A)", () => {
  function extractFilenameFromCallLine(callLine: string): string {
    const match = /\{ filename: (.+) \}\s*\)$/.exec(callLine);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]) as string;
  }

  it("accepts an absolute path under the workspace scripts dir", async () => {
    const root = await tempRoot();
    const abs = path.join(root, ".pi-jobs", "scripts", "acme-role-submit.js");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const o = classifyOpts(root);
    const r = classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename: abs }, o);
    expect(r).toMatchObject({ kind: "submit_script", slug: "acme-role" });
  });

  it("accepts a relative generated script path", () => {
    const root = "/ws";
    const o = classifyOpts(root);
    const r = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { filename: ".pi-jobs/scripts/acme-role-fill.js" },
      o,
    );
    expect(r).toMatchObject({ kind: "browser_mutating", slug: "acme-role" });
  });

  it("rejects the same basename outside the scripts directory", async () => {
    const root = await tempRoot();
    const o = classifyOpts(root);
    const inScreenshots = path.join(root, "screenshots", "x-submit.js");
    await fs.mkdir(path.dirname(inScreenshots), { recursive: true });
    expect(
      classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename: inScreenshots }, o).kind,
    ).toBe("unsafe_code");
    const outsideRoot = path.join(os.tmpdir(), ".pi-jobs", "scripts", "x-submit.js");
    expect(
      classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename: outsideRoot }, o).kind,
    ).toBe("unsafe_code");
  });

  it("rejects traversal that escapes the scripts directory", () => {
    const root = "/ws";
    const o = classifyOpts(root);
    expect(
      classifyToolCall(
        "mcp__job_playwright__browser_run_code_unsafe",
        { filename: ".pi-jobs/scripts/../../state-submit.js" },
        o,
      ).kind,
    ).toBe("unsafe_code");
  });

  it("classifies browserRunCodeCallLine absolute path as submit_script", async () => {
    const root = await tempRoot();
    const abs = path.join(root, ".pi-jobs", "scripts", "acme-role-submit.js");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const callLine = browserRunCodeCallLine(abs);
    const filename = extractFilenameFromCallLine(callLine);
    const o = classifyOpts(root);
    expect(classifyToolCall("mcp__job_playwright__browser_run_code_unsafe", { filename }, o).kind).toBe(
      "submit_script",
    );
  });
});

describe("PJR-15 T2 review: darwin directory case (F-B)", () => {
  it("treats mixed-case workspace dirs as protected on darwin only", async () => {
    const root = await tempRoot();
    const darwin = classifyOpts(root, root, "darwin");
    const linux = classifyOpts(root, root, "linux");
    expect(classifyToolCall("write", { path: ".PI-JOBS/x", content: "" }, darwin).kind).toBe("state_direct_write");
    expect(classifyToolCall("write", { path: ".PI-JOBS/x", content: "" }, linux).kind).toBe("other");
    expect(classifyToolCall("write", { path: "Jobs/queue/x.md", content: "" }, darwin).kind).toBe(
      "state_direct_write",
    );
    expect(classifyToolCall("write", { path: "Jobs/queue/x.md", content: "" }, linux).kind).toBe("other");
    expect(classifyToolCall("write", { path: "SCREENSHOTS/x.png", content: "" }, darwin).kind).toBe(
      "state_direct_write",
    );
    expect(classifyToolCall("write", { path: "SCREENSHOTS/x.png", content: "" }, linux).kind).toBe("other");
  });

  it("allows browser output under mixed-case screenshots on darwin", () => {
    const root = "/ws";
    const darwin = classifyOpts(root, root, "darwin");
    const linux = classifyOpts(root, root, "linux");
    expect(
      classifyToolCall("mcp__job_playwright__browser_take_screenshot", { filename: "SCREENSHOTS/x.png" }, darwin).kind,
    ).toBe("read_only");
    expect(
      classifyToolCall("mcp__job_playwright__browser_take_screenshot", { filename: "SCREENSHOTS/x.png" }, linux).kind,
    ).toBe("state_direct_write");
  });
});

describe("PJR-15 T2 review: future timestamps on other apps (F-C)", () => {
  it("returns STATE_INVALID naming the other slug when its submitted_at is in the future", () => {
    const root = "/ws";
    const now = Date.parse("2026-06-01T12:00:00.000Z");
    const state = baseState({
      applications: [
        { slug: "other", status: "submitted", submitted_at: "2026-06-01T12:05:00.000Z" },
        { slug: "acme-role", status: "queued" },
      ],
    });
    const call = classifyToolCall(
      "mcp__job_playwright__browser_run_code_unsafe",
      { filename: ".pi-jobs/scripts/acme-role-submit.js" },
      classifyOpts(root),
    );
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_run_code_unsafe", input: {} },
      gateCtx({ root, applySlug: "acme-role", now, state: { ok: true, value: state } }),
    );
    expect(r).toMatchObject({ allow: false, code: "STATE_INVALID" });
    if (!r.allow) expect(r.reason).toContain("other");
  });
});

describe("PJR-15 T2 review: cookie tools URL path (F-D)", () => {
  it("allows browser_cookie_delete and browser_cookie_list with path /", () => {
    const o = classifyOpts("/ws");
    expect(classifyToolCall("mcp__job_playwright__browser_cookie_delete", { path: "/" }, o).kind).toBe(
      "browser_mutating",
    );
    expect(classifyToolCall("mcp__job_playwright__browser_cookie_list", { path: "/" }, o).kind).toBe(
      "browser_mutating",
    );
  });
});

describe("PJR-15 T2 review: root-only protected basenames (F-E)", () => {
  it("allows nested settings.json and protects only workspace root copies", () => {
    const root = "/ws";
    const linux = classifyOpts(root, root, "linux");
    expect(classifyToolCall("write", { path: "notes/x/settings.json", content: "" }, linux).kind).toBe("other");
    const darwin = classifyOpts(root, root, "darwin");
    expect(classifyToolCall("write", { path: "SETTINGS.json", content: "" }, darwin).kind).toBe("state_direct_write");
  });
});

describe("PJR-15 T2 review: corrupt state scope (F-F)", () => {
  it("allows terminal click without slug when state is corrupt", () => {
    const root = "/ws";
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({
        root,
        runDir: undefined,
        kind: undefined,
        applySlug: undefined,
        state: { ok: false, corrupt: true },
      }),
    );
    expect(r).toEqual({ allow: true });
  });

  it("blocks apply UI browser click when state is corrupt", () => {
    const root = "/ws";
    const call = classifyToolCall("mcp__job_playwright__browser_click", {}, classifyOpts(root));
    const r = evaluateGate(
      { ...call, toolName: "mcp__job_playwright__browser_click", input: {} },
      gateCtx({ root, runDir: "/ws/.pi-jobs/runs/r1", kind: "apply", state: { ok: false, corrupt: true } }),
    );
    expect(r).toMatchObject({ allow: false, code: "STATE_CORRUPT" });
  });
});

describe("whole-branch review boundaries", () => {
  const hosts = ["localhost", "LOCALHOST.", "app.localhost", "app.localhost.", "127.0.0.1", "127.42.0.99",
    "127.255.255.255", "[::1]", "0.0.0.0", "[::]", "2130706433", "0x7f000001", "127.1", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]"];
  it.each(hosts)("blocks local host %s through every MCP shape and context", (host) => {
    for (const protocol of ["http", "https"]) {
      const args = { url: `${protocol}://${host}:4915/api/session`, action: "new" };
      for (const tool of ["browser_navigate", "browser_tabs"]) {
        for (const [toolName, input] of [
          [tool, args], [`mcp__job_playwright__${tool}`, args],
          ["mcp", { server: "job-playwright", tool, args: JSON.stringify(args) }],
        ] as const) {
          const call = { ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input };
          for (const context of [{}, { runDir: "/ws/run" }, { runDir: "/ws/run", kind: "gather", stopMarkerExists: true }]) {
            // boundary: B15
            expect(evaluateGate(call, gateCtx({ root: "/ws", ...context }))).toMatchObject({ allow: false, code: "OFF_PIPELINE_BROWSER" });
          }
        }
      }
    }
  });
  it("blocks local fetch in evaluate but allows ordinary internet navigation", () => {
    const toolName = "browser_evaluate";
    const input = { function: '() => fetch("http://127.0.0.1:4747/api/session")' };
    expect(evaluateGate({ ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input },
      gateCtx({ root: "/ws" }))).toMatchObject({ allow: false, code: "OFF_PIPELINE_BROWSER" });
    const nav = { url: "https://boards.greenhouse.io/example" };
    expect(evaluateGate({ ...classifyToolCall("browser_navigate", nav, classifyOpts("/ws")), toolName: "browser_navigate", input: nav },
      gateCtx({ root: "/ws" }))).toEqual({ allow: true });
  });
  it.each(["./foo", "x/../foo", "../foo", ""])("rejects tool slug %j before any slug checks", (slug) => {
    for (const toolName of ["solve_captcha", "greenhouse_prepare_submit", "update_application_state", "promote_to_queue"]) {
      const input = { slug };
      expect(evaluateGate({ ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input },
        gateCtx({ root: "/ws" }))).toMatchObject({ allow: false, code: "STATE_INVALID", reason: expect.stringContaining(slug) });
    }
  });
  it.each(["solve_captcha", "greenhouse_prepare_submit", "browser_run_code_unsafe"])("rejects a different tool slug in apply: %s", (toolName) => {
    const input = { slug: "other", filename: ".pi-jobs/scripts/other-submit.js" };
    expect(evaluateGate({ ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input },
      gateCtx({ root: "/ws", runDir: "/ws/run" }))).toMatchObject({ allow: false, code: "STATE_INVALID" });
  });
  it.each(["promote_to_queue", "reject_discovered", "add_target"])("fences queue mutation %s", (toolName) => {
    const input = { slug: "acme-role" };
    const call = { ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input };
    expect(evaluateGate(call, gateCtx({ root: "/ws", runDir: "/ws/run" }))).toMatchObject({ allow: false, code: "OFF_PIPELINE_BROWSER" });
    expect(evaluateGate(call, gateCtx({ root: "/ws", runDir: "/ws/run", kind: "gather" }))).toEqual({ allow: true });
    expect(evaluateGate(call, gateCtx({ root: "/ws", runDir: "/ws/run", kind: "gather", stopMarkerExists: true }))).toMatchObject({ allow: false, code: "RUN_STOPPED" });
  });
  it.each([".pi/extensions/submission-guard.ts", ".pi/mcp.json", "ui/server/app.ts", "scripts/fixture.mjs",
    "node_modules/lib/index.js", "package.json", "package-lock.json", ".mcp.json", "AGENTS.md", "CLAUDE.md", "SECURITY.md"])("protects runtime path %s in all contexts", (file) => {
    for (const toolName of ["write", "edit"]) {
      for (const platform of ["linux", "darwin"] as const) {
        const input = { path: platform === "darwin" ? "@"+file.toUpperCase() : "sub/../"+file };
        const call = { ...classifyToolCall(toolName, input, classifyOpts("/ws", "/ws", platform)), toolName, input };
        for (const runDir of [undefined, "/ws/run"]) {
          // boundary: B15
          expect(evaluateGate(call, gateCtx({ root: "/ws", platform, runDir }))).toMatchObject({ allow: false, code: "STATE_DIRECT_WRITE" });
        }
      }
    }
  });
});

it("apply gate uses canonical slug and reads numbered queue URL for duplicate checks", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, "jobs/queue"), { recursive: true });
  await fs.writeFile(path.join(root, "jobs/queue/01-foo.md"), "url: https://example.invalid/foo\n");
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(baseState({
    applications: [{ slug: "foo", status: "submitted" }],
  })));
  expect(await evaluateApplyRunGate(root, "01-foo")).toMatchObject({ ok: false, code: "ALREADY_SUBMITTED" });
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(baseState({
    applications: [{ slug: "different", status: "submitted", url: "https://example.invalid/foo" }],
  })));
  expect(await evaluateApplyRunGate(root, "foo")).toMatchObject({ ok: false, code: "ALREADY_SUBMITTED" });
});


describe("dashboard page gate", () => {
  it("blocks every browser call shape while on the dashboard, including read-only and unsafe calls", () => {
    for (const [tool, args] of [
      ["browser_click", {}], ["browser_snapshot", {}], ["browser_mystery", {}],
      ["browser_evaluate", { function: "() => 1" }],
      ["browser_run_code_unsafe", { code: "async () => 1" }],
      ["browser_navigate", { url: "http://localhost:4915/" }],
    ] as const) {
      for (const [toolName, input] of [[tool, args], [`mcp__job_playwright__${tool}`, args],
        ["mcp", { server: "job-playwright", tool, args: JSON.stringify(args) }]] as const) {
        const call = { ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input };
        // boundary: B15
        expect(evaluateGate(call, gateCtx({ root: "/ws", currentPageUrl: "http://127.0.0.1:4747/" })))
          .toMatchObject({ allow: false, code: "OFF_PIPELINE_BROWSER", reason: /controlled browser is on the local Rolebound dashboard/ });
      }
    }
  });
  it("allows only navigation that leaves the dashboard", () => {
    for (const [url, allow] of [
      ["https://job-boards.greenhouse.io/fixture", true], ["http://example.invalid/", true], ["about:blank", true],
      ["javascript:document.querySelector('button').click()", false], ["data:text/html,hello", false],
      ["/setup", false], ["http://localhost:4747/", false],
    ] as const) {
      const toolName = "browser_navigate";
      const input = { url };
      const result = evaluateGate({ ...classifyToolCall(toolName, input, classifyOpts("/ws")), toolName, input },
        gateCtx({ root: "/ws", currentPageUrl: "http://127.0.0.1:4747/" }));
      expect(result.allow).toBe(allow);
      if (!allow) expect(result).toMatchObject({ code: "OFF_PIPELINE_BROWSER" });
    }
  });
  it("scans only URL-bearing browser arguments", () => {
    for (const toolName of ["browser_type", "browser_fill_form", "browser_click"]) {
      const input = { text: "http://localhost:3000", fields: [{ value: "http://localhost:3000" }], element: "http://localhost:3000" };
      expect(classifyToolCall(toolName, input, classifyOpts("/ws"))).toEqual({ kind: "browser_mutating" });
    }
    expect(classifyToolCall("browser_run_code_unsafe", { code: 'async () => fetch("http://localhost:4747/")' }, classifyOpts("/ws")))
      .toEqual({ kind: "off_pipeline_browser" });
  });

});


it("sanctioned chat writers honor run stop markers without permitting direct writes", () => {
  const root = "/ws"; const opts = classifyOpts(root);
  for (const toolName of ["profile_update_section", "resume_add", "queue_add_url"]) {
    const input = {}; const classified = classifyToolCall(toolName, input, opts);
    expect(evaluateGate({ ...classified, toolName, input }, gateCtx({ root, kind: "chat", applySlug: undefined, runDir: "/ws/run" }))).toEqual({ allow: true });
    expect(evaluateGate({ ...classified, toolName, input }, gateCtx({ root, kind: "chat", runDir: "/ws/run", stopMarkerExists: true }))).toMatchObject({ allow: false, code: "RUN_STOPPED" });
  }
  expect(classifyToolCall("write", { path: "state.json", content: "x" }, opts).kind).toBe("state_direct_write");
});

it("chat preserves application acknowledgement and requires a selected job before form actions", () => {
  const root = "/ws"; const opts = classifyOpts(root);
  const toolName = "mcp__job_playwright__browser_click"; const input = {};
  const call = { ...classifyToolCall(toolName, input, opts), toolName, input };
  expect(evaluateGate(call, gateCtx({ root, kind: "chat", applySlug: undefined, runDir: "/ws/run" }))).toMatchObject({ allow: false, code: "STATE_INVALID" });
  expect(evaluateGate(call, gateCtx({ root, kind: "chat", runDir: "/ws/run", state: { ok: true, value: baseState({ acknowledged_at: null, acknowledged_policy: null }) } }))).toMatchObject({ allow: false, code: "ACK_REQUIRED" });
  expect(evaluateGate(call, gateCtx({ root, kind: "chat", runDir: "/ws/run", state: { ok: false, corrupt: true } }))).toMatchObject({ allow: false, code: "STATE_CORRUPT" });
  expect(evaluateGate(call, gateCtx({ root, kind: "chat", runDir: "/ws/run", queueFileExists: () => false }))).toMatchObject({ allow: false, code: "QUEUE_ITEM_REMOVED" });
});
