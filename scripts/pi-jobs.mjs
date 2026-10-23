#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChild, childExitCode } from "./process-lifecycle.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { codeRoot, initWorkspace, listBackups, resolveWorkspaceRoot, restoreBackup, runWorkspaceBackup } from "./workspace.mjs";
import { seedPopulatedDemoWorkspace } from "./demo-seed.mjs";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export function buildDoctorReadinessArgs(workspaceRoot, launcherArgs = []) {
  const childArgs = [
    path.join(codeRoot, "node_modules/tsx/dist/cli.mjs"),
    path.join(codeRoot, "scripts/doctor-readiness.mts"),
    workspaceRoot,
  ];
  if (launcherArgs.includes("--repair")) childArgs.push("--repair");
  const portIndex = launcherArgs.indexOf("--port");
  if (portIndex >= 0 && launcherArgs[portIndex + 1]) childArgs.push("--port", launcherArgs[portIndex + 1]);
  return [process.execPath, childArgs];
}

if (isMain) {
const command = process.argv[2] || "help";
const args = process.argv.slice(3);
const root = command === "demo" ? codeRoot : resolveWorkspaceRoot(args);
const ui = path.join(root, "ui");
const run = async (cmd, cmdArgs, opts = {}) => {
  const result = await runChild(cmd, cmdArgs, { cwd: opts.cwd ?? root, env: { ...(opts.replaceEnv ? {} : process.env), ...opts.env } });
  if (result.error || result.forced || result.signal) console.error(`Child shutdown failed: ${result.error?.message ?? (result.forced ? "forced termination" : result.signal)}`);
  return childExitCode(result);
};
const serverArgs = () => ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, path.join(codeRoot, "ui/server/index.ts")];
const portIndex = args.indexOf("--port"); const requestedPort = portIndex >= 0 ? args[portIndex + 1] : undefined; if (portIndex >= 0 && (!requestedPort || !/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535)) { console.error("--port must be an integer from 1 to 65535"); process.exit(2); }
const usage = () => console.log("Usage: npm run <setup|build|start|dev|demo|doctor|backup|restore> [-- --root PATH] [-- --port N] (demo also supports --empty; restore supports --list and --backup <id>)");
const backupLimitsNote = "Note: resumes/ and model keys (.pi-jobs/pi-agent/auth.json) are not included in backups.";

if (command === "setup") { initWorkspace(root); console.log(`Workspace ready: ${root}`); process.exit(0); }
if (command === "build") { initWorkspace(root); process.exit(await run("npm", ["run", "build", "--workspace", "ui"])); }
if (command === "start") { initWorkspace(root); if (!fs.existsSync(path.join(ui, "dist", "index.html"))) { console.error("Run npm run build first."); process.exit(1); } process.env.PI_JOBS_ROOT = root; process.env.PI_JOBS_PORT = requestedPort || process.env.PI_JOBS_PORT || "4747"; process.exit(await run(process.execPath, serverArgs(), { cwd: codeRoot })); }
if (command === "dev") { initWorkspace(root); process.env.PI_JOBS_ROOT = root; process.env.PI_JOBS_PORT = requestedPort || process.env.PI_JOBS_PORT || "4747"; process.env.PI_JOBS_DEV_PROXY = "1"; process.exit(await run("npm", ["run", "dev", "--workspace", "ui"])); }
if (command === "demo") {
  if (args.includes("--root") || process.env.PI_JOBS_ROOT?.trim()) {
    console.error("demo mode ignores --root and PI_JOBS_ROOT; it always uses an isolated temporary workspace");
    process.exit(2);
  }
  const empty = args.includes("--empty");
  const demo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-demo-"));
  let exitCode = 0;
  try {
    fs.cpSync(path.join(codeRoot, "templates"), path.join(demo, "templates"), { recursive: true });
    fs.mkdirSync(path.join(demo, ".pi", "extensions"), { recursive: true });
    fs.cpSync(path.join(codeRoot, ".pi", "extensions"), path.join(demo, ".pi", "extensions"), { recursive: true });
    initWorkspace(demo);
    if (!empty) seedPopulatedDemoWorkspace(demo, codeRoot);
    else {
      fs.mkdirSync(path.join(demo, ".pi-jobs"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(demo, ".pi-jobs", "demo-mode.json"), JSON.stringify({ mode: "empty", label: "Synthetic demo workspace — no external calls" }, null, 2) + "\n", { mode: 0o600 });
    }
    if (!fs.existsSync(path.join(codeRoot, "ui", "dist", "index.html"))) {
      exitCode = await run("npm", ["run", "build", "--workspace", "ui"], { cwd: codeRoot });
      if (exitCode) throw new Error(`demo build failed: ${exitCode}`);
    }
    const safeEnv = {
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV,
      HOME: process.env.HOME,
      PI_JOBS_ROOT: demo,
      PI_JOBS_PORT: requestedPort || "4747",
      PI_JOBS_DEMO: "1",
      PI_JOBS_DEMO_ROOT: demo,
      PI_CODING_AGENT_DIR: path.join(demo, ".pi-jobs", "pi-agent"),
      NO_EXTERNAL_CALLS: "1",
    };
    exitCode = await run(process.execPath, serverArgs(), { cwd: codeRoot, env: safeEnv, replaceEnv: true });
  } finally {
    fs.rmSync(demo, { recursive: true, force: true });
  }
  process.exit(exitCode);
}
if (command === "doctor") {
  const [nodeExec, childArgs] = buildDoctorReadinessArgs(root, args);
  try {
    execFileSync(nodeExec, childArgs, { cwd: codeRoot, stdio: "inherit" });
    process.exit(0);
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 1;
    process.exit(status);
  }
}
if (command === "backup") {
  try {
    const { id } = runWorkspaceBackup(root);
    console.log(id);
    console.log(backupLimitsNote);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (command === "restore") {
  if (args.includes("--list")) {
    for (const entry of listBackups(root)) {
      console.log(`${entry.id}\t${entry.date}\t${entry.fileCount}`);
    }
    process.exit(0);
  }
  const i = args.indexOf("--backup");
  if (i < 0 || !args[i + 1]) {
    console.error("Use: npm run restore -- --backup <id>  or  npm run restore -- --list");
    process.exit(2);
  }
  try {
    restoreBackup(root, args[i + 1]);
    console.log(`Restored backup ${args[i + 1]}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
usage(); process.exit(command === "help" ? 0 : 2);
}
