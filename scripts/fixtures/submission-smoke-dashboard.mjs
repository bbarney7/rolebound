#!/usr/bin/env node
/**
 * Dashboard + real pi helpers for submission-smoke T6 API scenarios.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFreshAppDirectory } from "./app-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const profileFixture = path.join(here, "submission-smoke-profile.md");
export const LOCK_STALE_MS = 10_000;
const MODEL_ID = "scripted";

export const clickTool = {
  name: "mcp__job_playwright__browser_click",
  arguments: { element: "Submit application", ref: "e1" },
};

export const typeTool = {
  name: "mcp__job_playwright__browser_type",
  arguments: { element: "Name field", ref: "e2", text: "Jane Doe" },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function isGroupAlive(pid) {
  if (process.platform === "win32" || !pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function killOwnedGroup(pid) {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseURL, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`health check timed out for ${baseURL}`);
}

export function createCaptchaProbeServer() {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return {
    server,
    getRequestCount: () => requests,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * @param {string} tempParent
 * @param {{ fixtureBase?: string }} [options]
 */
export async function prepareDashboardWorkspace(tempParent, options = {}) {
  const { home, app } = await buildFreshAppDirectory(repoRoot, tempParent);
  await fs.mkdir(path.join(app, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(app, "screenshots", "acme-role-confirmation.png"), "png-bytes\n");
  await fs.writeFile(path.join(app, "resumes", "default.pdf"), "stub resume\n");
  await fs.copyFile(profileFixture, path.join(app, "profile.md"));
  await fs.writeFile(path.join(app, "targets.md"), "# greenhouse\n- acme\n", "utf8");
  return { home, app, emptyAgentDir: path.join(tempParent, "pi-coding-agent-empty") };
}

export async function writeAckedState(app, overrides = {}) {
  await fs.writeFile(
    path.join(app, "state.json"),
    `${JSON.stringify(
      {
        acknowledged_at: "2026-01-01T00:00:00.000Z",
        acknowledged_policy: "auto-submit-v1",
        applications: [],
        addresses: { denver: { street: "100 Test St", city: "Denver", state: "CO", zip: "80202" } },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function writeQueue(app, slug = "acme-role") {
  await fs.writeFile(
    path.join(app, "jobs", "queue", `${slug}.md`),
    `---
url: https://boards.example.invalid/boards/fixture/jobs/1234567
company: Fixture
title: Role
location: Remote
---
`,
    "utf8",
  );
}

/**
 * @param {object} options
 * @param {string} options.app
 * @param {string} options.home
 * @param {string} options.modelOrigin
 * @param {string} [options.fixtureBase]
 * @param {Record<string, string>} [options.extraEnv]
 */
export async function startDashboardServer(options) {
  const { app, home, modelOrigin, fixtureBase, extraEnv = {} } = options;
  const emptyAgentDir = options.emptyAgentDir ?? path.join(path.dirname(app), "pi-coding-agent-empty");
  await fs.mkdir(emptyAgentDir, { recursive: true });
  const port = await pickPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const serverChild = spawn(process.execPath, [tsx, "server/index.ts"], {
    cwd: path.join(repoRoot, "ui"),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: emptyAgentDir,
      PI_JOBS_ROOT: app,
      PI_JOBS_PORT: String(port),
      NO_EXTERNAL_CALLS: "1",
      PI_OFFLINE: "1",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      CAPSOLVER_API_KEY: "",
      TWOCAPTCHA_API_KEY: "",
      ...(fixtureBase ? { PJR15_FIXTURE_URL: fixtureBase } : {}),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(baseURL);
  return {
    baseURL,
    port,
    serverChild,
    serverPgid: serverChild.pid,
    async stop() {
      try {
        const pid = await readRunManagerPid(app);
        killOwnedGroup(pid);
      } catch {
        // no active run metadata
      }
      if (serverChild.exitCode === null && !serverChild.killed) {
        try {
          if (process.platform !== "win32" && serverChild.pid) process.kill(-serverChild.pid, "SIGTERM");
          else serverChild.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([
          new Promise((resolve) => serverChild.once("exit", resolve)),
          sleep(5_000),
        ]);
        if (serverChild.exitCode === null && process.platform !== "win32" && serverChild.pid) {
          killOwnedGroup(serverChild.pid);
        }
      }
    },
    async killGroup() {
      killOwnedGroup(serverChild.pid);
      await sleep(200);
    },
  };
}

async function sessionHeaders(baseURL, method = "POST") {
  const { csrfToken } = await fetch(`${baseURL}/api/session`).then((r) => r.json());
  return {
    "content-type": "application/json",
    "x-pi-jobs-csrf": csrfToken,
  };
}

export async function rewireScriptedAgent(baseURL, modelOrigin) {
  const list = await fetch(`${baseURL}/api/connections`).then((r) => r.json());
  const conn = list.data?.connections?.[0];
  if (!conn?.id) return wireScriptedAgent(baseURL, modelOrigin);
  const res = await fetch(`${baseURL}/api/connections/${conn.id}`, {
    method: "PUT",
    headers: await sessionHeaders(baseURL, "PUT"),
    body: JSON.stringify({
      expectedRevision: list.revision,
      label: conn.label,
      provider: conn.provider,
      baseUrl: modelOrigin,
    }),
  });
  if (!res.ok) {
    throw new Error(`rewire connection failed: ${res.status} ${await res.text()}`);
  }
}

export async function wireScriptedAgent(baseURL, modelOrigin) {
  const list = await fetch(`${baseURL}/api/connections`).then((r) => r.json());
  const agentSel = list.data?.agent;
  if (agentSel?.modelId === MODEL_ID && agentSel.connectionId) {
    const known = list.data?.connections?.some((c) => c.id === agentSel.connectionId);
    if (known) return;
  }
  const { revision } = list;
  const created = await fetch(`${baseURL}/api/connections`, {
    method: "POST",
    headers: await sessionHeaders(baseURL),
    body: JSON.stringify({
      expectedRevision: revision,
      label: "Submission smoke scripted",
      provider: "openai-compatible",
      baseUrl: modelOrigin,
      apiKey: "smoke-key",
    }),
  });
  if (created.status !== 201) {
    throw new Error(`create connection failed: ${created.status} ${await created.text()}`);
  }
  const { revision: rev2, connectionId } = await created.json();
  const sel = await fetch(`${baseURL}/api/connections/selections`, {
    method: "PUT",
    headers: await sessionHeaders(baseURL, "PUT"),
    body: JSON.stringify({
      expectedRevision: rev2,
      agent: { connectionId, modelId: MODEL_ID },
      scoring: null,
    }),
  });
  if (sel.status !== 200) {
    throw new Error(`selections failed: ${sel.status} ${await sel.text()}`);
  }
}

export async function postRun(baseURL, body) {
  const res = await fetch(`${baseURL}/api/runs`, {
    method: "POST",
    headers: await sessionHeaders(baseURL),
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}

export async function postApplyRun(baseURL, slug) {
  let attempt = await postRun(baseURL, { kind: "apply", slug });
  if (attempt.res.status === 409) {
    await sleep(LOCK_STALE_MS + 500);
    attempt = await postRun(baseURL, { kind: "apply", slug });
  }
  return attempt;
}

export async function postUiResponse(baseURL, runId, body) {
  return fetch(`${baseURL}/api/runs/${runId}/ui-response`, {
    method: "POST",
    headers: await sessionHeaders(baseURL),
    body: JSON.stringify(body),
  });
}

export async function postAbort(baseURL, runId) {
  return fetch(`${baseURL}/api/runs/${runId}/abort`, {
    method: "POST",
    headers: await sessionHeaders(baseURL),
  });
}

export async function postFinish(baseURL, runId) {
  return fetch(`${baseURL}/api/runs/${runId}/finish`, {
    method: "POST",
    headers: await sessionHeaders(baseURL),
  });
}

export async function waitForMinFixtureSubmits(fixtureBase, minSubmits = 1, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { submitCount } = await fetch(`${fixtureBase}/counts`).then((r) => r.json());
    if ((submitCount ?? 0) >= minSubmits) return submitCount;
    await sleep(100);
  }
  throw new Error("timed out waiting for fixture submit");
}

export async function readCurrent(baseURL) {
  const res = await fetch(`${baseURL}/api/runs/current`);
  return res.json();
}

export async function waitForRunStatus(baseURL, status, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await readCurrent(baseURL);
    if (payload.run?.status === status) return payload;
    if (!payload.run && (status === "done" || status === "stopped")) return payload;
    await sleep(50);
  }
  throw new Error(`timed out waiting for run status ${status}`);
}

export async function waitForUiRequest(baseURL, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await readCurrent(baseURL);
    const hit = payload.events?.find((e) => e.type === "ui_request" && predicate(e));
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error("timed out waiting for ui_request");
}

export async function waitForEvent(baseURL, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await readCurrent(baseURL);
    const hit = payload.events?.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error("timed out waiting for run event");
}

export async function readRunManager(app) {
  const raw = await fs.readFile(path.join(app, "ui", "run-manager.json"), "utf8");
  return JSON.parse(raw);
}

export async function readRunManagerPid(app) {
  const data = await readRunManager(app);
  return data.pid ?? null;
}

export async function readScriptedRequests(modelPort) {
  const res = await fetch(`http://127.0.0.1:${modelPort}/__test__/requests`);
  return res.json();
}

export function transcriptHasCode(events, code) {
  return JSON.stringify(events ?? []).includes(code);
}

export async function waitForFillCount(fixtureBase, min = 1, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${fixtureBase}/counts`);
    const body = await res.json();
    if ((body.fillCount ?? 0) >= min) return body.fillCount;
    await sleep(50);
  }
  throw new Error("timed out waiting for stub fill call");
}

export async function waitForObservationFile(app, slug, timeoutMs = 120_000) {
  const file = path.join(app, ".pi-jobs", "observed", `${slug}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(file, "utf8");
      if (text.trim()) return JSON.parse(text);
    } catch {
      // retry
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for observation ${file}`);
}

export function runDoctorReadiness(appRoot, repair = false) {
  const doctorMts = path.join(repoRoot, "scripts/doctor-readiness.mts");
  const args = [doctorMts, appRoot, "--port", "14899"];
  if (repair) args.push("--repair");
  try {
    return execFileSync(process.execPath, [tsx, ...args], {
      encoding: "utf8",
      cwd: repoRoot,
      env: process.env,
    });
  } catch (err) {
    if (err.stdout || err.stderr) return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    throw err;
  }
}

export function piPgidFromPid(pid) {
  if (!pid || process.platform === "win32") return pid;
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return pid;
  }
}

export function assertNoOwnedProcessSurvives(serverPgid, piPid) {
  if (process.platform === "win32") return;
  if (serverPgid && isGroupAlive(serverPgid)) {
    throw new Error(`dashboard process group ${serverPgid} still alive`);
  }
  const piGroup = piPgidFromPid(piPid);
  if (piPid && (isAlive(piPid) || isGroupAlive(piGroup))) {
    throw new Error(`pi process/group still alive (pid=${piPid}, pgid=${piGroup})`);
  }
}
