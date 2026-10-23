import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { codeRoot, initWorkspace } from "./workspace.mjs";

const TSX_CLI = path.join(codeRoot, "node_modules", "tsx", "dist", "cli.mjs");
const DOCTOR_MTS = path.join(codeRoot, "scripts", "doctor-readiness.mts");
const PI_JOBS = path.join(codeRoot, "scripts", "pi-jobs.mjs");
const AUTO_SUBMIT_POLICY_VERSION = "auto-submit-v1";

const LIVE_PROFILE = `# Applicant Profile

## Identity

- **Full name:** Jane Doe
- **Preferred name / first name on forms:** Jane
- **Email:** jane@example.com
- **Phone:** 555-0100
- **LinkedIn:** https://linkedin.com/in/janedoe
- **Pronouns:** she/her

## Resume

## City → Address rules (\`address_city_key\`)

| \`address_city_key\` | Display "City, State" | Real-ZIP candidates |
|---|---|---|
| \`denver\` | Denver, CO | one of {80202, 80203} |
| \`default\` | Remote | n/a |

## Work history

### Staff Engineer · Acme · 2022-01 – Present

Led the platform team.

## Education

**BS** · State University

## Authorization

- **Citizenship / work authorization:** US citizen

## Q&A bank

- **Desired salary range:** 200000
`;

const AGENT_CONNECTION_ID = "123e4567-e89b-12d3-a456-426614174000";

function runDoctorReadiness(workspaceRoot, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [TSX_CLI, DOCTOR_MTS, workspaceRoot, ...extraArgs], {
    cwd: codeRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runPiJobsDoctor(extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [PI_JOBS, "doctor", ...extraArgs], {
    cwd: codeRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makeWorkspaceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-doctor-test-"));
  fs.cpSync(path.join(codeRoot, "templates"), path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  fs.cpSync(path.join(codeRoot, ".pi", "extensions"), path.join(root, ".pi", "extensions"), { recursive: true });
  try {
    fs.symlinkSync(path.join(codeRoot, "node_modules"), path.join(root, "node_modules"));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  initWorkspace(root);
  return root;
}

function seedApplyReadyWorkspace(root) {
  fs.writeFileSync(path.join(root, "profile.md"), LIVE_PROFILE);
  fs.writeFileSync(
    path.join(root, "targets.md"),
    "# greenhouse\n- acme-corp\n",
  );
  fs.writeFileSync(
    path.join(root, "settings.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      connections: [{
        id: AGENT_CONNECTION_ID,
        label: "Loopback Agent",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9001/v1",
        api: "openai-completions",
      }],
      agent: { connectionId: AGENT_CONNECTION_ID, modelId: "agent-model" },
      scoring: null,
      captcha: {},
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "state.json"),
    `${JSON.stringify({
      applications: [],
      addresses: { denver: { street: "1 Main", city: "Denver", state: "CO", zip: "80202" } },
      acknowledged_at: "2026-01-01T00:00:00.000Z",
      acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
    }, null, 2)}\n`,
  );
  const resumeFixture = path.join(codeRoot, "ui", "e2e", "fixtures", "sample.pdf");
  if (fs.existsSync(resumeFixture)) {
    fs.copyFileSync(resumeFixture, path.join(root, "resumes", "default.pdf"));
  } else {
    fs.writeFileSync(path.join(root, "resumes", "default.pdf"), Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"));
  }
}

function listenHttp(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function evalDoctor(segments) {
  const body = segments.join("\n");
  const scriptPath = path.join(os.tmpdir(), `doctor-eval-${process.pid}-${Date.now()}.mts`);
  fs.writeFileSync(scriptPath, body);
  const result = spawnSync(process.execPath, [TSX_CLI, scriptPath], { cwd: codeRoot, encoding: "utf8" });
  fs.rmSync(scriptPath, { force: true });
  return result;
}

test("doctor blocks when Node is too old (injectable seam)", async () => {
  const root = makeWorkspaceRoot();
  try {
    const result = await evalDoctor([
      `import { setDoctorTestDeps, runDoctor } from ${JSON.stringify(DOCTOR_MTS)};`,
      `setDoctorTestDeps({ nodeVersion: "22.18.0" });`,
      `const code = await runDoctor({ workspaceRoot: ${JSON.stringify(root)}, codeRoot: ${JSON.stringify(codeRoot)}, port: 14801, repair: false });`,
      `setDoctorTestDeps(null);`,
      `process.exit(code);`,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /BLOCKED node: 22\.18\.0 is too old — install Node 22\.19\+ \(24\.14\.0 is tested\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports a foreign listener on the port", async () => {
  const root = makeWorkspaceRoot();
  const server = await listenHttp((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not rolebound");
  });
  const port = server.address().port;
  try {
    const result = runDoctorReadiness(root, ["--port", String(port)]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`BLOCKED port ${port}: in use — stop the other process or run npm start -- --port <n>`));
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor recognizes Rolebound already listening on the port", async () => {
  const root = makeWorkspaceRoot();
  try {
    const result = await evalDoctor([
      `import http from "node:http";`,
      `import { runDoctor } from ${JSON.stringify(DOCTOR_MTS)};`,
      `const root = ${JSON.stringify(root)};`,
      `const codeRoot = ${JSON.stringify(codeRoot)};`,
      `const server = await new Promise((resolve, reject) => {`,
      `  const s = http.createServer((req, res) => {`,
      `    if (req.url?.startsWith("/api/health")) {`,
      `      res.writeHead(200, { "content-type": "application/json" });`,
      `      res.end(JSON.stringify({ ok: true, root }));`,
      `      return;`,
      `    }`,
      `    res.writeHead(404);`,
      `    res.end();`,
      `  });`,
      `  s.once("error", reject);`,
      `  s.listen(0, "127.0.0.1", () => resolve(s));`,
      `});`,
      `const port = server.address().port;`,
      `const code = await runDoctor({ workspaceRoot: root, codeRoot, port, repair: false });`,
      `console.log("PORT_LINE:" + port);`,
      `await new Promise((resolve) => server.close(() => resolve()));`,
      `process.exit(code);`,
    ]);
    const portLine = result.stdout.split("\n").find((line) => line.startsWith("PORT_LINE:"));
    const port = portLine?.slice("PORT_LINE:".length);
    assert.ok(port);
    assert.match(result.stdout, new RegExp(`OK port ${port}: Rolebound already running`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor prints OS-specific hint when browser is missing (injectable seam)", async () => {
  const root = makeWorkspaceRoot();
  try {
    const result = await evalDoctor([
      `import { setDoctorTestDeps, runDoctor } from ${JSON.stringify(DOCTOR_MTS)};`,
      `setDoctorTestDeps({ browserLookup: () => "missing" });`,
      `const code = await runDoctor({ workspaceRoot: ${JSON.stringify(root)}, codeRoot: ${JSON.stringify(codeRoot)}, port: 14802, repair: false });`,
      `setDoctorTestDeps(null);`,
      `process.exit(code);`,
    ]);
    assert.equal(result.status, 1);
    if (process.platform === "darwin") {
      assert.match(result.stdout, /BLOCKED browser: missing — on macOS, install Google Chrome into \/Applications/);
    } else {
      assert.match(result.stdout, /BLOCKED browser: missing — on Linux, install google-chrome or chromium on PATH/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor prints readiness blocker messages and quoted workspace root", () => {
  const root = makeWorkspaceRoot();
  try {
    const result = runDoctorReadiness(root, ["--port", "14803"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`workspace: ${JSON.stringify(root)}`));
    assert.match(result.stdout, /BLOCKED AGENT_MODEL_MISSING: Choose an agent connection and model\./);
    assert.match(result.stdout, /BLOCKED NAME_MISSING: Add your full name\./);
    assert.match(result.stdout, /BLOCKED EMAIL_MISSING: Add a valid email address\./);
    assert.match(result.stdout, /BLOCKED RESUME_MISSING:/);
    assert.match(result.stdout, /BLOCKED ACKNOWLEDGEMENT_MISSING:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor exits 0 for a fully ready workspace", async () => {
  const root = makeWorkspaceRoot();
  try {
    seedApplyReadyWorkspace(root);
    const result = await evalDoctor([
      `import { setDoctorTestDeps, runDoctor } from ${JSON.stringify(DOCTOR_MTS)};`,
      `setDoctorTestDeps({ browserLookup: () => "/usr/bin/chromium", buildReady: () => true });`,
      `const code = await runDoctor({ workspaceRoot: ${JSON.stringify(root)}, codeRoot: ${JSON.stringify(codeRoot)}, port: 14804, repair: false });`,
      `setDoctorTestDeps(null);`,
      `process.exit(code);`,
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /READY capability apply/);
    assert.match(result.stdout, /READY capability score/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor exits 1 for a Cursor agent without a scorer when otherwise ready", async () => {
  const root = makeWorkspaceRoot();
  try {
    seedApplyReadyWorkspace(root);
    fs.writeFileSync(
      path.join(root, "settings.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        connections: [{ id: AGENT_CONNECTION_ID, label: "Cursor", provider: "cursor" }],
        agent: { connectionId: AGENT_CONNECTION_ID, modelId: "composer-2.5" },
        scoring: null,
        captcha: {},
      }, null, 2)}\n`,
    );
    const credResult = await evalDoctor([
      `import { setConnectionCredential } from ${JSON.stringify(path.join(codeRoot, "ui/server/providers/providerService.ts"))};`,
      `await setConnectionCredential(${JSON.stringify(root)}, ${JSON.stringify(AGENT_CONNECTION_ID)}, "cursor-test-key");`,
      `process.exit(0);`,
    ]);
    assert.equal(credResult.status, 0);
    const result = runDoctorReadiness(root, ["--port", "14808"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /BLOCKED capability score/);
    assert.match(result.stdout, /BLOCKED SCORING_MODEL_MISSING:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor prints reconcile findings report-only without --repair", () => {
  const root = makeWorkspaceRoot();
  const url = "https://ex.test/doctor-reconcile";
  const body = `url: ${url}\n`;
  fs.writeFileSync(path.join(root, "jobs", "discovered", "dup.md"), body);
  fs.writeFileSync(path.join(root, "jobs", "queue", "dup.md"), body);
  try {
    const result = runDoctorReadiness(root, ["--port", "14805"]);
    assert.match(result.stdout, /RECONCILE R1:.*\(run npm run doctor -- --repair\)/);
    assert.ok(fs.existsSync(path.join(root, "jobs", "discovered", "dup.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor applies reconcile findings with --repair", () => {
  const root = makeWorkspaceRoot();
  const url = "https://ex.test/doctor-repair";
  const body = `url: ${url}\n`;
  fs.writeFileSync(path.join(root, "jobs", "discovered", "dup.md"), body);
  fs.writeFileSync(path.join(root, "jobs", "queue", "dup.md"), body);
  try {
    const result = runDoctorReadiness(root, ["--port", "14806", "--repair"]);
    assert.match(result.stdout, /RECONCILE R1:/);
    assert.doesNotMatch(result.stdout, /\(run npm run doctor -- --repair\)/);
    assert.equal(fs.existsSync(path.join(root, "jobs", "discovered", "dup.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pi-jobs doctor forwards --repair to doctor-readiness", async () => {
  const { buildDoctorReadinessArgs } = await import("./pi-jobs.mjs");
  const root = makeWorkspaceRoot();
  const url = "https://ex.test/pi-jobs-repair";
  const body = `url: ${url}\n`;
  fs.writeFileSync(path.join(root, "jobs", "discovered", "dup.md"), body);
  fs.writeFileSync(path.join(root, "jobs", "queue", "dup.md"), body);
  try {
    const [nodeExec, childArgs] = buildDoctorReadinessArgs(root, ["--repair", "--port", "14807"]);
    assert.ok(childArgs.includes("--repair"));
    const result = spawnSync(nodeExec, childArgs, { cwd: codeRoot, encoding: "utf8" });
    assert.match(result.stdout, /RECONCILE R1:/);
    assert.doesNotMatch(result.stdout, /\(run npm run doctor -- --repair\)/);
    assert.equal(fs.existsSync(path.join(root, "jobs", "discovered", "dup.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor usage errors exit 2 for invalid --port", () => {
  const result = runPiJobsDoctor(["--port", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--port must be an integer from 1 to 65535/);
});

test("pi-jobs doctor does not create profile.md when it is missing", async () => {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-doctor-isolated-"));
  const { buildFreshAppDirectory } = await import("./fixtures/app-dir.mjs");
  const { buildDoctorReadinessArgs } = await import("./pi-jobs.mjs");
  const { app } = await buildFreshAppDirectory(codeRoot, tempParent);
  fs.cpSync(path.join(codeRoot, "scripts"), path.join(app, "scripts"), { recursive: true });
  const profilePath = path.join(app, "profile.md");
  try {
    fs.rmSync(profilePath);
    const [nodeExec, childArgs] = buildDoctorReadinessArgs(app);
    const result = spawnSync(nodeExec, childArgs, { cwd: codeRoot, encoding: "utf8" });
    assert.match(result.stdout, /BLOCKED workspace: setup required/);
    assert.equal(fs.existsSync(profilePath), false);
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});
