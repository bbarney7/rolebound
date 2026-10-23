import { useEffect, useState } from "react";
import type { CaptchaProviderChoice, CaptchaSettingsPayload, CaptchaTestResponse } from "../shared/types";
import {
  fetchCaptchaSettings,
  fetchConnections,
  hcaptchaNote,
  keyStatusLine,
  testCaptchaKey,
  updateCaptchaSettings,
  type CaptchaRequestError,
} from "./settings";
import AISettings from "./AISettings";
import FormSaveBar from "./components/FormSaveBar";
import { useUnsavedChanges, useWorkspaceState } from "./WorkspaceDrafts";
import { ApplicationsSettingsSection } from "./ApplicationsSettingsSection";
import { fetchReadiness } from "./settings";
import type { ReadinessPayload } from "../shared/types";
import "./surfaces.css";

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="rb-field-error field-error" id={id}>
      {message}
    </p>
  );
}

function invalidProps(
  id: string,
  message: string | undefined,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return message ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
}

export default function Settings() {
  const [connections, setConnections] = useState<Awaited<ReturnType<typeof fetchConnections>> | null>(null);
  const [connError, setConnError] = useState<string | null>(null);

  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [payload, setPayload] = useState<CaptchaSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captchaDraft, setCaptchaDraft] = useWorkspaceState("captcha-options", { provider: "off" as CaptchaProviderChoice, cap: 20, baselineProvider: "off" as CaptchaProviderChoice, baselineCap: 20 });
  const captchaProvider = captchaDraft.provider;
  const maxPaidTasksPerDay = captchaDraft.cap;
  const setCaptchaProvider = (provider: CaptchaProviderChoice) => { setNote(null); setCaptchaDraft(old => ({...old,provider})); };
  const setMaxPaidTasksPerDay = (cap: number) => { setNote(null); setCaptchaDraft(old => ({...old,cap})); };
  const [captchaKey, setCaptchaKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function reloadConnections() {
    try {
      const next = await fetchConnections();
      setConnections(next);
      setConnError(null);
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reloadCaptcha() {
    try {
      const next = await fetchCaptchaSettings();
      setPayload(next);
      setCaptchaDraft(old => ({
        provider: old.provider !== old.baselineProvider ? old.provider : next.provider,
        cap: old.cap !== old.baselineCap ? old.cap : next.maxPaidTasksPerDay,
        baselineProvider: next.provider, baselineCap: next.maxPaidTasksPerDay,
      }));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reloadReadiness() {
    try {
      setReadiness(await fetchReadiness());
    } catch {
      setReadiness(null);
    }
  }

  useEffect(() => {
    void reloadConnections();
    void reloadCaptcha();
    void reloadReadiness();
  }, []);

  function applyUpdateError(err: unknown) {
    const reqErr = err as CaptchaRequestError;
    if (typeof reqErr.field === "string") setFieldErrors({ [reqErr.field]: reqErr.message });
    else setError(err instanceof Error ? err.message : String(err));
  }

  async function handleCaptchaSave(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedKey = captchaKey;
    setBusy("save");
    setError(null);
    setNote(null);
    setFieldErrors({});
    try {
      const trimmed = captchaKey.trim();
      const next = await updateCaptchaSettings({
        provider: captchaProvider,
        maxPaidTasksPerDay,
        ...(trimmed === "" ? {} : { apiKey: trimmed }),
      });
      setPayload(next);
      setCaptchaDraft(old => ({...old,baselineProvider:next.provider,baselineCap:next.maxPaidTasksPerDay}));
      setCaptchaKey(current => current === submittedKey ? "" : current);
      setNote("Saved.");
    } catch (err) {
      applyUpdateError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy("remove");
    setError(null);
    setNote(null);
    setFieldErrors({});
    try {
      const next = await updateCaptchaSettings({ provider: captchaProvider, apiKey: null });
      setPayload(next);
      setCaptchaDraft(old => ({...old,baselineProvider:next.provider,baselineCap:next.maxPaidTasksPerDay}));
      setCaptchaKey("");
      setNote("Key removed.");
    } catch (err) {
      applyUpdateError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setError(null);
    setNote(null);
    setFieldErrors({});
    try {
      const trimmed = captchaKey.trim();
      const result: CaptchaTestResponse =
        trimmed !== "" && captchaProvider !== "off"
          ? await testCaptchaKey({ provider: captchaProvider, apiKey: trimmed })
          : await testCaptchaKey({});
      if (result.ok) setNote(`Key works — balance $${result.balance.toFixed(2)}.`);
      else setError(`Key rejected: ${result.error}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const captchaDirty = !!payload && (captchaProvider !== payload.provider || maxPaidTasksPerDay !== payload.maxPaidTasksPerDay || captchaKey.trim() !== "");
  useUnsavedChanges("captcha-options", captchaDraft.provider !== captchaDraft.baselineProvider || captchaDraft.cap !== captchaDraft.baselineCap);
  useUnsavedChanges("captcha-key", captchaKey.trim() !== "", false);

  if (loadError) {
    return (
      <div className="rb-surface rb-empty state crit">
        <span className="glyph" aria-hidden="true">!</span>
        <p>{`Settings error: ${loadError}`}</p>
      </div>
    );
  }

  const hcaptcha = payload ? hcaptchaNote(payload, captchaProvider) : null;
  const canTest = payload && busy === null && (captchaKey.trim() !== "" ? captchaProvider !== "off" : payload.hasApiKey);

  return (
    <div className="rb-surface rb-settings-stack">
      <section className="rb-settings-section" aria-labelledby="settings-models-heading">
        <header className="rb-settings-section-head">
          <h2 id="settings-models-heading" className="rb-h-major">AI account &amp; model</h2>
          <p>Used for conversations and job search. Changes apply to the next run.</p>
        </header>

        {!connections ? <p className="rb-form-status">{connError ?? "Loading connections…"}</p> : <AISettings connections={connections} nodeMajor={readiness?.serverRuntime.nodeMajor ?? 24} onUpdated={async () => { await reloadConnections(); await reloadReadiness(); }} />}

      </section>

      <section className="rb-settings-section"><h2 className="rb-h-major">Site logins</h2><p className="rb-hint">Manage saved accounts used to sign in to application sites.</p><a href="/settings/accounts">Manage site logins →</a></section>

      <ApplicationsSettingsSection
        acknowledgement={readiness?.acknowledgement ?? null}
        captchaProvider={captchaProvider}
        captchaDailyPaidTasksCount={payload?.dailyPaidTasksCount ?? null}
      />

      {payload && (
        <section className="rb-settings-section" aria-labelledby="settings-captcha-heading">
          <header className="rb-settings-section-head">
            <h2 id="settings-captcha-heading" className="rb-h-major">CAPTCHA solver</h2>
            <p>
              Off by default. When enabled, each paid provider task bills your account. At most two paid tasks per
              application (persisted) and a rolling 24-hour workspace cap below.
              {payload.dailyPaidTasksCount != null
                ? ` Used in the last 24 hours: ${payload.dailyPaidTasksCount} of ${payload.maxPaidTasksPerDay}.`
                : ""}
            </p>
          </header>
          <form className="rb-settings-form" onSubmit={handleCaptchaSave}>
            <div className="rb-settings-grid">
              <div className="rb-profile-field">
                <label htmlFor="captcha-provider">Provider</label>
                <select
                  id="captcha-provider"
                  className="control"
                  value={captchaProvider}
                  onChange={(e) => setCaptchaProvider(e.target.value as CaptchaProviderChoice)}
                  {...invalidProps("captcha-provider", fieldErrors.provider)}
                >
                  <option value="off">Off</option>
                  {payload.providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <FieldError id="captcha-provider-error" message={fieldErrors.provider} />
              </div>
              {hcaptcha && <p className="rb-field-error rb-settings-span2">{hcaptcha}</p>}
              <div className="rb-profile-field">
                <label htmlFor="captcha-daily-cap">Daily paid-task cap</label>
                <input
                  id="captcha-daily-cap"
                  className="control"
                  type="number"
                  min={1}
                  max={200}
                  value={maxPaidTasksPerDay}
                  onChange={(e) => setMaxPaidTasksPerDay(Number(e.target.value))}
                  {...invalidProps("captcha-daily-cap", fieldErrors.maxPaidTasksPerDay)}
                />
                <FieldError id="captcha-daily-cap-error" message={fieldErrors.maxPaidTasksPerDay} />
                <p className="rb-hint">Rolling 24-hour limit across all applications (1–200).</p>
              </div>
              <div className="rb-profile-field rb-settings-span2">
                <label htmlFor="captcha-key">API key</label>
                <input
                  id="captcha-key"
                  className="control"
                  type="password"
                  autoComplete="off"
                  value={captchaKey}
                  placeholder={payload.hasApiKey ? "leave blank to keep the stored key" : "paste your key"}
                  onChange={(e) => { setCaptchaKey(e.target.value); setNote(null); }}
                  {...invalidProps("captcha-key", fieldErrors.apiKey)}
                />
                <FieldError id="captcha-key-error" message={fieldErrors.apiKey} />
                <p className="rb-hint">{keyStatusLine(payload)}</p>
              </div>
            </div>
            {payload.warnings.map((w) => (
              <p key={w} className="rb-field-error">{w}</p>
            ))}
            <div className="rb-form-actions">
              <button type="button" className="btn" disabled={!canTest} onClick={handleTest}>
                {busy === "test" ? "Testing…" : "Test key"}
              </button>
              {payload.fileHasKey && (
                <button type="button" className="btn" disabled={busy !== null} onClick={handleRemove}>
                  {busy === "remove" ? "Removing…" : "Remove key"}
                </button>
              )}
            </div>
            <FormSaveBar dirty={captchaDirty} saving={busy === "save"} disabled={busy !== null} error={error} saved={note === "Saved."} label="Save CAPTCHA settings" />
            {note && note !== "Saved." && <p className="rb-form-status" role="status">{note}</p>}
          </form>
        </section>
      )}
    </div>
  );
}
