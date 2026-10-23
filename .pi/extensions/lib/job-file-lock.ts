import { promises as fs } from "node:fs";
import lockfile from "proper-lockfile";

const STALE_MS = 10_000;

export function discoveredJobLockTarget(filePath: string): string {
  return `${filePath}.lock`;
}

/** Reject symlinks and non-regular files before any discovered-job mutation. */
export async function assertRegularDiscoveredJobFile(filePath: string): Promise<void> {
  try {
    const info = await fs.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("discovered job file is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("discovered job file was not found");
    throw error;
  }
}

async function ensureLockTarget(filePath: string): Promise<string> {
  const target = discoveredJobLockTarget(filePath);
  await fs.appendFile(target, "");
  return target;
}

/** Shared proper-lockfile contract for score, dismiss, and promote readers. */
export async function withDiscoveredJobFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const target = await ensureLockTarget(filePath);
  const release = await lockfile.lock(target, {
    stale: STALE_MS,
    retries: { retries: 10, factor: 1.5, minTimeout: 25, randomize: true },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
