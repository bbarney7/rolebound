import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { ReactNode } from "react";
import type { ConnectionList } from "../../shared/providers";
import type { RunSummary, RunUiResponseBody } from "../../shared/types";
import type { RunEntry } from "../useRun";
import Transcript from "./Transcript";
import Composer, { isRunning } from "./Composer";
import "./chat.css";

/**
 * The conversation column: the transcript, inline cards and the composer.
 * App owns the run; this component only renders it and reports intent.
 */
export interface ChatPaneProps {
  run: RunSummary | null;
  /** Entries from earlier runs in this page session, oldest first, then the current run's. */
  entries: RunEntry[];
  /** a request to the run API is in flight */
  busy: boolean;
  /** the run API's last refusal, in its own words */
  error: string | null;
  /**
   * App decides whether this starts a chat run or replies to the live one.
   * Resolves false when the server refused, so the composer keeps the draft.
   */
  onSend: (message: string) => Promise<boolean>;
  /** Esc and the Stop button: stops the live run. */
  onInterrupt: () => Promise<void>;
  onRespondUi: (body: RunUiResponseBody) => Promise<void>;
  /** Ends a settled (waiting) session, releasing the workspace for edits and other runs. */
  onFinish: () => Promise<void>;
  /** Shown above the composer when there are no entries yet (first launch hero, model card). */
  intro?: ReactNode;
  /** One-tap prompts above the composer; tapping one sends its text. */
  chips: string[];
  /** Composer placeholder; App varies it with readiness. */
  placeholder: string;
  /** False while no model is connected: the composer stays visible but cannot send. */
  canSend: boolean;
  connections?: ConnectionList | null;
  onConnectionsChange?: (next: ConnectionList) => void | Promise<void>;
  /** Local notes rendered above the composer (e.g. model switch). */
  chatNotes?: RunEntry[];
}

export default function ChatPane({
  run,
  entries,
  busy,
  error,
  onSend,
  onInterrupt,
  onFinish,
  onRespondUi,
  intro,
  chips,
  placeholder,
  canSend,
  connections = null,
  onConnectionsChange,
  chatNotes = [],
}: ChatPaneProps) {
  const [dropOverlay, setDropOverlay] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<{ files: File[]; id: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Esc belongs to an open dialog (the Workspace drawer) before it stops the agent.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!isRunning(run)) return;
      e.preventDefault();
      void onInterrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, onInterrupt]);

  const onSendMessage = useCallback((message: string) => onSend(message), [onSend]);

  const onDragActiveChange = useCallback((active: boolean) => setDropOverlay(active), []);

  const onPaneDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDropOverlay(true);
    }
  };

  const onPaneDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setDropOverlay(false);
  };

  const onPaneDrop = (e: DragEvent) => {
    setDropOverlay(false);
    // The composer attaches files dropped on itself and marks the event handled.
    if (e.isDefaultPrevented() || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setDroppedFiles({ files: Array.from(e.dataTransfer.files), id: Date.now() });
  };

  return (
    <section
      className="rb-chat-pane"
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
    >
      <div className="rb-chat-column">
        <Transcript
          run={run}
          entries={entries}
          intro={intro}
          onSend={onSendMessage}
          onRespondUi={onRespondUi}
        />
        {chatNotes.length > 0 ? (
          <div className="rb-chat-notes" aria-live="polite">
            {chatNotes.map((note) => (
              <p key={note.key} className="rb-chat-note">{note.kind === "system" ? note.text : ""}</p>
            ))}
          </div>
        ) : null}
        <Composer
          run={run}
          placeholder={placeholder}
          chips={chips}
          canSend={canSend}
          busy={busy}
          error={error}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onFinish={onFinish}
          onDragActiveChange={onDragActiveChange}
          incomingFiles={droppedFiles}
          connections={connections}
          onConnectionsChange={onConnectionsChange}
        />
      </div>
      {dropOverlay ? (
        <div className="rb-chat-drop-overlay" aria-hidden="true">
          Drop your resume or a file
        </div>
      ) : null}
    </section>
  );
}
