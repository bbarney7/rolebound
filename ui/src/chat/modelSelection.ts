import type { ConnectionList, ModelSelection } from "../../shared/providers";
import type { RunSummary } from "../../shared/types";

export function effectiveChatSelection(
  chat: ModelSelection | null | undefined,
  agent: ModelSelection | null | undefined,
): ModelSelection | null {
  return chat ?? agent ?? null;
}

export function selectionKey(selection: ModelSelection | null | undefined): string {
  if (!selection) return "";
  const thinking = selection.thinking?.trim() ?? "";
  return `${selection.connectionId}\0${selection.modelId}\0${thinking}`;
}

export function connectionLabelFor(connections: ConnectionList | null, connectionId: string): string {
  return connections?.data.connections.find((c) => c.id === connectionId)?.label ?? "Model";
}

export function formatCompactModelLabel(selection: ModelSelection, connectionLabel?: string): string {
  const name = selection.modelId;
  const effort = selection.thinking?.trim();
  const base = connectionLabel ? `${connectionLabel}: ${name}` : name;
  return effort ? `${base} · ${effort}` : base;
}

export function shortModelLabel(selection: ModelSelection): string {
  const effort = selection.thinking?.trim();
  return effort ? `${selection.modelId} · ${effort}` : selection.modelId;
}

/** Visible label for the composer model control (e.g. "Model: gpt-5-chat-latest"). */
export function formatChatModelButtonLabel(connections: ConnectionList | null): string {
  if (!connections) return "Model";
  const agent = connections.data.agent;
  const chat = connections.data.chat;
  const effective = effectiveChatSelection(chat, agent);
  if (!effective) return "No model";
  return `Model: ${shortModelLabel(effective)}`;
}

/** Tooltip and accessible description when chat follows the applying model. */
export function formatChatModelButtonHint(connections: ConnectionList | null): string | undefined {
  if (!connections?.data.chat && connections?.data.agent) {
    return "Same as applying model";
  }
  return undefined;
}

export function chatRunEligibleForContinue(run: RunSummary | null, hasTranscript: boolean): boolean {
  if (!run || run.kind !== "chat") return false;
  if (run.status === "waiting") return true;
  if ((run.status === "done" || run.status === "stopped") && hasTranscript) return true;
  return false;
}

export function buildChatModelSwitchNote(modelLabel: string): string {
  return `Switched chat to ${modelLabel}. The conversation continues.`;
}
