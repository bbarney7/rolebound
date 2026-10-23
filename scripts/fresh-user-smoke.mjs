#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPortReleased,
  freePort,
  launch,
  stopChild,
  waitFor,
} from "./smoke-support.mjs";

export const HOSTILE_AUTH_FAKE_KEY = "fresh-user-hostile-global-auth-pjr23";

/** Scaffold readiness codes on a fresh `npm run setup` workspace (recorded from shipped doctor). */
export const SCAFFOLD_BLOCKER_CODES = [
  "AGENT_MODEL_MISSING",
  "NAME_MISSING",
  "EMAIL_MISSING",
  "PROFILE_PLACEHOLDERS",
  "RESUME_MISSING",
  "TARGETS_PLACEHOLDER",
  "ACKNOWLEDGEMENT_MISSING",
];

const SETUP_FILES = ["profile.md", "targets.md", "settings.json", "state.json"];

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex < 0 || !argv[rootIndex + 1]) {
    console.error("Usage: npm run fresh-user-smoke -- --root <exported-candidate-dir>");
    process.exit(2);
  }
  const workspaceRoot = path.resolve(argv[rootIndex + 1]);
  if (!fs.existsSync(workspaceRoot)) {
    console.error(`fresh-user-smoke: --root does not exist: ${workspaceRoot}`);
    process.exit(2);
  }
  return { workspaceRoot };
}

export async function loadScrubEnvNames(workspaceRoot) {
  const tsx = path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const snippet = `
import { ALL_SCRUB_ENV_NAMES } from "./ui/shared/providerCatalog.ts";
import { PROVIDER_ENV_VARS } from "./.pi/extensions/lib/captcha.ts";
const names = [...new Set([...ALL_SCRUB_ENV_NAMES, ...Object.values(PROVIDER_ENV_VARS)])];
process.stdout.write(JSON.stringify(names));
`;
  const result = spawnSync(process.execPath, [tsx, "--eval", snippet], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`loadScrubEnvNames failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

export function buildChildEnv({ workspaceRoot, home, piAgentDir, scrubNames, parentEnv = process.env }) {
  const env = { ...parentEnv, HOME: home, PI_CODING_AGENT_DIR: piAgentDir };
  for (const name of scrubNames) {
    delete env[name];
  }
  delete env.PI_JOBS_ROOT;
  return env;
}

function runSync(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  return result;
}

export function parseDoctorBlockers(stdout) {
  const blockers = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^BLOCKED ([A-Z0-9_]+): (.*)$/.exec(line.trim());
    if (!match) continue;
    const code = match[1];
    if (code === "capability" || code.startsWith("setup")) continue;
    if (!blockers.has(code)) blockers.set(code, match[2]);
  }
  return blockers;
}

export function readinessBlockerCodes(payload) {
  const codes = new Set();
  for (const step of payload.steps ?? []) {
    for (const blocker of step.blockers ?? []) codes.add(blocker.code);
  }
  for (const blocker of payload.scoreBlockers ?? []) codes.add(blocker.code);
  return codes;
}

function assertScaffoldBlockers(blockers, label) {
  for (const code of SCAFFOLD_BLOCKER_CODES) {
    assert.ok(blockers.has(code), `${label}: missing scaffold blocker ${code}`);
  }
}

function readBytes(filePath) {
  return fs.readFileSync(filePath);
}

async function listenForeign(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("foreign");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function closeHttpServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function walkFiles(root, skip = new Set(["node_modules"])) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(root);
  return files;
}

async function snapshotTree(root) {
  const files = await walkFiles(root);
  const snap = new Map();
  for (const file of files) {
    snap.set(file, await fs.promises.readFile(file));
  }
  return snap;
}

function filesChanged(before, after) {
  const changed = [];
  for (const [file, buf] of after) {
    const prev = before.get(file);
    if (!prev || !buf.equals(prev)) changed.push(file);
  }
  return changed;
}

async function grepFilesForNeedle(files, needle) {
  const hits = [];
  for (const file of files) {
    const text = await fs.promises.readFile(file, "utf8");
    if (text.includes(needle)) hits.push(file);
  }
  return hits;
}

async function createApiClient(base) {
  const port = new URL(base).port;
  const host = `127.0.0.1:${port}`;
  const session = await fetch(`${base}/api/session`, { headers: { host } });
  assert.equal(session.status, 200);
  const { csrfToken } = await session.json();
  return {
    host,
    csrfToken,
    async json(path, init = {}) {
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      headers.set("host", host);
      if (init.body) headers.set("content-type", "application/json");
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers.set("x-pi-jobs-csrf", csrfToken);
      }
      const res = await fetch(`${base}${path}`, { ...init, method, headers });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { res, body };
    },
  };
}

export async function runFreshUserSmoke(workspaceRoot) {
  const scrubNames = await loadScrubEnvNames(workspaceRoot);
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rolebound-fresh-home-"));
  const piAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rolebound-fresh-pi-agent-"));
  const probeBin = path.join(home, "probe-bin");
  const securityMarker = path.join(home, "security-probe-ran");
  const ghMarker = path.join(home, "gh-probe-ran");
  await fs.promises.mkdir(probeBin, { recursive: true });
  for (const [name, marker] of [["security", securityMarker], ["gh", ghMarker]]) {
    const executable = path.join(probeBin, name);
    await fs.promises.writeFile(executable, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  }
  await fs.promises.mkdir(path.join(home, ".config/gh"), { recursive: true });
  await fs.promises.writeFile(path.join(home, ".config/gh/hosts.yml"), "github.com:\n  user: smoke-fixture\n");
  const env = buildChildEnv({
    workspaceRoot,
    home,
    piAgentDir,
    scrubNames,
    parentEnv: { ...process.env, PATH: `${probeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });

  // Step 1 — setup twice, byte-stable scaffold files
  for (let pass = 1; pass <= 2; pass += 1) {
    const setup = runSync("npm", ["run", "setup"], { cwd: workspaceRoot, env });
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  }
  const firstPass = {};
  for (const name of SETUP_FILES) {
    firstPass[name] = readBytes(path.join(workspaceRoot, name));
  }
  const setupAgain = runSync("npm", ["run", "setup"], { cwd: workspaceRoot, env });
  assert.equal(setupAgain.status, 0, setupAgain.stderr || setupAgain.stdout);
  for (const name of SETUP_FILES) {
    const next = readBytes(path.join(workspaceRoot, name));
    assert.ok(firstPass[name].equals(next), `${name} changed after second setup`);
  }

  // Step 2 — build
  const build = runSync("npm", ["run", "build"], { cwd: workspaceRoot, env });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  // Step 3 — doctor on fresh scaffold
  const port = await freePort();
  const doctor = runSync("npm", ["run", "doctor", "--", "--port", String(port)], { cwd: workspaceRoot, env });
  assert.equal(doctor.status, 1, doctor.stdout);
  const recordedBlockers = parseDoctorBlockers(doctor.stdout);
  assertScaffoldBlockers(recordedBlockers, "doctor");

  // Step 4 — start, health/readiness/dashboard, SIGINT, port released
  const serverRun = launch("npm", ["start", "--", "--port", String(port)], { cwd: workspaceRoot, env, detached: true });
  try {
    const base = `http://127.0.0.1:${port}`;
    const { body: health } = await waitFor(`${base}/api/health`, (res, text) => res.status === 200 && text.includes('"ok":true'));
    assert.equal(
      fs.realpathSync.native(health.root),
      fs.realpathSync.native(workspaceRoot),
    );
    const readinessRes = await fetch(`${base}/api/readiness`);
    assert.equal(readinessRes.status, 200);
    const readiness = await readinessRes.json();
    const readinessCodes = readinessBlockerCodes(readiness);
    for (const code of SCAFFOLD_BLOCKER_CODES) {
      assert.ok(readinessCodes.has(code), `readiness missing ${code}`);
    }
    for (const [code, message] of recordedBlockers) {
      if (!SCAFFOLD_BLOCKER_CODES.includes(code)) continue;
      const stepHit = readiness.steps.some((step) => step.blockers.some((b) => b.code === code && b.message === message));
      const scoreHit = readiness.scoreBlockers?.some((b) => b.code === code && b.message === message);
      assert.ok(stepHit || scoreHit, `readiness message drift for ${code}`);
    }
    const dashboard = await fetch(`${base}/`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /<html/i);
    const detectedRes = await fetch(`${base}/api/providers/detected`);
    assert.equal(detectedRes.status, 200);
    const detectedBody = await detectedRes.json();
    assert.deepEqual(detectedBody, []);
    assert.equal(fs.existsSync(ghMarker), true, "fresh smoke did not use the stub gh probe");
    if (process.platform === "darwin") {
      assert.equal(fs.existsSync(securityMarker), true, "fresh smoke did not use the stub security probe");
    }
    await stopChild(serverRun, "SIGINT");
    await assertPortReleased(port);
  } finally {
    await stopChild(serverRun, "SIGTERM", false);
  }

  // Step 5 — occupied port: npm start exits 1; doctor reports port blocker
  const occupiedPort = await freePort();
  const foreign = await listenForeign(occupiedPort);
  try {
    const occupiedStart = launch("npm", ["start", "--", "--port", String(occupiedPort)], { cwd: workspaceRoot, env });
    const startFailure = await occupiedStart.closed;
    assert.equal(startFailure.code, 1);
    assert.match(occupiedStart.output(), /already in use/);
    const doctorOccupied = runSync("npm", ["run", "doctor", "--", "--port", String(occupiedPort)], {
      cwd: workspaceRoot,
      env,
    });
    assert.equal(doctorOccupied.status, 1);
    assert.match(
      doctorOccupied.stdout,
      new RegExp(`BLOCKED port ${occupiedPort}: in use — stop the other process or run npm start -- --port <n>`),
    );
  } finally {
    await closeHttpServer(foreign);
  }

  // Step 6 — hostile global auth ignored; credential-required connection without key
  const hostileAgentDir = path.join(home, ".pi", "agent");
  await fs.promises.mkdir(hostileAgentDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(hostileAgentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: HOSTILE_AUTH_FAKE_KEY } }),
    { mode: 0o600 },
  );
  const authPort = await freePort();
  const beforeServer = await snapshotTree(workspaceRoot);
  const authServer = launch("npm", ["start", "--", "--port", String(authPort)], { cwd: workspaceRoot, env, detached: true });
  try {
    const base = `http://127.0.0.1:${authPort}`;
    await waitFor(`${base}/api/health`, (res) => res.status === 200);
    const api = await createApiClient(base);
    let { body: readiness } = await api.json("/api/readiness");
    assert.ok(readinessBlockerCodes(readiness).has("AGENT_MODEL_MISSING"));
    let { body: connections } = await api.json("/api/connections");
    let { revision } = connections;
    let created = await api.json("/api/connections", {
      method: "POST",
      body: JSON.stringify({ label: "OpenAI agent", provider: "openai", expectedRevision: revision }),
    });
    assert.equal(created.res.status, 201, JSON.stringify(created.body));
    revision = created.body.revision;
    const selected = await api.json("/api/connections/selections", {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: revision,
        agent: { connectionId: created.body.connectionId, modelId: "gpt-4o-mini" },
        scoring: null,
      }),
    });
    assert.equal(selected.res.status, 200, JSON.stringify(selected.body));
    ({ body: readiness } = await api.json("/api/readiness"));
    assert.ok(readinessBlockerCodes(readiness).has("CREDENTIAL_MISSING"));
    const afterServer = await snapshotTree(workspaceRoot);
    const changed = filesChanged(beforeServer, afterServer);
    const leaks = await grepFilesForNeedle(changed, HOSTILE_AUTH_FAKE_KEY);
    assert.deepEqual(leaks, [], `hostile auth key leaked into workspace files: ${leaks.join(", ")}`);
  } finally {
    await stopChild(authServer, "SIGTERM", false);
  }

  console.log("fresh-user smoke passed: setup idempotence, doctor scaffold, server lifecycle, port safety, auth isolation");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { workspaceRoot } = parseArgs(process.argv.slice(2));
  runFreshUserSmoke(workspaceRoot).catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
