import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionView } from "../shared/config";
import {
  answerLogin,
  cancelLogin,
  fetchLogin,
  startLogin,
  startProviderLogin,
  type LoginSession,
} from "./providerSetupApi";
import {
  CURSOR_AUTH_BUTTONS,
  cursorNeedsNode24,
  oauthSignInLabel,
  providerSignInStatusLine,
} from "./loginUiHelpers";

type UiStatus = "idle" | LoginSession["status"];

function openSignInWindow(): Window | null {
  try {
    return window.open("", "_blank");
  } catch {
    return null;
  }
}

function navigatePopup(popup: Window | null, url: string) {
  if (!popup) return;
  try {
    popup.location.href = url;
  } catch {
    // cross-origin or blocked — fallback link handles navigation
  }
}

function closePopup(popup: Window | null) {
  if (!popup) return;
  try {
    popup.close();
  } catch {
    // ignore
  }
}

export default function LoginButton({
  provider,
  connectionId,
  detectionId,
  enterpriseDomain,
  buttonLabel,
  nodeMajor,
  connection,
  onUpdated,
  showCursorImport = false,
}: {
  provider: string;
  connectionId?: string;
  detectionId?: string;
  enterpriseDomain?: string;
  buttonLabel?: string;
  nodeMajor?: number;
  connection?: ConnectionView;
  onUpdated: () => void | Promise<void>;
  showCursorImport?: boolean;
}) {
  const label = buttonLabel ?? oauthSignInLabel(provider);
  const [status, setStatus] = useState<UiStatus>("idle");
  const [session, setSession] = useState<LoginSession | null>(null);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(connectionId ?? null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<"sign-in" | "import" | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const navigatedRef = useRef(false);
  const sessionEpochRef = useRef(0);
  const pollRequestRef = useRef(0);
  const terminalRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopPolling();
    closePopup(popupRef.current);
  }, [stopPolling]);

  const applySession = useCallback(
    (body: LoginSession, popup: Window | null, epoch = sessionEpochRef.current) => {
      if (epoch !== sessionEpochRef.current) return;
      if (terminalRef.current && body.status === "pending") return;
      setSession(body);
      setStatus(body.status);
      if (body.error?.message) setError(body.error.message);
      const url = body.authUrl ?? body.deviceCode?.verificationUri ?? null;
      if (url) setFallbackUrl(url);
      if (body.deviceCode?.userCode) setUserCode(body.deviceCode.userCode);
      if (url && !navigatedRef.current) {
        navigatePopup(popup, url);
        navigatedRef.current = true;
      }
      if (body.status === "succeeded") {
        terminalRef.current = true;
        stopPolling();
        closePopup(popup);
        setBusy(null);
        void onUpdated();
      }
      if (body.status === "cancelled" || body.status === "failed" || body.status === "interrupted") {
        terminalRef.current = true;
        stopPolling();
        closePopup(popup);
        setBusy(null);
      }
    },
    [onUpdated, stopPolling],
  );

  const pollStatus = useCallback(async (connectionIdOverride?: string, epoch = sessionEpochRef.current) => {
    const id = connectionIdOverride ?? activeConnectionId;
    if (!id) return;
    const request = ++pollRequestRef.current;
    const body = await fetchLogin(id);
    if (request !== pollRequestRef.current || epoch !== sessionEpochRef.current) return;
    applySession(body, popupRef.current, epoch);
  }, [activeConnectionId, applySession]);

  async function beginSession(start: () => Promise<{ connectionId: string; session: LoginSession }>) {
    const epoch = ++sessionEpochRef.current;
    pollRequestRef.current = 0;
    terminalRef.current = false;
    setBusy("sign-in");
    setError(null);
    setImportWarnings([]);
    setPromptValue("");
    setUserCode(null);
    setFallbackUrl(null);
    navigatedRef.current = false;
    const popup = openSignInWindow();
    popupRef.current = popup;
    if (!popup) {
      // popup blocked — fallback link appears once authUrl / verificationUri is known
    }
    try {
      const { connectionId: cid, session: initial } = await start();
      setActiveConnectionId(cid);
      applySession(initial, popup, epoch);
      if (initial.status === "pending") {
        pollRef.current = setInterval(() => {
          void pollStatus(cid, epoch);
        }, 1000);
      } else if (initial.status !== "succeeded") {
        setBusy(null);
      }
    } catch (err) {
      closePopup(popup);
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSignInClick() {
    void beginSession(async () => {
      if (connectionId) {
        const body = await startLogin(connectionId, enterpriseDomain ? { enterpriseDomain } : undefined);
        return { connectionId, session: body };
      }
      const body = await startProviderLogin({
        provider,
        ...(detectionId ? { detectionId } : {}),
        ...(enterpriseDomain ? { enterpriseDomain } : {}),
      });
      return body;
    });
  }

  async function handleCancel() {
    const id = activeConnectionId;
    if (!id) return;
    try {
      await cancelLogin(id);
      await pollStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImport() {
    if (!connectionId) return;
    setBusy("import");
    setError(null);
    setImportWarnings([]);
    try {
      const body = await startLogin(connectionId, { mode: "import" });
      setImportWarnings(body.warnings ?? []);
      setBusy(null);
      await onUpdated();
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitPromptAnswer() {
    const id = activeConnectionId;
    const prompt = session?.prompt;
    if (!id || !prompt) return;
    try {
      const body = await answerLogin(id, prompt.id, promptValue);
      setPromptValue("");
      applySession(body, popupRef.current);
      if (body.status === "pending" && !pollRef.current) {
        pollRef.current = setInterval(() => {
          void pollStatus();
        }, 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitSelect(optionId: string) {
    const id = activeConnectionId;
    const prompt = session?.prompt;
    if (!id || !prompt) return;
    try {
      const body = await answerLogin(id, prompt.id, optionId);
      applySession(body, popupRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const signedInLine = connection ? providerSignInStatusLine(connection) : null;
  const nodeWarning = provider === "cursor" && nodeMajor !== undefined ? cursorNeedsNode24(nodeMajor) : false;
  const prompt = session?.prompt;

  return (
    <div className="rb-login-button">
      <div className="rb-form-actions">
        <button className="btn" type="button" disabled={busy !== null} onClick={handleSignInClick}>
          {busy === "sign-in" ? "Starting…" : label}
        </button>
        {showCursorImport && connectionId && (
          <button className="btn" type="button" disabled={busy !== null} onClick={() => void handleImport()}>
            {busy === "import" ? "Importing…" : CURSOR_AUTH_BUTTONS.import}
          </button>
        )}
        {status === "pending" && activeConnectionId && (
          <button className="btn" type="button" onClick={() => void handleCancel()}>
            Cancel
          </button>
        )}
      </div>
      {nodeWarning && <p className="rb-hint">{CURSOR_AUTH_BUTTONS.nodeWarning}</p>}
      {userCode && (
        <p className="rb-hint rb-device-code">
          Device code: <code>{userCode}</code>{" "}
          <button
            type="button"
            className="small-link"
            onClick={() => void navigator.clipboard.writeText(userCode)}
          >
            Copy
          </button>
        </p>
      )}
      {fallbackUrl && (
        <p className="rb-hint">
          <a href={fallbackUrl} target="_blank" rel="noreferrer">
            Open sign-in page
          </a>
        </p>
      )}
      {prompt?.type === "manual_code" && (
        <div className="rb-field">
          <label htmlFor={`login-prompt-${prompt.id}`}>{prompt.message}</label>
          <input
            id={`login-prompt-${prompt.id}`}
            className="control"
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
          />
          <button type="button" className="btn" onClick={() => void submitPromptAnswer()}>
            Submit code
          </button>
        </div>
      )}
      {prompt?.type === "text" && (
        <div className="rb-field">
          <label htmlFor={`login-prompt-${prompt.id}`}>{prompt.message}</label>
          <input
            id={`login-prompt-${prompt.id}`}
            className="control"
            placeholder={prompt.placeholder}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitPromptAnswer();
            }}
          />
          <button type="button" className="btn" onClick={() => void submitPromptAnswer()}>
            Submit
          </button>
        </div>
      )}
      {prompt?.type === "select" && prompt.options && (
        <div className="rb-field">
          <p className="rb-hint">{prompt.message}</p>
          <div className="rb-form-actions">
            {prompt.options.map((opt) => (
              <button key={opt.id} type="button" className="btn" onClick={() => void submitSelect(opt.id)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {status !== "idle" && (
        <p className="rb-form-status" aria-live="polite">
          Sign-in status: {status}
          {status === "interrupted" && " — sign-in interrupted, try again"}
        </p>
      )}
      {signedInLine && <p className="rb-form-status">{signedInLine}</p>}
      {importWarnings.map((warning) => (
        <p key={warning} className="rb-form-status">
          {warning}
        </p>
      ))}
      {error && <p className="rb-form-status crit">{error}</p>}
    </div>
  );
}
