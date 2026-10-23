import { ConfigRevisionConflictError, readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import { catalogEntryFor } from "../../shared/providerCatalog";
import { validateSelection, type Connection, type ModelSelection, type SettingsV2 } from "../../shared/config";
import type { DetectedLogin } from "../../shared/providers";
import { JEV_OPENROUTER_MODEL_IDS, JEV_TYPESAFE_MODEL_ID } from "../../shared/jevModels";
import { withProviderStoreLock } from "./authStoreFile";
import { resolveAgentModelId, explicitScoringModelId } from "./agentModelDefaults";
import { selectionConfigBlockers } from "./selectionRules";
import { readAuth, type StoredAuth } from "./authStoreFile";
import { ProviderServiceError } from "./providerService";
import { providerAlias } from "./providerIds";
import type { LoginMutationJournal } from "./loginMutationJournal";

function bare(connection: Connection): Connection {
  const value = connection as Connection & { credential?: unknown; validation?: unknown };
  const { credential: _c, validation: _v, ...result } = value;
  return result;
}

function pickJevScoring(connection: Connection): ModelSelection {
  const modelId =
    connection.provider === "openrouter" && JEV_OPENROUTER_MODEL_IDS[0]
      ? JEV_OPENROUTER_MODEL_IDS[0]
      : JEV_TYPESAFE_MODEL_ID;
  return { connectionId: connection.id, modelId };
}

async function resolveScoring(
  connections: Connection[],
  agentConnection: Connection | undefined,
  detected: DetectedLogin[],
  auth: StoredAuth,
  preferredJevConnectionId?: string,
): Promise<ModelSelection | null> {
  const preferredJevConnection = connections.find(
    (connection) =>
      connection.id === preferredJevConnectionId
      && (connection.provider === "typesafe" || connection.provider === "openrouter"),
  );
  if (preferredJevConnection) return pickJevScoring(preferredJevConnection);

  const jevDetected = detected.filter(
    (d) =>
      (d.provider === "typesafe" || d.provider === "openrouter") &&
      (d.action === "adopt" || d.action === "adopt-scoring"),
  );
  if (jevDetected.length > 0) {
    const jevConn =
      connections.find((c) => jevDetected.some((d) => d.provider === c.provider && c.origin?.kind === d.kind));
    if (jevConn) return pickJevScoring(jevConn);
  }

  const configuredJevConnection =
    connections.find(
      (connection) =>
        connection.provider === "typesafe"
        && auth[providerAlias(connection.id)]?.type === "api_key",
    )
    ?? connections.find(
      (connection) =>
        connection.provider === "openrouter"
        && auth[providerAlias(connection.id)]?.type === "api_key",
    );
  if (configuredJevConnection) return pickJevScoring(configuredJevConnection);

  const agentEntry = agentConnection ? catalogEntryFor(agentConnection.provider) : undefined;
  if (agentEntry?.roles.includes("scoring")) {
    return null;
  }

  for (const d of detected) {
    if (d.action !== "adopt" && d.action !== "adopt-scoring") continue;
    if (d.provider === agentConnection?.provider) continue;
    const entry = catalogEntryFor(d.provider);
    if (!entry?.auth.apiKey) continue;
    const conn = connections.find((c) => c.provider === d.provider && c.origin?.kind === d.kind);
    if (!conn) continue;
    const modelId = explicitScoringModelId(d.provider);
    if (modelId) return validateSelection({ connectionId: conn.id, modelId }, connections, "scoring");
  }

  return null;
}

export async function finalizeDefaultsAfterAdopt(
  root: string,
  connectionId: string,
  detected: DetectedLogin[],
  preferredJevConnectionId?: string,
): Promise<LoginMutationJournal> {
  return withProviderStoreLock(root, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await readApplicationSettings(root);
      const connections = current.data.connections.map(bare);
      const auth = await readAuth(root);
      const next = await finalizeDefaultsUnlocked(
        { ...current.data, connections },
        connectionId,
        detected,
        auth,
        preferredJevConnectionId,
      );

      try {
        await writeApplicationSettings(root, next, current.revision);
        const journal: LoginMutationJournal = [];
        if (JSON.stringify(current.data.agent) !== JSON.stringify(next.agent)) {
          journal.push({ kind: "selection", field: "agent", before: current.data.agent, written: next.agent });
        }
        if (JSON.stringify(current.data.scoring) !== JSON.stringify(next.scoring)) {
          journal.push({ kind: "selection", field: "scoring", before: current.data.scoring, written: next.scoring });
        }
        return journal;
      } catch (error) {
        if (error instanceof ConfigRevisionConflictError) continue;
        throw error;
      }
    }
    throw new ConfigRevisionConflictError("settings changed; reload and retry");
  });
}

/** Computes finalized selections without taking the provider lock or writing either store. */
export async function finalizeDefaultsUnlocked(
  current: SettingsV2,
  connectionId: string,
  detected: DetectedLogin[],
  auth: StoredAuth,
  preferredJevConnectionId?: string,
): Promise<SettingsV2> {
  const connections = current.connections.map(bare);
  const connection = connections.find((candidate) => candidate.id === connectionId);
  if (!connection) return { ...current, connections };

  const entry = catalogEntryFor(connection.provider);
  const hasAgentRole = entry?.roles.includes("agent") ?? false;
  const hasScoringOnly = entry?.roles.length === 1 && entry.roles[0] === "scoring";

  let agent = current.agent;
  if (hasAgentRole && agent === null) {
    const credential = auth[providerAlias(connection.id)];
    const rawAvailableModelIds =
      credential?.type === "oauth"
        ? (credential as unknown as { availableModelIds?: unknown }).availableModelIds
        : undefined;
    const availableModelIds =
      Array.isArray(rawAvailableModelIds)
        ? rawAvailableModelIds.filter((modelId): modelId is string => typeof modelId === "string")
        : undefined;
    const modelId = await resolveAgentModelId(connection.provider, availableModelIds);
    if (modelId) agent = validateSelection({ connectionId, modelId }, connections, "agent");
  }

  let scoring = current.scoring;
  if (hasScoringOnly && scoring === null) {
    scoring = pickJevScoring(connection);
  } else if (scoring === null) {
    const selectedAgentConnection = agent
      ? connections.find((candidate) => candidate.id === agent.connectionId)
      : undefined;
    scoring = await resolveScoring(
      connections,
      selectedAgentConnection,
      detected,
      auth,
      preferredJevConnectionId,
    );
  }

  const next = { ...current, connections, agent, scoring };
  const blockers = selectionConfigBlockers(next, auth);
  if (blockers.length) {
    throw new ProviderServiceError(blockers[0].code, blockers[0].message, 422);
  }
  return next;
}

/** Post-login defaults (agent only when unset). */
export async function finalizeDefaults(root: string, connectionId: string): Promise<LoginMutationJournal> {
  return finalizeDefaultsAfterAdopt(root, connectionId, []);
}
