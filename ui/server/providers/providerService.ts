import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ConfigRevisionConflictError, readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import {
  catalogApiKeyEnv,
  validateConnection,
  validateSelection,
  type Connection,
  type ConnectionView,
  type CredentialSource,
  type ModelSelection,
} from "../../shared/config";
import { catalogEntryFor } from "../../shared/providerCatalog";
import type { ConnectionCreate, CredentialResolution } from "../../shared/providers";
import { isolatedMetadataRuntime } from "./metadataRuntime";
import { ensureCursorCatalog, listCursorPiModelIds } from "./cursorModels";
import { JEV_OPENROUTER_PICKER_MODELS, JEV_TYPESAFE_MODEL_ID, JEV_TYPESAFE_PROVIDER } from "../../shared/jevModels";
import {
  assertConnectionCredentialWriteAllowed,
  authPath,
  providerStoreLockPath,
  readAuth,
  withProviderStoreLock,
  writeAuthFileUnlocked,
  type StoredAuth,
} from "./authStoreFile";
import { ConnectionCredentialStore } from "./connectionCredentialStore";
import { ProviderServiceError } from "./providerErrors";
import { providerAlias } from "./providerIds";
import { selectionConfigBlockers } from "./selectionRules";

export { readAuth } from "./authStoreFile";
export { ProviderServiceError } from "./providerErrors";
export { providerAlias } from "./providerIds";

const LIVE_CATALOG_PROVIDERS = new Set(["openai", "anthropic", "google"]);
export const modelPath = (root: string) => path.join(root, ".pi-jobs", "pi-agent", "models.json");

const validations = new Map<string, ConnectionView["validation"]>();
const validationKey = (root: string, id: string) => `${root}\0${id}`;

export type ModelRuntimeFactory = (options: {
  credentials: CredentialStore;
  modelsPath: null;
  refreshOnCreate: false;
}) => Promise<Pick<ModelRuntime, "getAuth">>;

let modelRuntimeFactoryOverride: ModelRuntimeFactory | undefined;

export function setModelRuntimeFactoryForTests(factory: ModelRuntimeFactory | undefined): void {
  modelRuntimeFactoryOverride = factory;
}

const bare = (connection: Connection): Connection => {
  const value = connection as Connection & { credential?: unknown; validation?: unknown };
  const { credential: _c, validation: _v, ...result } = value;
  return result;
};

function oauthExpiresAtIso(credential: StoredAuth[string]): string | undefined {
  if (credential.type !== "oauth") return undefined;
  return new Date(credential.expires).toISOString();
}

export function effectiveCredentialSource(
  connection: Connection,
  auth: StoredAuth,
  env: NodeJS.ProcessEnv,
): CredentialSource {
  const stored = auth[providerAlias(connection.id)];
  if (stored?.type === "oauth") return "oauth";
  const envName = catalogApiKeyEnv(connection);
  if (envName && env[envName]?.trim()) return "environment";
  if (stored?.type === "api_key" && stored.key) return "app-store";
  return "none";
}

function rejectApiKeyForOAuthOnlyProvider(connection: Connection, apiKey: string | undefined | null): void {
  if (apiKey === undefined || apiKey === null) return;
  const entry = catalogEntryFor(connection.provider);
  if (entry?.auth.oauth && !entry?.auth.apiKey) {
    throw new ProviderServiceError("CONFIG_INVALID", "this provider does not accept pasted API keys", 422);
  }
}

function publicConnection(root: string, connection: Connection, auth: StoredAuth, env: NodeJS.ProcessEnv): ConnectionView {
  const alias = providerAlias(connection.id);
  const stored = auth[alias];
  const validation = validations.get(validationKey(root, connection.id)) ?? { status: "untested", checkedAt: null };
  const source = effectiveCredentialSource(connection, auth, env);

  if (source === "oauth" && stored?.type === "oauth") {
    const expiresAt = oauthExpiresAtIso(stored) ?? connection.expiresAt;
    return {
      ...connection,
      ...(expiresAt ? { expiresAt } : {}),
      credential: { configured: true, source: "oauth" },
      validation,
    };
  }

  return {
    ...connection,
    credential: { configured: source !== "none", source },
    validation,
  };
}

function validateKey(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("!") || /\$\{?[A-Z_][A-Z0-9_]*\}?/.test(value)) {
    throw new ProviderServiceError("CONFIG_INVALID", "credential must be a literal nonempty value");
  }
  return value.trim();
}

async function createModelRuntime(
  connection: Connection,
  store: ConnectionCredentialStore,
): Promise<ModelRuntime> {
  const factory =
    modelRuntimeFactoryOverride ??
    (async (options) => {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      return ModelRuntime.create(options);
    });
  return factory({ credentials: store, modelsPath: null, refreshOnCreate: false }) as Promise<ModelRuntime>;
}

function isOAuthRefreshFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("OAuth refresh failed") || ["AbortError", "TimeoutError"].includes(error.name))
  );
}

async function resolveOAuthCredential(
  root: string,
  connection: Connection,
  stored: Extract<StoredAuth[string], { type: "oauth" }>,
): Promise<{
  auth?: CredentialResolution["auth"];
  authError?: unknown;
  usedCredential: Credential | undefined;
}> {
  const store = new ConnectionCredentialStore(root, connection.id, connection.provider);
  const runtime = await createModelRuntime(connection, store);
  let authResult: Awaited<ReturnType<ModelRuntime["getAuth"]>> | undefined;
  let authError: unknown;
  store.beginObservation();
  try {
    authResult = await runtime.getAuth(connection.provider, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    authError = error;
  }

  const observation = store.endObservation();
  // Test doubles do not necessarily consult the injected store. Production
  // runtimes do; the starting OAuth generation is the coherent fallback for a
  // double that only returns the corresponding ModelAuth.
  const usedCredential = observation.observed ? observation.credential : stored;
  return { auth: authResult?.auth, authError, usedCredential };
}

async function mutateConnection(
  root: string,
  expectedRevision: string,
  mutate: (connections: Connection[], settings: Awaited<ReturnType<typeof readApplicationSettings>>["data"]) => Connection[],
  credential?: { id: string; key?: string | null },
) {
  return withProviderStoreLock(root, async () => {
    const current = await readApplicationSettings(root);
    if (current.revision !== expectedRevision) throw new ConfigRevisionConflictError("settings changed; reload and retry");
    const beforeAuth = await readAuth(root);
    const nextAuth = { ...beforeAuth };
    const changesCredential = credential?.key !== undefined;
    if (credential) await assertConnectionCredentialWriteAllowed(root, credential.id);
    if (credential && changesCredential) {
      if (credential.key === null) delete nextAuth[providerAlias(credential.id)];
      else nextAuth[providerAlias(credential.id)] = { type: "api_key", key: validateKey(credential.key) };
    }
    const next = { ...current.data, connections: mutate(current.data.connections.map(bare), current.data) };
    for (const resultingConnection of next.connections) {
      const previousConnection = current.data.connections.find((item) => item.id === resultingConnection.id);
      if (!previousConnection || previousConnection.provider === resultingConnection.provider) continue;
      await assertConnectionCredentialWriteAllowed(root, resultingConnection.id);
      const existingCredential = beforeAuth[providerAlias(resultingConnection.id)];
      const intentionallyChangesCredential =
        credential?.id === resultingConnection.id
        && changesCredential;
      if (existingCredential && !intentionallyChangesCredential) {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "replace or clear the stored credential when changing providers",
          422,
        );
      }
    }
    if (credential) {
      const resultingConnection = next.connections.find((connection) => connection.id === credential.id);
      const resultingCredential = nextAuth[providerAlias(credential.id)];
      if (resultingConnection && resultingCredential?.type === "api_key") {
        rejectApiKeyForOAuthOnlyProvider(resultingConnection, resultingCredential.key);
      }
      if (
        resultingConnection
        && resultingCredential?.type === "oauth"
        && !catalogEntryFor(resultingConnection.provider)?.auth.oauth
      ) {
        throw new ProviderServiceError("CONFIG_INVALID", "this provider does not accept OAuth credentials", 422);
      }
    }
    if (changesCredential) await writeAuthFileUnlocked(root, nextAuth);
    try {
      return await writeApplicationSettings(root, next, expectedRevision);
    } catch (error) {
      if (changesCredential) await writeAuthFileUnlocked(root, beforeAuth);
      throw error;
    }
  });
}

export async function listConnections(root: string, env: NodeJS.ProcessEnv = process.env) {
  const [envelope, auth] = await Promise.all([readApplicationSettings(root), readAuth(root)]);
  return {
    data: {
      connections: envelope.data.connections.map((c) => publicConnection(root, c, auth, env)),
      agent: envelope.data.agent,
      chat: envelope.data.chat,
      scoring: envelope.data.scoring,
    },
    revision: envelope.revision,
  };
}

export async function createConnection(root: string, input: ConnectionCreate, expectedRevision: string) {
  const connection = validateConnection({ ...input, id: randomUUID() });
  rejectApiKeyForOAuthOnlyProvider(connection, input.apiKey);
  const key = input.apiKey === undefined ? undefined : validateKey(input.apiKey);
  const result = await mutateConnection(
    root,
    expectedRevision,
    (connections) => {
      if (connections.some((c) => c.label.toLowerCase() === connection.label.toLowerCase())) {
        throw new ProviderServiceError("CONFIG_INVALID", "connection label already exists");
      }
      return [...connections, connection];
    },
    key === undefined ? undefined : { id: connection.id, key },
  );
  return { ...result, connectionId: connection.id };
}

export async function removeConnection(root: string, id: string, expectedRevision: string) {
  const result = await mutateConnection(
    root,
    expectedRevision,
    (connections, settings) => {
      if (
        settings.agent?.connectionId === id
        || settings.chat?.connectionId === id
        || settings.scoring?.connectionId === id
      ) {
        throw new ProviderServiceError("CONFIG_INVALID", "cannot remove a selected connection", 409);
      }
      if (!connections.some((c) => c.id === id)) {
        throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      }
      return connections.filter((c) => c.id !== id);
    },
    { id, key: null },
  );
  validations.delete(validationKey(root, id));
  return result;
}

export async function resolveCredential(
  root: string,
  expectedConnection: Connection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  const alias = providerAlias(expectedConnection.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = await withProviderStoreLock(root, async () => {
      const settings = await readApplicationSettings(root);
      const current = settings.data.connections.find((item) => item.id === expectedConnection.id);
      if (!current) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      const connection = bare(current);
      const auth = await readAuth(root);
      const stored = auth[alias];
      const source = effectiveCredentialSource(connection, auth, env);
      return { connection, revision: settings.revision, source, stored };
    });
    const { connection, source, stored } = generation;
    if (source === "oauth" && stored?.type === "oauth") {
      const oauth = await resolveOAuthCredential(root, connection, stored);
      const verified = await withProviderStoreLock(root, async () => {
        const settings = await readApplicationSettings(root);
        if (settings.revision !== generation.revision) return undefined;
        const current = settings.data.connections.find((item) => item.id === expectedConnection.id);
        if (!current || current.provider !== connection.provider) return undefined;
        const auth = await readAuth(root);
        if (!isDeepStrictEqual(auth[alias], oauth.usedCredential)) return undefined;
        return bare(current);
      });
      if (!verified) continue;
      if (oauth.authError !== undefined) {
        if (isOAuthRefreshFailure(oauth.authError) && oauth.usedCredential?.type === "oauth") {
          return {
            connection: verified,
            alias,
            source: "oauth",
            credential: oauth.usedCredential,
            refreshFailed: true,
          };
        }
        if (oauth.authError instanceof ProviderServiceError) throw oauth.authError;
        throw new ProviderServiceError("CREDENTIAL_MISSING", "connection credential is not configured", 422);
      }
      if (oauth.usedCredential?.type !== "oauth" || !oauth.auth) continue;
      return {
        connection: verified,
        alias,
        source: "oauth",
        apiKey: oauth.auth.apiKey,
        auth: oauth.auth,
        credential: oauth.usedCredential,
        refreshFailed: false,
      };
    }

    const envName = catalogApiKeyEnv(connection);
    const fromEnv = envName ? env[envName]?.trim() : undefined;
    if (source === "environment" && fromEnv) {
      return { connection, alias, source, apiKey: fromEnv, auth: { apiKey: fromEnv } };
    }
    if (source === "app-store" && stored?.type === "api_key" && stored.key) {
      return { connection, alias, source: "app-store", apiKey: stored.key, auth: { apiKey: stored.key }, credential: stored };
    }
    if (connection.provider === "openai-compatible" && connection.baseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(connection.baseUrl).hostname)) {
      return { connection, alias, source: "none" };
    }
    throw new ProviderServiceError("CREDENTIAL_MISSING", "connection credential is not configured", 422);
  }
  throw new ProviderServiceError("CONFIG_INVALID", "connection changed while credentials were resolving; retry", 409);
}

export async function setConnectionCredential(root: string, id: string, apiKey: string | null) {
  const settings = await readApplicationSettings(root);
  const result = await mutateConnection(root, settings.revision, (connections) => {
    if (!connections.some((connection) => connection.id === id)) {
      throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
    }
    return connections;
  }, {
    id,
    key: apiKey === null ? null : validateKey(apiKey),
  });
  validations.delete(validationKey(root, id));
  return result;
}

export type ConnectionUpdatePatch = Omit<Partial<Connection>, "email" | "expiresAt" | "cursorBackendUrl" | "origin" | "refreshFailedAt"> & {
  apiKey?: string | null;
  cursorBackendUrl?: string | null;
  email?: string | null;
  expiresAt?: string | null;
  origin?: never;
  refreshFailedAt?: never;
};

export async function updateConnection(root: string, id: string, patch: ConnectionUpdatePatch, expectedRevision: string) {
  const {
    apiKey,
    id: _ignored,
    cursorBackendUrl: cursorBackendPatch,
    email: emailPatch,
    expiresAt: expiresPatch,
    origin: _origin,
    refreshFailedAt: _refreshFailedAt,
    ...metadata
  } = patch as ConnectionUpdatePatch & { origin?: unknown; refreshFailedAt?: unknown };

  const result = await mutateConnection(
    root,
    expectedRevision,
    (connections) => {
      const found = connections.find((item) => item.id === id);
      if (!found) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      let merged: Connection = { ...found, ...metadata, id };
      if (cursorBackendPatch === null) delete merged.cursorBackendUrl;
      else if (cursorBackendPatch !== undefined) merged.cursorBackendUrl = cursorBackendPatch;
      if (emailPatch === null) delete merged.email;
      else if (emailPatch !== undefined) merged.email = emailPatch;
      if (expiresPatch === null) delete merged.expiresAt;
      else if (expiresPatch !== undefined) merged.expiresAt = expiresPatch;
      if (apiKey !== undefined && found.provider === "cursor") {
        const { email: _e, expiresAt: _x, cursorBackendUrl: _b, ...rest } = merged;
        merged = { ...rest, id };
        if (emailPatch === null) delete merged.email;
        else if (emailPatch !== undefined) merged.email = emailPatch;
        if (expiresPatch === null) delete merged.expiresAt;
        else if (expiresPatch !== undefined) merged.expiresAt = expiresPatch;
        if (cursorBackendPatch === null) delete merged.cursorBackendUrl;
        else if (cursorBackendPatch !== undefined) merged.cursorBackendUrl = cursorBackendPatch;
      }
      const updated = validateConnection(merged);
      if (connections.some((c) => c.id !== id && c.label.toLowerCase() === updated.label.toLowerCase())) {
        throw new ProviderServiceError("CONFIG_INVALID", "connection label already exists");
      }
      return connections.map((item) => (item.id === id ? updated : item));
    },
    {
      id,
      ...(apiKey === undefined ? {} : { key: apiKey === null ? null : validateKey(apiKey) }),
    },
  );
  validations.delete(validationKey(root, id));
  return result;
}

export async function updateSelections(
  root: string,
  selections: { agent: ModelSelection | null; chat?: ModelSelection | null; scoring: ModelSelection | null },
  expectedRevision: string,
) {
  const current = await readApplicationSettings(root);
  const connections = current.data.connections.map(bare);
  const auth = await readAuth(root);
  const agent = validateSelection(selections.agent, connections, "agent");
  const scoring = validateSelection(selections.scoring, connections, "scoring");
  const chat = selections.chat === undefined
    ? current.data.chat
    : selections.chat === null
      ? null
      : validateSelection(selections.chat, connections, "chat");
  const candidate = { ...current.data, connections, agent, chat, scoring };
  const blockers = selectionConfigBlockers(candidate, auth);
  if (blockers.length) {
    throw new ProviderServiceError(blockers[0].code, blockers[0].message, 422);
  }
  return writeApplicationSettings(root, candidate, expectedRevision);
}

export async function persistConnectionHealth(
  root: string,
  connectionId: string,
  patch: { refreshFailedAt?: string | null },
): Promise<void> {
  await withProviderStoreLock(root, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await readApplicationSettings(root);
      const connections = current.data.connections.map(bare);
      const index = connections.findIndex((c) => c.id === connectionId);
      if (index < 0) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      const previous = connections[index]!.refreshFailedAt;
      if (
        (patch.refreshFailedAt === null && previous === undefined)
        || (patch.refreshFailedAt !== undefined && patch.refreshFailedAt === previous)
      ) {
        return;
      }
      let merged: Connection = { ...connections[index] };
      if (patch.refreshFailedAt === null) delete merged.refreshFailedAt;
      else if (patch.refreshFailedAt !== undefined) merged.refreshFailedAt = patch.refreshFailedAt;
      merged = validateConnection(merged);
      connections[index] = merged;
      try {
        await writeApplicationSettings(root, { ...current.data, connections }, current.revision);
        return;
      } catch (error) {
        if (error instanceof ConfigRevisionConflictError) continue;
        throw error;
      }
    }
    throw new ConfigRevisionConflictError("settings changed; reload and retry");
  });
}

/**
 * Writes a credential rotated by a run back only while the captured connection
 * still names the same provider. Credential and health changes share the
 * provider-store lock; a settings conflict rolls the credential change back
 * before retrying.
 */
export async function writeBackRunOAuthCredential(
  root: string,
  connectionId: string,
  capturedProvider: string,
  credential: Extract<Credential, { type: "oauth" }>,
  startedWith: Extract<Credential, { type: "oauth" }>,
): Promise<boolean> {
  return withProviderStoreLock(root, async () => {
    await assertConnectionCredentialWriteAllowed(root, connectionId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await readApplicationSettings(root);
      const connections = current.data.connections.map(bare);
      const index = connections.findIndex((connection) => connection.id === connectionId);
      if (index < 0 || connections[index]!.provider !== capturedProvider) return false;

      const beforeAuth = await readAuth(root);
      const alias = providerAlias(connectionId);
      const stored = beforeAuth[alias];
      // D5: merge only while the alias is still OAuth. A missing or `api_key`
      // alias means the user replaced the credential during the run; writing
      // the run's token back would undo that choice.
      if (stored?.type !== "oauth") return false;
      // Compare-and-swap against the credential this run started from: if the
      // workspace now holds a different OAuth identity (the user signed the
      // connection into another account mid-run), the run's rotation of the
      // old identity must not replace it, whatever its expiry.
      if (
        stored.access !== startedWith.access
        || stored.refresh !== startedWith.refresh
        || stored.expires !== startedWith.expires
      ) {
        return false;
      }
      const authChanged = credential.expires > stored.expires;
      if (!authChanged) return true;
      // `refreshFailedAt` is cleared only on the evidence of an accepted newer
      // credential; an unchanged snapshot says nothing about refresh health.
      const healthChanged = connections[index]!.refreshFailedAt !== undefined;

      const nextAuth = { ...beforeAuth, [alias]: credential };
      if (healthChanged) {
        const connection = { ...connections[index]! };
        delete connection.refreshFailedAt;
        connections[index] = validateConnection(connection);
      }

      await writeAuthFileUnlocked(root, nextAuth);
      try {
        if (healthChanged) {
          await writeApplicationSettings(root, { ...current.data, connections }, current.revision);
        }
        return true;
      } catch (error) {
        await writeAuthFileUnlocked(root, beforeAuth);
        if (error instanceof ConfigRevisionConflictError && attempt < 7) continue;
        throw error;
      }
    }
    throw new ConfigRevisionConflictError("settings changed; reload and retry");
  });
}

function catalogRequest(connection: Connection, apiKey?: string) {
  const headers: Record<string, string> = { accept: "application/json" };
  let endpoint: string;
  if (connection.provider === "openai") {
    endpoint = "https://api.openai.com/v1/models";
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  } else if (connection.provider === "anthropic") {
    endpoint = "https://api.anthropic.com/v1/models";
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (connection.provider === "google") {
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else {
    endpoint = `${connection.baseUrl!.replace(/\/$/, "")}/models`;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  return { endpoint, headers };
}

async function boundedText(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new ProviderServiceError("UPSTREAM_UNAVAILABLE", "Provider response was too large.", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ProviderServiceError("UPSTREAM_UNAVAILABLE", "Provider response was too large.", 502);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function filterCopilotModels(
  models: Array<{ id: string; label?: string }>,
  credential: StoredAuth[string] | undefined,
): Array<{ id: string; label?: string }> {
  if (!credential || credential.type !== "oauth") return models;
  const ids = (credential as { availableModelIds?: unknown }).availableModelIds;
  if (!Array.isArray(ids)) return models;
  const allowed = new Set(ids.filter((id): id is string => typeof id === "string"));
  return models.filter((model) => allowed.has(model.id));
}

async function listRegistryModels(connection: Connection, credential?: StoredAuth[string]): Promise<Array<{ id: string; label?: string }>> {
  if (connection.provider === "cursor") {
    await ensureCursorCatalog();
    return listCursorPiModelIds().map((id) => ({ id }));
  }
  if (connection.provider === JEV_TYPESAFE_PROVIDER) {
    return [{ id: JEV_TYPESAFE_MODEL_ID, label: "Jev (decision model, scoring only)" }];
  }
  if (connection.provider === "openai-compatible") {
    throw new ProviderServiceError("CONFIG_INVALID", "openai-compatible catalogs require a live endpoint");
  }
  const runtime = await isolatedMetadataRuntime();
  let models = runtime.getModels(connection.provider).map((model) => ({ id: model.id })).sort((a, b) => a.id.localeCompare(b.id));
  if (connection.provider === "github-copilot") {
    models = filterCopilotModels(models, credential);
  }
  if (connection.provider === "openrouter") {
    const jev = JEV_OPENROUTER_PICKER_MODELS.map((entry) => ({ id: entry.id, label: entry.label }));
    const seen = new Set(jev.map((m) => m.id));
    return [...jev, ...models.filter((m) => !seen.has(m.id))];
  }
  return models;
}

export async function listModels(root: string, connection: Connection, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const resolved = await resolveCredential(root, connection, env);
  if (resolved.connection.provider !== connection.provider) {
    throw new ProviderServiceError(
      "CONFIG_INVALID",
      "connection provider changed while credentials were resolving; reload and retry",
      409,
    );
  }
  const currentConnection = resolved.connection;
  if (resolved.refreshFailed) {
    throw new ProviderServiceError("CREDENTIAL_EXPIRED", "OAuth credential could not be refreshed", 422);
  }
  if (resolved.source === "oauth") {
    return listRegistryModels(currentConnection, resolved.credential);
  }
  if (!LIVE_CATALOG_PROVIDERS.has(currentConnection.provider)) {
    if (currentConnection.provider !== "openai-compatible") {
      return listRegistryModels(currentConnection);
    }
  }
  const { endpoint, headers } = catalogRequest(currentConnection, resolved.apiKey);
  try {
    const response = await fetcher(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new ProviderServiceError("AUTH_REJECTED", "Provider rejected the credential.", 401);
      if (response.status === 429) throw new ProviderServiceError("QUOTA_EXCEEDED", "Provider quota or rate limit was exceeded.", 429);
      throw new ProviderServiceError("UPSTREAM_UNAVAILABLE", "Provider is unavailable.", 502);
    }
    const text = await boundedText(response, 2_000_000);
    const body = JSON.parse(text) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    const ids = [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.name?.replace(/^models\//, ""))].filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 300,
    );
    return [...new Set(ids)].slice(0, 1000).sort().map((id) => ({ id }));
  } catch (error) {
    if (error instanceof ProviderServiceError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new ProviderServiceError("UPSTREAM_TIMEOUT", "Provider request timed out.", 504);
    }
    throw new ProviderServiceError("UPSTREAM_UNAVAILABLE", "Provider is unavailable.", 502);
  }
}

export async function testConnection(root: string, connection: Connection, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const checkedAt = new Date().toISOString();
  try {
    const models = (await listModels(root, connection, env, fetcher)).slice(0, 100);
    const verified = LIVE_CATALOG_PROVIDERS.has(connection.provider);
    validations.set(validationKey(root, connection.id), { status: verified ? "valid" : "untested", checkedAt });
    await persistConnectionHealth(root, connection.id, { refreshFailedAt: null });
    return { ok: true as const, models, verified };
  } catch (error) {
    const code = error instanceof ProviderServiceError ? error.code : ("UPSTREAM_UNAVAILABLE" as const);
    validations.set(validationKey(root, connection.id), { status: "invalid", checkedAt, code });
    if (code === "CREDENTIAL_EXPIRED") {
      await persistConnectionHealth(root, connection.id, { refreshFailedAt: new Date().toISOString() });
    }
    return { ok: false as const, code };
  }
}

export const providerPaths = { authPath, modelPath, lockPath: providerStoreLockPath };
