import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";
import { ConfigRevisionConflictError, readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import type { Connection } from "../../shared/config";
import { validateConnection } from "../../shared/config";
import type { AdoptResult, DetectedLogin } from "../../shared/providers";
import { catalogEntryFor } from "../../shared/providerCatalog";
import { catalogApiKeyEnv } from "../../shared/config";
import { computeReadiness } from "../readiness";
import { detectLogins, findDetectedLogin } from "./detectLogins";
import type { ProviderHostDeps } from "./hostDeps";
import * as finalizeDefaults from "./finalizeDefaults";
import { effectiveCredentialSource, listConnections, ProviderServiceError } from "./providerService";
import { readAuth, withProviderStoreLock, writeAuthFileUnlocked } from "./authStoreFile";
import { providerAlias } from "./providerIds";
import { CURSOR_PRODUCTION_BACKEND } from "./cursorReadiness";
import type { LoginMutationJournal } from "./loginMutationJournal";
import {
  connectionOrigin,
  normalizeConnectionAccount,
  normalizeConnectionOriginAccount,
  uniqueConnectionLabel,
} from "./connectionMetadata";


async function readPiCredential(deps: ProviderHostDeps, provider: string): Promise<Credential | undefined> {
  try {
    const raw = await fs.readFile(path.join(deps.home, ".pi/agent/auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, Credential>;
    return parsed[provider];
  } catch {
    return undefined;
  }
}

function findExistingByOrigin(connections: Connection[], item: DetectedLogin): Connection | undefined {
  const account = normalizeConnectionOriginAccount(item.account);
  return connections.find((c) => {
    if (!c.origin || c.origin.kind !== item.kind || c.provider !== item.provider) return false;
    if (account) return c.origin.account === account;
    return !c.origin.account;
  });
}

function createAdoptedConnection(connections: Connection[], item: DetectedLogin): Connection {
  const entry = catalogEntryFor(item.provider);
  if (!entry) throw new ProviderServiceError("CONFIG_INVALID", "unknown provider", 422);
  const label = uniqueConnectionLabel(entry.name, item.account, connections);
  const envName =
    item.kind === "env-key" ? catalogApiKeyEnv({ id: "x", label: "x", provider: item.provider }) : undefined;
  return validateConnection({
    id: randomUUID(),
    label,
    provider: item.provider,
    origin: connectionOrigin(item.kind, item.account),
    ...(envName ? { envKeyName: envName } : {}),
    ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
  });
}

async function credentializeAdoptedConnection(
  connection: Connection,
  item: DetectedLogin,
  deps: ProviderHostDeps,
  auth: Awaited<ReturnType<typeof readAuth>>,
): Promise<{ connection: Connection; auth: Awaited<ReturnType<typeof readAuth>>; authChanged: boolean }> {
  if (item.kind === "env-key") return { connection, auth, authChanged: false };
  if (item.kind === "cursor-sdk") {
    const { loadCursorSdkStore } = await import("./detectLogins");
    const stored = await loadCursorSdkStore(deps);
    if (!stored?.apiKey) throw new ProviderServiceError("CREDENTIAL_MISSING", "Cursor login not found", 422);
    // The Cursor SDK store lives outside Rolebound's lock. The detection that
    // named this origin was taken from an earlier snapshot; if the signed-in
    // account changed in between, refuse rather than attach account B's key
    // and email to origin A (D9).
    // Detection carries the store's raw email as the account and omits it when
    // the store has none ("" or absent), so compare with the same collapsing.
    if ((stored.email || undefined) !== (item.account || undefined)) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "The Cursor account on this computer changed; reload and choose it again.",
        409,
      );
    }
    const backend = stored.backendUrl ?? CURSOR_PRODUCTION_BACKEND;
    const {
      email: _previousEmail,
      expiresAt: _previousExpiresAt,
      cursorBackendUrl: _previousCursorBackendUrl,
      ...connectionWithoutCursorSourceMetadata
    } = connection;
    const email = normalizeConnectionAccount(stored.email);
    const updated = validateConnection({
      ...connectionWithoutCursorSourceMetadata,
      ...(email ? { email } : {}),
      ...(stored.apiKeyExpiresAtMs !== undefined
        ? { expiresAt: new Date(stored.apiKeyExpiresAtMs).toISOString() }
        : {}),
      ...(backend !== CURSOR_PRODUCTION_BACKEND ? { cursorBackendUrl: backend } : {}),
    });
    return {
      connection: updated,
      auth: { ...auth, [providerAlias(connection.id)]: { type: "api_key", key: stored.apiKey } },
      authChanged: true,
    };
  }
  if (item.kind === "pi-auth") {
    const credential = await readPiCredential(deps, item.provider);
    if (!credential || credential.type !== "api_key" || !credential.key?.trim()) {
      throw new ProviderServiceError("CREDENTIAL_MISSING", "API key not found for provider", 422);
    }
    return {
      connection,
      auth: { ...auth, [providerAlias(connection.id)]: { type: "api_key", key: credential.key.trim() } },
      authChanged: true,
    };
  }
  throw new ProviderServiceError("CONFIG_INVALID", "detection source cannot be adopted", 422);
}

function supplementalSelection(
  primaryConnection: Connection,
  primaryDetectionId: string | undefined,
  detected: DetectedLogin[],
  connections: Connection[],
  auth: Awaited<ReturnType<typeof readAuth>>,
  env: NodeJS.ProcessEnv,
): { supplemental?: DetectedLogin; preferredJevConnectionId?: string } {
  const primaryProvider = primaryConnection.provider;
  if (primaryProvider === "typesafe" || primaryProvider === "openrouter") {
    return { preferredJevConnectionId: primaryConnection.id };
  }

  const hasUsableApiKey = (connection: Connection): boolean => {
    const source = effectiveCredentialSource(connection, auth, env);
    return source === "app-store" || source === "environment";
  };
  const configuredJev =
    connections.find(
      (connection) =>
        connection.provider === "typesafe"
        && hasUsableApiKey(connection),
    )
    ?? connections.find(
      (connection) =>
        connection.provider === "openrouter"
        && hasUsableApiKey(connection),
    );
  if (configuredJev) return { preferredJevConnectionId: configuredJev.id };

  const jev = detected.filter(
    (candidate) =>
      candidate.id !== primaryDetectionId &&
      (candidate.provider === "typesafe" || candidate.provider === "openrouter") &&
      (candidate.action === "adopt" || candidate.action === "adopt-scoring"),
  );
  const preferredJev =
    jev.find((candidate) => candidate.provider === "typesafe")
    ?? jev.find((candidate) => candidate.provider === "openrouter");
  if (preferredJev) return { supplemental: preferredJev };
  const primary = catalogEntryFor(primaryProvider);
  if (primary?.roles.includes("scoring")) return {};
  const fallback = detected.find((candidate) => {
    if (
      candidate.id === primaryDetectionId
      || candidate.provider === primaryProvider
      || findExistingByOrigin(connections, candidate)
    ) return false;
    if (candidate.action !== "adopt" && candidate.action !== "adopt-scoring") return false;
    const entry = catalogEntryFor(candidate.provider);
    return Boolean(entry?.auth.apiKey && entry.roles.includes("scoring"));
  });
  return fallback ? { supplemental: fallback } : {};
}

function bareConnections(connections: Connection[]): Connection[] {
  return connections.map((connection) => {
    const { credential: _credential, validation: _validation, ...bare } = connection as Connection & {
      credential?: unknown;
      validation?: unknown;
    };
    return bare;
  });
}

async function adoptUnderLock(
  root: string,
  deps: ProviderHostDeps,
  item: DetectedLogin | undefined,
  detected: DetectedLogin[],
  existingConnectionId?: string,
  expectedProvider?: string,
  mutationOptions: {
    assertActive?: () => void;
    journal?: LoginMutationJournal;
  } = {},
): Promise<{ connectionId: string; journal: LoginMutationJournal }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    mutationOptions.assertActive?.();
    const current = await readApplicationSettings(root);
    mutationOptions.assertActive?.();
    const beforeAuth = await readAuth(root);
    mutationOptions.assertActive?.();
    let nextAuth = beforeAuth;
    let authChanged = false;
    let connections = bareConnections(current.data.connections);
    let primary = existingConnectionId
      ? connections.find((connection) => connection.id === existingConnectionId)
      : item ? findExistingByOrigin(connections, item) : undefined;
    const additions: Array<{ connection: Connection; item: DetectedLogin }> = [];
    const credentializations: Array<{ connection: Connection; item: DetectedLogin }> = [];

    if (!primary) {
      if (!item) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      primary = createAdoptedConnection(connections, item);
      connections.push(primary);
      additions.push({ connection: primary, item });
    }
    const requiredProvider = expectedProvider ?? item?.provider;
    if (requiredProvider && primary.provider !== requiredProvider) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "connection provider changed while defaults were being finalized",
        409,
      );
    }

    const primaryDetection = item ?? detected.find((candidate) => {
      if (candidate.provider !== primary?.provider || candidate.kind !== primary.origin?.kind) return false;
      const account = normalizeConnectionOriginAccount(candidate.account);
      return account ? account === primary.origin?.account : !primary.origin?.account;
    });
    if (
      primaryDetection
      && (primaryDetection.action === "adopt" || primaryDetection.action === "adopt-scoring")
    ) {
      credentializations.push({ connection: primary, item: primaryDetection });
    }
    const supplemental = supplementalSelection(
      primary,
      primaryDetection?.id,
      detected,
      connections,
      beforeAuth,
      deps.env,
    );
    if (supplemental.supplemental) {
      const item = supplemental.supplemental;
      const existing = findExistingByOrigin(connections, item);
      if (existing) {
        credentializations.push({ connection: existing, item });
      } else {
        const connection = createAdoptedConnection(connections, item);
        connections.push(connection);
        additions.push({ connection, item });
        credentializations.push({ connection, item });
      }
    }

    let preferredJevId = supplemental.preferredJevConnectionId;
    for (const target of credentializations) {
      const result = await credentializeAdoptedConnection(target.connection, target.item, deps, nextAuth);
      mutationOptions.assertActive?.();
      nextAuth = result.auth;
      authChanged ||= result.authChanged;
      connections = connections.map((connection) =>
        connection.id === result.connection.id ? result.connection : connection,
      );
      if (target.item.provider === "typesafe") preferredJevId = result.connection.id;
      else if (target.item.provider === "openrouter" && !preferredJevId) preferredJevId = result.connection.id;
    }

    let authWritten = false;
    try {
      mutationOptions.assertActive?.();
      if (authChanged) {
        await writeAuthFileUnlocked(root, nextAuth);
        authWritten = true;
        mutationOptions.assertActive?.();
      }
      const next = await finalizeDefaults.finalizeDefaultsUnlocked(
        { ...current.data, connections },
        primary.id,
        detected,
        nextAuth,
        preferredJevId,
      );
      mutationOptions.assertActive?.();
      await writeApplicationSettings(root, next, current.revision);
      const journal: LoginMutationJournal = [];
      for (const target of credentializations) {
        const alias = providerAlias(target.connection.id);
        if (JSON.stringify(beforeAuth[alias]) !== JSON.stringify(nextAuth[alias])) {
          journal.push({ kind: "auth", alias, before: beforeAuth[alias], written: nextAuth[alias] });
        }
      }
      const addedIds = new Set(additions.map(({ connection }) => connection.id));
      for (const target of credentializations) {
        if (addedIds.has(target.connection.id)) continue;
        const before = current.data.connections.find((connection) => connection.id === target.connection.id);
        const written = next.connections.find((connection) => connection.id === target.connection.id);
        if (!before || !written) continue;
        for (const field of ["email", "expiresAt", "cursorBackendUrl"] as const) {
          if (before[field] === written[field]) continue;
          journal.push({
            kind: "connection-field",
            connectionId: target.connection.id,
            field,
            before: before[field],
            written: written[field],
          });
        }
      }
      for (const addition of additions) {
        const written = next.connections.find((connection) => connection.id === addition.connection.id);
        if (written) journal.push({ kind: "connection-add", connectionId: written.id, written });
      }
      if (JSON.stringify(current.data.agent) !== JSON.stringify(next.agent)) {
        journal.push({ kind: "selection", field: "agent", before: current.data.agent, written: next.agent });
      }
      if (JSON.stringify(current.data.scoring) !== JSON.stringify(next.scoring)) {
        journal.push({ kind: "selection", field: "scoring", before: current.data.scoring, written: next.scoring });
      }
      mutationOptions.journal?.push(...journal);
      mutationOptions.assertActive?.();
      return { connectionId: primary.id, journal };
    } catch (error) {
      if (authWritten) await writeAuthFileUnlocked(root, beforeAuth);
      if (error instanceof ConfigRevisionConflictError) {
        mutationOptions.assertActive?.();
        continue;
      }
      throw error;
    }
  }
  throw new ProviderServiceError("REVISION_CONFLICT", "settings changed; reload and retry", 409);
}

export async function adoptDetectedLogin(
  root: string,
  deps: ProviderHostDeps,
  detectionId: string,
): Promise<AdoptResult> {
  const item = await findDetectedLogin(deps, detectionId);
  if (!item) throw new ProviderServiceError("CONFIG_INVALID", "unknown detection id", 422);
  if (item.action === "sign-in") {
    throw new ProviderServiceError(
      "CONFIG_INVALID",
      "This account requires browser sign-in; use POST /api/providers/login",
      422,
    );
  }

  const detected = await detectLogins(deps);
  await withProviderStoreLock(root, () => adoptUnderLock(root, deps, item, detected));
  const listed = await listConnections(root, deps.env);
  return {
    connections: listed.data.connections,
    agent: listed.data.agent,
    chat: listed.data.chat,
    scoring: listed.data.scoring,
    readiness: await computeReadiness(root, { nodeMajor: deps.nodeMajor, env: deps.env }),
  };
}

/** Applies detected supplemental credentials and defaults after browser sign-in. */
export async function finalizeDetectedLoginDefaults(
  root: string,
  deps: ProviderHostDeps,
  connectionId: string,
  expectedProvider?: string,
  mutationOptions: {
    assertActive?: () => void;
    journal?: LoginMutationJournal;
  } = {},
): Promise<LoginMutationJournal> {
  mutationOptions.assertActive?.();
  const detected = await detectLogins(deps);
  mutationOptions.assertActive?.();
  const result = await withProviderStoreLock(root, () =>
    adoptUnderLock(root, deps, undefined, detected, connectionId, expectedProvider, mutationOptions));
  return result.journal;
}
