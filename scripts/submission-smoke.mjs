#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { close as closeFixture, createSubmissionSmokeFixtureServer, listen as listenFixture } from "./fixtures/submission-smoke-fixture-server.mjs";
import { close as closeModel, createScriptedModelServer, listen as listenModel } from "./fixtures/scripted-model.mjs";
import { prepareTempAppDir } from "./fixtures/app-dir.mjs";
import {
  LOCK_STALE_MS,
  assertNoOwnedProcessSurvives,
  createCaptchaProbeServer,
  killOwnedGroup,
  postAbort,
  postApplyRun,
  postRun,
  postUiResponse,
  prepareDashboardWorkspace,
  readCurrent,
  readRunManagerPid,
  readScriptedRequests,
  runDoctorReadiness,
  startDashboardServer,
  transcriptHasCode,
  typeTool,
  waitForFillCount,
  waitForMinFixtureSubmits,
  waitForObservationFile,
  waitForUiRequest,
  wireScriptedAgent,
  writeAckedState,
} from "./fixtures/submission-smoke-dashboard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_SUBMIT_POLICY_VERSION = "auto-submit-v1";
const SLUG = "acme-role";
const OTHER = "other-role";

const clickTool = {
  name: "mcp__job_playwright__browser_click",
  arguments: { element: "Submit application", ref: "e1" },
};

function fixtureUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function resetFixtureCount(base) {
  await fetch(`${base}/reset`, { method: "POST" });
}

async function readFixtureCount(base) {
  const res = await fetch(`${base}/counts`);
  const body = await res.json();
  return body.submitCount ?? 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunTerminal(baseURL, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await readCurrent(baseURL);
    const status = payload.run?.status;
    if (!payload.run || status === "done" || status === "stopped" || status === "failed") return payload;
    await sleep(100);
  }
  throw new Error("timed out waiting for run terminal state");
}

function transcriptText(events) {
  return JSON.stringify(events);
}

function hasBlockCode(events, code) {
  const text = transcriptText(events);
  return text.includes(code);
}

async function prepareApp(temp, modelPort) {
  const { home, app, runDir, runId } = await prepareTempAppDir(root, temp, { runId: "smoke-run" });
  const agentDir = path.join(app, ".pi-jobs", "pi-agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(path.join(app, ".pi", "mcp.json"), path.join(agentDir, "mcp.json"));
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    `${JSON.stringify({ "pjr15-smoke": { type: "api_key", key: "smoke-key" } })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        "pjr15-smoke": {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          models: [
            {
              id: "scripted",
              name: "scripted",
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${modelPort}/v1`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 256,
            },
          ],
        },
      },
    })}\n`,
  );

  return { home, app, agentDir, runDir, runId };
}

async function writeQueue(app) {
  const file = path.join(app, "jobs", "queue", `${SLUG}.md`);
  await fs.writeFile(
    file,
    `---
url: https://boards.example.invalid/boards/fixture/jobs/1234567
company: Fixture
title: Role
---
`,
    "utf8",
  );
}

async function writeState(app, state) {
  await fs.writeFile(path.join(app, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ackedState(overrides = {}) {
  return {
    acknowledged_at: "2026-01-01T00:00:00.000Z",
    acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
    applications: [],
    addresses: {},
    ...overrides,
  };
}

async function scenarioT6DashboardApi(temp, fixtureBase) {
  const uiDist = path.join(root, "ui", "dist", "index.html");
  try {
    await fs.access(uiDist);
  } catch {
    const { spawnSync } = await import("node:child_process");
    const build = spawnSync(process.execPath, ["scripts/pi-jobs.mjs", "build"], { cwd: root, stdio: "inherit" });
    assert.equal(build.status, 0, "npm run build required for T6 dashboard scenarios");
  }

  // T6.1 — OTP through the API
  await resetFixtureCount(fixtureBase);
  {
    const model = createScriptedModelServer({
      modelIds: ["scripted"],
      steps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "otp", message: "Enter the emailed code" } } },
        { tool: clickTool },
        { text: "done" },
      ],
    });
    await listenModel(model);
    const modelPort = model.address().port;
    const modelOrigin = `http://127.0.0.1:${modelPort}/v1`;
    const { home, app, emptyAgentDir } = await prepareDashboardWorkspace(temp);
    await writeAckedState(app);
    await writeQueue(app);
    const dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
    try {
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      const { res, json } = await postRun(dash.baseURL, { kind: "apply", slug: SLUG });
      assert.equal(res.status, 201, JSON.stringify(json));
      const otp = "87654321";
      const uiReq = await waitForUiRequest(dash.baseURL, (e) => e.method === "input");
      assert.equal(uiReq.method, "input");
      const uiRes = await postUiResponse(dash.baseURL, json.runId, { id: uiReq.id, value: otp });
      assert.equal(uiRes.status, 200);
      await waitFor(async () => {
        const reqs = await readScriptedRequests(modelPort);
        const bodies = reqs.map((r) => r.body ?? "").join("\n");
        return bodies.includes(otp) ? true : null;
      }, 120_000);
      await waitForMinFixtureSubmits(fixtureBase);
      assert.equal(await readFixtureCount(fixtureBase), 1);
    } finally {
      await dash.stop();
      await closeModel(model);
    }
    console.log("scenario (T6.1) OTP through API: ok");
  }

  // T6.2 — CAPTCHA default pause
  await resetFixtureCount(fixtureBase);
  {
    const captchaProbe = createCaptchaProbeServer();
    await captchaProbe.listen();
    const model = createScriptedModelServer({
      modelIds: ["scripted"],
      steps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "captcha", message: "Complete the widget" } } },
        { tool: clickTool },
        { text: "done" },
      ],
    });
    await listenModel(model);
    const modelPort = model.address().port;
    const modelOrigin = `http://127.0.0.1:${modelPort}/v1`;
    const { home, app, emptyAgentDir } = await prepareDashboardWorkspace(temp);
    await writeAckedState(app);
    await writeQueue(app);
    const dash = await startDashboardServer({
      app,
      home,
      modelOrigin,
      fixtureBase,
      emptyAgentDir,
      extraEnv: {
        CAPSOLVER_API_KEY: "FIXTURE-SECRET-do-not-leak",
        TWOCAPTCHA_API_KEY: "FIXTURE-SECRET-do-not-leak",
      },
    });
    try {
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      const { res, json } = await postRun(dash.baseURL, { kind: "apply", slug: SLUG });
      assert.equal(res.status, 201);
      const uiReq = await waitForUiRequest(dash.baseURL, (e) => e.method === "confirm");
      const confirm = await postUiResponse(dash.baseURL, json.runId, { id: uiReq.id, confirmed: true });
      assert.equal(confirm.status, 200);
      await waitForMinFixtureSubmits(fixtureBase);
      assert.equal(captchaProbe.getRequestCount(), 0);
      assert.equal(await readFixtureCount(fixtureBase), 1);
    } finally {
      await dash.stop();
      await captchaProbe.close();
      await closeModel(model);
    }
    console.log("scenario (T6.2) CAPTCHA pause: ok");
  }

  // T6.3 — Stop while paused
  await resetFixtureCount(fixtureBase);
  {
    const model = createScriptedModelServer({
      modelIds: ["scripted"],
      steps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "captcha", message: "Waiting" } } },
        { tool: clickTool },
        { text: "done" },
      ],
    });
    await listenModel(model);
    const modelPort = model.address().port;
    const modelOrigin = `http://127.0.0.1:${modelPort}/v1`;
    const { home, app, emptyAgentDir } = await prepareDashboardWorkspace(temp);
    await writeAckedState(app);
    await writeQueue(app);
    const dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
    try {
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      const { res, json } = await postRun(dash.baseURL, { kind: "apply", slug: SLUG });
      assert.equal(res.status, 201);
      await waitForUiRequest(dash.baseURL, (e) => e.method === "confirm");
      let piPid = null;
      await waitFor(async () => {
        piPid = await readRunManagerPid(app);
        return piPid ? true : null;
      }, 30_000);
      const stopPath = path.join(app, ".pi-jobs", "runs", json.runId, "stop.json");
      let sawStop = false;
      const parent = path.dirname(stopPath);
      await fs.mkdir(parent, { recursive: true });
      const { watch } = await import("node:fs");
      const watcher = watch(parent, (_event, file) => {
        if (file === "stop.json") sawStop = true;
      });
      await sleep(50);
      await fs.writeFile(
        stopPath,
        `${JSON.stringify({ runId: json.runId, reason: "submission-smoke", at: new Date().toISOString() })}\n`,
      );
      const uiReq = (await readCurrent(dash.baseURL)).events.find((e) => e.type === "ui_request" && e.method === "confirm");
      const confirm = await postUiResponse(dash.baseURL, json.runId, { id: uiReq.id, confirmed: true });
      assert.equal(confirm.status, 200);
      await waitFor(async () => {
        const payload = await readCurrent(dash.baseURL);
        return transcriptHasCode(payload.events, "RUN_STOPPED") ? true : null;
      }, 60_000);
      const abort = await postAbort(dash.baseURL, json.runId);
      assert.equal(abort.status, 200);
      await waitFor(async () => {
        try {
          process.kill(piPid, 0);
          return null;
        } catch {
          return true;
        }
      }, 30_000);
      watcher.close();
      assert.equal(sawStop, true, "stop marker should be observed before cleanup");
      assert.equal(await readFixtureCount(fixtureBase), 0);
    } finally {
      await dash.stop();
      await closeModel(model);
    }
    console.log("scenario (T6.3) stop while paused: ok");
  }

  // T6.4 — Interruption before submit
  await resetFixtureCount(fixtureBase);
  {
    const submitUpdate = {
      name: "update_application_state",
      arguments: {
        slug: SLUG,
        status: "submitted",
        confirmation_source: "page",
        confirmation_evidence: "Stub click reported submit confirmation on the fixture page.",
        screenshot: `screenshots/${SLUG}-confirmation.png`,
      },
    };
    const model = createScriptedModelServer({
      modelIds: ["scripted"],
      steps: [{ tool: typeTool }],
    });
    const completionSteps = [
      { tool: clickTool },
      { tool: submitUpdate },
      { tool: { name: "complete_application", arguments: { slug: SLUG } } },
      { text: "done" },
    ];
    await listenModel(model);
    const modelPort = model.address().port;
    const modelOrigin = `http://127.0.0.1:${modelPort}/v1`;
    const { home, app, emptyAgentDir } = await prepareDashboardWorkspace(temp);
    await writeAckedState(app, {
      applications: [
        {
          slug: SLUG,
          status: "in_progress",
          captcha_paid_tasks: 1,
          queue_file: `jobs/queue/${SLUG}.md`,
        },
      ],
    });
    await writeQueue(app);
    let dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
    let serverPgid;
    let piPid;
    try {
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      await sleep(LOCK_STALE_MS + 500);
      const started = await postApplyRun(dash.baseURL, SLUG);
      assert.equal(started.res.status, 201, JSON.stringify(started.json));
      await waitForFillCount(fixtureBase, 1);
      piPid = await readRunManagerPid(app);
      serverPgid = dash.serverPgid;
      await dash.killGroup();
      killOwnedGroup(piPid);
      assertNoOwnedProcessSurvives(serverPgid, piPid);
      const stateAfterKill = JSON.parse(await fs.readFile(path.join(app, "state.json"), "utf8"));
      const entry = stateAfterKill.applications.find((a) => a.slug === SLUG);
      assert.equal(entry.status, "in_progress");
      assert.equal(entry.captcha_paid_tasks, 1);
      assert.equal(entry.submitted_at, undefined);
      await dash.stop().catch(() => {});
      model.setSteps(completionSteps);
      dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      const retry = await postApplyRun(dash.baseURL, SLUG);
      assert.equal(retry.res.status, 201, JSON.stringify(retry.json));
      await waitForMinFixtureSubmits(fixtureBase);
      assert.equal(await readFixtureCount(fixtureBase), 1);
      const doneEntry = await waitFor(async () => {
        const stateDone = JSON.parse(await fs.readFile(path.join(app, "state.json"), "utf8"));
        const entry = stateDone.applications.find((a) => a.slug === SLUG);
        return entry?.status === "submitted" ? entry : null;
      }, 60_000);
      assert.equal(doneEntry.status, "submitted");
      assert.equal(doneEntry.captcha_paid_tasks, 1);
      assert.ok(doneEntry.submitted_at);
      assert.ok(doneEntry.confirmation_evidence);
    } finally {
      await dash.stop();
      await closeModel(model);
    }
    console.log("scenario (T6.4) interruption before submit: ok");
  }

  // T6.5 — Interruption after observed submit
  await resetFixtureCount(fixtureBase);
  {
    const { home, app, emptyAgentDir } = await prepareDashboardWorkspace(temp);
    await writeAckedState(app, {
      applications: [{ slug: SLUG, status: "in_progress", queue_file: `jobs/queue/${SLUG}.md` }],
    });
    await writeQueue(app);
    const script = path.join(app, ".pi-jobs/scripts", `${SLUG}-submit.js`);
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, 'async (page) => { return { state: "submitted" }; }');
    const model = createScriptedModelServer({
      modelIds: ["scripted"],
      steps: [
        { tool: { name: "mcp__job_playwright__browser_run_code_unsafe", arguments: { filename: script } } },
        { holdUntilReleased: true, text: "hold-before-update" },
        {
          tool: {
            name: "update_application_state",
            arguments: {
              slug: SLUG,
              status: "submitted",
              confirmation_source: "greenhouse_submit_script",
              confirmation_evidence: "Script returned state submitted with thank-you text.",
              screenshot: `screenshots/${SLUG}-confirmation.png`,
            },
          },
        },
        { text: "done" },
      ],
    });
    await listenModel(model);
    const modelPort = model.address().port;
    const modelOrigin = `http://127.0.0.1:${modelPort}/v1`;
    let dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
    let serverPgid;
    let piPid;
    try {
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      await sleep(LOCK_STALE_MS + 500);
      const started = await postApplyRun(dash.baseURL, SLUG);
      assert.equal(started.res.status, 201, JSON.stringify(started.json));
      await waitForObservationFile(app, SLUG);
      while (model.pendingHolds > 0) model.releaseHold();
      piPid = await readRunManagerPid(app);
      serverPgid = dash.serverPgid;
      await dash.killGroup();
      killOwnedGroup(piPid);
      assertNoOwnedProcessSurvives(serverPgid, piPid);
      await dash.stop().catch(() => {});
      const report = runDoctorReadiness(app, false);
      assert.match(report, /RECONCILE R13:.*record observed submission/);
      const repaired = runDoctorReadiness(app, true);
      assert.match(repaired, /RECONCILE R13:.*recorded submission/);
      const state = JSON.parse(await fs.readFile(path.join(app, "state.json"), "utf8"));
      assert.equal(state.applications.find((a) => a.slug === SLUG)?.status, "submitted");
      dash = await startDashboardServer({ app, home, modelOrigin, fixtureBase, emptyAgentDir });
      await wireScriptedAgent(dash.baseURL, modelOrigin);
      await writeQueue(app);
      const refused = await postApplyRun(dash.baseURL, SLUG);
      assert.equal(refused.res.status, 409);
      assert.equal(refused.json.code, "ALREADY_SUBMITTED");
      assert.equal(await readFixtureCount(fixtureBase), 1);
    } finally {
      await dash.stop();
      await closeModel(model);
    }
    console.log("scenario (T6.5) interruption after observed submit: ok");
  }
}

async function waitFor(probe, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

async function scenarioNoAck(temp, fixtureBase) {
  const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
  await writeQueue(app);
  await writeState(app, { applications: [], addresses: {} });
  const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
    { tool: clickTool },
    { text: "done" },
  ]);
  assert(hasBlockCode(events, "ACK_REQUIRED"), "expected ACK_REQUIRED");
  assert.equal(await readFixtureCount(fixtureBase), 0);
}

async function runWithModel(app, home, agentDir, runDir, runId, fixtureBase, steps, hooks = {}) {
  const model = createScriptedModelServer({ steps, onAfterStep: hooks.onAfterStep });
  await listenModel(model);
  const port = model.address().port;
  const modelsPath = path.join(agentDir, "models.json");
  let models = JSON.parse(await fs.readFile(modelsPath, "utf8"));
  models.providers["pjr15-smoke"].baseUrl = `http://127.0.0.1:${port}/v1`;
  models.providers["pjr15-smoke"].models[0].baseUrl = `http://127.0.0.1:${port}/v1`;
  await fs.writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
  const { RpcClient } = await import("@earendil-works/pi-coding-agent");
  const rpc = new RpcClient({
    cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    cwd: app,
    provider: "pjr15-smoke",
    model: "scripted",
    env: {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PJR15_FIXTURE_URL: fixtureBase,
      PI_JOBS_RUN_ID: runId,
      PI_JOBS_RUN_DIR: runDir,
      PI_JOBS_RUN_KIND: "apply",
      PI_JOBS_APPLY_SLUG: SLUG,
      ...(hooks.extraEnv ?? {}),
    },
    args: ["--mode", "rpc", "--offline", "-a", "--no-session", ...(hooks.extraArgs ?? [])],
  });
  try {
    await rpc.start();
    return await rpc.promptAndWait("scenario", undefined, 120_000);
  } finally {
    await rpc.stop();
    await closeModel(model);
  }
}

async function main() {
  const { server: fixtureServer } = createSubmissionSmokeFixtureServer();
  await listenFixture(fixtureServer);
  const fixtureBase = fixtureUrl(fixtureServer);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr15-submission-smoke-"));
  try {
    await resetFixtureCount(fixtureBase);

    await scenarioNoAck(temp, fixtureBase);
    console.log("scenario (1) no ack: ok");

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: clickTool },
        { text: "done" },
      ]);
      assert(!hasBlockCode(events, "ACK_REQUIRED"));
      assert.equal(await readFixtureCount(fixtureBase), 1);
      console.log("scenario (2) ack + queue: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      let wroteStop = false;
      const events = await runWithModel(
        app,
        home,
        agentDir,
        runDir,
        runId,
        fixtureBase,
        [{ tool: clickTool }, { tool: clickTool }, { tool: { name: "update_application_state", arguments: { slug: SLUG, status: "in_progress" } } }, { text: "done" }],
        {
          onAfterStep: async (index) => {
            if (index === 1 && !wroteStop) {
              wroteStop = true;
              await fs.writeFile(
                path.join(runDir, "stop.json"),
                `${JSON.stringify({ runId, reason: "submission-smoke", at: new Date().toISOString() })}\n`,
              );
            }
          },
        },
      );
      assert(hasBlockCode(events, "RUN_STOPPED"));
      assert.equal(await readFixtureCount(fixtureBase), 1);
      assert.match(transcriptText(events), /update_application_state/);
      console.log("scenario (3) stop marker: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      let removed = false;
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: clickTool },
        { tool: clickTool },
        { text: "done" },
      ], {
        onAfterStep: async (index) => {
          if (index === 1 && !removed) {
            removed = true;
            await fs.unlink(path.join(app, "jobs", "queue", `${SLUG}.md`));
          }
        },
      });
      assert(hasBlockCode(events, "QUEUE_ITEM_REMOVED"));
      assert.equal(await readFixtureCount(fixtureBase), 1);
      console.log("scenario (4) queue removed: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      const submittedAt = new Date().toISOString();
      await writeState(
        app,
        ackedState({
          applications: [{ slug: SLUG, status: "submitted", submitted_at: submittedAt, queue_file: `jobs/queue/${SLUG}.md` }],
        }),
      );
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: clickTool },
        { text: "done" },
      ]);
      assert(hasBlockCode(events, "ALREADY_SUBMITTED"));
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (5) already submitted: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
      await writeState(
        app,
        ackedState({
          applications: [
            { slug: OTHER, status: "submitted", submitted_at: oneMinuteAgo, queue_file: `jobs/queue/${OTHER}.md` },
            { slug: SLUG, status: "in_progress", queue_file: `jobs/queue/${SLUG}.md` },
          ],
        }),
      );
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: clickTool },
        { text: "done" },
      ]);
      assert(hasBlockCode(events, "RATE_LIMITED"));
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (6) rate limited: ok");
    }


    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const script = path.join(app, ".pi-jobs/scripts", `${SLUG}-submit.js`);
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.writeFile(script, 'async (page) => { return { state: "submitted" }; }');
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: { name: "mcp__job_playwright__browser_run_code_unsafe", arguments: { filename: script } } },
        { text: "done" },
      ]);
      assert(!hasBlockCode(events, "UNSAFE_CODE"));
      assert.equal(await readFixtureCount(fixtureBase), 1);
      const observation = JSON.parse(await fs.readFile(path.join(app, ".pi-jobs/observed", `${SLUG}.json`), "utf8"));
      assert.equal(observation.state, "submitted");
      assert.equal(observation.slug, SLUG);
      console.log("scenario (6b) allowed submit script persists observation: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tools: [
          { name: "mcp__job_playwright__browser_navigate", arguments: { url: "https://example.invalid/redirect" } },
          clickTool,
        ] },
        { text: "done" },
      ]);
      assert.match(transcriptText(events), /Page URL: http:\/\/127\.0\.0\.1:4747\//, "expected navigation to report its dashboard landing page");
      assert(hasBlockCode(events, "BROWSER_BUSY") || hasBlockCode(events, "OFF_PIPELINE_BROWSER"), "expected BROWSER_BUSY or OFF_PIPELINE_BROWSER");
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (6c) same-batch dashboard redirect: ok");
    }

    console.log("scenario (7) codemode inner: skipped (T0: MCP exposure is direct)");

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        {
          tool: {
            name: "mcp__job_playwright__browser_run_code_unsafe",
            arguments: { code: "async () => ({})" },
          },
        },
        { text: "done" },
      ]);
      assert(hasBlockCode(events, "UNSAFE_CODE"));
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (7b) inline UNSAFE_CODE: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const throwingExt = path.join(root, "scripts/fixtures/pjr15-throwing-tool-call.ts");
      const events = await runWithModel(
        app,
        home,
        agentDir,
        runDir,
        runId,
        fixtureBase,
        [{ tool: clickTool }, { text: "done" }],
        { extraArgs: ["-e", throwingExt], extraEnv: { PJR15_THROWING_GUARD: "1" } },
      );
      assert.match(transcriptText(events), /pjr15 throwing tool_call handler/i);
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (8) throwing handler: ok");
    }

    await resetFixtureCount(fixtureBase);
    {
      const { home, app, agentDir, runDir, runId } = await prepareApp(temp, 1);
      await writeQueue(app);
      await writeState(app, ackedState());
      const events = await runWithModel(app, home, agentDir, runDir, runId, fixtureBase, [
        { tool: { name: "mcp__job_playwright__browser_navigate", arguments: { url: "https://redirect.example.invalid/" } } },
        { tool: clickTool },
        { text: "done" },
      ]);
      assert.match(transcriptText(events), /Page URL: http:\/\/127\.0\.0\.1:4747\//);
      assert(hasBlockCode(events, "OFF_PIPELINE_BROWSER"), "expected OFF_PIPELINE_BROWSER after dashboard redirect");
      assert.equal(await readFixtureCount(fixtureBase), 0);
      console.log("scenario (9) dashboard redirect blocks click, 0 submits: ok");
    }

    if (process.platform !== "win32") {
      await scenarioT6DashboardApi(temp, fixtureBase);
    } else {
      console.log("scenario (T6.1-5) dashboard API: skipped on win32");
    }

    console.log("submission-smoke passed (real pi 1.0.4 + stub MCP + scripted model)");
  } finally {
    await closeFixture(fixtureServer);
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
