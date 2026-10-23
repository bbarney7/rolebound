import { useState } from "react";
import type { ConnectionList } from "../shared/providers";
import { providerSupportsOAuth } from "../shared/providerCatalog";
import { deleteModelConnection, testModelConnection } from "./settings";
import ConnectionSelections from "./ConnectionSelections";
import ProviderSetup, { ProviderMark } from "./ProviderSetup";
import LoginButton from "./LoginButton";

export default function AISettings({ connections, nodeMajor, onUpdated }: { connections: ConnectionList; nodeMajor: number; onUpdated: () => Promise<void> }) {
  const [operations, setOperations] = useState<Record<string, { pending?: string; message?: string; error?: boolean }>>({});
  const [changing, setChanging] = useState(false);
  const active = connections.data.connections.find(c => c.id === connections.data.agent?.connectionId);
  async function operate(id: string, action: "test" | "remove") {
    if (operations[id]?.pending) return;
    setOperations(old => ({ ...old, [id]: { pending: action } }));
    try {
      if (action === "remove") {
        await deleteModelConnection(id, connections.revision);
        await onUpdated();
        setOperations(old => ({ ...old, [id]: {} }));
      } else {
        const result = await testModelConnection(id);
        setOperations(old => ({ ...old, [id]: { message: result.ok ? `Connection works; ${result.models?.length ?? 0} models available.` : `Connection test failed: ${result.code}`, error: !result.ok } }));
        await onUpdated();
      }
    } catch (error) {
      setOperations(old => ({ ...old, [id]: { message: error instanceof Error ? error.message : String(error), error: true } }));
    }
  }
  return <div className="rb-ai-settings">
    <section className="rb-ai-summary" aria-label="Active AI">
      <div><h3 className="rb-h-minor">Active AI</h3><p>{active?.label ?? "Choose an applying account"}</p>
        {active && <><p className="rb-hint">{connections.data.agent?.modelId || "Choose a model"}</p><p className="rb-hint">{active.validation.status === "valid" ? "Account tested successfully" : active.credential.configured ? "Signed in · not verified for this model" : active.provider === "openai-compatible" ? "Local endpoint · not tested" : "Needs attention · sign in again"}</p></>}
        {connections.data.chat && <p className="rb-hint">Chat: {connections.data.connections.find(c => c.id === connections.data.chat?.connectionId)?.label ?? "Account unavailable"} · {connections.data.chat.modelId}</p>}
        {connections.data.scoring && <p className="rb-hint">Separate scoring: {connections.data.connections.find(c => c.id === connections.data.scoring?.connectionId)?.label ?? "Account unavailable"} · {connections.data.scoring.modelId}</p>}
      </div>
      {connections.data.connections.length > 0 && <button type="button" className="btn" onClick={() => setChanging(!changing)} aria-expanded={changing}>Change</button>}
    </section>
    {connections.data.connections.length > 0 && <details className="rb-advanced" open={changing} onToggle={e => setChanging(e.currentTarget.open)}><summary>Account and model</summary><ConnectionSelections value={connections} onSaved={onUpdated} /></details>}
    <details className="rb-advanced" open={connections.data.connections.length === 0}>
      <summary>Manage accounts{connections.data.connections.length > 0 ? ` (${connections.data.connections.length})` : ""}</summary>
      <ul className="rb-account-list">
        {connections.data.connections.map(connection => {
          const operation = operations[connection.id];
          return <li className="rb-account-row" key={connection.id}>
            <div className="rb-account-head"><div className="rb-account-identity"><ProviderMark provider={connection.provider} label={connection.label} /><h3 className="rb-h-minor">{connection.label}</h3></div><span className="rb-hint">{connection.credential.configured ? "Signed in" : "Needs sign-in"}</span></div>
            <details className="rb-account-details"><summary>Account details &amp; repair</summary><p className="rb-hint">{connection.provider} · {connection.credential.source} · validation {connection.validation.status}{connection.baseUrl ? ` · ${connection.baseUrl}` : ""}</p>
              {(connection.provider === "cursor" || providerSupportsOAuth(connection.provider)) && <LoginButton provider={connection.provider} connectionId={connection.id} connection={connection} nodeMajor={nodeMajor} showCursorImport={connection.provider === "cursor"} onUpdated={onUpdated} />}
            </details>
            <div className="rb-form-actions"><button type="button" className="btn" disabled={!!operation?.pending} onClick={() => void operate(connection.id,"test")}>{operation?.pending === "test" ? "Testing…" : "Test connection"}</button><button type="button" className="btn danger" disabled={!!operation?.pending} onClick={() => void operate(connection.id,"remove")}>{operation?.pending === "remove" ? "Removing…" : "Remove"}</button></div>
            {operation?.message && <p className={operation.error ? "rb-form-status crit" : "rb-form-status"} role={operation.error ? "alert" : "status"}>{operation.message}</p>}
          </li>;
        })}
      </ul>
      <ProviderSetup connections={connections} nodeMajor={nodeMajor} onUpdated={onUpdated} excludeConnected />
    </details>
  </div>;
}
