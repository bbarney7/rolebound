import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** Newest `*.jsonl` under `<runDir>/pi-agent`, if any. */
export async function findPiAgentSessionJsonl(runDir: string): Promise<string | null> {
  const agentDir = path.join(runDir, "pi-agent");
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let info;
      try {
        info = await fs.lstat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile() && name.endsWith(".jsonl")) {
        entries.push(full);
      }
    }
  }
  await walk(agentDir);
  if (entries.length === 0) return null;
  let newest = entries[0]!;
  let newestMtime = 0;
  for (const file of entries) {
    const mtime = (await fs.stat(file)).mtimeMs;
    if (mtime >= newestMtime) {
      newestMtime = mtime;
      newest = file;
    }
  }
  return newest;
}

const KEEP_SAVED_SESSIONS = 10;

function savedSessionsDir(root: string): string {
  return path.join(root, ".pi-jobs", "chat-sessions");
}

/**
 * Run directories are removed when a run ends, so a chat run keeps a private
 * copy of its pi session here; a later chat forks from it (`continueFrom`).
 */
export async function saveChatSession(root: string, runId: string, runDir: string): Promise<void> {
  if (!isRunId(runId)) return;
  const session = await findPiAgentSessionJsonl(runDir);
  if (!session) return;
  const dir = savedSessionsDir(root);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(dir)).isDirectory()) return;
  // Copy beside the target and rename over it: a planted symlink is replaced, never followed.
  const temp = path.join(dir, `.${runId}.${process.pid}.tmp`);
  await fs.copyFile(session, temp, fsConstants.COPYFILE_EXCL);
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, path.join(dir, `${runId}.jsonl`));
  const saved = await Promise.all((await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
    .map(async (name) => ({ name, mtime: (await fs.stat(path.join(dir, name))).mtimeMs })));
  saved.sort((a, b) => b.mtime - a.mtime);
  for (const old of saved.slice(KEEP_SAVED_SESSIONS)) await fs.rm(path.join(dir, old.name), { force: true });
}

/** The saved session of an ended chat run, else the live session of a running one. */
export async function findChatSession(root: string, runId: string): Promise<string | null> {
  if (!isRunId(runId)) return null;
  const saved = path.join(savedSessionsDir(root), `${runId}.jsonl`);
  try {
    if ((await fs.lstat(savedSessionsDir(root))).isDirectory() && (await fs.lstat(saved)).isFile()) return saved;
  } catch {
    // fall through to the live run directory
  }
  return findPiAgentSessionJsonl(path.join(root, ".pi-jobs", "runs", runId));
}

export async function resolveContinueFromForkSource(
  root: string,
  continueFrom: string,
  newRunDir: string,
): Promise<string> {
  const session = await findChatSession(root, continueFrom);
  if (!session) throw new Error("continueFrom has no saved chat session");
  const forkCopy = path.join(newRunDir, "fork-source.jsonl");
  await fs.copyFile(session, forkCopy);
  return path.resolve(forkCopy);
}
