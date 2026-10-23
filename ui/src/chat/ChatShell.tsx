import type { MouseEvent, ReactNode, Ref } from "react";
import type { ConnectionState } from "../sse";
import BrandMark from "./cards/BrandMark";


function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export type ModelPillState =
  | { kind: "needs"; label: "No model connected" }
  | { kind: "ok"; provider: string; model: string };

export default function ChatShell({
  children,
  rail,
  modelPill,
  connection,
  workspaceOpen,
  workspaceButtonRef,
  onHome,
  onWorkspace,
  onThemeToggle,
  themeResolved,
  error,
}: {
  children: ReactNode;
  rail?: ReactNode;
  modelPill: ModelPillState;
  connection: ConnectionState;
  workspaceOpen: boolean;
  workspaceButtonRef?: Ref<HTMLButtonElement>;
  onHome: () => void;
  onWorkspace: () => void;
  onThemeToggle: () => void;
  themeResolved: "light" | "dark";
  error: string | null;
}) {
  const onWordmarkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onHome();
  };

  const showReconnecting = connection !== "open";

  return (
    <div className="rb-chat-app">
      <header className="rb-chat-header">
        <a className="rb-chat-brand" href="/" onClick={onWordmarkClick}>
          <BrandMark />
          <span className="rb-chat-brand-name">Rolebound</span>
        </a>

        <div className="rb-chat-header-actions">
          {modelPill.kind === "needs" ? (
            <span
              className="rb-model-pill rb-model-pill--needs"
              title={modelPill.label}
              aria-label={modelPill.label}
            >
              <span className="rb-model-pill-dot" aria-hidden="true" />
              <span className="rb-model-pill-text rb-model-pill-text--full">{modelPill.label}</span>
              <span className="rb-model-pill-text rb-model-pill-text--short">{modelPill.label}</span>
            </span>
          ) : (
            <span
              className="rb-model-pill rb-model-pill--ok"
              title={`${modelPill.provider}: ${modelPill.model}`}
              aria-label={`AI ready. ${modelPill.provider}: ${modelPill.model}`}
            >
              <span className="rb-model-pill-dot" aria-hidden="true" />
              <span className="rb-model-pill-text rb-model-pill-text--full">
                <strong>{modelPill.provider}</strong> <span>{modelPill.model}</span>
              </span>
              <span className="rb-model-pill-text rb-model-pill-text--short">AI ready</span>
            </span>
          )}

          {showReconnecting ? <p className="rb-chat-conn">Reconnecting…</p> : null}

          <button
            type="button"
            className="rb-chat-btn rb-chat-btn--workspace"
            ref={workspaceButtonRef}
            aria-pressed={workspaceOpen}
            aria-label="Workspace"
            onClick={onWorkspace}
          >
            <PanelIcon />
            <span className="rb-chat-btn-label">Workspace</span>
          </button>

          <button
            type="button"
            className="rb-chat-btn rb-chat-btn--icon"
            onClick={onThemeToggle}
            aria-label={themeResolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {themeResolved === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <div className="rb-chat-body">
        <main className="rb-chat-main">
          {error ? (
            <div className="rb-workspace-error state crit" role="alert">
              <span className="glyph" aria-hidden="true">!</span>
              <p>{`API error: ${error}`}</p>
              <p className="mono">Is the API server running on 127.0.0.1:4747?</p>
            </div>
          ) : null}
          {children}
        </main>
        {rail ? <aside className="rb-chat-rail" aria-label="Your search">{rail}</aside> : null}
      </div>
    </div>
  );
}
