#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CONNECTION_ID } from "../../scripts/demo-constants.mjs";
import { demoProfile } from "../../scripts/demo-seed.mjs";
import { initWorkspace } from "../../scripts/workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const uiRoot = path.join(repoRoot, "ui");
const fixturesDir = path.join(here, "fixtures");
const runtimeFile = path.join(here, ".runtime.json");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-e2e-"));

function pickPort(preferred) {
  if (preferred) return Promise.resolve(preferred);
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

function seedWorkspace(root) {
  fs.cpSync(path.join(repoRoot, "templates"), path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true });
  fs.cpSync(path.join(repoRoot, ".pi", "extensions"), path.join(root, ".pi", "extensions"), { recursive: true });
  initWorkspace(root);

  const profileTemplate = fs.readFileSync(path.join(root, "templates", "profile.template.md"), "utf8");
  fs.writeFileSync(path.join(root, "profile.md"), demoProfile(profileTemplate));

  fs.writeFileSync(
    path.join(root, "targets.md"),
    fs.readFileSync(path.join(root, "templates", "targets.template.md"), "utf8").replaceAll("example-co", "e2e-co"),
  );

  fs.writeFileSync(
    path.join(root, "settings.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      connections: [{
        id: DEMO_CONNECTION_ID,
        label: "E2E Fake Provider",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
      }],
      agent: { connectionId: DEMO_CONNECTION_ID, modelId: "e2e-model" },
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    }, null, 2)}\n`,
  );

  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  state.acknowledged_at = "2026-01-01T00:00:00.000Z";
  state.acknowledged_policy = "auto-submit-v1";
  state.addresses = {
    denver: { street: "100 Test St", city: "Denver", state: "CO", zip: "80202" },
  };
  state.applications = [];
  fs.writeFileSync(path.join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);

  fs.writeFileSync(path.join(root, "resumes", "default.pdf"), fs.readFileSync(path.join(fixturesDir, "sample.pdf")));
  fs.mkdirSync(path.join(root, ".pi-jobs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, ".pi-jobs", "demo-mode.json"), `${JSON.stringify({ mode: "populated", label: "E2E synthetic workspace — no external calls" }, null, 2)}\n`, { mode: 0o600 });

  for (const [slug, score, title] of [
    ["e2e-engineer", 5, "Platform Engineer"],
    ["e2e-designer", 3, "Product Designer"],
    ["e2e-analyst", null, "Business Analyst"],
  ]) {
    const scoreLines = score
      ? `llm_score: ${score}\nllm_reasoning: Strong fictional fit for E2E.\nllm_scored_at: 2026-01-01T00:00:00.000Z\n`
      : "";
    fs.writeFileSync(
      path.join(root, "jobs", "discovered", `${slug}.md`),
      `---\nurl: https://example.invalid/jobs/${slug}\ncompany: E2E Company\ntitle: ${title}\nlocation: Remote\nsource: greenhouse\n${scoreLines}discovered_at: 2026-01-01T00:00:00.000Z\n---\nSynthetic posting for browser tests only.\n`,
    );
  }
}

async function ensureBuild() {
  const build = spawn(process.execPath, ["scripts/pi-jobs.mjs", "build"], { cwd: repoRoot, stdio: "inherit" });
  const code = await new Promise((resolve) => build.on("exit", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

function cleanup() {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(runtimeFile, { force: true }); } catch {}
}

const port = await pickPort(process.env.PI_JOBS_E2E_PORT ? Number(process.env.PI_JOBS_E2E_PORT) : undefined);
await ensureBuild();
seedWorkspace(workspace);
fs.writeFileSync(runtimeFile, `${JSON.stringify({ port, workspace, pid: process.pid }, null, 2)}\n`);

const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "server/index.ts"], {
  cwd: uiRoot,
  env: {
    ...process.env,
    PI_JOBS_ROOT: workspace,
    PI_JOBS_PORT: String(port),
    PI_JOBS_DEMO: "1",
    PI_JOBS_DEMO_ROOT: workspace,
    PI_JOBS_E2E_FIXTURES: fixturesDir,
    NO_EXTERNAL_CALLS: "1",
    PI_CODING_AGENT_DIR: path.join(workspace, ".pi-jobs", "pi-agent"),
  },
  stdio: "inherit",
});

const shutdown = (signal) => {
  child.kill(signal);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.stdout.write(`[e2e] listening on http://127.0.0.1:${port}\n`);
