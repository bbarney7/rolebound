import { useCallback, useEffect, useRef, useState } from "react";
import type { RunSummary } from "../../shared/types";
import { isAllowedAttachment, uploadChatAttachment, validateAttachmentSize } from "./attachments";
import ModelMenu from "./ModelMenu";
import type { ConnectionList } from "../../shared/providers";

type AttachmentChip = {
  id: string;
  name: string;
  path?: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
};

export interface ComposerProps {
  run: RunSummary | null;
  placeholder: string;
  chips: string[];
  canSend: boolean;
  /** a run API request is in flight */
  busy?: boolean;
  error: string | null;
  onSend: (message: string) => Promise<boolean>;
  onInterrupt: () => Promise<void>;
  onFinish?: () => Promise<void>;
  onDragActiveChange?: (active: boolean) => void;
  /** Files dropped elsewhere on the pane; each new batch is attached once. */
  incomingFiles?: { files: File[]; id: number } | null;
  connections?: ConnectionList | null;
  onConnectionsChange?: (next: ConnectionList) => void | Promise<void>;
}

function isRunning(run: RunSummary | null): boolean {
  return run?.status === "starting" || run?.status === "running";
}

export default function Composer({
  run,
  placeholder,
  chips,
  canSend,
  busy = false,
  error,
  onSend,
  onInterrupt,
  onFinish,
  onDragActiveChange,
  incomingFiles,
  connections = null,
  onConnectionsChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [isComposing, setIsComposing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const running = isRunning(run);

  const uploading = attachments.some((a) => a.status === "uploading");
  const readyPaths = attachments.filter((a) => a.status === "ready" && a.path).map((a) => a.path!);
  const trimmed = text.trim();
  const hasPayload = trimmed.length > 0 || readyPaths.length > 0;
  // The server refuses a reply while the run is still starting, so hold sends until it is up.
  const blocked = !canSend || busy || sending || run?.status === "starting";
  const sendDisabled = blocked || uploading || !hasPayload;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight) || 24;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const max = lineHeight * 8 + padding;
    el.style.maxHeight = `${max}px`;
    el.style.height = `${el.value ? Math.max(44,Math.min(el.scrollHeight, max)) : 44}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);
  useEffect(() => {
    window.addEventListener("resize",resizeTextarea);
    return () => window.removeEventListener("resize",resizeTextarea);
  },[resizeTextarea]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      if (!isAllowedAttachment(file)) {
        setLocalError("Attachment must be PDF, DOCX, TXT, or MD.");
        continue;
      }
      const sizeErr = validateAttachmentSize(file);
      if (sizeErr) {
        setLocalError(sizeErr);
        continue;
      }
      const id = `${file.name}-${Date.now()}-${Math.random()}`;
      setAttachments((prev) => [...prev, { id, name: file.name, status: "uploading" }]);
      try {
        const path = await uploadChatAttachment(file);
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "ready", path } : a)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "failed", error: message } : a)),
        );
      }
    }
  }, []);

  useEffect(() => {
    if (incomingFiles && incomingFiles.files.length > 0) void addFiles(incomingFiles.files);
  }, [incomingFiles, addFiles]);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const buildMessage = (): string => {
    const lines: string[] = [];
    if (trimmed) lines.push(trimmed);
    if (readyPaths.length > 0) {
      if (lines.length > 0) lines.push("");
      for (const p of readyPaths) lines.push(`Attached file: ${p}`);
    }
    return lines.join("\n");
  };

  const submit = async () => {
    if (sendDisabled) return;
    const message = buildMessage();
    setSending(true);
    try {
      // Clear only once the server took it: a refused message stays in the box to retry.
      if (await onSend(message)) {
        setText("");
        setAttachments([]);
        setLocalError(null);
      }
    } finally {
      setSending(false);
    }
  };

  const sendChip = async (chip: string) => {
    setSending(true);
    try {
      await onSend(chip);
    } finally {
      setSending(false);
    }
  };

  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: { preventDefault: () => void; dataTransfer: DataTransfer }) => {
    e.preventDefault();
    onDragActiveChange?.(false);
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  };

  const onDragOver = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    onDragActiveChange?.(true);
  };

  const onDragLeave = (e: { currentTarget: EventTarget & Element; target: EventTarget | null }) => {
    if (e.currentTarget === e.target) onDragActiveChange?.(false);
  };

  const displayError = error ?? localError;

  return (
    <div
      className="rb-chat-composer-block"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onPaste={onPaste}
    >
      {chips.length > 0 ? (
        <div className="rb-chat-prompt-chips">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              className="rb-chat-prompt-chip"
              disabled={blocked}
              onClick={() => void sendChip(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      {displayError ? (
        <p className="rb-chat-composer-error" role="alert">{displayError}</p>
      ) : null}

      {attachments.length > 0 ? (
        <div className="rb-chat-attach-chips">
          {attachments.map((a) => (
            <span key={a.id} className={`rb-chat-attach-chip rb-chat-attach-chip--${a.status}`}>
              <span className="rb-chat-attach-name">{a.name}</span>
              {a.status === "uploading" ? <span className="rb-chat-attach-state">Uploading…</span> : null}
              {a.status === "failed" ? <span className="rb-chat-attach-state">{a.error ?? "Failed"}</span> : null}
              <button type="button" className="rb-chat-attach-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {onConnectionsChange ? (
        <ModelMenu connections={connections} run={run} onConnectionsChange={onConnectionsChange} />
      ) : null}

      <div className="rb-chat-composer">
        <label className="rb-chat-composer-label" htmlFor="rb-chat-message">Message Rolebound</label>
        <textarea
          id="rb-chat-message"
          ref={textareaRef}
          className="rb-chat-composer-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          className="rb-chat-file-input"
          accept=".pdf,.docx,.txt,.md"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="rb-chat-icon-btn"
          aria-label="Attach a file"
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" />
          </svg>
        </button>
        {running ? (
          <button
            type="button"
            className="rb-chat-icon-btn rb-chat-icon-btn--stop"
            aria-label="Stop"
            onClick={() => void onInterrupt()}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="rb-chat-icon-btn rb-chat-icon-btn--send"
            aria-label="Send"
            disabled={sendDisabled}
            onClick={() => void submit()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      <p className="rb-chat-composer-hint">
        Enter sends. Esc stops whatever I&apos;m doing.
        {run?.status === "waiting" && onFinish ? (
          <button
            type="button"
            className="rb-chat-end-session"
            title="Ends this chat session so Workspace edits and new runs can start"
            onClick={() => void onFinish()}
          >
            End session
          </button>
        ) : null}
      </p>
    </div>
  );
}

export { isRunning };
