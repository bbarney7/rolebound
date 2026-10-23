import { withFileLock } from "../../.pi/extensions/lib/durable-store";

/**
 * Serialize a read-modify-write of a shared workspace file behind a cross-process lock.
 * Advisory for extensions and the dashboard server — same proper-lockfile contract (D4).
 * The locked file must exist; callers read INSIDE fn().
 */
export async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(filePath, async () => fn());
}

export { withFileLock } from "../../.pi/extensions/lib/durable-store";
