#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFreshAppDirectory } from "../../scripts/fixtures/app-dir.mjs";
import { createBackup, restoreBackup } from "../../scripts/workspace.mjs";
import {
  close as closeModel,
  createScriptedModelServer,
  listen as listenModel,
} from "../../scripts/fixtures/scripted-model.mjs";
import {
  close as closeFixture,
  createSubmissionSmokeFixtureServer,
  listen as listenFixture,
} from "../../scripts/fixtures/submission-smoke-fixture-server.mjs";
import {
  closeAtsJsonFixtureServer,
  createAtsJsonFixtureServer,
  listenAtsJsonFixtureServer,
} from "./fixtures/ats-json/server.mjs";
import { buildChildEnv, loadScrubEnvNames } from "../../scripts/fresh-user-smoke.mjs";

const FIXTURE_SECRET = "FIXTURE-SECRET-do-not-leak";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const uiRoot = path.join(repoRoot, "ui");
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

export const FRESH_MODEL_ID = "fresh-scripted";

function pickPort() {
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

function waitForHealth(baseURL, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseURL}/api/health`);
        if (res.ok) return;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`health check timed out for ${baseURL}`);
  })();
}

function createCaptchaProbeServer() {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return {
    server,
    getRequestCount: () => requests,
  };
}

/**
 * @param {import('fs').WatchListener<string>} listener
 */
export function watchStopMarker(appRoot, runId, listener) {
  const stopPath = path.join(appRoot, ".pi-jobs", "runs", runId, "stop.json");
  const parent = path.dirname(stopPath);
  return fs
    .mkdir(parent, { recursive: true })
    .then(() => import("node:fs"))
    .then((fsSync) => {
      const watcher = fsSync.watch(parent, (event, file) => {
        if (file === "stop.json" || event === "rename") {
          listener(event, file ?? "stop.json");
        }
      });
      return watcher;
    });
}

/**
 * @param {import("./fresh-fixture.ts").SeedLoginsOptions | undefined} seedLogins
 * @param {string} home
 */
async function seedLoginFixtures(home, seedLogins) {
  if (!seedLogins) return;
  if (seedLogins.cursorSdk) {
    await fs.mkdir(path.join(home, ".cursor/sdk"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".cursor/sdk/auth.json"),
      JSON.stringify({
        version: 1,
        apiKey: FIXTURE_SECRET,
        backendUrl: "https://api2.cursor.sh",
        email: "dev@example.com",
        createdAtMs: Date.now(),
        apiKeyExpiresAtMs: Date.now() + 86_400_000,
      }),
      "utf8",
    );
  }
  if (seedLogins.piAuth) {
    await fs.mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".pi/agent/auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE_SECRET } }),
      "utf8",
    );
  }
  if (seedLogins.claudeCode) {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude/.credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE_SECRET } }),
      "utf8",
    );
  }
  if (seedLogins.codex) {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codex/auth.json"),
      JSON.stringify({ tokens: { refresh_token: FIXTURE_SECRET } }),
      "utf8",
    );
  }
  if (seedLogins.ghHosts) {
    await fs.mkdir(path.join(home, ".config/gh"), { recursive: true });
    await fs.writeFile(path.join(home, ".config/gh/hosts.yml"), "github.com:\n  user: fixture-user\n", "utf8");
  }
}

/**
 * @param {{
 *   scriptedSteps?: Array<Record<string, unknown>>;
 *   modelIds?: string[];
 *   withSubmissionFixture?: boolean;
 *   withCaptchaProbe?: boolean;
 *   seedLogins?: import("./fresh-fixture.ts").SeedLoginsOptions;
 * }} [options]
 */
export async function startFreshWorkspace(options = {}) {
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-fresh-e2e-"));
  const { home, app } = await buildFreshAppDirectory(repoRoot, tempParent);
  const emptyAgentDir = path.join(tempParent, "pi-coding-agent-empty");
  await fs.mkdir(emptyAgentDir, { recursive: true });
  const scrubNames = await loadScrubEnvNames(repoRoot);
  let childEnv = buildChildEnv({
    workspaceRoot: repoRoot,
    home,
    piAgentDir: emptyAgentDir,
    scrubNames,
    parentEnv: process.env,
  });
  await seedLoginFixtures(home, options.seedLogins);

  const atsServer = createAtsJsonFixtureServer();
  await listenAtsJsonFixtureServer(atsServer);
  const atsOrigin = `http://127.0.0.1:${atsServer.address().port}`;

  const scripted = createScriptedModelServer({
    modelIds: options.modelIds ?? [FRESH_MODEL_ID],
    steps: options.scriptedSteps ?? [],
  });
  await listenModel(scripted);
  const modelOrigin = `http://127.0.0.1:${scripted.address().port}`;

  let fixtureServer;
  let fixtureBase;
  if (options.withSubmissionFixture) {
    const bundle = createSubmissionSmokeFixtureServer();
    fixtureServer = bundle.server;
    await listenFixture(fixtureServer);
    fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
  }

  let captchaProbe;
  if (options.withCaptchaProbe) {
    captchaProbe = createCaptchaProbeServer();
    await new Promise((resolve, reject) => {
      captchaProbe.server.once("error", reject);
      captchaProbe.server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  const port = await pickPort();
  const baseURL = `http://127.0.0.1:${port}`;

  childEnv = {
    ...childEnv,
    PI_JOBS_ROOT: app,
    PI_JOBS_PORT: String(port),
    PI_JOBS_ATS_FIXTURE_ORIGIN: atsOrigin,
    PI_OAUTH_CALLBACK_HOST: "127.0.0.1",
    PI_JOBS_E2E_NODE_MAJOR: "24",
    ...(options.seedLogins?.ghHosts ? { PI_JOBS_E2E_GH_PROBE: "authenticated" } : {}),
    NO_EXTERNAL_CALLS: "1",
    ...(fixtureBase ? { PJR15_FIXTURE_URL: fixtureBase } : {}),
    ...(captchaProbe
      ? { CAPSOLVER_API_KEY: FIXTURE_SECRET, TWOCAPTCHA_API_KEY: FIXTURE_SECRET }
      : {}),
  };

  const serverChild = spawn(process.execPath, [tsx, "server/e2e-entry.ts"], {
    cwd: uiRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForHealth(baseURL);

  async function stop() {
    if (serverChild.exitCode === null && !serverChild.killed) {
      serverChild.kill("SIGTERM");
      await new Promise((resolve) => serverChild.once("exit", resolve));
    }
    await closeModel(scripted);
    await closeAtsJsonFixtureServer(atsServer);
    if (fixtureServer) await closeFixture(fixtureServer);
    if (captchaProbe) {
      await new Promise((resolve) => captchaProbe.server.close(() => resolve()));
    }
    await fs.rm(tempParent, { recursive: true, force: true });
  }

  async function corruptStateJson() {
    await fs.writeFile(path.join(app, "state.json"), "{ not-json", "utf8");
  }

  async function createStateBackup() {
    return createBackup(app, ["state.json"], "fresh-e2e");
  }

  async function restoreStateBackup(backupId) {
    await restoreBackup(app, backupId);
  }

  async function readScriptedRequests() {
    const res = await fetch(`${modelOrigin}/__test__/requests`);
    return res.json();
  }

  async function resetFixtureSubmitCount() {
    if (!fixtureBase) return;
    await fetch(`${fixtureBase}/reset`, { method: "POST" });
  }

  async function readFixtureSubmitCount() {
    if (!fixtureBase) return 0;
    const res = await fetch(`${fixtureBase}/counts`);
    const body = await res.json();
    return body.submitCount ?? 0;
  }

  function releaseScriptedHold() {
    scripted.releaseHold();
  }

  async function waitForScriptedHoldAndRelease(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (scripted.pendingHolds > 0) {
        scripted.releaseHold();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for scripted model hold");
  }

  async function readRunManagerPid() {
    const raw = await fs.readFile(path.join(app, "ui", "run-manager.json"), "utf8");
    const data = JSON.parse(raw);
    return data.pid ?? null;
  }

  async function runDirExists(runId) {
    try {
      await fs.access(path.join(app, ".pi-jobs", "runs", runId));
      return true;
    } catch {
      return false;
    }
  }

  async function seedApplyQueue(slug = "fresh-apply-role") {
    await fs.writeFile(
      path.join(app, "jobs", "queue", `${slug}.md`),
      `---
url: https://boards.example.invalid/fixture/jobs/1234567
company: Fixture Co
title: Fixture Role
location: Remote
---
Fictional queue posting for fresh run-panel tests.
`,
      "utf8",
    );
  }

  async function seedAcknowledgedState() {
    const statePath = path.join(app, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.acknowledged_at = "2026-01-01T00:00:00.000Z";
    state.acknowledged_policy = "auto-submit-v1";
    state.applications = state.applications ?? [];
    state.addresses = state.addresses ?? { denver: { street: "100 Fresh Test St", city: "Denver", state: "CO", zip: "80202" } };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return {
    baseURL,
    app,
    home,
    atsOrigin,
    modelOrigin,
    fixtureBase,
    scripted,
    captchaProbe,
    stop,
    corruptStateJson,
    createStateBackup,
    restoreStateBackup,
    readScriptedRequests,
    resetFixtureSubmitCount,
    readFixtureSubmitCount,
    releaseScriptedHold,
    waitForScriptedHoldAndRelease,
    readRunManagerPid,
    runDirExists,
    seedApplyQueue,
    seedAcknowledgedState,
  };
}
