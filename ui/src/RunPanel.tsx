import { useState } from "react";
import Stamp, { humanize, type Tone } from "./Stamp";
import type { RunStatus, RunSummary, RunUiResponseBody } from "../shared/types";
import type { RunEntry } from "./useRun";
import type { ConnectionState } from "./sse";
import "./surfaces.css";

export const STATUS_TONE: Record<RunStatus, Tone> = {
  starting: "accent",
  running: "accent",
  waiting: "warn",
  done: "good",
  stopped: "neutral",
  failed: "crit",
};

function statusLabel(status: RunStatus, connection: ConnectionState): string {
  if (connection === "reconnecting") return "reconnecting";
  if (status === "waiting") return "waiting for you";
  return humanize(status);
}

export default function RunPanel({
  run,
  entries,
  busy,
  error,
  connection,
  draft,
  onDraftChange,
  onReply,
  onRespondUi,
  onAbort,
  onFinish,
}: {
  run: RunSummary | null;
  entries: RunEntry[];
  busy: boolean;
  error: string | null;
  connection: ConnectionState;
  draft: string;
  onDraftChange: (value: string) => void;
  onReply: (message: string) => void;
  onRespondUi: (body: RunUiResponseBody) => void;
  onAbort: () => void;
  onFinish: () => void;
}) {
  if (!run) {
    return (
      <div className="rb-surface rb-empty state">
        <span className="glyph" aria-hidden="true">▷</span>
        <p>No run yet — start one from Today or a queue row.</p>
        {error !== null && <p className="rb-section-note crit note">{error}</p>}
      </div>
    );
  }

  const active = run.status === "starting" || run.status === "running" || run.status === "waiting";
  const canReply = run.status === "running" || run.status === "waiting";
  const pending = entries.filter((entry): entry is Extract<RunEntry, { kind: "ui_request" }> => entry.kind === "ui_request" && !entry.resolved);
  const history = entries.filter((entry) => entry.kind !== "ui_request" || entry.resolved);

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    onDraftChange("");
    onReply(message);
  };

  return (
    <div className="rb-surface rb-run card run-panel">
      <header className="rb-run-head head run-head">
        <div>
          <h2 className="rb-h-major">{humanize(run.kind)}{run.slug ? ` — ${run.slug}` : ""}</h2>
          <p className="rb-run-meta meta mono">{run.sessionName} · {run.model}</p>
          {run.status === "failed" && <p className="rb-section-note warn note">This process ended unexpectedly. Start a new run — it will not resume the old process.</p>}
          {run.status === "done" && <p className="rb-section-note note">Agent finished. Submission is only confirmed when the application record shows receipt evidence.</p>}
        </div>
        <div className="rb-run-actions run-actions">
          <Stamp tone={connection === "reconnecting" ? "warn" : STATUS_TONE[run.status]}>{statusLabel(run.status, connection)}</Stamp>
          {active && (
            <button type="button" className="btn" disabled={busy} onClick={onAbort}>Abort</button>
          )}
          {run.status === "waiting" && (
            <button type="button" className="btn primary" disabled={busy} onClick={onFinish}>Finish</button>
          )}
        </div>
      </header>

      {error !== null && <p className="rb-section-note crit note" style={{ padding: "0 1.1rem" }}>{error}</p>}

      {pending.length > 0 && (
        <section className="rb-run-pinned run-pinned" aria-label="Required action">
          {pending.map((entry) => (
            <UiRequest key={entry.key} entry={entry} busy={busy} onRespondUi={onRespondUi} />
          ))}
        </section>
      )}

      <div className="rb-run-transcript transcript">
        {history.length === 0 ? (
          <p className="tl-system">Waiting for the agent's first output…</p>
        ) : (
          history.map((entry) => <Line key={entry.key} entry={entry} busy={busy} onRespondUi={onRespondUi} />)
        )}
      </div>

      {canReply && (
        <div className="rb-run-reply reply">
          <textarea
            className="control wide"
            rows={3}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={run.status === "waiting" ? "Reply to the agent…" : "Steer the running agent…"}
            aria-label="Reply to the agent"
          />
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Line({
  entry,
  busy,
  onRespondUi,
}: {
  entry: RunEntry;
  busy: boolean;
  onRespondUi: (body: RunUiResponseBody) => void;
}) {
  switch (entry.kind) {
    case "user":
      return <div className="tl-user">{entry.text}</div>;
    case "assistant":
      return <div className="tl-assistant">{entry.text}</div>;
    case "tool":
      return (
        <details className="tl-tool">
          <summary className="mono">{entry.name} → {entry.summary}</summary>
          {entry.args != null && <p className="mono block">{JSON.stringify(entry.args, null, 2)}</p>}
          {entry.result !== null && <p className="mono block">{entry.isError ? `error: ${entry.result}` : entry.result}</p>}
        </details>
      );
    case "notify":
      return <div className={entry.level === "info" ? "tl-notify" : `tl-notify ${entry.level}`}>{entry.text}</div>;
    case "system":
      return <div className="tl-system">{entry.text}</div>;
    case "ui_request":
      return <div className="tl-system">answered: {entry.title}</div>;
  }
}

function UiRequest({
  entry,
  busy,
  onRespondUi,
}: {
  entry: Extract<RunEntry, { kind: "ui_request" }>;
  busy: boolean;
  onRespondUi: (body: RunUiResponseBody) => void;
}) {
  const [value, setValue] = useState(entry.prefill ?? "");
  const cancel = (
    <button type="button" className="btn" disabled={busy} onClick={() => onRespondUi({ id: entry.id, cancelled: true })}>Cancel</button>
  );

  return (
    <div className="rb-ui-request ui-request pinned-request">
      <p className="mono">{entry.method}</p>
      <p><strong>{entry.title}</strong></p>
      {entry.message && <p>{entry.message}</p>}
      {entry.method === "confirm" ? (
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => onRespondUi({ id: entry.id, confirmed: true })}>Yes</button>
          <button type="button" className="btn" disabled={busy} onClick={() => onRespondUi({ id: entry.id, confirmed: false })}>No</button>
          {cancel}
        </div>
      ) : entry.method === "select" ? (
        <div className="actions">
          {(entry.options ?? []).map((option) => (
            <button key={option} type="button" className="btn" disabled={busy} onClick={() => onRespondUi({ id: entry.id, value: option })}>{option}</button>
          ))}
          {cancel}
        </div>
      ) : (
        <>
          <textarea className="control wide tall" value={value} placeholder={entry.placeholder} onChange={(e) => setValue(e.target.value)} aria-label={entry.title} />
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => onRespondUi({ id: entry.id, value })}>Send</button>
            {cancel}
          </div>
        </>
      )}
    </div>
  );
}
