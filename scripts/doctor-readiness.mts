#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeReadiness } from "../ui/server/readiness.ts";
import { readApplicationSettings } from "../ui/server/applicationConfigStore.ts";
import { reconcileWorkspace } from "../.pi/extensions/lib/reconcile.ts";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type DoctorTestDeps = {
  nodeVersion?: string;
  browserLookup?: () => string;
  /** Whether `ui/dist` is built; CI runs the doctor tests before `npm run build`. */
  buildReady?: () => boolean;
};

let doctorTestDeps: DoctorTestDeps | null = null;

export function setDoctorTestDeps(deps: DoctorTestDeps | null) {
  doctorTestDeps = deps;
}

function runningNodeVersion(): string {
  return doctorTestDeps?.nodeVersion ?? process.versions.node;
}

function parseNodeVersion(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nodeVersionAtLeast(version: string, minimum: string): boolean {
  const [a1, a2, a3] = parseNodeVersion(version);
  const [b1, b2, b3] = parseNodeVersion(minimum);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

function readRequiredNodeVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(codeRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const spec = pkg.engines?.node?.trim();
    if (spec?.startsWith(">=")) return spec.slice(2).trim();
  } catch {
    /* use fallback */
  }
  return "22.19.0";
}

function defaultBrowserLookup(): string {
  for (const candidate of [
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) {
    try {
      if (candidate.startsWith("/")) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      const found = execFileSync("sh", ["-lc", `command -v ${candidate}`], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      /* try next */
    }
  }
  return "missing";
}

function browserMissingLine(): string {
  if (process.platform === "darwin") {
    return "BLOCKED browser: missing — on macOS, install Google Chrome into /Applications";
  }
  return "BLOCKED browser: missing — on Linux, install google-chrome or chromium on PATH";
}

function tryBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function fetchRoleboundHealth(port: number): Promise<{ ok: true; root: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { ok?: boolean; root?: string };
    if (parsed.ok === true && typeof parsed.root === "string") {
      return { ok: true, root: parsed.root };
    }
  } catch {
    /* not Rolebound */
  }
  return null;
}

async function checkPort(port: number, workspaceRoot: string): Promise<"free" | "rolebound" | "blocked"> {
  if (await tryBindPort(port)) return "free";
  const health = await fetchRoleboundHealth(port);
  if (health) return "rolebound";
  return "blocked";
}

function parseDoctorArgv(argv: string[]) {
  const repair = argv.includes("--repair");
  const portIndex = argv.indexOf("--port");
  const portRaw = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  if (portIndex >= 0 && (!portRaw || !/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535)) {
    console.error("--port must be an integer from 1 to 65535");
    process.exit(2);
  }
  const positional = argv.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    if (index > 0 && argv[index - 1] === "--port") return false;
    return true;
  });
  const workspaceRoot = path.resolve(positional[0] || process.cwd());
  const port = Number(portRaw || "4747");
  return { workspaceRoot, port, repair };
}

export async function runDoctor(options: {
  workspaceRoot: string;
  codeRoot: string;
  port: number;
  repair: boolean;
}): Promise<number> {
  const { workspaceRoot, codeRoot: rootDir, port, repair } = options;
  let bad = false;

  console.log(`workspace: ${JSON.stringify(workspaceRoot)}`);

  const requiredNode = readRequiredNodeVersion();
  const nodeVersion = runningNodeVersion();
  if (!nodeVersionAtLeast(nodeVersion, requiredNode)) {
    bad = true;
    console.log(`BLOCKED node: ${nodeVersion} is too old — install Node 22.19+ (24.14.0 is tested)`);
  } else {
    console.log(`OK node: ${nodeVersion}`);
  }

  let npmOk = true;
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
  } catch {
    npmOk = false;
  }
  const npmVersion = npmOk ? execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() : "missing";
  if (!npmOk) {
    bad = true;
    console.log(`BLOCKED npm: ${npmVersion}`);
  } else {
    console.log(`OK npm: ${npmVersion}`);
  }

  let piVersion = "missing";
  try {
    piVersion =
      JSON.parse(
        fs.readFileSync(path.join(rootDir, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"),
      ).version || "missing";
  } catch {
    piVersion = "missing";
  }
  if (piVersion === "missing") {
    bad = true;
    console.log(`BLOCKED pi package: ${piVersion}`);
  } else {
    console.log(`OK pi package: ${piVersion}`);
  }

  const browser = doctorTestDeps?.browserLookup?.() ?? defaultBrowserLookup();
  if (!browser || browser === "missing") {
    bad = true;
    console.log(browserMissingLine());
  } else {
    console.log(`OK browser: ${browser}`);
  }

  const browserProfile = fs.existsSync(path.join(workspaceRoot, ".browser-data"))
    ? path.join(workspaceRoot, ".browser-data")
    : "created on first browser run";
  console.log(`OK browser profile: ${browserProfile}`);

  const workspaceState = fs.existsSync(path.join(workspaceRoot, "profile.md")) ? "initialized" : "setup required";
  if (workspaceState === "setup required") {
    bad = true;
    console.log(`BLOCKED workspace: ${workspaceState}`);
  } else {
    console.log(`OK workspace: ${workspaceState}`);
  }

  const buildReady = doctorTestDeps?.buildReady?.() ?? fs.existsSync(path.join(rootDir, "ui", "dist", "index.html"));
  if (!buildReady) {
    bad = true;
    console.log("BLOCKED build: run npm run build");
  } else {
    console.log("OK build: ready");
  }

  const portStatus = await checkPort(port, workspaceRoot);
  if (portStatus === "free") {
    /* port available — no line required */
  } else if (portStatus === "rolebound") {
    const health = await fetchRoleboundHealth(port);
    if (health && path.resolve(health.root) === path.resolve(workspaceRoot)) {
      console.log(`OK port ${port}: Rolebound already running`);
    } else {
      console.log(`OK port ${port}: a Rolebound server already running`);
    }
  } else {
    bad = true;
    console.log(`BLOCKED port ${port}: in use — stop the other process or run npm start -- --port <n>`);
  }

  const reconcileFindings = await reconcileWorkspace(workspaceRoot, { apply: repair });
  for (const finding of reconcileFindings) {
    // R12 always reports a count; a zero count is not something to repair.
    if (/^(found|removed) 0 /.test(finding.message)) continue;
    if (repair) {
      console.log(`RECONCILE ${finding.row}: ${finding.message}`);
    } else {
      console.log(`RECONCILE ${finding.row}: ${finding.message} (run npm run doctor -- --repair)`);
    }
  }

  const readiness = await computeReadiness(workspaceRoot);
  const settings = await readApplicationSettings(workspaceRoot);
  const printedScoreBlockerCodes = new Set<string>();
  for (const step of readiness.steps) {
    const label = step.complete ? "OK" : step.optional ? "OPTIONAL" : "BLOCKED";
    if (!step.complete && !step.optional) bad = true;
    if (step.complete || step.optional) {
      console.log(
        `${label} setup:${step.id}${step.blockers.length ? ` (${step.blockers.map((b) => b.code).join(", ")})` : ""}`,
      );
      continue;
    }
    console.log(`${label} setup:${step.id}`);
    for (const blocker of step.blockers) {
      console.log(`BLOCKED ${blocker.code}: ${blocker.message}`);
      printedScoreBlockerCodes.add(blocker.code);
    }
  }
  console.log(`${readiness.browseReady ? "READY" : "BLOCKED"} capability browse`);
  console.log(`${readiness.discoverReady ? "READY" : "BLOCKED"} capability discover`);
  console.log(`${readiness.applyReady ? "READY" : "BLOCKED"} capability apply`);
  console.log(`${readiness.scoreReady ? "READY" : "BLOCKED"} capability score`);
  if (!readiness.scoreReady) {
    for (const blocker of readiness.scoreBlockers) {
      if (printedScoreBlockerCodes.has(blocker.code)) continue;
      console.log(`BLOCKED ${blocker.code}: ${blocker.message}`);
      printedScoreBlockerCodes.add(blocker.code);
    }
  }
  for (const warning of readiness.warnings) {
    console.log(`WARN ${warning.code}: ${warning.message}`);
  }

  const agentConnection = settings.data.agent
    ? settings.data.connections.find((c) => c.id === settings.data.agent?.connectionId)
    : undefined;
  const scoringOverride = Boolean(
    settings.data.scoring &&
      (settings.data.scoring.connectionId !== settings.data.agent?.connectionId ||
        settings.data.scoring.modelId !== settings.data.agent?.modelId ||
        settings.data.scoring.thinking !== settings.data.agent?.thinking),
  );
  const workspaceNeedsScorer = scoringOverride || agentConnection?.provider === "cursor";
  const setupIncomplete = readiness.steps.some((step) => !step.complete && !step.optional);
  if (!readiness.scoreReady && workspaceNeedsScorer && !setupIncomplete) {
    bad = true;
  }

  return bad ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { workspaceRoot, port, repair } = parseDoctorArgv(process.argv.slice(2));
  const exitCode = await runDoctor({ workspaceRoot, codeRoot, port, repair });
  process.exit(exitCode);
}
