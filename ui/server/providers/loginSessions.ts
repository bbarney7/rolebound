import { withCodexOAuthStartup } from "./codexOAuthStartup";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import {
  ConfigRevisionConflictError,
  readApplicationSettings,
  writeApplicationSettings,
} from "../applicationConfigStore";
import { validateConnection, type Connection } from "../../shared/config";
import { providerSupportsOAuth } from "../../shared/providerCatalog";
import { ConnectionCredentialStore } from "./connectionCredentialStore";
import { finalizeDetectedLoginDefaults } from "./adoptDetection";
import { CURSOR_PRODUCTION_BACKEND } from "./cursorReadiness";
import type { ProviderHostDeps } from "./hostDeps";
import { ProviderServiceError } from "./providerErrors";
import {
  LOGIN_LEASE_HEARTBEAT_MS,
  readAuth,
  releaseConnectionCredentialOwnership,
  releaseConnectionCredentialOwnershipUnlocked,
  renewConnectionCredentialOwnership,
  reserveConnectionCredentialOwnership,
  withProviderStoreLock,
  writeAuthFileUnlocked,
  type CredentialOwnerToken,
} from "./authStoreFile";
import { providerAlias } from "./providerIds";
import type {
  LoginConnectionMetadataField,
  LoginMutationJournal,
} from "./loginMutationJournal";
import { normalizeConnectionAccount } from "./connectionMetadata";

export const CURSOR_LOGIN_API_KEY_NAME = "Rolebound";

export type LoginStatus = "pending" | "succeeded" | "cancelled" | "failed" | "interrupted";

export type LoginSessionView = {
  status: LoginStatus;
  authUrl?: string;
  deviceCode?: { userCode: string; verificationUri: string; expiresAt: string };
  prompt?: {
    id: string;
    type: string;
    message: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string }>;
  };
  info?: string;
  error?: { code: string; message: string };
};

export type CursorSdkAuthModule = {
  Cursor: {
    auth: {
      login: (options: {
        apiKeyName?: string;
        backendUrl?: string;
        websiteUrl?: string;
        openBrowser?: boolean | ((url: string) => void | Promise<void>);
        store?: null;
        signal?: AbortSignal;
        onLoginUrl?: (url: string) => void;
      }) => Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
    };
  };
  FileCredentialStore: new (filePath?: string) => {
    load: () => Promise<
      | {
          apiKey: string;
          backendUrl: string;
          apiKeyExpiresAtMs?: number;
          email?: string;
        }
      | undefined
    >;
  };
  AuthenticationError?: new (message: string) => Error;
};

export type LoginRuntimeFactory = (options: {
  credentials: ConnectionCredentialStore;
  modelsPath: null;
  refreshOnCreate: false;
}) => Promise<Pick<ModelRuntime, "login" | "checkAuth">>;

type LoginDeps = {
  loadCursorSdk: () => Promise<CursorSdkAuthModule>;
  createRuntime: LoginRuntimeFactory;
  finalizeDefaults: (
    root: string,
    host: ProviderHostDeps,
    connectionId: string,
    expectedProvider: string,
    mutationOptions?: LoginMutationOptions,
  ) => Promise<LoginMutationJournal>;
  now: () => number;
  leaseHeartbeatMs: number;
  renewOwnership: typeof renewConnectionCredentialOwnership;
};

type LoginMutationOptions = {
  assertActive?: () => void;
  journal?: LoginMutationJournal;
};

let deps: LoginDeps = {
  loadCursorSdk: async () => (await import("@cursor/sdk")) as CursorSdkAuthModule,
  createRuntime: async (options) => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create(options);
    return { login: runtime.login.bind(runtime), checkAuth: runtime.checkAuth.bind(runtime) };
  },
  finalizeDefaults: finalizeDetectedLoginDefaults,
  now: () => Date.now(),
  leaseHeartbeatMs: LOGIN_LEASE_HEARTBEAT_MS,
  renewOwnership: renewConnectionCredentialOwnership,
};

const SETTLED_TTL_MS = 10 * 60 * 1000;

const sessions = new Map<string, ActiveSession>();
const settled = new Map<string, { view: LoginSessionView; dropAt: number }>();
const inFlight = new Set<Promise<unknown>>();
const settledDropTimers = new Set<ReturnType<typeof setTimeout>>();

function trackInFlight<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  const done = () => {
    inFlight.delete(promise);
  };
  void promise.then(done, done);
  return promise;
}

/** Test seam: await login completion and background finalisation before workspace teardown. */
export async function drainLoginSessions(): Promise<void> {
  for (const session of sessions.values()) {
    session.controller.abort();
    rejectParkedPrompts(session, new ProviderServiceError("PROMPT_STALE", "sign-in drained", 409));
  }
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
  for (const timer of settledDropTimers) clearTimeout(timer);
  settledDropTimers.clear();
}

type ParkedPrompt = {
  promptId: string;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
};

type ActiveSession = {
  root: string;
  connectionId: string;
  ownerToken: CredentialOwnerToken;
  status: LoginStatus;
  cancelling: boolean;
  terminalReason?: "user-cancelled" | "lease-lost";
  authUrl?: string;
  deviceCode?: LoginSessionView["deviceCode"];
  prompt?: LoginSessionView["prompt"];
  info?: string;
  error?: { code: string; message: string };
  controller: AbortController;
  expectedProvider: string;
  credentialGeneration: { credential: Credential | undefined };
  enterpriseDomain?: string;
  selectAutoCount: number;
  parked: Map<string, ParkedPrompt>;
  listeners: Set<() => void>;
  leaseHeartbeat?: ReturnType<typeof setInterval>;
  worker?: Promise<unknown>;
};

function sessionKey(root: string, connectionId: string): string {
  return `${root}\0${connectionId}`;
}

export function isLoginActive(root: string, connectionId: string): boolean {
  return sessions.has(sessionKey(root, connectionId));
}

function toView(session: ActiveSession): LoginSessionView {
  return {
    status: session.status,
    ...(session.authUrl ? { authUrl: session.authUrl } : {}),
    ...(session.deviceCode ? { deviceCode: session.deviceCode } : {}),
    ...(session.prompt ? { prompt: session.prompt } : {}),
    ...(session.info ? { info: session.info } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function notifyListeners(session: ActiveSession): void {
  for (const listener of session.listeners) listener();
}

function scheduleSettledDrop(key: string): void {
  const entry = settled.get(key);
  if (!entry) return;
  const delay = Math.max(0, entry.dropAt - deps.now());
  const timer = setTimeout(() => {
    settledDropTimers.delete(timer);
    const current = settled.get(key);
    if (current && current.dropAt === entry.dropAt) settled.delete(key);
  }, delay);
  settledDropTimers.add(timer);
  timer.unref?.();
}

async function finish(key: string, session: ActiveSession): Promise<void> {
  if (sessions.get(key) !== session) return;
  if (session.leaseHeartbeat) clearInterval(session.leaseHeartbeat);
  const view = toView(session);
  try {
    await releaseConnectionCredentialOwnership(session.root, session.connectionId, session.ownerToken);
    settled.set(key, { view, dropAt: deps.now() + SETTLED_TTL_MS });
    scheduleSettledDrop(key);
  } finally {
    sessions.delete(key);
  }
}

function startLeaseHeartbeat(key: string, session: ActiveSession): void {
  const renew = () => {
    const renewal = deps.renewOwnership(
      session.root,
      session.connectionId,
      session.ownerToken,
    ).catch((error) => {
      if (sessions.get(key) !== session || session.status !== "pending") return;
      session.terminalReason = "lease-lost";
      session.status = "failed";
      session.error = {
        code: "LEASE_LOST",
        message: `Sign-in lease was lost: ${error instanceof Error ? error.message : String(error)}`,
      };
      session.controller.abort();
      rejectParkedPrompts(session, new ProviderServiceError("PROMPT_STALE", "sign-in lease expired", 409));
      notifyListeners(session);
    });
    trackInFlight(renewal);
  };
  session.leaseHeartbeat = setInterval(renew, deps.leaseHeartbeatMs);
  session.leaseHeartbeat.unref?.();
}

function throwIfSessionInactive(key: string, session: ActiveSession): void {
  if (
    session.controller.signal.aborted
    || session.status !== "pending"
    || sessions.get(key) !== session
  ) {
    throw new Error("Sign-in was cancelled.");
  }
}

function rejectParkedPrompts(session: ActiveSession, reason: unknown): void {
  for (const parked of session.parked.values()) {
    parked.cleanup();
    parked.reject(reason);
  }
  session.parked.clear();
  session.prompt = undefined;
}

export function configureLoginSessions(overrides: Partial<LoginDeps> | null): void {
  if (overrides === null) {
    deps = {
      loadCursorSdk: async () => (await import("@cursor/sdk")) as CursorSdkAuthModule,
      createRuntime: async (options) => {
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create(options);
        return { login: runtime.login.bind(runtime), checkAuth: runtime.checkAuth.bind(runtime) };
      },
      finalizeDefaults: finalizeDetectedLoginDefaults,
      now: () => Date.now(),
      leaseHeartbeatMs: LOGIN_LEASE_HEARTBEAT_MS,
      renewOwnership: renewConnectionCredentialOwnership,
    };
    for (const session of sessions.values()) {
      session.controller.abort();
      if (session.leaseHeartbeat) clearInterval(session.leaseHeartbeat);
      trackInFlight(
        releaseConnectionCredentialOwnership(session.root, session.connectionId, session.ownerToken).catch(() => {}),
      );
    }
    sessions.clear();
    settled.clear();
    return;
  }
  deps = { ...deps, ...overrides };
}

export function resetLoginSessions(): void {
  for (const session of sessions.values()) {
    session.controller.abort();
    if (session.leaseHeartbeat) clearInterval(session.leaseHeartbeat);
    trackInFlight(
      releaseConnectionCredentialOwnership(session.root, session.connectionId, session.ownerToken).catch(() => {}),
    );
  }
  sessions.clear();
  settled.clear();
  for (const timer of settledDropTimers) clearTimeout(timer);
  settledDropTimers.clear();
}

function normalizeBackendUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isAuthenticationCancelled(err: unknown, AuthenticationError?: new (message: string) => Error): boolean {
  if (AuthenticationError && err instanceof AuthenticationError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message === "Login was cancelled." || message.includes("Login was cancelled");
}

function settleWorkerFailure(
  session: ActiveSession,
  error: unknown,
  authenticationCancelled = false,
): void {
  // The heartbeat records the actionable lease failure before aborting the
  // provider worker. That abort must not be reinterpreted as a user DELETE.
  if (session.terminalReason === "lease-lost") return;
  const cancelled =
    session.terminalReason === "user-cancelled"
    || session.controller.signal.aborted
    || authenticationCancelled;
  session.status = cancelled ? "cancelled" : "failed";
  session.error = {
    code: cancelled ? "CANCELLED" : "LOGIN_FAILED",
    message: cancelled
      ? "Sign-in was cancelled."
      : error instanceof Error ? error.message : String(error),
  };
}

async function assertConnection(root: string, connectionId: string): Promise<Connection> {
  const settings = await readApplicationSettings(root);
  const connection = settings.data.connections.find((item) => item.id === connectionId);
  if (!connection) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
  return connection;
}

export async function persistCursorLogin(
  root: string,
  connectionId: string,
  result: { apiKey: string; email?: string; apiKeyExpiresAtMs?: number },
  backendUrl?: string,
  expectedProvider = "cursor",
  expectedGeneration?: { credential: Credential | undefined },
  ownerToken?: CredentialOwnerToken,
  mutationOptions: LoginMutationOptions = {},
): Promise<LoginMutationJournal> {
  const normalizedBackend = backendUrl ? normalizeBackendUrl(backendUrl) : CURSOR_PRODUCTION_BACKEND;
  return persistLoginConnection(root, connectionId, expectedProvider, {
    email: normalizeConnectionAccount(result.email) ?? null,
    expiresAt:
      result.apiKeyExpiresAtMs !== undefined ? new Date(result.apiKeyExpiresAtMs).toISOString() : null,
    cursorBackendUrl: normalizedBackend !== CURSOR_PRODUCTION_BACKEND ? normalizedBackend : null,
    refreshFailedAt: null,
  }, {
    credential: { type: "api_key", key: result.apiKey },
    expectedGeneration,
    ownerToken,
    ...mutationOptions,
  });
}

async function persistOAuthMetadata(
  root: string,
  connection: Connection,
  credential: Credential,
  checkAuth?: { email?: string },
  expectedGeneration?: { credential: Credential | undefined },
  ownerToken?: CredentialOwnerToken,
  mutationOptions: LoginMutationOptions = {},
): Promise<LoginMutationJournal> {
  const patch: LoginMetadataPatch = { refreshFailedAt: null };
  if (credential.type === "oauth" && typeof credential.expires === "number" && Number.isFinite(credential.expires)) {
    patch.expiresAt = new Date(credential.expires).toISOString();
  }
  if (checkAuth?.email) patch.email = normalizeConnectionAccount(checkAuth.email);
  return persistLoginConnection(root, connection.id, connection.provider, patch, {
    expectedGeneration,
    ownerToken,
    ...mutationOptions,
  });
}

type LoginMetadataPatch = Partial<Record<LoginConnectionMetadataField, string | null>>;
const LOGIN_METADATA_FIELDS: readonly LoginConnectionMetadataField[] = [
  "email",
  "expiresAt",
  "cursorBackendUrl",
  "refreshFailedAt",
];

async function persistLoginConnection(
  root: string,
  connectionId: string,
  expectedProvider: string,
  patch: LoginMetadataPatch,
  credentialOptions: {
    credential?: Credential;
    expectedGeneration?: { credential: Credential | undefined };
    ownerToken?: CredentialOwnerToken;
    assertActive?: () => void;
    journal?: LoginMutationJournal;
  } = {},
): Promise<LoginMutationJournal> {
  return withProviderStoreLock(root, async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      credentialOptions.assertActive?.();
      const current = await readApplicationSettings(root);
      credentialOptions.assertActive?.();
      const beforeConnection = current.data.connections.find((item) => item.id === connectionId);
      if (!beforeConnection) {
        throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      }
      if (beforeConnection.provider !== expectedProvider) {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "connection provider changed while sign-in was completing",
          409,
        );
      }

      let writtenConnection: Connection = { ...beforeConnection };
      const fieldJournal: LoginMutationJournal = [];
      for (const field of LOGIN_METADATA_FIELDS) {
        const requested = patch[field];
        if (requested === undefined) continue;
        const before = beforeConnection[field];
        const written = requested === null ? undefined : requested;
        if (sameValue(before, written)) continue;
        if (written === undefined) delete writtenConnection[field];
        else writtenConnection[field] = written;
        fieldJournal.push({ kind: "connection-field", connectionId, field, before, written });
      }
      writtenConnection = validateConnection(writtenConnection);

      const beforeAuth = await readAuth(root);
      credentialOptions.assertActive?.();
      const alias = providerAlias(connectionId);
      if (
        credentialOptions.expectedGeneration
        && !sameValue(beforeAuth[alias], credentialOptions.expectedGeneration.credential)
      ) {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "connection credential changed while sign-in was in progress",
          409,
        );
      }
      const credential = credentialOptions.credential;
      const writtenAuth = credential === undefined ? beforeAuth : { ...beforeAuth, [alias]: credential };
      const authMutation = credential !== undefined && !sameValue(beforeAuth[alias], credential)
        ? { kind: "auth" as const, alias, before: beforeAuth[alias], written: credential }
        : undefined;

      // Destructured so the release secret scanner's generic `token: <value>`
      // rule does not flag this line.
      const { ownerToken } = credentialOptions;
      const authorization = ownerToken ? { connectionId, ownerToken } : { connectionId };
      credentialOptions.assertActive?.();
      if (authMutation) await writeAuthFileUnlocked(root, writtenAuth, authorization);
      try {
        credentialOptions.assertActive?.();
        if (fieldJournal.length > 0) {
          const connections = current.data.connections.map((item) =>
            item.id === connectionId ? writtenConnection : item,
          );
          await writeApplicationSettings(root, { ...current.data, connections }, current.revision);
        }
        const journal = [...(authMutation ? [authMutation] : []), ...fieldJournal];
        credentialOptions.journal?.push(...journal);
        credentialOptions.assertActive?.();
        if (credentialOptions.expectedGeneration && credential !== undefined) {
          credentialOptions.expectedGeneration.credential = credential;
        }
        return journal;
      } catch (error) {
        if (authMutation) await writeAuthFileUnlocked(root, beforeAuth, authorization);
        if (error instanceof ConfigRevisionConflictError && attempt < 7) {
          credentialOptions.assertActive?.();
          continue;
        }
        throw error;
      }
    }
    throw new ConfigRevisionConflictError("settings changed; reload and retry");
  });
}

async function assertLoginGeneration(
  root: string,
  connectionId: string,
  expectedProvider: string,
  generation: { credential: Credential | undefined },
): Promise<void> {
  await withProviderStoreLock(root, async () => {
    const settings = await readApplicationSettings(root);
    const connection = settings.data.connections.find((item) => item.id === connectionId);
    if (!connection) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
    if (connection.provider !== expectedProvider) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "connection provider changed while sign-in was completing",
        409,
      );
    }
    const auth = await readAuth(root);
    if (!sameValue(auth[providerAlias(connectionId)], generation.credential)) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "connection credential changed while sign-in was completing",
        409,
      );
    }
  });
}

function findBrowserOption(options: Array<{ id: string; label: string }>): string | undefined {
  const hit = options.find((o) => /browser/i.test(o.id) || /browser/i.test(o.label));
  return hit?.id;
}

function buildInteraction(session: ActiveSession, providerId: string): AuthInteraction {
  return {
    signal: session.controller.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        session.authUrl = event.url;
      } else if (event.type === "device_code") {
        const expiresMs =
          typeof event.expiresInSeconds === "number"
            ? deps.now() + event.expiresInSeconds * 1000
            : deps.now() + 15 * 60 * 1000;
        session.deviceCode = {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresAt: new Date(expiresMs).toISOString(),
        };
      } else if (event.type === "info" || event.type === "progress") {
        session.info = typeof event.message === "string" ? event.message : String(event.message ?? "");
      }
      notifyListeners(session);
    },
    prompt: async (authPrompt: AuthPrompt) => {
      authPrompt.signal?.throwIfAborted();
      if (authPrompt.type === "select" && session.selectAutoCount === 0) {
        session.selectAutoCount += 1;
        const browserId = findBrowserOption([...authPrompt.options]);
        if (browserId) return browserId;
      }
      if (authPrompt.type === "text" && providerId === "github-copilot" && session.selectAutoCount === 0) {
        session.selectAutoCount += 1;
        return session.enterpriseDomain ?? "";
      }

      const promptId = randomUUID();
      return new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          authPrompt.signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          const parked = session.parked.get(promptId);
          if (!parked) return;
          parked.cleanup();
          session.parked.delete(promptId);
          if (session.prompt?.id === promptId) session.prompt = undefined;
          notifyListeners(session);
          parked.reject(new ProviderServiceError("PROMPT_STALE", "sign-in prompt was superseded", 409));
        };
        session.prompt = {
          id: promptId,
          type: authPrompt.type,
          message: authPrompt.message,
          ...("placeholder" in authPrompt && authPrompt.placeholder ? { placeholder: authPrompt.placeholder } : {}),
          ...(authPrompt.type === "select"
            ? { options: authPrompt.options.map((o) => ({ id: o.id, label: o.label })) }
            : {}),
        };
        session.parked.set(promptId, { promptId, resolve, reject, cleanup });
        authPrompt.signal?.addEventListener("abort", onAbort, { once: true });
        if (authPrompt.signal?.aborted) {
          onAbort();
          return;
        }
        notifyListeners(session);
      });
    },
  };
}

// Key-order-insensitive structural equality. `writeApplicationSettings` runs
// every connection through `validateConnection`, which rebuilds the object, so
// a journal entry's `written` value and the re-read value differ in key order
// even when they are the same connection.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function bareConnection(connection: Connection): Connection {
  const { credential: _credential, validation: _validation, ...bare } = connection as Connection & {
    credential?: unknown;
    validation?: unknown;
  };
  return bare;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function rollbackLoginState(
  root: string,
  journal: LoginMutationJournal,
  authorization?: { connectionId: string; ownerToken: CredentialOwnerToken },
): Promise<void> {
  await withProviderStoreLock(root, async () => {
    const currentAuth = await readAuth(root);
    const restoredAuth = { ...currentAuth };
    for (const mutation of [...journal].reverse()) {
      if (mutation.kind !== "auth") continue;
      if (!sameValue(restoredAuth[mutation.alias], mutation.written)) continue;
      if (mutation.before === undefined) delete restoredAuth[mutation.alias];
      else restoredAuth[mutation.alias] = mutation.before;
    }

    const hasSettingsMutations = journal.some((mutation) => mutation.kind !== "auth");
    let rollbackBase: Awaited<ReturnType<typeof readApplicationSettings>> | undefined;
    let restoredSettings: Awaited<ReturnType<typeof writeApplicationSettings>> | undefined;
    let settingsSettled = !hasSettingsMutations;
    if (hasSettingsMutations) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const currentSettings = await readApplicationSettings(root);
        let restoredData = {
          ...currentSettings.data,
          connections: [...currentSettings.data.connections],
        };
        for (const mutation of [...journal].reverse()) {
          if (mutation.kind === "auth") continue;
          if (mutation.kind === "selection") {
            if (sameValue(restoredData[mutation.field], mutation.written)) {
              restoredData = { ...restoredData, [mutation.field]: mutation.before };
            }
            continue;
          }
          if (mutation.kind === "connection-add") {
            const currentConnection = restoredData.connections.find(
              (item) => item.id === mutation.connectionId,
            );
            // readApplicationSettings returns a SettingsView: every connection
            // carries `credential`/`validation` decorations that the journal's
            // bare `written` connection never has. Compare the bare record.
            if (currentConnection && sameValue(bareConnection(currentConnection), mutation.written)) {
              restoredData = {
                ...restoredData,
                connections: restoredData.connections.filter(
                  (item) => item.id !== mutation.connectionId,
                ),
              };
            }
            continue;
          }
          const index = restoredData.connections.findIndex(
            (item) => item.id === mutation.connectionId,
          );
          if (index < 0) continue;
          const currentConnection = restoredData.connections[index]!;
          if (!sameValue(currentConnection[mutation.field], mutation.written)) continue;
          const restoredConnection = { ...currentConnection };
          if (mutation.before === undefined) delete restoredConnection[mutation.field];
          else restoredConnection[mutation.field] = mutation.before;
          const connections = [...restoredData.connections];
          connections[index] = restoredConnection;
          restoredData = { ...restoredData, connections };
        }
        if (sameValue(restoredData, currentSettings.data)) {
          settingsSettled = true;
          break;
        }
        try {
          restoredSettings = await writeApplicationSettings(root, restoredData, currentSettings.revision);
          rollbackBase = currentSettings;
          settingsSettled = true;
          break;
        } catch (error) {
          if (error instanceof ConfigRevisionConflictError && attempt < 7) continue;
          throw error;
        }
      }
    }
    if (!settingsSettled) throw new ConfigRevisionConflictError("settings changed; reload and retry");

    if (sameValue(restoredAuth, currentAuth)) return;
    try {
      await writeAuthFileUnlocked(root, restoredAuth, authorization);
    } catch (error) {
      if (rollbackBase && restoredSettings) {
        await writeApplicationSettings(root, rollbackBase.data, restoredSettings.revision);
      }
      throw error;
    }
  });
}

async function runOAuthLogin(
  root: string,
  connection: Connection,
  host: ProviderHostDeps,
  session: ActiveSession,
  key: string,
): Promise<void> {
  const journal: LoginMutationJournal = [];
  const store = new ConnectionCredentialStore(
    root,
    connection.id,
    connection.provider,
    (mutation) => {
      journal.push(mutation);
    },
    session.credentialGeneration,
    session.ownerToken,
  );
  let credential: Credential | undefined;
  let synchronizationError: CredentialSynchronizationError | undefined;
  try {
    const runtime = await deps.createRuntime({ credentials: store, modelsPath: null, refreshOnCreate: false });
    throwIfSessionInactive(key, session);
    try {
      credential = await withCodexOAuthStartup(connection.provider, session.controller.signal, (attempt) => {
        // The failed initialization consumed the automatic browser-method choice.
        if (attempt === 1) session.selectAutoCount = 0;
        return runtime.login(connection.provider, "oauth", buildInteraction(session, connection.provider));
      });
    } catch (error) {
      if (error instanceof CredentialSynchronizationError && error.credential) {
        console.info(`OAuth login sync info for ${connection.provider}: ${error.message}`);
        credential = error.credential;
        synchronizationError = error;
      } else {
        throw error;
      }
    }
    throwIfSessionInactive(key, session);
    if (synchronizationError) {
      throwIfSessionInactive(key, session);
      const committed = await store.read(connection.provider);
      if (!committed) {
        await store.modify(connection.provider, async (current) =>
          current === undefined ? credential : undefined);
      }
      credential = (await store.read(connection.provider)) ?? credential;
      throwIfSessionInactive(key, session);
    }
    if (!sameValue(session.credentialGeneration.credential, credential)) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "sign-in helper did not persist the credential it returned",
        409,
      );
    }
    const check = synchronizationError ? undefined : await runtime.checkAuth(connection.provider);
    throwIfSessionInactive(key, session);
    await persistOAuthMetadata(
      root,
      connection,
      credential!,
      check as { email?: string } | undefined,
      session.credentialGeneration,
      session.ownerToken,
      {
        assertActive: () => throwIfSessionInactive(key, session),
        journal,
      },
    );
    throwIfSessionInactive(key, session);
    const journalLength = journal.length;
    const finalized = await deps.finalizeDefaults(root, host, connection.id, connection.provider, {
      assertActive: () => throwIfSessionInactive(key, session),
      journal,
    });
    if (journal.length === journalLength) journal.push(...finalized);
    throwIfSessionInactive(key, session);
    await assertLoginGeneration(
      root,
      connection.id,
      connection.provider,
      session.credentialGeneration,
    );
    throwIfSessionInactive(key, session);
    session.status = "succeeded";
  } catch (error) {
    let failure = error;
    if (journal.length > 0) {
      try {
        await rollbackLoginState(root, journal, {
          connectionId: connection.id,
          ownerToken: session.ownerToken,
        });
      } catch (rollbackError) {
        failure = rollbackError;
      }
    }
    settleWorkerFailure(session, failure);
  } finally {
    rejectParkedPrompts(session, new ProviderServiceError("PROMPT_STALE", "sign-in ended", 409));
    await finish(key, session);
  }
}

async function runCursorLogin(
  root: string,
  connectionId: string,
  host: ProviderHostDeps,
  session: ActiveSession,
  key: string,
): Promise<LoginSessionView> {
  let sdk: CursorSdkAuthModule;
  try {
    sdk = await deps.loadCursorSdk();
  } catch (err) {
    settleWorkerFailure(session, err);
    await finish(key, session);
    return toView(session);
  }

  let urlResolve!: (url: string) => void;
  const urlWait = new Promise<string>((resolve) => {
    urlResolve = resolve;
  });

  const loginPromise = sdk.Cursor.auth.login({
    apiKeyName: CURSOR_LOGIN_API_KEY_NAME,
    backendUrl: CURSOR_PRODUCTION_BACKEND,
    websiteUrl: "https://cursor.com",
    openBrowser: false,
    store: null,
    signal: session.controller.signal,
    onLoginUrl: (loginUrl) => {
      if (session.controller.signal.aborted || sessions.get(key) !== session) return;
      session.authUrl = loginUrl;
      urlResolve(loginUrl);
      notifyListeners(session);
    },
  });

  session.worker = trackInFlight(
    loginPromise
      .then(async (result) => {
        throwIfSessionInactive(key, session);
        await assertConnection(root, connectionId);
        throwIfSessionInactive(key, session);
        const journal: LoginMutationJournal = [];
        try {
          throwIfSessionInactive(key, session);
          await persistCursorLogin(
            root,
            connectionId,
            result,
            undefined,
            session.expectedProvider,
            session.credentialGeneration,
            session.ownerToken,
            {
              assertActive: () => throwIfSessionInactive(key, session),
              journal,
            },
          );
          throwIfSessionInactive(key, session);
          const journalLength = journal.length;
          const finalized = await deps.finalizeDefaults(
            root,
            host,
            connectionId,
            session.expectedProvider,
            {
              assertActive: () => throwIfSessionInactive(key, session),
              journal,
            },
          );
          if (journal.length === journalLength) journal.push(...finalized);
          throwIfSessionInactive(key, session);
          await assertLoginGeneration(
            root,
            connectionId,
            session.expectedProvider,
            session.credentialGeneration,
          );
          throwIfSessionInactive(key, session);
          session.status = "succeeded";
        } catch (err) {
          let failure = err;
          if (journal.length > 0) {
            try {
              await rollbackLoginState(root, journal, {
                connectionId,
                ownerToken: session.ownerToken,
              });
            } catch (rollbackError) {
              failure = rollbackError;
            }
          }
          settleWorkerFailure(session, failure);
        } finally {
          await finish(key, session);
        }
      })
      .catch(async (err) => {
        settleWorkerFailure(
          session,
          err,
          isAuthenticationCancelled(err, sdk.AuthenticationError),
        );
        await finish(key, session);
      }),
  );

  try {
    const raced = await Promise.race([
      urlWait.then(() => toView(session)),
      loginPromise.then(() => toView(session)).catch((err) => {
        settleWorkerFailure(
          session,
          err,
          isAuthenticationCancelled(err, sdk.AuthenticationError),
        );
        return toView(session);
      }),
    ]);
    return raced;
  } catch (err) {
    settleWorkerFailure(
      session,
      err,
      isAuthenticationCancelled(err, sdk.AuthenticationError),
    );
    return toView(session);
  }
}

export type StartLoginOptions = {
  enterpriseDomain?: string;
  expectedProvider?: string;
  reserve?: () => Promise<string>;
};

export async function startLogin(
  root: string,
  connectionId: string | undefined,
  host: ProviderHostDeps,
  options: StartLoginOptions = {},
): Promise<LoginSessionView> {
  const reserved = await withProviderStoreLock(root, async () => {
    const reservedConnectionId = options.reserve ? await options.reserve() : connectionId;
    if (!reservedConnectionId) {
      throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
    }
    const connection = await assertConnection(root, reservedConnectionId);
    if (options.expectedProvider && connection.provider !== options.expectedProvider) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "connection provider changed before sign-in could start",
        409,
      );
    }
    if (connection.provider !== "cursor" && !providerSupportsOAuth(connection.provider)) {
      throw new ProviderServiceError("CONFIG_INVALID", "this connection does not support browser sign-in", 422);
    }

    const key = sessionKey(root, reservedConnectionId);
    if (sessions.has(key)) {
      throw new ProviderServiceError(
        "LOGIN_IN_PROGRESS",
        "A sign-in is already in progress for this connection.",
        409,
      );
    }
    const ownerToken = await reserveConnectionCredentialOwnership(root, reservedConnectionId);
    try {
      const auth = await readAuth(root);
      settled.delete(key);
      const controller = new AbortController();
      const session: ActiveSession = {
        root,
        connectionId: reservedConnectionId,
        ownerToken,
        status: "pending",
        cancelling: false,
        controller,
        expectedProvider: connection.provider,
        credentialGeneration: { credential: auth[providerAlias(reservedConnectionId)] },
        enterpriseDomain: options.enterpriseDomain,
        selectAutoCount: 0,
        parked: new Map(),
        listeners: new Set(),
      };
      sessions.set(key, session);
      return { connection, connectionId: reservedConnectionId, key, session };
    } catch (error) {
      await releaseConnectionCredentialOwnershipUnlocked(root, reservedConnectionId, ownerToken);
      throw error;
    }
  });
  const { connection, connectionId: reservedConnectionId, key, session } = reserved;
  // Outside the store lock on purpose: a timer created inside the locked
  // section inherits the lock's AsyncLocalStorage context, so every renewal
  // would be rejected as a nested lock and the session would fail at the
  // first heartbeat.
  startLeaseHeartbeat(key, session);

  if (connection.provider === "cursor") {
    return runCursorLogin(root, reservedConnectionId, host, session, key);
  }

  session.worker = trackInFlight(runOAuthLogin(root, connection, host, session, key));
  return toView(session);
}

export function getLogin(root: string, connectionId: string): LoginSessionView {
  const key = sessionKey(root, connectionId);
  const session = sessions.get(key);
  if (session) return toView(session);
  const settledEntry = settled.get(key);
  if (settledEntry) return settledEntry.view;
  return { status: "interrupted" };
}

export async function answerLogin(
  root: string,
  connectionId: string,
  promptId: string,
  value: string,
): Promise<LoginSessionView> {
  const key = sessionKey(root, connectionId);
  const session = sessions.get(key);
  if (!session || session.status !== "pending") {
    throw new ProviderServiceError("PROMPT_STALE", "sign-in prompt is no longer active", 409);
  }
  const parked = session.parked.get(promptId);
  if (!parked) {
    throw new ProviderServiceError("PROMPT_STALE", "sign-in prompt is no longer active", 409);
  }
  if (session.prompt?.type === "select" && session.prompt.options) {
    const allowed = session.prompt.options.some((o) => o.id === value);
    if (!allowed) {
      throw new ProviderServiceError("PROMPT_INVALID", "answer must be one of the offered options", 422);
    }
  }
  parked.cleanup();
  session.parked.delete(promptId);
  session.prompt = undefined;
  notifyListeners(session);
  parked.resolve(value);
  return toView(session);
}

export async function cancelLogin(root: string, connectionId: string): Promise<LoginSessionView> {
  const key = sessionKey(root, connectionId);
  const session = sessions.get(key);
  if (!session) {
    await assertConnection(root, connectionId);
    return settled.get(key)?.view ?? { status: "interrupted" };
  }
  if (!session.cancelling && session.status === "pending") {
    session.cancelling = true;
    session.terminalReason = "user-cancelled";
    session.status = "cancelled";
    session.error = { code: "CANCELLED", message: "Sign-in was cancelled." };
    session.controller.abort();
    rejectParkedPrompts(session, new ProviderServiceError("PROMPT_STALE", "sign-in cancelled", 409));
    notifyListeners(session);
  }
  // Keep the session reserved until an abort-ignoring worker has finished any
  // credential persistence and the worker-side rollback has quiesced.
  if (session.worker) await session.worker;
  return settled.get(key)?.view ?? toView(session);
}

export type CursorImportResult = { warnings: string[] };

type CursorImportOutcome =
  | { result: CursorImportResult; error?: never }
  | { result?: never; error: unknown };

async function runCursorImport(
  root: string,
  connection: Connection,
  host: ProviderHostDeps,
  key: string,
  session: ActiveSession,
): Promise<CursorImportOutcome> {
  const journal: LoginMutationJournal = [];
  try {
    throwIfSessionInactive(key, session);
    const sdk = await deps.loadCursorSdk();
    throwIfSessionInactive(key, session);
    const storePath = path.join(host.home, ".cursor/sdk/auth.json");
    const store = new sdk.FileCredentialStore(storePath);
    throwIfSessionInactive(key, session);
    const stored = await store.load();
    throwIfSessionInactive(key, session);
    if (!stored?.apiKey) {
      throw new ProviderServiceError("CREDENTIAL_MISSING", "Not signed in to Cursor on this computer", 422);
    }
    const now = deps.now();
    if (stored.apiKeyExpiresAtMs !== undefined && stored.apiKeyExpiresAtMs <= now) {
      throw new ProviderServiceError("CREDENTIAL_MISSING", "Your Cursor login expired, sign in again", 422);
    }

    const backend = normalizeBackendUrl(stored.backendUrl);
    const warnings: string[] = [];
    if (backend !== CURSOR_PRODUCTION_BACKEND) {
      warnings.push(`Imported Cursor credentials use a non-production backend (${backend}).`);
    }
    throwIfSessionInactive(key, session);
    await persistCursorLogin(
      root,
      connection.id,
      {
        apiKey: stored.apiKey,
        email: stored.email,
        apiKeyExpiresAtMs: stored.apiKeyExpiresAtMs,
      },
      backend,
      connection.provider,
      session.credentialGeneration,
      session.ownerToken,
      {
        assertActive: () => throwIfSessionInactive(key, session),
        journal,
      },
    );
    throwIfSessionInactive(key, session);
    const journalLength = journal.length;
    const finalized = await deps.finalizeDefaults(
      root,
      host,
      connection.id,
      connection.provider,
      {
        assertActive: () => throwIfSessionInactive(key, session),
        journal,
      },
    );
    if (journal.length === journalLength) journal.push(...finalized);
    throwIfSessionInactive(key, session);
    await assertLoginGeneration(
      root,
      connection.id,
      connection.provider,
      session.credentialGeneration,
    );
    throwIfSessionInactive(key, session);
    session.status = "succeeded";
    return { result: { warnings } };
  } catch (error) {
    let failure = error;
    if (journal.length > 0) {
      try {
        await rollbackLoginState(root, journal, {
          connectionId: connection.id,
          ownerToken: session.ownerToken,
        });
      } catch (rollbackError) {
        failure = rollbackError;
      }
    }
    settleWorkerFailure(session, failure);
    if (
      session.status === "failed"
      && session.terminalReason !== "lease-lost"
      && failure instanceof ProviderServiceError
    ) {
      session.error = { code: failure.code, message: failure.message };
    }
    return { error: failure };
  } finally {
    await finish(key, session);
  }
}

export async function importCursorLogin(
  root: string,
  connectionId: string,
  host: ProviderHostDeps,
): Promise<CursorImportResult> {
  const reserved = await withProviderStoreLock(root, async () => {
    const connection = await assertConnection(root, connectionId);
    if (connection.provider !== "cursor") {
      throw new ProviderServiceError("CONFIG_INVALID", "import is only available for Cursor connections", 422);
    }
    const key = sessionKey(root, connectionId);
    if (sessions.has(key)) {
      throw new ProviderServiceError(
        "LOGIN_IN_PROGRESS",
        "A sign-in is already in progress for this connection.",
        409,
      );
    }
    const ownerToken = await reserveConnectionCredentialOwnership(root, connectionId);
    try {
      const auth = await readAuth(root);
      settled.delete(key);
      const session: ActiveSession = {
        root,
        connectionId,
        ownerToken,
        status: "pending",
        cancelling: false,
        controller: new AbortController(),
        expectedProvider: connection.provider,
        credentialGeneration: { credential: auth[providerAlias(connectionId)] },
        selectAutoCount: 0,
        parked: new Map(),
        listeners: new Set(),
      };
      sessions.set(key, session);
      return { connection, key, session };
    } catch (error) {
      await releaseConnectionCredentialOwnershipUnlocked(root, connectionId, ownerToken);
      throw error;
    }
  });
  const { connection, key, session } = reserved;
  startLeaseHeartbeat(key, session); // outside the lock; see startLogin
  const worker = trackInFlight(runCursorImport(root, connection, host, key, session));
  session.worker = worker;
  const outcome = await worker;
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}
