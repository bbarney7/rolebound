import { useEffect, useRef, useState } from "react";
import type { ConnectionList } from "../shared/providers";
import { defaultModels } from "../shared/defaultModels";
import { JEV_TYPESAFE_MODEL_ID } from "../shared/jevModels";
import { fetchModelCatalog, updateSelections } from "./settings";
import ModelPicker from "./components/ModelPicker";
import FormSaveBar from "./components/FormSaveBar";
import { useUnsavedChanges, useWorkspaceState } from "./WorkspaceDrafts";
import "./surfaces.css";

const EFFORTS = ["", "low", "medium", "high", "xhigh"];
type Fields = { agent: string; model: string; thinking: string; chat: string; chatModel: string; chatThinking: string; score: string; scoreModel: string };
function fields(value: ConnectionList): Fields {
  return { agent: value.data.agent?.connectionId ?? "", model: value.data.agent?.modelId ?? "", thinking: value.data.agent?.thinking ?? "", chat: value.data.chat?.connectionId ?? "", chatModel: value.data.chat?.modelId ?? "", chatThinking: value.data.chat?.thinking ?? "", score: value.data.scoring?.connectionId ?? "", scoreModel: value.data.scoring?.modelId ?? "" };
}
const keys: (keyof Fields)[] = ["agent", "model", "thinking", "chat", "chatModel", "chatThinking", "score", "scoreModel"];
function defaultScoreModelForProvider(provider: string): string {
  return provider === "typesafe" ? JEV_TYPESAFE_MODEL_ID : (defaultModels.scoring as Record<string, string | undefined>)[provider] ?? "";
}
export default function ConnectionSelections({ value, onSaved }: { value: ConnectionList; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useWorkspaceState("model-selection", () => ({ values: fields(value), baseline: fields(value), revision: value.revision }));
  const { agent, model, thinking, chat, chatModel, chatThinking, score, scoreModel } = draft.values;
  const dirty = keys.some(key => draft.values[key] !== draft.baseline[key]);
  useUnsavedChanges("model-selection", dirty);
  const [catalog, setCatalog] = useState<Array<{ id: string; label?: string }>>([]);
  const [chatCatalog, setChatCatalog] = useState<Array<{id:string;label?:string}>>([]);
  const [chatLoading,setChatLoading] = useState(false);
  const chatRequest = useRef(0);
  const [scoreCatalog, setScoreCatalog] = useState<Array<{ id: string; label?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [scoreCatalogLoading, setScoreCatalogLoading] = useState(false);
  const catalogRequest = useRef(0);
  const scoreRequest = useRef(0);
  const manualScoreVersion = useRef(0);
  const autoScore = useRef(false);

  function change(next: Partial<Fields>) { setSaved(false); setError(null); setDraft(old => ({ ...old, values: { ...old.values, ...next } })); }
  useEffect(() => {
    const incoming = fields(value);
    setDraft(old => {
      const values = { ...old.values }, baseline = { ...old.baseline };
      const wasDirty = keys.some(key => old.values[key] !== old.baseline[key]);
      for (const key of keys) if (old.values[key] === old.baseline[key]) values[key] = baseline[key] = incoming[key];
      return { values, baseline, revision: wasDirty ? old.revision : value.revision };
    });
  }, [value]);

  async function loadCatalog(id: string) {
    const request = ++catalogRequest.current;
    setCatalogError(null); setCatalog([]); setCatalogLoading(Boolean(id));
    if (!id) return;
    try { const models = await fetchModelCatalog(id); if (request === catalogRequest.current) setCatalog(models); }
    catch (e) { if (request === catalogRequest.current) setCatalogError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === catalogRequest.current) setCatalogLoading(false); }
  }
  async function loadChatCatalog(id: string) {
    const request = ++chatRequest.current;
    setChatCatalog([]); setChatLoading(Boolean(id));
    if (!id) return;
    try { const models = await fetchModelCatalog(id); if(request === chatRequest.current) setChatCatalog(models); }
    catch(e) { if(request === chatRequest.current) setCatalogError(e instanceof Error ? e.message : String(e)); }
    finally { if(request === chatRequest.current) setChatLoading(false); }
  }
  useEffect(() => { void loadChatCatalog(chat); return () => {chatRequest.current++;}; },[chat]);
  async function loadScoreCatalog(id: string, connectionDriven = false) {
    const request = ++scoreRequest.current, version = manualScoreVersion.current;
    setCatalogError(null); setScoreCatalog([]); setScoreCatalogLoading(Boolean(id));
    if (!id) return;
    try {
      const models = await fetchModelCatalog(id);
      if (request !== scoreRequest.current) return;
      setScoreCatalog(models);
      if (models.length === 1) setDraft(old => {
        if (old.values.score !== id || (Boolean(old.values.scoreModel) && !(connectionDriven && version === manualScoreVersion.current))) return old;
        return { ...old, values: { ...old.values, scoreModel: models[0]!.id } };
      });
    } catch (e) { if (request === scoreRequest.current) setCatalogError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === scoreRequest.current) setScoreCatalogLoading(false); }
  }
  useEffect(() => { void loadCatalog(agent); return () => { catalogRequest.current++; }; }, [agent]);
  useEffect(() => { const fill = autoScore.current; autoScore.current = false; void loadScoreCatalog(score, fill); return () => { scoreRequest.current++; }; }, [score]);

  return <form className="rb-settings-form rb-model-select" onSubmit={async event => {
    event.preventDefault();
    if (!dirty || busy) return;
    if (score && !scoreModel.trim()) { setError("Choose a scoring model or use the main AI account."); return; }
    if (chat && !chatModel.trim()) { setError("Choose a chat model or select Same as applying model."); return; }
    const submitted = { ...draft.values };
    setBusy(true); setError(null);
    try {
      const next = await updateSelections({ agent: { connectionId: agent, modelId: model.trim(), ...(thinking ? { thinking } : {}) }, chat: chat ? {connectionId:chat,modelId:chatModel.trim(),...(chatThinking ? {thinking:chatThinking} : {})} : null, scoring: score ? { connectionId: score, modelId: scoreModel.trim() } : null, expectedRevision: draft.revision });
      setDraft(old => ({ values: old.values, baseline: submitted, revision: next?.revision ?? value.revision }));
      setSaved(true); await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}>
    <h3 className="rb-h-minor">Choose your AI model</h3>
    <div className="rb-settings-grid">
      <div className="rb-profile-field"><label htmlFor="agent-connection">Applying connection</label>
        <select id="agent-connection" className="control" required disabled={busy} value={agent} onChange={e => change({ agent: e.target.value, model: "" })}>
          <option value="">Choose an account…</option>{value.data.connections.filter(c => c.provider !== "typesafe").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      <div className="rb-profile-field"><div className="rb-field-label-row"><label htmlFor="agent-model">Applying model</label>
        {agent && <button id="load-catalog-btn" type="button" className="small-link" disabled={catalogLoading} onClick={() => void loadCatalog(agent)}>{catalogLoading ? "Loading…" : "Refresh models"}</button>}
      </div><ModelPicker id="agent-model" required disabled={!agent || busy} loading={catalogLoading} value={model} models={catalog} onChange={next => { if (next !== model) change({ model: next }); }} /></div>
    </div>
    <details className="rb-advanced" open={Boolean(chat) || undefined}>
      <summary>Chat model{chat ? " · separate model enabled" : " · same as applying"}</summary>
      <div className="rb-settings-grid">
        <div className="rb-profile-field"><label htmlFor="chat-connection">Chat connection</label><select id="chat-connection" className="control" disabled={busy} value={chat} onChange={e => change({chat:e.target.value,chatModel:"",chatThinking:""})}><option value="">Same as applying model</option>{value.data.connections.filter(c => c.provider !== "typesafe").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        {chat && <><div className="rb-profile-field"><div className="rb-field-label-row"><label htmlFor="chat-model">Chat model</label><button type="button" className="small-link" disabled={chatLoading} onClick={() => void loadChatCatalog(chat)}>{chatLoading ? "Loading…" : "Refresh chat models"}</button></div><ModelPicker id="chat-model" required disabled={busy} loading={chatLoading} value={chatModel} models={chatCatalog} onChange={next => change({chatModel:next})} /></div>
        <div className="rb-profile-field"><label htmlFor="chat-thinking">Chat reasoning effort</label><select id="chat-thinking" className="control" disabled={busy} value={chatThinking} onChange={e => change({chatThinking:e.target.value})}>{EFFORTS.map(v => <option key={v} value={v}>{v || "Provider default"}</option>)}</select></div></>}
      </div>
    </details>
    <details className="rb-advanced" open={Boolean(score || thinking) || undefined}>
      <summary>Advanced model settings{score ? " · separate scoring model enabled" : ""}</summary>
      <div className="rb-settings-grid">
        <div className="rb-profile-field"><label htmlFor="agent-thinking">Reasoning effort</label><select id="agent-thinking" className="control" value={thinking} disabled={busy} onChange={e => change({ thinking: e.target.value })}>{EFFORTS.map(v => <option key={v} value={v}>{v || "Provider default"}</option>)}</select></div>
        <div className="rb-profile-field"><label htmlFor="score-connection">Scoring connection</label><select id="score-connection" className="control" value={score} disabled={busy} onChange={e => { const id = e.target.value, conn = value.data.connections.find(c => c.id === id); autoScore.current = true; change({ score: id, scoreModel: conn ? defaultScoreModelForProvider(conn.provider) : "" }); }}><option value="">Use main AI account</option>{value.data.connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        {score && <div className="rb-profile-field rb-settings-span2"><div className="rb-field-label-row"><label htmlFor="score-model">Scoring model</label><button type="button" className="small-link" disabled={scoreCatalogLoading} onClick={() => void loadScoreCatalog(score)}>{scoreCatalogLoading ? "Loading…" : "Refresh scoring models"}</button></div><ModelPicker id="score-model" required disabled={busy} loading={scoreCatalogLoading} value={scoreModel} models={scoreCatalog} onChange={next => { manualScoreVersion.current++; change({ scoreModel: next }); }} /></div>}
      </div>
      <p className="rb-hint">Scoring ranks job matches. By default it uses the applying account and model.</p>
    </details>
    {catalogError && <div className="rb-hint"><p>Couldn’t load the model catalog. Try refreshing or select a custom model ID.</p><details><summary>Technical details</summary>{catalogError}</details></div>}
    <FormSaveBar dirty={dirty} saving={busy} error={error} saved={saved} label="Save model selection" disabled={!agent || !model.trim()} />
  </form>;
}
