import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RunSummary, RunUiResponseBody } from "../../shared/types";
import type { RunEntry } from "../useRun";
import { renderMarkdown } from "./markdown";
import BrandMark from "./cards/BrandMark";
import ActivityRow, { toolActivityLabel } from "./cards/ActivityRow";
import ToolCard, { canRenderToolCard } from "./cards/ToolCard";

const SCROLL_THRESHOLD = 80;

type ToolGroup = { kind: "tool-group"; key: string; entries: Extract<RunEntry, { kind: "tool" }>[] };
type RenderItem =
  | { kind: "entry"; entry: RunEntry }
  | ToolGroup
  | { kind: "system-group"; key: string; entries: Extract<RunEntry, {kind:"system"}>[] };

function buildRenderItems(entries: RunEntry[]): RenderItem[] {
  const items: RenderItem[] = [];
  let batch: Extract<RunEntry, { kind: "tool" }>[] = [];

  const flushBatch = () => {
    if (batch.length === 0) return;
    if (batch.length === 1) {
      items.push({ kind: "entry", entry: batch[0] });
    } else {
      items.push({ kind: "tool-group", key: batch.map((e) => e.key).join("-"), entries: [...batch] });
    }
    batch = [];
  };

  for (const entry of entries) {
    if (entry.kind === "tool" && !entry.isError && (!entry.details?.card || !canRenderToolCard(entry.details))) {
      batch.push(entry);
      continue;
    }
    flushBatch();
    if (entry.kind === "system" && entry.severity === "info" && (entry.source === "status_line" || entry.source === "exit")) {
      const last = items[items.length-1];
      if (last?.kind === "system-group") last.entries.push(entry);
      else items.push({kind:"system-group",key:entry.key,entries:[entry]});
      continue;
    }
    items.push({ kind: "entry", entry });
  }
  flushBatch();
  return items;
}

function UiRequestCard({
  entry,
  onRespondUi,
}: {
  entry: Extract<RunEntry, { kind: "ui_request" }>;
  onRespondUi: (body: RunUiResponseBody) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.prefill ?? "");

  if (entry.resolved) {
    return (
      <div className="rb-chat-ui-request rb-chat-ui-request--resolved">
        <span className="rb-chat-ui-title rb-chat-ui-title--muted">{entry.title}</span>
        <span className="rb-chat-ui-answered">Answered</span>
      </div>
    );
  }

  const cancel = () => void onRespondUi({ id: entry.id, cancelled: true });

  return (
    <div className="rb-chat-ui-request">
      <div className="rb-chat-ui-title">{entry.title}</div>
      {entry.message ? <p className="rb-chat-ui-message">{entry.message}</p> : null}
      {entry.method === "confirm" ? (
        <div className="rb-chat-ui-actions">
          <button type="button" className="rb-chat-btn rb-chat-btn--primary" onClick={() => void onRespondUi({ id: entry.id, confirmed: true })}>
            Yes
          </button>
          <button type="button" className="rb-chat-btn" onClick={() => void onRespondUi({ id: entry.id, confirmed: false })}>
            No
          </button>
          <button type="button" className="rb-chat-link-btn" onClick={cancel}>Cancel</button>
        </div>
      ) : null}
      {entry.method === "select" && entry.options ? (
        <div className="rb-chat-ui-actions rb-chat-ui-actions--stack">
          {entry.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="rb-chat-btn"
              onClick={() => void onRespondUi({ id: entry.id, value: opt })}
            >
              {opt}
            </button>
          ))}
          <button type="button" className="rb-chat-link-btn" onClick={cancel}>Cancel</button>
        </div>
      ) : null}
      {entry.method === "input" || entry.method === "editor" ? (
        <div className="rb-chat-ui-form">
          <textarea
            className="rb-chat-ui-input"
            aria-label={entry.title}
            rows={entry.method === "editor" ? 6 : 3}
            placeholder={entry.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="rb-chat-ui-actions">
            <button
              type="button"
              className="rb-chat-btn rb-chat-btn--primary"
              onClick={() => void onRespondUi({ id: entry.id, value })}
            >
              Submit
            </button>
            <button type="button" className="rb-chat-link-btn" onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolGroupDetails({ group }: { group: ToolGroup }) {
  const pending = group.entries.some((e) => e.result === null);
  const latest = group.entries[group.entries.length - 1];
  const summary = pending
    ? toolActivityLabel(latest)
    : `Worked through ${group.entries.length} steps`;

  return (
    <details className="rb-chat-tool-group">
      <summary className="rb-chat-tool-group-summary">{summary}</summary>
      <div className="rb-chat-tool-group-body">
        {group.entries.map((e) => (
          <ActivityRow key={e.key} entry={e} compact />
        ))}
      </div>
    </details>
  );
}

export interface TranscriptProps {
  run: RunSummary | null;
  entries: RunEntry[];
  intro?: ReactNode;
  onSend: (message: string) => void;
  onRespondUi: (body: RunUiResponseBody) => Promise<void>;
}

export default function Transcript({ run, entries, intro, onSend, onRespondUi }: TranscriptProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const renderItems = useMemo(() => buildRenderItems(entries), [entries]);

  const turnMarkKeys = useMemo(() => {
    const keys = new Set<string>();
    let needMark = true;
    for (const entry of entries) {
      if (entry.kind === "user") {
        needMark = true;
        continue;
      }
      if (entry.kind === "assistant" && needMark) {
        keys.add(entry.key);
        needMark = false;
      }
    }
    return keys;
  }, [entries]);

  const showWorking = useMemo(() => {
    if (!run || (run.status !== "starting" && run.status !== "running")) return false;
    const last = entries[entries.length - 1];
    if (last?.kind === "assistant" && !last.done) return false;
    return true;
  }, [run, entries]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < SCROLL_THRESHOLD;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, showWorking]);

  const jumpToLatest = () => {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  if (entries.length === 0) {
    return <div className="rb-chat-intro-wrap">{intro}</div>;
  }

  return (
    <div className="rb-chat-transcript-wrap">
      <div
        ref={logRef}
        className="rb-chat-transcript"
        role="log"
        aria-live="polite"
        onScroll={onScroll}
      >
        {renderItems.map((item) => {
          if (item.kind === "system-group") return <details key={item.key} className="rb-chat-tool-group"><summary>Activity ({item.entries.length})</summary>{item.entries.map(entry => <p className="rb-chat-system" key={entry.key}>{entry.text}</p>)}</details>;
          if (item.kind === "tool-group") {
            return <ToolGroupDetails key={item.key} group={item} />;
          }
          const entry = item.entry;
          switch (entry.kind) {
            case "user":
              return (
                <div key={entry.key} className="rb-chat-user-row">
                  <div className="rb-chat-user-bubble">{entry.text}</div>
                </div>
              );
            case "assistant": {
              const showMark = turnMarkKeys.has(entry.key);
              return (
                <div key={entry.key} className="rb-chat-assistant-row">
                  {showMark ? <BrandMark className="rb-chat-assistant-mark" /> : <span className="rb-chat-assistant-mark-spacer" aria-hidden="true" />}
                  <div className="rb-chat-assistant-text">
                    {renderMarkdown(entry.text, { caret: !entry.done })}
                  </div>
                </div>
              );
            }
            case "tool": {
              if (entry.isError) return <ActivityRow key={entry.key} entry={entry} />;
              if (entry.details?.card && canRenderToolCard(entry.details)) {
                return (
                  <div key={entry.key} className="rb-chat-card-wrap">
                    <ToolCard details={entry.details} onSend={onSend} />
                  </div>
                );
              }
              return <ActivityRow key={entry.key} entry={entry} />;
            }
            case "notify": {
              const levelClass =
                entry.level === "warning"
                  ? "rb-chat-notify rb-chat-notify--warning"
                  : entry.level === "error"
                    ? "rb-chat-notify rb-chat-notify--error"
                    : "rb-chat-notify";
              return (
                <p key={entry.key} className={levelClass} role={entry.level === "error" ? "alert" : undefined}>
                  {entry.text}
                </p>
              );
            }
            case "ui_request":
              return (
                <UiRequestCard key={entry.key} entry={entry} onRespondUi={onRespondUi} />
              );
            case "system":
              return (
                <p key={entry.key} className={entry.severity === "error" ? "rb-chat-notify rb-chat-notify--error" : "rb-chat-system"} role={entry.severity === "error" ? "alert" : undefined}>{entry.text}</p>
              );
            default:
              return null;
          }
        })}
        {showWorking ? (
          <div className="rb-chat-working">
            <span className="rb-chat-activity-dot" aria-hidden="true" />
            Working…
          </div>
        ) : null}
      </div>
      {showJump ? (
        <button type="button" className="rb-chat-jump" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
