import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Credential } from "@earendil-works/pi-ai";
import { withLock } from "../lock";
import { ProviderServiceError } from "./providerErrors";

export type StoredAuth = Record<string, Credential>;

export const authPath = (root: string) => path.join(root, ".pi-jobs", "pi-agent", "auth.json");
export const providerStoreLockPath = (root: string) => path.join(root, ".pi-jobs", "pi-agent", ".provider-store");
export const loginLeasesPath = (root: string) => path.join(root, ".pi-jobs", "pi-agent", ".login-leases.json");

export const LOGIN_LEASE_TTL_MS = 30_000;
export const LOGIN_LEASE_HEARTBEAT_MS = 10_000;

declare const credentialOwnerTokenBrand: unique symbol;
export type CredentialOwnerToken = string & { readonly [credentialOwnerTokenBrand]: true };

export type CredentialWriteAuthorization = {
  connectionId: string;
  ownerToken?: CredentialOwnerToken;
};

export type ConnectionCredentialLease = {
  connectionId: string;
  owner: { pid: number; token: string };
  expiresAt: number;
};

const credentialOwners = new Map<string, ConnectionCredentialLease>();

function credentialOwnerKey(root: string, connectionId: string): string {
  return `${path.resolve(root)}\0${connectionId}`;
}

function loginInProgress(): ProviderServiceError {
  return new ProviderServiceError(
    "LOGIN_IN_PROGRESS",
    "finish or cancel the active sign-in before changing credentials",
    409,
  );
}

function parseLoginLeases(text: string): ConnectionCredentialLease[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error();
    return value.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const candidate = entry as Partial<ConnectionCredentialLease>;
      if (typeof candidate.connectionId !== "string" || !candidate.connectionId) throw new Error();
      if (!candidate.owner || typeof candidate.owner !== "object") throw new Error();
      if (!Number.isInteger(candidate.owner.pid) || candidate.owner.pid <= 0) throw new Error();
      if (typeof candidate.owner.token !== "string" || !candidate.owner.token) throw new Error();
      if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) throw new Error();
      return candidate as ConnectionCredentialLease;
    });
  } catch {
    throw new ProviderServiceError("CONFIG_INVALID", "login lease store is malformed");
  }
}

async function readLoginLeasesFile(root: string): Promise<ConnectionCredentialLease[]> {
  try {
    await assertPrivateReadPath(root);
    const file = loginLeasesPath(root);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error();
    return parseLoginLeases(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof ProviderServiceError) throw error;
    throw new ProviderServiceError("CONFIG_INVALID", "login lease store is malformed");
  }
}

/** Writes the lease store; caller must hold `.provider-store`. */
async function writeLoginLeasesFileUnlocked(
  root: string,
  leases: ConnectionCredentialLease[],
): Promise<void> {
  const file = loginLeasesPath(root);
  await assertPrivateDir(root);
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProviderServiceError("CONFIG_INVALID", "private configuration file is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(leases, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await handle?.close();
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Caller must hold `.provider-store`; expired leases are removed before returning. */
async function activeLoginLeasesUnlocked(root: string): Promise<ConnectionCredentialLease[]> {
  const leases = await readLoginLeasesFile(root);
  const now = Date.now();
  const active = leases.filter((lease) => lease.expiresAt > now);
  if (active.length !== leases.length) await writeLoginLeasesFileUnlocked(root, active);
  return active;
}

/** Caller must hold `.provider-store` so reservation and the initial auth read are atomic. */
export async function reserveConnectionCredentialOwnership(
  root: string,
  connectionId: string,
): Promise<CredentialOwnerToken> {
  const key = credentialOwnerKey(root, connectionId);
  const leases = await activeLoginLeasesUnlocked(root);
  if (leases.some((lease) => lease.connectionId === connectionId)) throw loginInProgress();
  const token = randomUUID() as CredentialOwnerToken;
  const lease: ConnectionCredentialLease = {
    connectionId,
    owner: { pid: process.pid, token },
    expiresAt: Date.now() + LOGIN_LEASE_TTL_MS,
  };
  await writeLoginLeasesFileUnlocked(root, [...leases, lease]);
  credentialOwners.set(key, lease);
  return token;
}

/** Caller must hold `.provider-store`. */
export async function releaseConnectionCredentialOwnershipUnlocked(
  root: string,
  connectionId: string,
  ownerToken: CredentialOwnerToken,
): Promise<void> {
  const key = credentialOwnerKey(root, connectionId);
  const leases = await activeLoginLeasesUnlocked(root);
  const next = leases.filter((lease) => !(
    lease.connectionId === connectionId
    && lease.owner.pid === process.pid
    && lease.owner.token === ownerToken
  ));
  if (next.length !== leases.length) await writeLoginLeasesFileUnlocked(root, next);
  const cached = credentialOwners.get(key);
  if (cached?.owner.pid === process.pid && cached.owner.token === ownerToken) credentialOwners.delete(key);
}

export async function releaseConnectionCredentialOwnership(
  root: string,
  connectionId: string,
  ownerToken: CredentialOwnerToken,
): Promise<void> {
  await withProviderStoreLock(root, () =>
    releaseConnectionCredentialOwnershipUnlocked(root, connectionId, ownerToken));
}

export async function renewConnectionCredentialOwnership(
  root: string,
  connectionId: string,
  ownerToken: CredentialOwnerToken,
): Promise<void> {
  await withProviderStoreLock(root, async () => {
    const leases = await activeLoginLeasesUnlocked(root);
    const index = leases.findIndex((lease) => lease.connectionId === connectionId);
    const current = index >= 0 ? leases[index] : undefined;
    if (
      !current
      || current.owner.pid !== process.pid
      || current.owner.token !== ownerToken
    ) {
      throw loginInProgress();
    }
    const renewed: ConnectionCredentialLease = {
      ...current,
      expiresAt: Date.now() + LOGIN_LEASE_TTL_MS,
    };
    const next = [...leases];
    next[index] = renewed;
    await writeLoginLeasesFileUnlocked(root, next);
    credentialOwners.set(credentialOwnerKey(root, connectionId), renewed);
  });
}

/** Caller must hold `.provider-store` when using this as a pre-mutation guard. */
export async function assertConnectionCredentialWriteAllowed(
  root: string,
  connectionId: string,
  authorization?: CredentialWriteAuthorization,
): Promise<void> {
  const leases = await activeLoginLeasesUnlocked(root);
  const owner = leases.find((lease) => lease.connectionId === connectionId);
  if (!owner) {
    credentialOwners.delete(credentialOwnerKey(root, connectionId));
    return;
  }
  credentialOwners.set(credentialOwnerKey(root, connectionId), owner);
  if (
    authorization?.connectionId === connectionId
    && owner.owner.pid === process.pid
    && authorization.ownerToken === owner.owner.token
  ) return;
  throw loginInProgress();
}

async function assertAuthWriteAllowed(
  root: string,
  current: StoredAuth,
  next: StoredAuth,
  authorization?: CredentialWriteAuthorization,
): Promise<void> {
  for (const alias of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (isDeepStrictEqual(current[alias], next[alias])) continue;
    const prefix = "pi-jobs-";
    if (!alias.startsWith(prefix)) continue;
    await assertConnectionCredentialWriteAllowed(root, alias.slice(prefix.length), authorization);
  }
}

async function assertPrivateDir(root: string) {
  for (const dir of [path.join(root, ".pi-jobs"), path.join(root, ".pi-jobs", "pi-agent")]) {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await fs.lstat(dir)).isSymbolicLink()) {
      throw new ProviderServiceError("CONFIG_INVALID", "private configuration directory must not be a symlink");
    }
  }
}

async function assertPrivateReadPath(root: string) {
  for (const dir of [path.join(root, ".pi-jobs"), path.join(root, ".pi-jobs", "pi-agent")]) {
    try {
      const info = await fs.lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ProviderServiceError("CONFIG_INVALID", "private configuration directory is unsafe");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function validateStoredCredential(entry: unknown): Credential {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
  const type = (entry as { type?: unknown }).type;
  if (type === "api_key") {
    if (typeof (entry as { key?: unknown }).key !== "string") throw new Error();
    return entry as Credential;
  }
  if (type === "oauth") {
    const oauth = entry as { access?: unknown; refresh?: unknown; expires?: unknown };
    if (typeof oauth.access !== "string" || typeof oauth.refresh !== "string") throw new Error();
    if (typeof oauth.expires !== "number" || !Number.isFinite(oauth.expires)) throw new Error();
    return entry as Credential;
  }
  throw new Error();
}

export function parseAuthStoreText(
  text: string,
  malformedMessage = "credential store is malformed",
): StoredAuth {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const result: StoredAuth = {};
    for (const [alias, entry] of Object.entries(value)) {
      result[alias] = validateStoredCredential(entry);
    }
    return result;
  } catch {
    throw new ProviderServiceError("CONFIG_INVALID", malformedMessage);
  }
}

/** Validates entries at runtime; fails closed without rewriting the file. */
export async function readAuth(root: string): Promise<StoredAuth> {
  try {
    await assertPrivateReadPath(root);
    const file = authPath(root);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error();
    return parseAuthStoreText(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof ProviderServiceError) throw error;
    throw new ProviderServiceError("CONFIG_INVALID", "credential store is malformed");
  }
}

/** Writes auth.json; caller must hold `.provider-store`. */
export async function writeAuthFileUnlocked(
  root: string,
  value: StoredAuth,
  authorization?: CredentialWriteAuthorization,
) {
  const current = await readAuth(root);
  await assertAuthWriteAllowed(root, current, value, authorization);
  const file = authPath(root);
  await assertPrivateDir(root);
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ProviderServiceError("CONFIG_INVALID", "private configuration file is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await handle?.close();
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function ensureProviderStoreLockFile(root: string) {
  await assertPrivateDir(root);
  const lockTarget = providerStoreLockPath(root);
  try {
    const handle = await fs.open(lockTarget, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Serializes auth.json mutations. The lock is not re-entrant. */
export async function withProviderStoreLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await ensureProviderStoreLockFile(root);
  return withLock(providerStoreLockPath(root), fn);
}

export async function writeAuthFile(root: string, value: StoredAuth): Promise<void> {
  return withProviderStoreLock(root, () => writeAuthFileUnlocked(root, value));
}

export async function readAuthUnderLock(root: string): Promise<StoredAuth> {
  return withProviderStoreLock(root, () => readAuth(root));
}

export async function modifyAuthFile(
  root: string,
  mutate: (current: StoredAuth) => StoredAuth | Promise<StoredAuth>,
  authorization?: CredentialWriteAuthorization,
): Promise<StoredAuth> {
  return withProviderStoreLock(root, async () => {
    if (authorization) {
      await assertConnectionCredentialWriteAllowed(root, authorization.connectionId, authorization);
    }
    const current = await readAuth(root);
    const next = await mutate({ ...current });
    await writeAuthFileUnlocked(root, next, authorization);
    return next;
  });
}
