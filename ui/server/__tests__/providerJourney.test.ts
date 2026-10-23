import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { ALL_SCRUB_ENV_NAMES } from "../../shared/providerCatalog";
import { FIXTURE_LIVE_SHAPED_PROFILE } from "./helpers";
import type { RunCurrentPayload, RunLogEntry } from "../../shared/types";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TIMEOUT = 180_000;
const MODEL_ID = "scripted";
const HOSTILE_ENV_KEY = "parent-openai-hostile-pjr23";
const HOSTILE_AUTH_KEY = "global-auth-hostile-pjr23";

type ScriptedHandle = {
  baseUrl: string;
  port: number;
  server: http.Server;
  getRequests: () => Promise<Array<{ headers: Record<string, string>; body: string }>>;
  releaseHold: () => void;
  close: () => Promise<void>;
};

type AppCtx = {
  root: string;
  temp: string;
  home: string;
  base: string;
  app: ReturnType<typeof createApp>;
  server: Server;
  keylessEnv: NodeJS.ProcessEnv;
};

const open: AppCtx[] = [];
const scriptedServers: ScriptedHandle[] = [];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scorePayload(score: number, reason: string) {
  return JSON.stringify({ score, reason });
}

async function importScripted() {
  return await import(path.join(REPO, "scripts/fixtures/scripted-model.mjs")) as {
    createScriptedModelServer: (opts: unknown) => http.Server & {
      capturedRequests: unknown[];
      releaseHold: () => void;
    };
    listen: (server: http.Server) => Promise<http.Server>;
    close: (server: http.Server) => Promise<void>;
  };
}

async function startDecisionsServer(
  steps: Array<Record<string, unknown>>,
  decisionsPath = "/api/alpha/decisions",
): Promise<ScriptedHandle & { baseUrl: string }> {
  const mod = await import(path.join(REPO, "scripts/fixtures/fake-decisions-server.mjs")) as {
    createFakeDecisionsServer: (opts: { decisionsPath: string; steps: unknown[] }) => http.Server;
    listen: (server: http.Server) => Promise<http.Server>;
    close: (server: http.Server) => Promise<void>;
  };
  const server = mod.createFakeDecisionsServer({ decisionsPath, steps });
  await mod.listen(server);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}${decisionsPath}`;
  const handle = {
    baseUrl,
    port,
    server,
    async getRequests() {
      const res = await fetch(`http://127.0.0.1:${port}/__test__/requests`);
      return (await res.json()) as Array<{ headers: Record<string, string>; body: string }>;
    },
    releaseHold: () => undefined,
    close: () => mod.close(server),
  };
  scriptedServers.push(handle);
  return handle;
}

async function startScripted(
  steps: Array<Record<string, unknown>>,
  modelIds: string[] = [MODEL_ID],
): Promise<ScriptedHandle> {
  const mod = await importScripted();
  const server = mod.createScriptedModelServer({ modelIds, steps });
  await mod.listen(server);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const handle: ScriptedHandle = {
    baseUrl,
    port,
    server,
    async getRequests() {
      const res = await fetch(`http://127.0.0.1:${port}/__test__/requests`);
      return (await res.json()) as Array<{ headers: Record<string, string>; body: string }>;
    },
    releaseHold: () => server.releaseHold(),
    close: () => mod.close(server),
  };
  scriptedServers.push(handle);
  return handle;
}

function chatCount(requests: Array<{ body: string }>) {
  return requests.length;
}

function allCapturedText(requests: Array<{ headers: Record<string, string>; body: string }>) {
  return JSON.stringify(requests);
}

async function prepareWorkspace(temp: string) {
  const { prepareTempAppDir } = await import(path.join(REPO, "scripts/fixtures/app-dir.mjs")) as {
    prepareTempAppDir: (repo: string, parent: string) => Promise<{ home: string; app: string }>;
  };
  const { home, app } = await prepareTempAppDir(REPO, temp);
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".pi", "agent", "auth.json"),
    `${JSON.stringify({ openai: { type: "api_key", key: HOSTILE_AUTH_KEY } })}\n`,
    { mode: 0o600 },
  );
  await fs.copyFile(path.join(REPO, "templates/settings.json"), path.join(app, "settings.json"));
  await fs.writeFile(path.join(app, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
  await fs.writeFile(path.join(app, "targets.md"), "# greenhouse\n- acme\n");
  await fs.mkdir(path.join(app, "resumes"), { recursive: true });
  await fs.writeFile(path.join(app, "resumes", "default.pdf"), "stub resume\n");
  await fs.writeFile(
    path.join(app, "state.json"),
    `${JSON.stringify({ applications: [], addresses: {} })}\n`,
  );
  return { home, app };
}

function keylessEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(ALL_SCRUB_ENV_NAMES.map((name) => [name, ""]));
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: "",
    PI_OFFLINE: "1",
    OPENAI_API_KEY: HOSTILE_ENV_KEY,
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    ...scrubbed,
    ...extra,
  };
}

async function bootPiApp(appRoot: string, home: string, extra: NodeJS.ProcessEnv = {}): Promise<AppCtx> {
  const temp = path.dirname(appRoot);
  const keyless = keylessEnv(home, extra);
  const app = createApp(appRoot, {
    security: { enabled: false },
    settings: { env: keyless },
    runs: {
      env: keyless,
      idleGraceMs: 2_000,
      killGraceMs: 3_000,
      heartbeatMs: 200,
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const ctx: AppCtx = {
    root: appRoot,
    temp,
    home,
    base: `http://127.0.0.1:${port}`,
    app,
    server,
    keylessEnv: keyless,
  };
  open.push(ctx);
  return ctx;
}

async function getConnections(base: string) {
  const res = await fetch(`${base}/api/connections`);
  const json = (await res.json()) as { revision: string; data: { connections: Array<{ id: string; label: string }> } };
  return json;
}

async function postConnection(
  base: string,
  revision: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(`${base}/api/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, expectedRevision: revision }),
  });
  const json = (await res.json()) as { revision: string; connectionId: string };
  expect(res.status).toBe(201);
  return json;
}

async function putSelections(
  base: string,
  revision: string,
  agent: { connectionId: string; modelId: string },
  scoring: { connectionId: string; modelId: string } | null,
) {
  const res = await fetch(`${base}/api/connections/selections`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: revision, agent, scoring }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { revision: string };
}

async function writeDiscovered(root: string, slug: string, title: string) {
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
  await fs.writeFile(
    path.join(root, "jobs", "discovered", `${slug}.md`),
    `---
url: https://example.invalid/jobs/${slug}
company: Co
title: ${title}
location: Remote
---
Role description for ${title}.
`,
  );
}

async function waitForRunTerminal(base: string, timeoutMs = 120_000): Promise<RunCurrentPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = (await fetch(`${base}/api/runs/current`).then((r) => r.json())) as RunCurrentPayload;
    const status = payload.run?.status;
    if (!payload.run || status === "done" || status === "stopped" || status === "failed") {
      return payload;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for run terminal state (last=${status})`);
    await sleep(100);
  }
}

async function waitForScoreRunComplete(base: string, timeoutMs = 120_000): Promise<RunCurrentPayload> {
  const deadline = Date.now() + timeoutMs;
  let runId: string | undefined;
  for (;;) {
    const payload = (await fetch(`${base}/api/runs/current`).then((r) => r.json())) as RunCurrentPayload;
    runId = payload.run?.runId;
    const toolDone = payload.events.some(
      (e) =>
        (e.type === "tool_end" && e.result.includes("Scoring complete")) ||
        (e.type === "notify" && e.message.includes("Scoring complete.")),
    );
    if (toolDone && payload.run?.status === "waiting" && runId) {
      const fin = await fetch(`${base}/api/runs/${runId}/finish`, { method: "POST" });
      expect(fin.status).toBe(200);
      break;
    }
    if (payload.run?.status === "done") return payload;
    if (Date.now() > deadline) throw new Error(`timed out waiting for score tool (last=${payload.run?.status})`);
    await sleep(100);
  }
  return waitForRunTerminal(base, Math.max(5_000, deadline - Date.now()));
}

async function startScoreRun(base: string, slugs: string[]) {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "score", slugs }),
  });
  return { res, json: await res.json() };
}

function parseAttemptsFromEvents(events: RunLogEntry[]): Record<string, number> {
  const blob = events
    .filter((e) => e.type === "tool_end" || e.type === "notify")
    .map((e) => (e.type === "tool_end" ? e.result : e.message))
    .join("\n");
  if (!blob.includes("Scoring complete")) return {};
  const out: Record<string, number> = {};
  for (const line of blob.split("\n")) {
    const m = line.match(/^- ([^:]+): (\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function setupAgentAndScorer(
  ctx: AppCtx,
  agent: ScriptedHandle,
  scorer: ScriptedHandle,
  agentKey: string,
  scorerKey: string,
  scoringOverride = true,
) {
  let { revision } = await getConnections(ctx.base);
  const agentConn = await postConnection(ctx.base, revision, {
    label: "Agent A",
    provider: "openai-compatible",
    baseUrl: agent.baseUrl,
    apiKey: agentKey,
  });
  revision = agentConn.revision;
  const scorerConn = await postConnection(ctx.base, revision, {
    label: "Scorer B",
    provider: "openai-compatible",
    baseUrl: scorer.baseUrl,
    apiKey: scorerKey,
  });
  revision = scorerConn.revision;
  await putSelections(
    ctx.base,
    revision,
    { connectionId: agentConn.connectionId, modelId: MODEL_ID },
    scoringOverride
      ? { connectionId: scorerConn.connectionId, modelId: MODEL_ID }
      : null,
  );
  return { agentConn, scorerConn };
}

afterEach(async () => {
  for (const handle of scriptedServers.splice(0)) await handle.close();
  for (const ctx of open.splice(0)) {
    await ctx.app.runs.dispose();
    ctx.server.closeAllConnections?.();
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    await fs.rm(ctx.temp, { recursive: true, force: true });
  }
});

describe("provider journey (T5 real run path)", () => {
  it("1 — agent on A, scoring override on B, scores three jobs on B only", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const ok = (n: number) => ({ text: scorePayload(4, `fit ${n}`) });
    const A = await startScripted([ok(1)]);
    const B = await startScripted([ok(1), ok(2), ok(3)]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent-a", "key-scorer-b");
    for (const slug of ["pj-job-a", "pj-job-b", "pj-job-c"]) await writeDiscovered(app, slug, slug);
    const { res } = await startScoreRun(ctx.base, ["pj-job-a", "pj-job-b", "pj-job-c"]);
    expect(res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await A.getRequests())).toBe(0);
    expect(chatCount(await B.getRequests())).toBe(3);
  }, TIMEOUT);

  it("2 — cleared scoring override uses agent connection A", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: scorePayload(3, "agent scores") }]);
    const B = await startScripted([{ text: scorePayload(5, "should not run") }]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent-a", "key-scorer-b", false);
    await writeDiscovered(app, "pj-only", "only");
    const { res } = await startScoreRun(ctx.base, ["pj-only"]);
    expect(res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await A.getRequests())).toBe(1);
    expect(chatCount(await B.getRequests())).toBe(0);
  }, TIMEOUT);

  it("3 — two connections of the same kind carry distinct Authorization headers", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const first = await startScripted([{ text: scorePayload(3, "one") }]);
    const second = await startScripted([{ text: scorePayload(3, "two") }]);
    const ctx = await bootPiApp(app, home);
    let { revision } = await getConnections(ctx.base);
    const c1 = await postConnection(ctx.base, revision, {
      label: "Compat one",
      provider: "openai-compatible",
      baseUrl: first.baseUrl,
      apiKey: "distinct-alpha-key",
    });
    revision = c1.revision;
    const c2 = await postConnection(ctx.base, revision, {
      label: "Compat two",
      provider: "openai-compatible",
      baseUrl: second.baseUrl,
      apiKey: "distinct-beta-key",
    });
    const test1 = await fetch(`${ctx.base}/api/connections/${c1.connectionId}/test`, { method: "POST" });
    const test2 = await fetch(`${ctx.base}/api/connections/${c2.connectionId}/test`, { method: "POST" });
    expect(test1.status).toBe(200);
    expect(test2.status).toBe(200);
    const r1 = await first.getRequests();
    const r2 = await second.getRequests();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]?.headers.authorization).toBe("Bearer distinct-alpha-key");
    expect(r2[0]?.headers.authorization).toBe("Bearer distinct-beta-key");
  }, TIMEOUT);

  it("4b — registry OpenRouter scorer without key blocks readiness and run start", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const ctx = await bootPiApp(app, home);
    let { revision } = await getConnections(ctx.base);
    const agentConn = await postConnection(ctx.base, revision, {
      label: "Loopback agent",
      provider: "openai-compatible",
      baseUrl: A.baseUrl,
      apiKey: "agent-loopback-key",
    });
    revision = agentConn.revision;
    const scorerConn = await postConnection(ctx.base, revision, {
      label: "OpenRouter scorer",
      provider: "openrouter",
      envKeyName: "PJR23_ABSENT_SCORER_KEY",
    });
    revision = scorerConn.revision;
    await putSelections(ctx.base, revision, { connectionId: agentConn.connectionId, modelId: MODEL_ID }, {
      connectionId: scorerConn.connectionId,
      modelId: "anthropic/claude-fable-5",
    });
    const readiness = (await fetch(`${ctx.base}/api/readiness`).then((r) => r.json())) as {
      scoreReady: boolean;
      scoreBlockers: Array<{ code: string; message: string }>;
    };
    expect(readiness.scoreReady).toBe(false);
    expect(readiness.scoreBlockers.some((b) => b.code === "CREDENTIAL_MISSING")).toBe(true);
    const refused = await startScoreRun(ctx.base, ["pj-missing-key"]);
    expect(refused.res.status).toBe(422);
    expect(refused.json.code).toBe("CREDENTIAL_MISSING");
  }, TIMEOUT);

  it("4 — native OpenAI scorer without key blocks readiness and run start", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([{ text: scorePayload(3, "noop") }]);
    const ctx = await bootPiApp(app, home);
    let { revision } = await getConnections(ctx.base);
    const agentConn = await postConnection(ctx.base, revision, {
      label: "Loopback agent",
      provider: "openai-compatible",
      baseUrl: A.baseUrl,
      apiKey: "agent-loopback-key",
    });
    revision = agentConn.revision;
    const scorerConn = await postConnection(ctx.base, revision, {
      label: "Paid scorer",
      provider: "openai",
    });
    revision = scorerConn.revision;
    await putSelections(ctx.base, revision, { connectionId: agentConn.connectionId, modelId: MODEL_ID }, {
      connectionId: scorerConn.connectionId,
      modelId: "gpt-4o-mini",
    });
    const readiness = (await fetch(`${ctx.base}/api/readiness`).then((r) => r.json())) as {
      scoreReady: boolean;
      scoreBlockers: Array<{ code: string; message: string }>;
    };
    expect(readiness.scoreReady).toBe(false);
    expect(readiness.scoreBlockers.some((b) => b.code === "CREDENTIAL_MISSING" && b.message.includes("Paid scorer"))).toBe(
      true,
    );
    const refused = await startScoreRun(ctx.base, ["pj-missing-key"]);
    expect(refused.res.status).toBe(422);
    expect(refused.json.code).toBe("CREDENTIAL_MISSING");
    expect(chatCount(await A.getRequests())).toBe(0);
    expect(chatCount(await B.getRequests())).toBe(0);
  }, TIMEOUT);

  it("5 — scorer 401 is credential rejection with a single attempt", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([{ httpStatus: 401, rawBody: '{"error":"nope"}' }]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent", "bad-scorer-key");
    await writeDiscovered(app, "pj-401", "auth fail");
    const { res } = await startScoreRun(ctx.base, ["pj-401"]);
    expect(res.status).toBe(201);
    const payload = await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await B.getRequests())).toBe(1);
    const text = payload.events.map((e) => JSON.stringify(e)).join("\n");
    expect(text.toLowerCase()).toMatch(/rejected the credential/);
    const raw = await fs.readFile(path.join(app, "jobs", "discovered", "pj-401.md"), "utf8");
    expect(raw).not.toMatch(/llm_score:/);
  }, TIMEOUT);

  it("6 — scorer 429 then 200 retries once (attempts: 2)", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([
      { httpStatus: 429, rawBody: "rate limited" },
      { text: scorePayload(4, "after retry") },
    ]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent", "key-scorer");
    await writeDiscovered(app, "pj-retry", "retry");
    const { res } = await startScoreRun(ctx.base, ["pj-retry"]);
    expect(res.status).toBe(201);
    const payload = await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await B.getRequests())).toBe(2);
    const attempts = parseAttemptsFromEvents(payload.events);
    expect(attempts["pj-retry"]).toBe(2);
    const raw = await fs.readFile(path.join(app, "jobs", "discovered", "pj-retry.md"), "utf8");
    expect(raw).toMatch(/llm_score: 4/);
  }, TIMEOUT);

  it("7 — malformed scorer JSON stays unscored until a valid rerun", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const longReason = "x".repeat(1001);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([
      { text: '{"score":7,"reason":"bad scale"}' },
      { rawBody: "not-json", httpStatus: 200 },
      { text: JSON.stringify({ score: 3, reason: longReason }) },
    ]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent", "key-scorer");
    for (const slug of ["pj-bad-scale", "pj-bad-json", "pj-bad-len"]) {
      await writeDiscovered(app, slug, slug);
    }
    const first = await startScoreRun(ctx.base, ["pj-bad-scale", "pj-bad-json", "pj-bad-len"]);
    expect(first.res.status).toBe(201);
    const firstPayload = await waitForScoreRunComplete(ctx.base);
    const blob = firstPayload.events.map((e) => JSON.stringify(e)).join("\n");
    expect(blob.toLowerCase()).toMatch(/invalid scoring json/);
    for (const slug of ["pj-bad-scale", "pj-bad-json", "pj-bad-len"]) {
      const raw = await fs.readFile(path.join(app, "jobs", "discovered", `${slug}.md`), "utf8");
      expect(raw).not.toMatch(/llm_score:/);
    }
    await B.close();
    const B2 = await startScripted([
      { text: scorePayload(5, "ok a") },
      { text: scorePayload(5, "ok b") },
      { text: scorePayload(5, "ok c") },
    ]);
    const after = await getConnections(ctx.base);
    const scorer = after.data.connections.find((c) => c.label === "Scorer B");
    expect(scorer).toBeDefined();
    const updated = await fetch(`${ctx.base}/api/connections/${scorer!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: after.revision,
        label: "Scorer B",
        provider: "openai-compatible",
        baseUrl: B2.baseUrl,
        apiKey: "key-scorer",
      }),
    });
    expect(updated.status).toBe(200);
    const rerun = await startScoreRun(ctx.base, ["pj-bad-scale", "pj-bad-json", "pj-bad-len"]);
    expect(rerun.res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await B2.getRequests())).toBe(3);
    for (const slug of ["pj-bad-scale", "pj-bad-json", "pj-bad-len"]) {
      const raw = await fs.readFile(path.join(app, "jobs", "discovered", `${slug}.md`), "utf8");
      expect(raw).toMatch(/llm_score: 5/);
    }
  }, TIMEOUT);

  it("8 — abort with two workers keeps only the job scored before abort, rerun finishes the rest", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([
      { text: scorePayload(4, "first done") },
      { holdUntilReleased: true },
      { holdUntilReleased: true },
    ]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent", "key-scorer");
    for (const slug of ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]) await writeDiscovered(app, slug, slug);
    const started = await startScoreRun(ctx.base, ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]);
    expect(started.res.status).toBe(201);
    const runId = (started.json as { runId: string }).runId;
    // Two workers race for B's scripted steps, so either job may receive the one answer.
    // Wait for whichever job is scored first; the other two stay held at the barrier.
    let first: string | null = null;
    const deadline = Date.now() + 90_000;
    while (!first && Date.now() < deadline) {
      for (const slug of ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]) {
        const raw = await fs.readFile(path.join(app, "jobs", "discovered", `${slug}.md`), "utf8");
        if (/llm_score:/.test(raw)) {
          first = slug;
          break;
        }
      }
      if (!first) await sleep(50);
    }
    expect(first).not.toBeNull();
    const abortRes = await fetch(`${ctx.base}/api/runs/${runId}/abort`, { method: "POST" });
    expect(abortRes.status).toBe(200);
    const aborted = await waitForRunTerminal(ctx.base);
    expect(aborted.run?.status).toBe("stopped");
    const scored = new Set<string>();
    for (const slug of ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]) {
      const raw = await fs.readFile(path.join(app, "jobs", "discovered", `${slug}.md`), "utf8");
      if (/llm_score:/.test(raw)) scored.add(slug);
    }
    expect(scored).toEqual(new Set([first!]));
    B.releaseHold();
    B.releaseHold();
    await waitForRunTerminal(ctx.base);
    await sleep(3_500);
    const beforeRerun = chatCount(await B.getRequests());
    await B.close();
    const B2 = await startScripted([
      { text: scorePayload(4, "two") },
      { text: scorePayload(4, "three") },
    ]);
    const conn = await getConnections(ctx.base);
    const scorer = conn.data.connections.find((c) => c.label === "Scorer B");
    expect(scorer).toBeDefined();
    await fetch(`${ctx.base}/api/connections/${scorer!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: conn.revision,
        label: "Scorer B",
        provider: "openai-compatible",
        baseUrl: B2.baseUrl,
        apiKey: "key-scorer",
      }),
    });
    const rerun = await startScoreRun(ctx.base, ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]);
    expect(rerun.res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await B2.getRequests())).toBe(2);
    for (const slug of ["pj-cancel-1", "pj-cancel-2", "pj-cancel-3"]) {
      const raw = await fs.readFile(path.join(app, "jobs", "discovered", `${slug}.md`), "utf8");
      expect(raw).toMatch(/llm_score:/);
    }
  }, TIMEOUT);

  it("9 — new app instance on the same root serves persisted scores", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([{ text: scorePayload(5, "persist me") }]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "key-agent", "key-scorer");
    await writeDiscovered(app, "pj-persist", "persist");
    const { res } = await startScoreRun(ctx.base, ["pj-persist"]);
    expect(res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    await ctx.app.runs.dispose();
    ctx.server.closeAllConnections?.();
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    open.splice(open.indexOf(ctx), 1);
    const ctx2 = await bootPiApp(app, home);
    const list = (await fetch(`${ctx2.base}/api/discoveries?scored=true`).then((r) => r.json())) as {
      items: Array<{ slug: string; llmScore: number; llmReasoning: string; llmScoreTemplate: string }>;
    };
    const item = list.items.find((i) => i.slug === "pj-persist");
    expect(item?.llmScore).toBe(5);
    expect(item?.llmReasoning).toBe("persist me");
    expect(item?.llmScoreTemplate).toBe("job-fit-v1");
  }, TIMEOUT);

  it("10 — ignores hostile global auth and parent OPENAI_API_KEY", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const B = await startScripted([{ text: scorePayload(3, "clean") }]);
    const ctx = await bootPiApp(app, home);
    await setupAgentAndScorer(ctx, A, B, "stored-agent-key-pjr23", "stored-scorer-key-pjr23");
    await writeDiscovered(app, "pj-hostile", "hostile");
    const { res } = await startScoreRun(ctx.base, ["pj-hostile"]);
    expect(res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    const captured = allCapturedText([...(await A.getRequests()), ...(await B.getRequests())]);
    expect(captured).not.toContain(HOSTILE_ENV_KEY);
    expect(captured).not.toContain(HOSTILE_AUTH_KEY);
    expect(captured).toContain("stored-scorer-key-pjr23");
  }, TIMEOUT);

  it("11 — agent on scripted A with OpenRouter Jev scorer uses the decisions API", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pjr23-prov-"));
    const { home, app } = await prepareWorkspace(temp);
    const A = await startScripted([{ text: "noop" }]);
    const probabilities = [0.05, 0.05, 0.05, 0.05, 0.05];
    probabilities[4] = 0.88;
    const Jev = await startDecisionsServer([
      {
        answers: {
          fit: { score: 3.99, probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])) },
          level: 0.9,
          skills: 0.8,
          location: 0.7,
        },
      },
    ]);
    const ctx = await bootPiApp(app, home, { PI_JOBS_JEV_DECISIONS_BASE_URL: Jev.baseUrl });
    let { revision } = await getConnections(ctx.base);
    const agentConn = await postConnection(ctx.base, revision, {
      label: "Agent A",
      provider: "openai-compatible",
      baseUrl: A.baseUrl,
      apiKey: "key-agent-a",
    });
    revision = agentConn.revision;
    const scorerConn = await postConnection(ctx.base, revision, {
      label: "OpenRouter Jev",
      provider: "openrouter",
      apiKey: "openrouter-jev-key",
    });
    revision = scorerConn.revision;
    await putSelections(
      ctx.base,
      revision,
      { connectionId: agentConn.connectionId, modelId: MODEL_ID },
      { connectionId: scorerConn.connectionId, modelId: "typesafe/jev-1.13" },
    );
    await writeDiscovered(app, "pj-jev", "jev");
    const { res } = await startScoreRun(ctx.base, ["pj-jev"]);
    expect(res.status).toBe(201);
    await waitForScoreRunComplete(ctx.base);
    expect(chatCount(await A.getRequests())).toBe(0);
    const jevRequests = await Jev.getRequests();
    expect(jevRequests.length).toBe(1);
    expect(jevRequests[0].headers.authorization).toBe("Bearer openrouter-jev-key");
    const body = JSON.parse(jevRequests[0].body);
    expect(body.model).toBe("typesafe/jev-1.13");
    const raw = await fs.readFile(path.join(app, "jobs", "discovered", "pj-jev.md"), "utf8");
    expect(raw).toMatch(/llm_score: 5/);
    expect(raw).toMatch(/llm_score_template: job-fit-jev-v1/);
  }, TIMEOUT);
});
