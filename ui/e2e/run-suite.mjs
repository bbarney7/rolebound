#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(uiRoot, "..");
const artifactsDir = path.join(here, "artifacts");
const playwrightBin = path.join(repoRoot, "node_modules", ".bin", "playwright");

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

function run(command, args, env, logPath) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(command, args, {
      cwd: uiRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** On failure, print the end of the log: CI keeps no artifacts, so this is the only record. */
function printLogTail(logPath, lines = 200) {
  try {
    const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n");
    process.stderr.write(`--- last ${lines} lines of ${logPath} ---\n${tail}\n--- end of log ---\n`);
  } catch {
    /* the path above is still printed */
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(artifactsDir, `playwright-${stamp}.log`);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(logPath, `pi-jobs browser suite ${new Date().toISOString()}\n`);

  const buildCode = await run(process.execPath, [path.join(repoRoot, "scripts/pi-jobs.mjs"), "build"], {}, logPath);
  if (buildCode !== 0) {
    process.stderr.write(`build failed (exit ${buildCode}); log: ${logPath}\n`);
    printLogTail(logPath);
    process.exit(buildCode);
  }

  const port = process.env.PI_JOBS_E2E_PORT ? Number(process.env.PI_JOBS_E2E_PORT) : await pickPort();
  const env = { PI_JOBS_E2E_PORT: String(port) };
  const demoCode = await run(playwrightBin, ["test", "--config", "e2e/playwright.config.ts"], env, logPath);
  if (demoCode !== 0) {
    process.stderr.write(`playwright demo suite failed (exit ${demoCode}); log: ${logPath}\n`);
    printLogTail(logPath);
    process.exit(demoCode);
  }

  const freshCode = await run(playwrightBin, ["test", "--config", "e2e/playwright.fresh.config.ts"], env, logPath);
  if (freshCode !== 0) {
    process.stderr.write(`playwright fresh suite failed (exit ${freshCode}); log: ${logPath}\n`);
    printLogTail(logPath);
    process.exit(freshCode);
  }

  process.stdout.write(`playwright demo + fresh suites passed; log: ${logPath}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
