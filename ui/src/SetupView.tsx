import { useEffect, useState } from "react";
import type { ConnectionList } from "../shared/providers";
import type { ReadinessPayload } from "../shared/types";
import { fetchConnections, fetchReadiness, recordSupervisedAcknowledgement } from "./settings";
import AISettings from "./AISettings";
import { AUTO_SUBMIT_DISCLOSURE_TEXT } from "../shared/autoSubmitPolicy";
import "./surfaces.css";

const TASKS = [
  { id: "connection", label: "Connect AI", steps: ["connection"] },
  { id: "profile", label: "Resume & profile", steps: ["resume", "profile"] },
  { id: "targets", label: "Find jobs", steps: ["targets"] },
  { id: "readiness", label: "Ready to apply", steps: ["readiness"] },
] as const;
export default function SetupView({ navigate, onReadinessChange }: { navigate: (path: string) => void; onReadinessChange?: (ready: ReadinessPayload) => void }) {
  const [ready, setReady] = useState<ReadinessPayload | null>(null);
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  async function reload() {
    try {
      const [r,c] = await Promise.all([fetchReadiness(), fetchConnections()]);
      setReady(r); setConnections(c); setError(null); onReadinessChange?.(r);
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { void reload(); }, []);
  async function acknowledge() {
    setAckBusy(true); setError(null);
    try { const next = await recordSupervisedAcknowledgement(); setReady(next); onReadinessChange?.(next); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAckBusy(false); }
  }
  if (!ready || !connections) return <div className="rb-surface rb-empty"><p role="status">{error ?? "Loading setup…"}</p>{error && <button className="btn" onClick={() => void reload()}>Try again</button>}</div>;
  const complete = (ids: readonly string[]) => ids.every(id => ready.steps.find(s => s.id === id)?.complete);
  const selected = active ?? TASKS.find(t => !complete(t.steps))?.id ?? "readiness";
  const task = TASKS.find(t => t.id === selected)!;
  const blockers = ready.steps.filter(s => (task.steps as readonly string[]).includes(s.id)).flatMap(s => s.blockers);
  const ackMissing = ready.steps.some(s => s.blockers.some(b => b.code === "ACKNOWLEDGEMENT_MISSING" || b.code === "ACKNOWLEDGEMENT_LEGACY"));
  return <div className="rb-surface rb-setup">

    <nav className="rb-setup-progress" aria-label="Setup progress">{TASKS.map((t,i) => <button key={t.id} type="button" className="rb-setup-step-button" aria-current={selected === t.id ? "step" : undefined} onClick={() => setActive(t.id)}><span>{i+1}. {t.label}</span><small>{complete(t.steps) ? "Complete · Edit" : selected === t.id ? "Current step" : "Needs setup"}</small></button>)}</nav>
    <section className="rb-setup-task" aria-label={task.label}>
      <h2 className="rb-h-major">{task.label}</h2>
      {selected === "connection" && <AISettings connections={connections} nodeMajor={ready.serverRuntime.nodeMajor} onUpdated={reload} />}
      {selected === "profile" && <><p>Import your resume, then check your contact details and application answers.</p><div className="rb-form-actions"><button className="btn primary" onClick={() => navigate("/profile?tab=resumes")}>Import a resume</button><button className="btn" onClick={() => navigate("/profile?tab=identity")}>Review profile</button></div></>}
      {selected === "targets" && <><p>Choose companies you want to watch or explore the roles already found.</p><div className="rb-form-actions"><button className="btn primary" onClick={() => navigate("/discover?tab=companies")}>Choose companies</button><button className="btn" onClick={() => navigate("/discover")}>Find jobs</button></div></>}
      {selected === "readiness" && <><p>{ready.applyReady ? "Your workspace is ready to apply." : "Finish these requirements before starting an application."}</p>
        <section className="rb-ack-banner" aria-label="Supervised automation acknowledgement"><h3 className="rb-h-minor">Automatic submission</h3><p>{AUTO_SUBMIT_DISCLOSURE_TEXT}</p>{ackMissing ? <button className="btn primary" disabled={ackBusy} onClick={() => void acknowledge()}>{ackBusy ? "Saving…" : "I understand — enable automatic submission"}</button> : <p role="status">Acknowledgement saved.</p>}</section>
      </>}
      {blockers.filter(b => !b.code.startsWith("ACKNOWLEDGEMENT_")).map(b => <p className="rb-setup-blocker" key={b.code}>{b.message} <button className="small-link" onClick={() => navigate(b.href)}>Review</button></p>)}
      {selected !== "readiness" && <div className="rb-form-actions"><button className="btn" onClick={() => setActive(TASKS[Math.min(TASKS.findIndex(t => t.id === selected)+1,3)].id)}>Continue →</button></div>}
    </section>
    {ready.warnings.map(w => <p key={w.code} className="rb-field-error">{w.message} <button className="small-link" onClick={() => navigate(w.href)}>Review</button></p>)}
    {error && <p className="rb-form-status crit" role="alert">{error}</p>}
    <p className="rb-hint">CAPTCHA solving is optional and stays Off unless configured in Settings. Manual CAPTCHA and email verification stay in the supervised run.</p>
  </div>;
}
