import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  AUTO_SUBMIT_POLICY_VERSION,
  MIN_SUBMIT_INTERVAL_MS,
  classifyToolCall,
  defaultResolvePath,
  evaluateGate,
  writeObservation,
  type GateContext,
} from "../../../.pi/extensions/lib/submission-policy";
import { parseStateText } from "../../../.pi/extensions/lib/workspace-files";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
  minimalProfileMd,
} from "./extensionHarness";

const AUTO_SUBMIT_POLICY = AUTO_SUBMIT_POLICY_VERSION;

function gateCtx(partial: Partial<GateContext> & { root: string }): GateContext {
  const {
    root,
    state = {
      ok: true,
      value: parseStateText(
        JSON.stringify({
          acknowledged_at: "2026-01-01T00:00:00.000Z",
          acknowledged_policy: AUTO_SUBMIT_POLICY,
          applications: [],
          addresses: {},
        }),
      ),
    },
    now = Date.parse("2026-06-01T12:00:00.000Z"),
    queueFileExists = () => true,
    observationForSlug = () => ({ status: "missing" }),
    ...rest
  } = partial;
  const platform = partial.platform ?? "linux";
  const cwd = partial.cwd ?? root;
  return {
    root,
    cwd,
    platform,
    runId: "run-1",
    runDir: partial.runDir,
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

async function submittedEvidenceSetup(ws: { root: string }, slug: string) {
  await fs.mkdir(path.join(ws.root, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(ws.root, "screenshots", `${slug}-confirmation.png`), "x", "utf8");
  await writeObservation(ws.root, {
    slug,
    state: "submitted",
    source: "greenhouse_submit_script",
    at: new Date().toISOString(),
    runId: "run-x",
  });
}

function submittedParams(slug: string) {
  return {
    slug,
    status: "submitted" as const,
    confirmation_source: "greenhouse_submit_script" as const,
    confirmation_evidence: "Script returned state submitted with thank-you text.",
    screenshot: `screenshots/${slug}-confirmation.png`,
  };
}

async function loadApplier(ws: { root: string }) {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  return api;
}

function toolCtx(ws: { root: string }, ui: { confirm: (title: string, message: string) => Promise<boolean> }) {
  return {
    cwd: ws.root,
    hasUI: true,
    ui: { confirm: ui.confirm, notify: () => {} },
  };
}

describe("extension harness — submitted state (T6)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("refuses submitted without evidence", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [{ slug: "role-a", status: "in_progress" }], addresses: {} }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update("t", { slug: "role-a", status: "submitted" }, undefined, undefined, toolCtx(ws, { confirm: async () => true }));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/SUBMITTED_EVIDENCE_REQUIRED/);
  });

  it("accepts Greenhouse submitted with cross-process observation", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    const slug = "gh-role";
    await fs.mkdir(path.join(ws.root, "screenshots"), { recursive: true });
    await fs.writeFile(path.join(ws.root, "screenshots", `${slug}-confirmation.png`), "png-bytes", "utf8");
    await writeObservation(ws.root, {
      slug,
      state: "submitted",
      source: "greenhouse_submit_script",
      at: new Date().toISOString(),
      runId: "run-x",
    });
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [{ slug, status: "in_progress" }], addresses: {} }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      {
        slug,
        status: "submitted",
        confirmation_source: "greenhouse_submit_script",
        confirmation_evidence: "Script returned state submitted with thank-you text.",
        screenshot: `screenshots/${slug}-confirmation.png`,
      },
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => true }),
    );
    expect(out.isError).not.toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].submitted_at).toBeTruthy();
    expect(state.applications[0].confirmation_source).toBe("greenhouse_submit_script");
  });

  it("rejects unknown extra fields via validateToolArguments", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
    const schema = mod.UPDATE_APPLICATION_STATE_PARAMETERS;
    expect(schema).toBeDefined();
    expect(() =>
      validateToolArguments(
        { name: "update_application_state", description: "test", parameters: schema },
        {
          type: "toolCall",
          id: "call-1",
          name: "update_application_state",
          arguments: { slug: "x", status: "in_progress", reopenApproval: { submitted_at: null } },
        },
      ),
    ).toThrow();
  });

  it("confirmed reopen deletes observation and writes reopen fields", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    const slug = "reopen-me";
    await fs.mkdir(path.join(ws.root, ".pi-jobs", "observed"), { recursive: true });
    await fs.writeFile(
      path.join(ws.root, ".pi-jobs", "observed", `${slug}.json`),
      JSON.stringify({ slug, state: "submitted", source: "greenhouse_submit_script", at: "t", runId: "r" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "submitted",
            queue_file: `jobs/applied/${slug}.md`,
            submitted_at: "2026-01-01T00:00:00.000Z",
            company: "Acme",
            title: "Role",
          },
        ],
        acknowledged_at: "2026-01-01T00:00:00.000Z",
        acknowledged_policy: AUTO_SUBMIT_POLICY,
        addresses: {},
      }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true, queue_file: `jobs/applied/${slug}.md` },
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => true }),
    );
    expect(out.isError).not.toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("in_progress");
    expect(state.applications[0].reopened_at).toBeTruthy();
    expect(state.applications[0].reopened_from_submitted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(state.applications[0].submitted_at).toBeUndefined();
    expect(state.applications[0].queue_file).toBeUndefined();
    await expect(fs.stat(path.join(ws.root, ".pi-jobs", "observed", `${slug}.json`))).rejects.toThrow();
    await fs.writeFile(path.join(ws.root, "jobs/queue", `${slug}.md`), "url: https://example.invalid/reopen\n");
    const guardModule = await import(path.join(ws.root, ".pi/extensions/submission-guard.ts"));
    const guard = createRecordingExtensionApi();
    guardModule.default(guard.pi);
    const runDir = path.join(ws.root, ".pi-jobs/runs/requeue");
    await fs.mkdir(runDir, { recursive: true });
    const keys = ["PI_JOBS_RUN_DIR", "PI_JOBS_RUN_KIND", "PI_JOBS_APPLY_SLUG"] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.PI_JOBS_RUN_DIR = runDir;
      process.env.PI_JOBS_RUN_KIND = "apply";
      process.env.PI_JOBS_APPLY_SLUG = slug;
      expect(await guard.invokeToolCall({
        type: "tool_call", toolCallId: "requeued-click", toolName: "browser_click", input: {},
      }, { cwd: ws.root })).toBeUndefined();
    } finally {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
    }
  });

  it("rejects confirmation_source demo in validateToolArguments", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
    const schema = mod.UPDATE_APPLICATION_STATE_PARAMETERS;
    expect(() =>
      validateToolArguments(
        { name: "update_application_state", description: "test", parameters: schema },
        {
          type: "toolCall",
          id: "call-1",
          name: "update_application_state",
          arguments: {
            slug: "x",
            status: "submitted",
            confirmation_source: "demo",
            confirmation_evidence: "demo run synthetic",
            screenshot_error: "demo",
          },
        },
      ),
    ).toThrow();
  });

  // boundary: B7
  it("override_submitted without UI is refused and state unchanged", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "no-ui";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        addresses: {},
      }),
      "utf8",
    );
    const before = await fs.readFile(path.join(ws.root, "state.json"), "utf8");
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      undefined,
      undefined,
      { cwd: ws.root, hasUI: false, ui: { confirm: async () => true, notify: () => {} } },
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/OVERRIDE_REQUIRES_USER|user's confirmation/);
    expect(await fs.readFile(path.join(ws.root, "state.json"), "utf8")).toBe(before);
  });

  // boundary: B7
  it("declined reopen confirm is refused", async () => {
    const slug = "decline-me";
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "submitted",
            submitted_at: "2026-01-01T00:00:00.000Z",
            company: "Acme",
            title: "Role",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => false }),
    );
    expect(out.isError).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
  });

  // boundary: B7
  it("cancelled reopen confirm is refused", async () => {
    const slug = "cancel-me";
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "submitted",
            submitted_at: "2026-01-01T00:00:00.000Z",
            company: "Acme",
            title: "Role",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    const controller = new AbortController();
    controller.abort();
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      controller.signal,
      undefined,
      {
        ...toolCtx(ws, { confirm: async () => true }),
        ui: {
          confirm: async (
            _title: string,
            _message: string,
            opts?: { signal?: AbortSignal },
          ) => (opts?.signal?.aborted ? false : true),
          notify: () => {},
        },
      },
    );
    expect(out.isError).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
  });

  // boundary: B8
  it("after confirmed reopen same slug and other slug are RATE_LIMITED until ten minutes after original submitted_at", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "reopened-role";
    const other = "other-role";
    const submittedAt = "2026-06-01T12:00:00.000Z";
    const now = Date.parse("2026-06-01T12:05:00.000Z");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        acknowledged_at: "2026-01-01T00:00:00.000Z",
        acknowledged_policy: AUTO_SUBMIT_POLICY,
        applications: [
          {
            slug,
            status: "submitted",
            submitted_at: submittedAt,
            company: "Acme",
            title: "Role",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const reopen = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => true }),
    );
    expect(reopen.isError).not.toBe(true);

    const state = parseStateText(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    state.applications.push({ slug: other, status: "queued" });
    const prep = classifyToolCall("greenhouse_prepare_submit", { slug: other }, {
      root: ws.root,
      cwd: ws.root,
      platform: "linux",
      home: "/home/tester",
      resolvePath: (p) => defaultResolvePath(p, { root: ws.root, cwd: ws.root, platform: "linux", home: "/home/tester" }),
    });
    const ctx = gateCtx({
      root: ws.root,
      now,
      applySlug: other,
      state: { ok: true, value: state },
      queueFileExists: () => true,
    });
    expect(evaluateGate({ ...prep, toolName: "greenhouse_prepare_submit", input: {} }, ctx)).toMatchObject({
      allow: false,
      code: "RATE_LIMITED",
    });

    const sameSlugPrep = classifyToolCall("greenhouse_prepare_submit", { slug }, {
      root: ws.root,
      cwd: ws.root,
      platform: "linux",
      home: "/home/tester",
      resolvePath: (p) => defaultResolvePath(p, { root: ws.root, cwd: ws.root, platform: "linux", home: "/home/tester" }),
    });
    expect(evaluateGate({ ...sameSlugPrep, toolName: "greenhouse_prepare_submit", input: {} }, ctx)).toMatchObject({
      allow: false,
      code: "RATE_LIMITED",
    });

    const afterWindow = Date.parse(submittedAt) + MIN_SUBMIT_INTERVAL_MS;
    const ctx2 = gateCtx({ ...ctx, now: afterWindow });
    expect(evaluateGate({ ...prep, toolName: "greenhouse_prepare_submit", input: {} }, ctx2)).toEqual({ allow: true });
  });

  // boundary: B7
  it(
    "parallel submitted and override_submitted on in_progress leaves submitted without dialog",
    async () => {
    const slug = "race-role";
    for (let i = 0; i < 20; i++) {
      const ws = await createExtensionHarnessWorkspace();
      cleanups.push(ws.cleanup);
      await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
      await submittedEvidenceSetup(ws, slug);
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify({ applications: [{ slug, status: "in_progress" }], addresses: {} }),
        "utf8",
      );
      const { tools } = await loadApplier(ws);
      const update = tools.get("update_application_state")!;
      let confirmCalls = 0;
      const ctx = toolCtx(ws, {
        confirm: async () => {
          confirmCalls++;
          return true;
        },
      });
      await Promise.all([
        update("t1", submittedParams(slug), undefined, undefined, ctx),
        update("t2", { slug, status: "queued", override_submitted: true }, undefined, undefined, ctx),
      ]);
      expect(confirmCalls).toBe(0);
      const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
      expect(state.applications[0].status).toBe("submitted");
    }
  },
    120_000,
  );

  // boundary: B7
  it("override_submitted with status submitted shows no dialog and merges other fields", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "stay-submitted";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "submitted",
            submitted_at: "2026-01-01T00:00:00.000Z",
            confirmation_source: "page",
            confirmation_evidence: "Thank you page visible",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    let confirmCalls = 0;
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "submitted", override_submitted: true, block_reason: "note" },
      undefined,
      undefined,
      toolCtx(ws, {
        confirm: async () => {
          confirmCalls++;
          return true;
        },
      }),
    );
    expect(out.isError).not.toBe(true);
    expect(confirmCalls).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
    expect(state.applications[0].submitted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(state.applications[0].reopened_at).toBeUndefined();
    expect(state.applications[0].block_reason).toBe("note");
  });

  // boundary: B7
  it("agent reopenApproval on execute is ignored and reopen without override is SUBMITTED_LOCKED", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "locked";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        addresses: {},
      }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      {
        slug,
        status: "in_progress",
        reopenApproval: { submitted_at: "2026-01-01T00:00:00.000Z" },
      } as Record<string, unknown>,
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => true }),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/already submitted/);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
  });

  // boundary: B7
  it("follow-up submitted update keeps submitted_at and skips evidence", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "follow-up";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "submitted",
            submitted_at: "2026-01-01T00:00:00.000Z",
            confirmation_source: "page",
            confirmation_evidence: "Thank you page visible",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "submitted", block_reason: "sync" },
      undefined,
      undefined,
      toolCtx(ws, { confirm: async () => true }),
    );
    expect(out.isError).not.toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].submitted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(state.applications[0].block_reason).toBe("sync");
  });

  // boundary: B7
  it('submitted without submitted_at shows "unknown date" in dialog and reopens on confirm', async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "no-date";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "submitted", company: "Acme", title: "Role" }],
        addresses: {},
      }),
      "utf8",
    );
    let message = "";
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      undefined,
      undefined,
      toolCtx(ws, {
        confirm: async (_title, msg) => {
          message = msg;
          return true;
        },
      }),
    );
    expect(out.isError).not.toBe(true);
    expect(message).toContain("unknown date");
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("in_progress");
  });

  // boundary: B7
  it("mutateApplicationState with mismatched reopenApproval returns OVERRIDE_REQUIRES_USER", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "mismatch";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        addresses: {},
      }),
      "utf8",
    );
    const { mutateApplicationState } = await import(
      path.join(ws.root, ".pi", "extensions", "lib", "applications.ts")
    );
    const result = await mutateApplicationState(
      { slug, status: "in_progress", reopenApproval: { submitted_at: "2026-02-01T00:00:00.000Z" } },
      () => {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "OVERRIDE_REQUIRES_USER" });
  });

  // boundary: B7
  it("stop marker refuses reopen before dialog", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "stopped";
    const runDir = path.join(ws.root, ".pi-jobs", "runs", "run-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "stop.json"), "{}", "utf8");
    process.env.PI_JOBS_RUN_DIR = runDir;
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
        addresses: {},
      }),
      "utf8",
    );
    let confirmCalls = 0;
    const { tools } = await loadApplier(ws);
    const update = tools.get("update_application_state")!;
    const out = await update(
      "t",
      { slug, status: "in_progress", override_submitted: true },
      undefined,
      undefined,
      toolCtx(ws, {
        confirm: async () => {
          confirmCalls++;
          return true;
        },
      }),
    );
    delete process.env.PI_JOBS_RUN_DIR;
    expect(out.isError).toBe(true);
    expect(confirmCalls).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
  });

  // boundary: B7
  it("parallel duplicate submitted transitions stamp submitted_at once", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const slug = "dup-stamp";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [{ slug, status: "in_progress" }], addresses: {} }),
      "utf8",
    );
    const { mutateApplicationState } = await import(
      path.join(ws.root, ".pi", "extensions", "lib", "applications.ts")
    );
    let transitions = 0;
    const merge = (app: Record<string, unknown>, existing: Record<string, unknown> | undefined) => {
      if (existing?.status !== "submitted") {
        transitions++;
        app.submitted_at = `T${transitions}`;
      }
    };
    const results = await Promise.all([
      mutateApplicationState({ slug, status: "submitted" }, merge),
      mutateApplicationState({ slug, status: "submitted" }, merge),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(transitions).toBe(1);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.applications[0].submitted_at).toBe("T1");
  });
});
