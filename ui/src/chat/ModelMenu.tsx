import { useEffect, useId, useRef, useState } from "react";
import type { ConnectionList, ModelSelection } from "../../shared/providers";
import { fetchModelCatalog, updateSelections } from "../settings";
import { formatChatModelButtonLabel } from "./modelSelection";
import { isRunning } from "./Composer";
import type { RunSummary } from "../../shared/types";

const EFFORTS = ["", "low", "medium", "high", "xhigh"];

const CHAT_SAME = "";

function selectionFromDraft(
  connectionId: string,
  modelId: string,
  thinking: string,
): ModelSelection | null {
  if (!connectionId) return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  return { connectionId, modelId: trimmed, ...(thinking ? { thinking } : {}) };
}

export interface ModelMenuProps {
  connections: ConnectionList | null;
  run: RunSummary | null;
  onConnectionsChange: (next: ConnectionList) => void | Promise<void>;
}

export default function ModelMenu({ connections, run, onConnectionsChange }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [chatConn, setChatConn] = useState("");
  const [chatModel, setChatModel] = useState("");
  const [chatThinking, setChatThinking] = useState("");
  const [agentConn, setAgentConn] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [agentThinking, setAgentThinking] = useState("");
  const [chatCatalog, setChatCatalog] = useState<Array<{ id: string; label?: string }>>([]);
  const [agentCatalog, setAgentCatalog] = useState<Array<{ id: string; label?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const disabled = isRunning(run);

  useEffect(() => {
    if (!connections || open) return;
    const chat = connections.data.chat;
    const agent = connections.data.agent;
    setChatConn(chat?.connectionId ?? CHAT_SAME);
    setChatModel(chat?.modelId ?? "");
    setChatThinking(chat?.thinking ?? "");
    setAgentConn(agent?.connectionId ?? "");
    setAgentModel(agent?.modelId ?? "");
    setAgentThinking(agent?.thinking ?? "");
  }, [connections, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  async function loadCatalog(kind: "chat" | "agent", connectionId: string) {
    if (!connectionId) {
      if (kind === "chat") setChatCatalog([]);
      else setAgentCatalog([]);
      return;
    }
    setError(null);
    try {
      const models = await fetchModelCatalog(connectionId);
      if (kind === "chat") setChatCatalog(models);
      else setAgentCatalog(models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!open || !chatConn) {
      setChatCatalog([]);
      return;
    }
    void loadCatalog("chat", chatConn);
  }, [open, chatConn]);

  useEffect(() => {
    if (!open || !agentConn) {
      setAgentCatalog([]);
      return;
    }
    void loadCatalog("agent", agentConn);
  }, [open, agentConn]);

  const buttonLabel = formatChatModelButtonLabel(connections);

  const onUse = async () => {
    if (!connections || disabled) return;
    if (!agentConn || !agentModel.trim()) {
      setError("Choose an applying model.");
      return;
    }
    if (chatConn && !chatModel.trim()) {
      setError("Choose a chat model or select Same as applying model.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chatPayload = chatConn
        ? selectionFromDraft(chatConn, chatModel, chatThinking)
        : null;
      const next = await updateSelections({
        agent: selectionFromDraft(agentConn, agentModel, agentThinking)!,
        chat: chatConn ? chatPayload : null,
        scoring: connections.data.scoring,
        expectedRevision: connections.revision,
      });
      setOpen(false);
      await onConnectionsChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectionOptions = connections?.data.connections.filter((c) => c.provider !== "typesafe") ?? [];

  return (
    <div className="rb-chat-model-menu" ref={rootRef}>
      <button
        type="button"
        className="rb-chat-model-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled || !connections}
        title={disabled ? "Wait for the reply to finish" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {buttonLabel}
      </button>
      {open ? (
        <div
          className="rb-chat-model-popover"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-label="Chat model"
        >
          <p id={titleId} className="rb-chat-model-popover-title">Chat model</p>
          <div className="rb-chat-model-field">
            <label htmlFor="rb-chat-model-conn">Chat connection</label>
            <select
              id="rb-chat-model-conn"
              className="rb-chat-model-control"
              value={chatConn}
              onChange={(e) => {
                setChatConn(e.target.value);
                setChatModel("");
              }}
            >
              <option value="">Same as applying model</option>
              {connectionOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.credential.source}
                </option>
              ))}
            </select>
          </div>
          {chatConn ? (
            <>
              <div className="rb-chat-model-field">
                <label htmlFor="rb-chat-model-id">Chat model</label>
                <input
                  id="rb-chat-model-id"
                  className="rb-chat-model-control"
                  list="rb-chat-model-list"
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                />
                <datalist id="rb-chat-model-list">
                  {chatCatalog.map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </div>
              <div className="rb-chat-model-field">
                <label htmlFor="rb-chat-model-thinking">Reasoning effort</label>
                <select
                  id="rb-chat-model-thinking"
                  className="rb-chat-model-control"
                  value={chatThinking}
                  onChange={(e) => setChatThinking(e.target.value)}
                >
                  {EFFORTS.map((v) => (
                    <option key={v} value={v}>{v || "Provider default"}</option>
                  ))}
                </select>
              </div>
            </>
          ) : null}

          <p className="rb-chat-model-section-label">Applying model</p>
          <div className="rb-chat-model-field">
            <label htmlFor="rb-apply-model-conn">Applying connection</label>
            <select
              id="rb-apply-model-conn"
              className="rb-chat-model-control"
              value={agentConn}
              onChange={(e) => {
                setAgentConn(e.target.value);
                setAgentModel("");
              }}
            >
              <option value="">Choose…</option>
              {connectionOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.credential.source}
                </option>
              ))}
            </select>
          </div>
          <div className="rb-chat-model-field">
            <label htmlFor="rb-apply-model-id">Model</label>
            <input
              id="rb-apply-model-id"
              className="rb-chat-model-control"
              list="rb-apply-model-list"
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
            />
            <datalist id="rb-apply-model-list">
              {agentCatalog.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>
          <div className="rb-chat-model-field">
            <label htmlFor="rb-apply-model-thinking">Reasoning effort</label>
            <select
              id="rb-apply-model-thinking"
              className="rb-chat-model-control"
              value={agentThinking}
              onChange={(e) => setAgentThinking(e.target.value)}
            >
              {EFFORTS.map((v) => (
                <option key={v} value={v}>{v || "Provider default"}</option>
              ))}
            </select>
          </div>

          {error ? <p className="rb-chat-model-error" role="alert">{error}</p> : null}
          <div className="rb-chat-model-actions">
            <button type="button" className="rb-chat-model-use" disabled={busy || disabled} onClick={() => void onUse()}>
              {busy ? "Saving…" : "Use"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
