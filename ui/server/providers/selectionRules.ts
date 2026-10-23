import type { Connection, SettingsV2 } from "../../shared/config";
import type { ProviderErrorCode } from "../../shared/providers";
import { providerAlias } from "./providerIds";
import type { StoredAuth } from "./authStoreFile";

export interface SelectionConfigBlocker {
  code: ProviderErrorCode;
  message: string;
}

export type SelectionCredentialKind = "oauth" | "api_key" | "none";

function storedCredentialKind(auth: StoredAuth, connectionId: string): SelectionCredentialKind {
  const entry = auth[providerAlias(connectionId)];
  if (!entry) return "none";
  if (entry.type === "oauth") return "oauth";
  if (entry.type === "api_key") return "api_key";
  return "none";
}

export function dualOAuthSelectionBlocker(
  agentConnection: Connection,
  scoringConnection: Connection,
  agentKind: SelectionCredentialKind,
  scoringKind: SelectionCredentialKind,
): SelectionConfigBlocker | undefined {
  if (
    agentConnection.id !== scoringConnection.id
    && agentConnection.provider === scoringConnection.provider
    && agentKind === "oauth"
    && scoringKind === "oauth"
  ) {
    return {
      code: "CONFIG_INVALID",
      message: "use the same connection for scoring, or an API-key connection",
    };
  }
  return undefined;
}

/** Same-provider dual-OAuth agent+scorer rule (D5). */
export function selectionConfigBlockers(settings: SettingsV2, auth: StoredAuth): SelectionConfigBlocker[] {
  const { agent, chat, scoring, connections } = settings;
  const blockers: SelectionConfigBlocker[] = [];
  if (agent?.connectionId && scoring?.connectionId) {
    const agentConn = connections.find((c) => c.id === agent.connectionId);
    const scoringConn = connections.find((c) => c.id === scoring.connectionId);
    if (agentConn && scoringConn) {
      const blocker = dualOAuthSelectionBlocker(
        agentConn,
        scoringConn,
        storedCredentialKind(auth, agentConn.id),
        storedCredentialKind(auth, scoringConn.id),
      );
      if (blocker) blockers.push(blocker);
    }
  }
  if (chat?.connectionId && scoring?.connectionId) {
    const chatConn = connections.find((c) => c.id === chat.connectionId);
    const scoringConn = connections.find((c) => c.id === scoring.connectionId);
    if (chatConn && scoringConn) {
      const blocker = dualOAuthSelectionBlocker(
        chatConn,
        scoringConn,
        storedCredentialKind(auth, chatConn.id),
        storedCredentialKind(auth, scoringConn.id),
      );
      if (blocker) blockers.push(blocker);
    }
  }
  return blockers;
}
