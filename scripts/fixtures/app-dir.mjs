#!/usr/bin/env node
/**
 * Minimal temp app layout for real-pi smokes and server integration tests.
 * Mirrors `scripts/runtime-smoke.mjs` / `scripts/submission-smoke.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "../workspace.mjs";

/**
 * Scaffold a non-demo workspace root (same layout as `npm run setup` on a temp clone).
 *
 * @param {string} repoRoot
 * @param {string} tempParent
 */
export async function buildFreshAppDirectory(repoRoot, tempParent) {
  const home = path.join(tempParent, "home");
  const app = path.join(tempParent, `app-${process.hrtime.bigint()}`);
  await fs.mkdir(path.join(app, ".pi"), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.cp(path.join(repoRoot, ".pi", "extensions"), path.join(app, ".pi", "extensions"), { recursive: true });
  await fs.cp(path.join(repoRoot, "ui", "shared"), path.join(app, "ui", "shared"), { recursive: true });
  await fs.cp(path.join(repoRoot, "templates"), path.join(app, "templates"), { recursive: true });
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(app, "package.json"));
  const libSrc = path.join(repoRoot, "lib");
  try {
    await fs.access(libSrc);
    await fs.cp(libSrc, path.join(app, "lib"), { recursive: true });
  } catch {
    // optional in this checkout
  }
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(app, "node_modules"), "dir");

  const smokeMcp = JSON.parse(await fs.readFile(path.join(repoRoot, ".pi", "mcp.json"), "utf8"));
  smokeMcp.mcpServers["job-playwright"] = {
    ...smokeMcp.mcpServers["job-playwright"],
    command: process.execPath,
    args: [path.join(repoRoot, "scripts/fixtures/stub-browser-mcp.mjs")],
  };
  await fs.writeFile(path.join(app, ".pi", "mcp.json"), `${JSON.stringify(smokeMcp, null, 2)}\n`);

  initWorkspace(app);
  return { home, app };
}

/**
 * @param {string} repoRoot
 * @param {string} tempParent
 * @param {{ runId?: string }} [options]
 */
export async function prepareTempAppDir(repoRoot, tempParent, options = {}) {
  const { home, app } = await buildFreshAppDirectory(repoRoot, tempParent);

  let runDir;
  let runId;
  if (options.runId) {
    runId = options.runId;
    runDir = path.join(app, ".pi-jobs", "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
  }

  return { home, app, runDir, runId };
}
