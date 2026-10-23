import { useCallback, useEffect, useState } from "react";
import type { ConnectionList, ConnectionView, DetectedLogin, ProviderKind } from "../shared/providers";
import { useUnsavedChanges } from "./WorkspaceDrafts";
import { createConnection } from "./settings";
import ProviderKindSelect from "./ProviderKindSelect";
import LoginButton from "./LoginButton";
import { adoptLogin, fetchDetectedLogins } from "./providerSetupApi";
import { oauthSignInLabel } from "./loginUiHelpers";
import "./providerSetup.css";

const PROVIDER_BRANDS: Record<string, { name: string; icon: string }> = {
  cursor: { name: "Cursor", icon: "cursor" },
  anthropic: { name: "Claude Pro/Max", icon: "claude" },
  "openai-codex": { name: "ChatGPT (Codex)", icon: "openai" },
  "openai-chatgpt": { name: "ChatGPT", icon: "openai" },
  "github-copilot": { name: "GitHub Copilot", icon: "github" },
  google: { name: "Google", icon: "google" },
  "google-gemini-cli": { name: "Google", icon: "google" },
  openrouter: { name: "OpenRouter", icon: "openrouter" },
  opencode: { name: "OpenCode", icon: "opencode" },
  "opencode-go": { name: "OpenCode Go", icon: "opencode" },
};

export function ProviderMark({ provider, label }: { provider: string; label: string }) {
  const brand = PROVIDER_BRANDS[provider];
  return <span className="rb-provider-mark" aria-hidden="true">{brand ? <img src={`/brand/providers/${brand.icon}.svg`} alt="" width="24" height="24" /> : label.trim().slice(0,1).toUpperCase()}</span>;
}

function ProviderIdentity({ item }: { item: DetectedLogin }) {
  const brand = PROVIDER_BRANDS[item.provider];
  return <div className="rb-detected-card-main">
    <ProviderMark provider={item.provider} label={item.label} />
    <div className="rb-provider-copy">
      <span className="rb-detected-label">{brand?.name ?? item.label}</span>
      {item.account && <span className="rb-detected-account">{item.account}</span>}
      <span className="rb-detected-meta">{item.provider === "github-copilot" ? "Copilot access checked at sign-in" : formatDetectedMeta(item)}</span>
    </div>
  </div>;
}

const OAUTH_SETUP_PROVIDERS = ["anthropic", "openai-codex", "github-copilot", "cursor"] as const;

function formatDetectedMeta(item: DetectedLogin): string {
  if (item.expiresAt) {
    const expires = new Date(item.expiresAt);
    if (!Number.isNaN(expires.getTime())) {
      const date = expires.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      return item.expired ? `Expired ${date}` : `Expires ${date}`;
    }
  }
  const lastUsed = item.label.match(/last used (.+)$/i);
  if (lastUsed) return `Last used ${lastUsed[1]}`;
  if (item.account) return "Account found on this device";
  return "Last used on this device";
}

function providerAlreadyDetected(detected: DetectedLogin[], provider: string): boolean {
  return detected.some((row) => row.provider === provider);
}

/**
 * The connection a detected login already produced, if any. Mirrors the
 * server's origin match (kind + provider + account) so a card whose "Use this"
 * would only return the same connection shows "Connected" instead of a button
 * that appears to do nothing. Accounts longer than the server's bound are
 * stored hashed, so a long account simply never matches here and the button
 * stays (idempotent on the server anyway).
 */
function connectedFor(connections: ConnectionList, item: DetectedLogin): ConnectionView | undefined {
  const account = item.account?.trim() || undefined;
  return connections.data.connections.find((c) => {
    if (!c.origin || c.origin.kind !== item.kind || c.provider !== item.provider) return false;
    if (!c.credential.configured) return false;
    return account ? c.origin.account === account : !c.origin.account;
  });
}

export default function ProviderSetup({
  connections,
  onUpdated,
  nodeMajor,
  excludeConnected = false,
}: {
  connections: ConnectionList;
  onUpdated: () => Promise<void>;
  nodeMajor: number;
  excludeConnected?: boolean;
}) {
  const [detected, setDetected] = useState<DetectedLogin[]>([]);
  const [loading, setLoading] = useState(true);
  const [adoptErrors, setAdoptErrors] = useState<Record<string,string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copilotEnterprise, setCopilotEnterprise] = useState(false);
  const [enterpriseDomain, setEnterpriseDomain] = useState("");

  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderKind>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pasteSaving, setPasteSaving] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  useUnsavedChanges("provider-key", !!apiKey, false);

  const reloadDetected = useCallback(async () => {
    setLoading(true);
    try {
      setDetected(await fetchDetectedLogins());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void reloadDetected();
  }, [reloadDetected]);

  async function handleAdopt(item: DetectedLogin) {
    setBusyId(item.id);
    setAdoptErrors(old => ({...old,[item.id]:""}));
    try {
      await adoptLogin(item.id);
      await onUpdated();
      await reloadDetected();
    } catch (err) {
      setAdoptErrors(old => ({...old,[item.id]: err instanceof Error ? err.message : String(err)}));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePasteSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasteSaving(true);
    setPasteError(null);
    try {
      await createConnection(
        {
          label,
          provider,
          ...(apiKey ? { apiKey } : {}),
          ...(provider === "openai-compatible" ? { baseUrl, api: "openai-completions" as const } : {}),
        },
        connections.revision,
      );
      setApiKey("");
      setLabel("");
      await onUpdated();
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasteSaving(false);
    }
  }

  const available = detected.filter(item => !excludeConnected || !connectedFor(connections,item));
  const signInProviders = OAUTH_SETUP_PROVIDERS.filter((id) => !providerAlreadyDetected(detected, id) && (!excludeConnected || !connections.data.connections.some(c => c.provider === id && c.credential.configured)));

  return (
    <div className="rb-provider-setup">
      {loading && <p className="rb-provider-loading" role="status">Checking accounts on this device…</p>}
      {!loading && available.length > 0 && (
        <section className="rb-provider-setup-group" aria-labelledby="detected-logins-heading">
          <h3 id="detected-logins-heading" className="rb-h-minor">
            Detected accounts
          </h3>
          <p className="rb-hint">Accounts already signed in on this computer.</p>
          <div className="rb-detected-stack">
            {available.map((item) => {
              const useLabel =
                item.action === "adopt-scoring" ? "Use for scoring" : "Use this";
              const isSignIn = item.action === "sign-in";
              const connected = connectedFor(connections, item);
              return (
                <article key={item.id} className="rb-detected-card">
                  <ProviderIdentity item={item} />
                  {connected ? (
                    <span className="stamp good" role="status">
                      Connected
                    </span>
                  ) : isSignIn ? (
                    <LoginButton
                      provider={item.provider}
                      detectionId={item.id}
                      buttonLabel={useLabel}
                      nodeMajor={nodeMajor}
                      onUpdated={async () => {
                        await onUpdated();
                        await reloadDetected();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busyId !== null}
                      onClick={() => void handleAdopt(item)}
                    >
                      {busyId === item.id ? "Working…" : useLabel}
                    </button>
                  )}
                  {adoptErrors[item.id] && <div className="rb-provider-error" role="alert"><p>Couldn’t connect this account. Try again or sign in.</p><details><summary>Technical details</summary>{adoptErrors[item.id]}</details></div>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {!loading && !loadError && signInProviders.length > 0 && (
        <section className="rb-provider-setup-group" aria-labelledby="sign-in-heading">
          <h3 id="sign-in-heading" className="rb-h-minor">
            Sign in
          </h3>
          <div className="rb-sign-in-grid">
            {signInProviders.map((id) => (
              <div key={id} className="rb-sign-in-cell">
                {id === "cursor" && (
                  <p className="rb-cursor-sign-in-hint">Cursor account · bills to your Cursor plan</p>
                )}
                {id === "github-copilot" && copilotEnterprise ? (
                  <div className="rb-field">
                    <label htmlFor="copilot-enterprise-domain">GitHub Enterprise domain</label>
                    <input
                      id="copilot-enterprise-domain"
                      className="control"
                      value={enterpriseDomain}
                      onChange={(e) => setEnterpriseDomain(e.target.value)}
                      placeholder="github.mycompany.com"
                    />
                    <LoginButton
                      provider={id}
                      enterpriseDomain={enterpriseDomain}
                      buttonLabel={oauthSignInLabel(id)}
                      onUpdated={async () => {
                        await onUpdated();
                        await reloadDetected();
                      }}
                    />
                  </div>
                ) : (
                  <LoginButton
                    provider={id}
                    buttonLabel={oauthSignInLabel(id)}
                    nodeMajor={id === "cursor" ? nodeMajor : undefined}
                    onUpdated={async () => {
                      await onUpdated();
                      await reloadDetected();
                    }}
                  />
                )}
                {id === "github-copilot" && !copilotEnterprise && (
                  <button
                    type="button"
                    className="small-link rb-enterprise-link"
                    onClick={() => setCopilotEnterprise(true)}
                  >
                    GitHub Enterprise…
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="rb-paste-key">
        <summary>Paste a key instead</summary>
        <form className="rb-settings-form" onSubmit={handlePasteSubmit}>
          <div className="rb-settings-grid">
            <div className="rb-profile-field">
              <label htmlFor="paste-label">Label</label>
              <input id="paste-label" className="control" required value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="rb-profile-field">
              <label htmlFor="paste-provider">Provider</label>
              <ProviderKindSelect id="paste-provider" only="apiKey" value={provider} onChange={setProvider} />
            </div>
            {provider === "openai-compatible" && (
              <div className="rb-profile-field rb-settings-span2">
                <label htmlFor="paste-base">Base URL</label>
                <input
                  id="paste-base"
                  className="control"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                />
              </div>
            )}
            <div className="rb-profile-field rb-settings-span2">
              <label htmlFor="paste-key">API key</label>
              <input
                id="paste-key"
                type="password"
                autoComplete="off"
                className="control"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          </div>
          <div className="rb-form-actions">
            <button className="btn primary" disabled={pasteSaving}>
              {pasteSaving ? "Saving…" : "Save connection"}
            </button>
          </div>
          {pasteError && <p className="rb-form-status crit">{pasteError}</p>}
        </form>
      </details>

      {loadError && <div role="alert"><p>Couldn’t check accounts on this device.</p><button className="btn" type="button" onClick={() => void reloadDetected()}>Try again</button><details><summary>Technical details</summary>{loadError}</details></div>}
    </div>
  );
}
