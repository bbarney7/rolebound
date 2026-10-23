#!/usr/bin/env node
/**
 * Local-only upgrade path: install `--from`, seed via that revision's HTTP API,
 * checkout candidate HEAD in the same clone, then assert backup/restore and corrupt recovery.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { close as closeModel, createScriptedModelServer, listen as listenModel } from "./fixtures/scripted-model.mjs";
import { freePort } from "./smoke-support.mjs";
import { listBackups, sha256File } from "./workspace.mjs";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "upgrade-smoke-scripted";
const SAMPLE_PDF = path.join(codeRoot, "ui", "e2e", "fixtures", "upload-resume.pdf");
const RESUME_NAME = "upgrade-smoke-resume.pdf";
const DISCOVERED_SLUG = "fictional-corp-platform-engineer";
const QUEUE_SLUG = "fictional-corp-staff-engineer";

function parseArgs(argv) {
  const fromIndex = argv.indexOf("--from");
  if (fromIndex < 0 || !argv[fromIndex + 1]) {
    console.error("Usage: npm run upgrade-smoke -- --from <git-sha>");
    process.exit(2);
  }
  return { fromSha: argv[fromIndex + 1] };
}

function piJobs(cloneDir, args) {
  return run("node", ["scripts/pi-jobs.mjs", ...args], cloneDir);
}

function run(cmd, args, cwd, opts = {}) {
  if (opts.inherit) {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
      env: { ...process.env, ...opts.env },
    });
  }
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(output || `command failed: ${cmd} ${args.join(" ")}`);
  }
  return output;
}

async function waitForHealth(baseURL) {
  const host = `127.0.0.1:${new URL(baseURL).port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/api/health`, { headers: { host } });
      const text = await res.text();
      if (res.status === 200 && text.includes('"ok":true')) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`startup timed out at ${new URL(baseURL).pathname}`);
}

async function startServer(cloneDir, modelOrigin, extraEnv = {}, { viaShell = false } = {}) {
  const port = await freePort();
  const baseEnv = {
    ...process.env,
    PI_JOBS_ROOT: cloneDir,
    NO_EXTERNAL_CALLS: "1",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    ...extraEnv,
  };
  const child = viaShell
    ? spawn("/bin/sh", ["-c", `exec node scripts/pi-jobs.mjs start --port ${port}`], {
        cwd: cloneDir,
        stdio: "ignore",
        env: baseEnv,
      })
    : spawn(process.execPath, [path.join(cloneDir, "scripts", "pi-jobs.mjs"), "start", "--port", String(port)], {
        cwd: cloneDir,
        stdio: "ignore",
        env: baseEnv,
      });
  const handle = {
    child,
    exited: () => child.exitCode !== null,
    output: () => "",
    closed: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  };
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseURL);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${handle.output()}`);
  }
  return { run: handle, baseURL, modelOrigin, port };
}

async function stopServer(handle) {
  if (!handle?.run) return;
  handle.run.child.kill("SIGTERM");
  await Promise.race([handle.run.closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function apiClient(baseURL) {
  const port = new URL(baseURL).port;
  const host = `127.0.0.1:${port}`;
  const session = await fetch(`${baseURL}/api/session`, { headers: { host } });
  const { csrfToken } = await session.json();
  return {
    async fetch(path, init = {}) {
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      headers.set("host", host);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers.set("x-pi-jobs-csrf", csrfToken);
      }
      const res = await fetch(`${baseURL}${path}`, { ...init, headers });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!res.ok) {
        throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
      }
      return body;
    },
  };
}

async function seedBaselineWorkspace(baseURL, modelOrigin, pdfSha256) {
  const api = await apiClient(baseURL);
  let profile = await api.fetch("/api/profile");
  const identityPatch = await api.fetch("/api/profile/sections/identity/bullets", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision: profile.revision,
      bullets: {
        "Full name": "Upgrade Smoke",
        "Preferred name / first name on forms": "Upgrade",
        "Email": "upgrade.smoke@example.invalid",
        "Phone": "+1 555 010 0998",
        "LinkedIn": "https://linkedin.com/in/upgrade-smoke",
        "Pronouns": "they/them",
      },
    }),
  });
  profile = identityPatch.profile ?? await api.fetch("/api/profile");

  const pdfBytes = fs.readFileSync(SAMPLE_PDF);
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), RESUME_NAME);
  await api.fetch("/api/resumes", { method: "POST", body: form });

  profile = await api.fetch("/api/profile");
  await api.fetch("/api/resumes/selection", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: RESUME_NAME,
      mode: "default",
      revision: profile.revision,
      replace: true,
    }),
  });

  const addressEnvelope = await api.fetch("/api/addresses");
  await api.fetch("/api/addresses/denver", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision: addressEnvelope.revision,
      street: "100 Upgrade Path",
      city: "Denver",
      state: "CO",
      zip: "80202",
    }),
  });

  const connections = await api.fetch("/api/connections");
  const created = await api.fetch("/api/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: connections.revision,
      label: "Upgrade smoke loopback",
      provider: "openai-compatible",
      baseUrl: `${modelOrigin}/v1`,
    }),
  });
  const connectionId = created.data.connections.find((c) => c.label === "Upgrade smoke loopback")?.id;
  assert.ok(connectionId, "connection id");
  await api.fetch("/api/connections/selections", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: created.revision,
      agent: { connectionId, modelId: MODEL_ID, thinking: "off" },
    }),
  });

  const targets = await api.fetch("/api/targets");
  await api.fetch("/api/targets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision: targets.revision,
      entries: [{ source: "greenhouse", slug: "fictional-greenhouse" }],
    }),
  });

  await api.fetch("/api/readiness/acknowledgement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ acknowledgement: "ACKNOWLEDGE" }),
  });

  assert.equal(sha256File(SAMPLE_PDF), pdfSha256);
}

function writeJobFiles(cloneDir) {
  const discoveredBody = `---
url: https://boards.greenhouse.io/fictional-corp/jobs/1001
company: Fictional Corp
title: Platform Engineer
location: Remote
source: greenhouse
match: strong
discovered_at: 2026-06-01T12:00:00.000Z
---

ATS: greenhouse
Role match: "platform" + topic "engineer"
Location key: default (remote)
Req ID: 1001

Description excerpt:
Fictional platform role for upgrade smoke.
`;
  const queueBody = `---
url: https://boards.greenhouse.io/fictional-corp/jobs/1002
company: Fictional Corp
title: Staff Engineer
location: Remote
source: greenhouse
---

ATS: greenhouse
Req ID: 1002
`;
  fs.writeFileSync(path.join(cloneDir, "jobs", "discovered", `${DISCOVERED_SLUG}.md`), discoveredBody, "utf8");
  fs.writeFileSync(path.join(cloneDir, "jobs", "queue", `${QUEUE_SLUG}.md`), queueBody, "utf8");
}

async function main() {
  const { fromSha } = parseArgs(process.argv.slice(2));
  const candidateSha = run("git", ["rev-parse", "HEAD"], codeRoot).trim();
  const pdfSha256 = sha256File(SAMPLE_PDF);
  let cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-upgrade-"));
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-upgrade-home-"));
  const agentDir = path.join(cloneDir, ".pi-jobs", "pi-agent");
  let modelServer;
  let serverRun;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (serverRun) void stopServer(serverRun).catch(() => {});
    if (modelServer) closeModel(modelServer).catch(() => {});
    fs.rmSync(cloneDir, { recursive: true, force: true });
    fs.rmSync(emptyHome, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    run("git", ["clone", codeRoot, cloneDir], codeRoot);
    run("git", ["checkout", fromSha], cloneDir);
    run("npm", ["ci"], cloneDir, { inherit: true });
    run("npm", ["run", "setup"], cloneDir);
    run("npm", ["run", "build"], cloneDir, { inherit: true });

    modelServer = createScriptedModelServer({ modelIds: [MODEL_ID], steps: [{ text: "ok" }] });
    await listenModel(modelServer);
    const modelOrigin = `http://127.0.0.1:${modelServer.address().port}`;

    serverRun = await startServer(cloneDir, modelOrigin, {
      HOME: emptyHome,
      PI_CODING_AGENT_DIR: agentDir,
    });
    process.env.PI_JOBS_ROOT = cloneDir;
    await seedBaselineWorkspace(serverRun.baseURL, modelOrigin, pdfSha256);
    writeJobFiles(cloneDir);
    await stopServer(serverRun);
    serverRun = null;
    fs.rmSync(path.join(cloneDir, "ui", "run-manager.json"), { force: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    run("git", ["checkout", candidateSha], cloneDir);
    run("npm", ["ci"], cloneDir, { inherit: true });
    run("npm", ["run", "build"], cloneDir, { inherit: true });

    const doctorBefore = run(
      "node",
      ["scripts/pi-jobs.mjs", "doctor", "--port", String(await freePort())],
      cloneDir,
      { allowFailure: true },
    );
    assert.match(doctorBefore, /BLOCKED ACKNOWLEDGEMENT_LEGACY: Rolebound now states plainly that it submits applications automatically/);
    assert.doesNotMatch(doctorBefore, /STATE_CORRUPT:/);
    assert.doesNotMatch(doctorBefore, /"corrupt"/);

    serverRun = await startServer(cloneDir, modelOrigin, {}, { viaShell: true });
    const base = serverRun.baseURL;
    const api = await apiClient(base);

    const resumes = await api.fetch("/api/resumes");
    const defaultPdf = path.join(cloneDir, "resumes", "default.pdf");
    assert.ok(fs.existsSync(defaultPdf));
    assert.equal(sha256File(defaultPdf), pdfSha256);
    assert.ok(resumes.files.some((f) => f.reachability === "default"));

    const profileMd = fs.readFileSync(path.join(cloneDir, "profile.md"), "utf8");
    assert.match(profileMd, /Upgrade Smoke/);
    const addresses = await api.fetch("/api/addresses");
    assert.ok(addresses.rows.some((r) => r.key === "denver" && r.address?.street === "100 Upgrade Path"));
    const targets = await api.fetch("/api/targets");
    assert.ok(targets.entries.some((e) => e.slug === "fictional-greenhouse"));
    const connections = await api.fetch("/api/connections");
    assert.ok(connections.data.connections.some((c) => c.label === "Upgrade smoke loopback"));
    assert.ok(fs.existsSync(path.join(cloneDir, "jobs", "discovered", `${DISCOVERED_SLUG}.md`)));
    assert.ok(fs.existsSync(path.join(cloneDir, "jobs", "queue", `${QUEUE_SLUG}.md`)));

    await api.fetch("/api/readiness/acknowledgement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgement: "ACKNOWLEDGE" }),
    });
    const readinessAfterAck = await api.fetch("/api/readiness");
    assert.equal(
      readinessAfterAck.steps.find((s) => s.id === "readiness")?.blockers.some((b) => b.code === "ACKNOWLEDGEMENT_LEGACY"),
      false,
    );

    const pdfHashesBefore = {};
    for (const name of fs.readdirSync(path.join(cloneDir, "resumes"))) {
      if (!name.endsWith(".pdf")) continue;
      pdfHashesBefore[name] = sha256File(path.join(cloneDir, "resumes", name));
    }

    const profileBeforeBackup = fs.readFileSync(path.join(cloneDir, "profile.md"), "utf8");
    const queueBeforeBackup = fs.readFileSync(path.join(cloneDir, "jobs", "queue", `${QUEUE_SLUG}.md`), "utf8");
    const addressBeforeBackup = JSON.parse(fs.readFileSync(path.join(cloneDir, "state.json"), "utf8")).addresses?.denver;

    const backupOut = piJobs(cloneDir, ["backup"]);
    const backupId = backupOut.trim().split("\n")[0];
    assert.ok(backupId);
    assert.match(backupOut, /resumes\/ and model keys/);

    fs.writeFileSync(path.join(cloneDir, "profile.md"), profileBeforeBackup.replace("Upgrade Smoke", "Mutated Name"), "utf8");
    const stateMut = JSON.parse(fs.readFileSync(path.join(cloneDir, "state.json"), "utf8"));
    stateMut.addresses.denver = { street: "9 Changed", city: "Denver", state: "CO", zip: "80202" };
    fs.writeFileSync(path.join(cloneDir, "state.json"), `${JSON.stringify(stateMut, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(cloneDir, "jobs", "queue", `${QUEUE_SLUG}.md`),
      queueBeforeBackup.replace("Staff Engineer", "Mutated Title"),
      "utf8",
    );

    const restoreOut = piJobs(cloneDir, ["restore", "--backup", backupId]);
    assert.match(restoreOut, /Restored backup/);
    const preRestore = listBackups(cloneDir).find((b) => b.id.endsWith("-pre-restore"));
    assert.ok(preRestore, "pre-restore backup exists");
    assert.match(fs.readFileSync(path.join(cloneDir, "profile.md"), "utf8"), /Upgrade Smoke/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cloneDir, "state.json"), "utf8")).addresses?.denver,
      addressBeforeBackup,
    );
    assert.match(fs.readFileSync(path.join(cloneDir, "jobs", "queue", `${QUEUE_SLUG}.md`), "utf8"), /Staff Engineer/);

    for (const [name, hash] of Object.entries(pdfHashesBefore)) {
      assert.equal(sha256File(path.join(cloneDir, "resumes", name)), hash);
    }

    fs.mkdirSync(path.join(cloneDir, "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(cloneDir, "ui", "run-manager.json"),
      JSON.stringify({ runId: "upgrade-smoke", pid: process.pid, sessionName: "test", startedAt: new Date().toISOString() }),
    );
    let restoreFailed = false;
    try {
      piJobs(cloneDir, ["restore", "--backup", backupId]);
    } catch {
      restoreFailed = true;
    }
    assert.ok(restoreFailed, "restore refused during active run");
    fs.rmSync(path.join(cloneDir, "ui", "run-manager.json"), { force: true });

    fs.writeFileSync(path.join(cloneDir, "state.json"), "");
    const overviewCorrupt = await api.fetch("/api/overview");
    assert.ok(overviewCorrupt.corrupt?.includes("state.json"));
    const doctorCorrupt = run(
      "node",
      ["scripts/pi-jobs.mjs", "doctor", "--port", String(await freePort())],
      cloneDir,
      { allowFailure: true },
    );
    assert.match(doctorCorrupt, /BLOCKED STATE_CORRUPT: state\.json is corrupt/);
    piJobs(cloneDir, ["restore", "--backup", backupId]);
    const overviewFixed = await api.fetch("/api/overview");
    assert.equal(overviewFixed.corrupt?.includes("state.json"), false);

    await stopServer(serverRun);
    serverRun = null;
    await closeModel(modelServer);
    modelServer = null;

    console.log("upgrade-smoke passed");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
