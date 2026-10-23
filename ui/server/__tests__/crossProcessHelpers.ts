import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCredentialsText } from "../readers/credentials";
import { parseGatherStateText, parseStateText } from "../../../.pi/extensions/lib/workspace-files";
import { withFileLock, LOCK_RETRY_BUDGET_MS } from "../../../.pi/extensions/lib/durable-store";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "crossProcessChild.mts");

export type CrossProcessChildSpec = Record<string, unknown> & { op: string };

export type SpawnedChild = {
  child: ChildProcess;
  specPath: string;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
};

export function pauseDir(root: string): string {
  return path.join(root, ".cross-test", "pause");
}

export function pauseMarker(root: string, token: string): string {
  return path.join(pauseDir(root), token);
}

export async function spawnCrossProcessChild(root: string, spec: CrossProcessChildSpec): Promise<SpawnedChild> {
  const dir = path.join(root, ".cross-test");
  await fs.mkdir(dir, { recursive: true });
  const specPath = path.join(dir, `spec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(specPath, JSON.stringify({ ...spec, root }), "utf8");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, [TSX_CLI, CHILD_SCRIPT, root, specPath], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => stdout.push(c));
  child.stderr?.on("data", (c) => stderr.push(c));
  return {
    child,
    specPath,
    wait: () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
        (resolve) => {
          child.once("close", (code, signal) => {
            resolve({
              code,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
          });
        },
      ),
  };
}

export async function waitForPause(root: string, token: string): Promise<void> {
  const marker = pauseMarker(root, token);
  for (;;) {
    try {
      await fs.access(marker);
      return;
    } catch {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

export async function killAndDrain(child: SpawnedChild, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  child.child.kill(signal);
  await child.wait();
}

export async function waitUntilLockable(file: string, budgetMs = LOCK_RETRY_BUDGET_MS + 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await withFileLock(file, async () => {}, { lockRetries: 0 });
      return;
    } catch (err: any) {
      if (err?.code !== "ELOCKED" || Date.now() - start > budgetMs) {
        if (err?.code === "ELOCKED" && Date.now() - start > budgetMs) {
          throw new Error(`timed out waiting for lock on ${file}`);
        }
        throw err;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

async function assertJsonFile(file: string, label: string, parse: (text: string) => unknown): Promise<void> {
  let st;
  try {
    st = await fs.stat(file);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (st.size === 0) throw new Error(`${label} is empty (0 bytes)`);
  const text = await fs.readFile(file, "utf8");
  if (!text.trim()) throw new Error(`${label} is whitespace-only`);
  try {
    parse(text);
  } catch (err) {
    throw new Error(`${label} is corrupt JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function assertNoStaleTempArtifacts(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      const base = ent.name;
      if (/^\..*\.tmp$/.test(base) || /\.restore-\d+$/.test(base)) {
        throw new Error(`stale temp artifact: ${full}`);
      }
    }
  };
  await walk(root);
}

export async function assertWorkspaceStoresHealthy(root: string): Promise<void> {
  await assertJsonFile(path.join(root, "credentials.json"), "credentials.json", parseCredentialsText);
  await assertJsonFile(path.join(root, "state.json"), "state.json", (t) => parseStateText(t));
  await assertJsonFile(path.join(root, "gather_state.json"), "gather_state.json", parseGatherStateText);
  await assertNoStaleTempArtifacts(root);
}

export async function writeStateAddress(
  root: string,
  key: string,
  address: { street: string; city: string; state: string; zip: string },
): Promise<void> {
  const file = path.join(root, "state.json");
  await withFileLock(file, async () => {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const addresses = (raw.addresses as Record<string, unknown>) ?? {};
    raw.addresses = { ...addresses, [key]: address };
    await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  });
}
