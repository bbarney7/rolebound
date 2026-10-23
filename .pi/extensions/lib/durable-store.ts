import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

export const NO_CHANGE = Symbol("NO_CHANGE");

export type WorkspaceFileErrorCode = "CORRUPT" | "UNSAFE" | "IO" | "MISSING";

export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;
  readonly file: string;

  constructor(code: WorkspaceFileErrorCode, file: string, message: string) {
    super(message);
    this.name = "WorkspaceFileError";
    this.code = code;
    this.file = file;
  }
}

export class LockReentryError extends Error {
  readonly code = "LOCK_REENTRY" as const;

  constructor(file: string) {
    super(`nested lock on ${file} is not allowed`);
    this.name = "LockReentryError";
  }
}

export class LockCompromisedError extends Error {
  readonly code = "LOCK_COMPROMISED" as const;

  constructor(file: string) {
    super(`lock compromised before writing ${file}`);
    this.name = "LockCompromisedError";
  }
}

export const LOCK_STALE_MS = 10_000;
/** Minimum total lock retry wait (ms); must be at least LOCK_STALE_MS (D1). */
export const LOCK_RETRY_BUDGET_MS = 12_000;

export const LOCKFILE_RETRY_OPTIONS = {
  retries: 10,
  factor: 1.5,
  minTimeout: 110,
  randomize: true,
};

/** Lower bound on total backoff for proper-lockfile retry options (no randomize). */
export function minimumLockRetryBudgetMs(
  options: { retries: number; factor?: number; minTimeout?: number } = LOCKFILE_RETRY_OPTIONS,
): number {
  const retries = options.retries;
  const factor = options.factor ?? 2;
  const minTimeout = options.minTimeout ?? 1000;
  let sum = 0;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    sum += minTimeout * factor ** attempt;
  }
  return Math.round(sum);
}

const STALE_MS = LOCK_STALE_MS;

const SECRET_BASENAMES = new Set(["credentials.json", "settings.json", "state.json"]);

const heldLocks = new AsyncLocalStorage<Set<string>>();

export type LockContext = {
  compromised: boolean;
};

export type WithFileLockOptions = {
  /** Test hook: proper-lockfile `update` interval (ms). */
  update?: number;
  /** Override retry count (`0` = fail fast on ELOCKED). */
  lockRetries?: number;
  testHooks?: {
    afterAcquire?: () => void | Promise<void>;
  };
};

function realpathSafe(file: string): Promise<string> {
  return fs.realpath(file).catch(async (err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") {
      const parent = path.dirname(file);
      const base = path.basename(file);
      const parentReal = await fs.realpath(parent);
      return path.join(parentReal, base);
    }
    throw err;
  });
}

export async function withFileLock<T>(
  target: string,
  fn: (ctx: LockContext) => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  let resolved: string;
  try {
    resolved = await realpathSafe(target);
  } catch {
    resolved = path.resolve(target);
  }
  const store = heldLocks.getStore();
  if (store?.has(resolved)) {
    throw new LockReentryError(resolved);
  }

  const lockTarget = target;
  const ctx: LockContext = { compromised: false };

  const retrySpec =
    options.lockRetries === 0
      ? 0
      : options.lockRetries !== undefined
        ? { ...LOCKFILE_RETRY_OPTIONS, retries: options.lockRetries }
        : LOCKFILE_RETRY_OPTIONS;

  const release = await lockfile.lock(lockTarget, {
    stale: STALE_MS,
    retries: retrySpec,
    update: options.update ?? undefined,
    onCompromised: () => {
      ctx.compromised = true;
    },
  });

  const nextHeld = new Set(store ?? []);
  nextHeld.add(resolved);

  try {
    if (options.testHooks?.afterAcquire) {
      await options.testHooks.afterAcquire();
    }
    return await heldLocks.run(nextHeld, async () => fn(ctx));
  } finally {
    try {
      await release();
    } catch (err: any) {
      if (err?.code !== "ERELEASED") throw err;
    }
  }
}

function tempNameFor(file: string): string {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${rand}.tmp`);
}

function secretModeFor(file: string, mode?: number): number {
  if (SECRET_BASENAMES.has(path.basename(file))) return 0o600;
  return mode ?? 0o600;
}

async function lstatRegularFile(file: string): Promise<void> {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must not be a symlink`);
    }
    if (!info.isFile()) {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must be a regular file`);
    }
  } catch (err: any) {
    if (err instanceof WorkspaceFileError) throw err;
    if (err?.code === "ENOENT") return;
    throw new WorkspaceFileError("IO", file, String(err));
  }
}

async function fsyncDirBestEffort(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err: any) {
    const code = err?.code;
    if (code === "EINVAL" || code === "EISDIR" || code === "EPERM" || code === "ENOTSUP") return;
    throw err;
  }
}

export type AtomicWriteTestHooks = {
  afterTempWrite?: () => void | Promise<void>;
};

export type AtomicWriteOptions = {
  mode?: number;
  lockCtx?: LockContext;
  testHooks?: AtomicWriteTestHooks;
};

export async function atomicWriteFile(
  file: string,
  bytes: Buffer | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await lstatRegularFile(file);
  let keepMode = options.mode ?? 0o644;
  try {
    const existing = await fs.lstat(file);
    keepMode = existing.mode & 0o777;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw new WorkspaceFileError("IO", file, String(err));
    }
  }
  const mode = secretModeFor(file, options.mode ?? keepMode);

  const temp = tempNameFor(file);
  try {
    const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      if (options.testHooks?.afterTempWrite) {
        await options.testHooks.afterTempWrite();
      }
    } finally {
      await handle.close();
    }
    if (options.lockCtx?.compromised) {
      throw new LockCompromisedError(file);
    }
    await fs.chmod(temp, mode);
    await fs.rename(temp, file);
    await fsyncDirBestEffort(path.dirname(file));
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export type AtomicCreateOptions = {
  mode?: number;
  /** Test hook: force link() to fail with this errno code. */
  injectLinkError?: NodeJS.ErrnoException["code"];
};

export async function atomicCreateFile(
  file: string,
  bytes: Buffer | string,
  options: AtomicCreateOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const mode = options.mode ?? 0o600;
  const temp = tempNameFor(file);
  try {
    const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (options.injectLinkError) {
        const err = new Error("injected link failure") as NodeJS.ErrnoException;
        err.code = options.injectLinkError;
        throw err;
      }
      await fs.link(temp, file);
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        throw err;
      }
      const fallbackCodes = new Set(["EPERM", "ENOTSUP", "EMLINK", "ENOSYS", "EXDEV"]);
      if (fallbackCodes.has(err?.code)) {
        try {
          await fs.copyFile(temp, file, fsConstants.COPYFILE_EXCL);
          const out = await fs.open(file, fsConstants.O_RDWR);
          try {
            await out.sync();
          } finally {
            await out.close();
          }
        } catch (copyErr: any) {
          if (copyErr?.code === "EEXIST") throw copyErr;
          throw copyErr;
        }
      } else {
        throw err;
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export type ReadJsonResult<T> =
  | { state: "missing" }
  | { state: "ok"; value: T; bytes: Buffer };

export async function readJsonFile<T>(
  file: string,
  parse: (raw: string) => T,
): Promise<ReadJsonResult<T>> {
  try {
    const lst = await fs.lstat(file);
    if (lst.isSymbolicLink()) {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must not be a symlink`);
    }
    if (!lst.isFile()) {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must be a regular file`);
    }
  } catch (err: any) {
    if (err instanceof WorkspaceFileError) throw err;
    if (err?.code === "ENOENT") return { state: "missing" };
    throw new WorkspaceFileError("IO", file, String(err));
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { state: "missing" };
    if (err?.code === "ELOOP") {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must not be a symlink`);
    }
    throw new WorkspaceFileError("IO", file, String(err));
  }

  try {
    const st = await handle.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new WorkspaceFileError("UNSAFE", file, `${file} must be a regular file`);
    }
    const bytes = await handle.readFile();
    const raw = bytes.toString("utf8");
    try {
      const value = parse(raw);
      return { state: "ok", value, bytes };
    } catch (err) {
      if (err instanceof WorkspaceFileError) throw err;
      throw new WorkspaceFileError("CORRUPT", file, `corrupt JSON in ${file}: ${String(err)}`);
    }
  } finally {
    await handle.close();
  }
}

export type MutateJsonFileOptions<T> = {
  parse: (raw: string) => T;
  serialize: (value: T) => string;
  bootstrapBytes?: Buffer | string;
  mode?: number;
  bootstrap?: boolean;
};

export async function mutateJsonFile<T>(
  file: string,
  options: MutateJsonFileOptions<T>,
  fn: (value: T) => T | typeof NO_CHANGE,
): Promise<T> {
  const bootstrap = options.bootstrap !== false;
  if (bootstrap && options.bootstrapBytes !== undefined) {
    try {
      await atomicCreateFile(file, options.bootstrapBytes, { mode: options.mode });
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }

  return withFileLock(file, async (ctx) => {
    const read = await readJsonFile(file, options.parse);
    if (read.state === "missing") {
      if (!bootstrap) {
        throw new WorkspaceFileError("MISSING", file, `missing file: ${file}`);
      }
      throw new WorkspaceFileError("IO", file, `expected file after bootstrap: ${file}`);
    }
    const next = fn(read.value);
    if (next === NO_CHANGE) return read.value;
    const serialized = options.serialize(next);
    await atomicWriteFile(file, serialized, { mode: options.mode, lockCtx: ctx });
    return next;
  });
}

export async function readJsonFileLocked<T>(
  file: string,
  parse: (raw: string) => T,
): Promise<ReadJsonResult<T>> {
  return readJsonFile(file, parse);
}

export async function writeJsonFileLocked<T>(
  file: string,
  value: T,
  serialize: (v: T) => string,
  options: { mode?: number; lockCtx?: LockContext } = {},
): Promise<void> {
  await atomicWriteFile(file, serialize(value), options);
}
