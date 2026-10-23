import { useState } from "react";
import {
  PIPELINE_STATUSES,
  type Application,
  type ApplicationDetailPayload,
  type Attempt,
  type MailingAddress,
  type PipelineStatus,
} from "../shared/types";
import { updateApplicationPipeline } from "./api";
import Stamp, { applyStateTone, humanize, isApplyState } from "./Stamp";
import "./surfaces.css";

const BODY_PREVIEW_LIMIT = 1200;

/**
 * addressUsed is truthy-but-empty for at least one live row
 * (postscript-…: {"street":"","city":"","state":"","zip":""}), because
 * normalizeStateApplication:79-86 builds an object whenever the `address` key
 * exists and coalesces every missing field to "". Guard on content, not truth.
 */
function hasAddress(a: MailingAddress | null): boolean {
  if (!a) return false;
  return Boolean(a.street.trim() || a.city.trim() || a.state.trim() || a.zip.trim());
}

/**
 * attempts[].startedAt/endedAt bypass toIsoOrNull (stateJson.ts:87-92) and stay
 * at second precision, so they must be parsed, never string-compared. One live
 * row (upstart-… attempt 2) has ended_at 3s BEFORE started_at — return null
 * rather than render a negative duration. startedAt can also legally be "".
 */
function attemptDuration(a: Attempt): string | null {
  if (!a.startedAt || !a.endedAt) return null;
  const start = Date.parse(a.startedAt);
  const end = Date.parse(a.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 0) return null;
  return `${seconds}s`;
}

/** 51% of applications are on shared hosts that need no account at all (39/77, 2026-08-03). */
function accountEmptyMessage(app: Application): string {
  const source = app.source?.toLowerCase() ?? "";
  if (source === "ashby" || source === "greenhouse") {
    return "No ATS account was needed — this posting is on a shared host that requires no login.";
  }
  return "No ATS account matched this posting.";
}

export default function ApplicationDetail({
  detail,
  onBack,
  onSaved,
}: {
  detail: ApplicationDetailPayload;
  onBack: () => void;
  onSaved: (next: ApplicationDetailPayload) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showFullBody, setShowFullBody] = useState(false);

  const app = detail.application;
  const account = detail.atsAccount;
  const body = detail.body ?? "";
  const truncated = body.length > BODY_PREVIEW_LIMIT && !showFullBody;

  function handleStatusChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const raw = event.target.value;
    // JSON has no undefined, so explicit null is the only way to express
    // "clear" over the wire; the server maps null to `delete`.
    const next: PipelineStatus | null = raw === "" ? null : (raw as PipelineStatus);
    setSaving(true);
    setSaveError(null);
    updateApplicationPipeline(app.slug, { pipelineStatus: next })
      .then((updated) => {
        onSaved(updated);
        setSaving(false);
      })
      .catch((e) => {
        setSaveError(String(e));
        setSaving(false);
      });
  }

  return (
    <div className="rb-surface">
      <div className="rb-detail-crumb crumb">
        Applications / <b>{app.slug}</b>
      </div>
      <header className="rb-detail-header topbar">
        <div className="rb-detail-title title-block">
          <h1 className="rb-h-detail">{app.title ?? "—"}</h1>
          <p className="rb-record-sub" style={{ margin: "0.25rem 0 0" }}>{app.company ?? app.slug}</p>
          <div className="rb-detail-status-row meta">
            <Stamp tone={applyStateTone(app.applyState)}>Execution: {humanize(app.applyState)}</Stamp>
            {app.pipelineStatus ? <Stamp tone="accent">Hiring: {humanize(app.pipelineStatus)}</Stamp> : <span className="note">Hiring stage not set</span>}
            {app.estimated && <Stamp tone="warn">estimated record</Stamp>}
            <span>{app.location ?? "—"}</span>
          </div>
        </div>
        <button type="button" className="btn" onClick={onBack}>
          ← All applications
        </button>
      </header>

      <div className="rb-detail-grid detail">
        <div className="col">
          <div className="rb-section section">
            <h2 className="rb-h-major">Hiring pipeline stage</h2>
            <p className="note">Separate from execution outcome. Changing this does not mark an application submitted.</p>
            <div>
              <select className="control" value={app.pipelineStatus ?? ""} disabled={saving} onChange={handleStatusChange}>
                <option value="">— not set —</option>
                {PIPELINE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <p className={saveError ? "note crit" : "note"}>
              {saveError
                ? `Save failed: ${saveError}`
                : saving
                  ? "saving…"
                  : app.pipelineExplicit
                    ? `set by you${detail.pipelineUpdatedAt ? ` on ${detail.pipelineUpdatedAt}` : ""}`
                    : "derived from apply state — not set by you"}
            </p>
          </div>

          <div className="rb-section section">
            <h2 className="rb-h-major">Receipt evidence</h2>
            {app.screenshot ? (
              <p className="note">
                <img className="rb-evidence-shot evidence-shot" src={`/api/applications/${encodeURIComponent(app.slug)}/screenshot`} alt={`Submission confirmation for ${app.company ?? app.slug}`} />
              </p>
            ) : app.applyState === "submitted" ? (
              <p className="note warn">Submitted without a saved screenshot — outcome is inferred from agent notes, not visual receipt.</p>
            ) : (
              <p className="note">No confirmation screenshot is on file for this application.</p>
            )}
          </div>

          <div className="section">
            <h2 className="rb-h-major">What was submitted</h2>
            <dl>
              <dt>Resume</dt>
              <dd>
                {app.resumePath ? (
                  <code>{app.resumePath}</code>
                ) : (
                  <span className="note">No resume path was recorded for this application.</span>
                )}
              </dd>
              <dt>Address</dt>
              <dd>
                {hasAddress(app.addressUsed) ? (
                  <>
                    <div>{app.addressUsed!.street}</div>
                    <div>
                      {app.addressUsed!.city}, {app.addressUsed!.state} {app.addressUsed!.zip}
                    </div>
                  </>
                ) : (
                  <span className="note">No address was recorded for this application.</span>
                )}
              </dd>
              <dt>Account</dt>
              <dd>
                {account ? (
                  <>
                    <div>{account.company ?? account.host}</div>
                    <span className="note">
                      {account.host} · {account.ats ?? "unknown ATS"} · {account.username ?? "no username"} ·{" "}
                      {account.hasPassword ? "password on file" : "no password on file"}
                    </span>
                  </>
                ) : (
                  <span className="note">{accountEmptyMessage(app)}</span>
                )}
              </dd>
              <dt>Job URL</dt>
              <dd>
                {app.url ? (
                  <a href={app.url} target="_blank" rel="noreferrer">
                    {app.url}
                  </a>
                ) : (
                  <span className="note">No URL was recorded for this application.</span>
                )}
              </dd>
              <dt>Details</dt>
              <dd>
                <span className="note">
                  {detail.ats ? `ATS: ${detail.ats}` : "ATS: unknown"} ·{" "}
                  {detail.reqId ? `Req ID: ${detail.reqId}` : "Req ID: unknown"} ·{" "}
                  {app.source ? `source: ${app.source}` : "source: unknown"}
                </span>
              </dd>
            </dl>
          </div>

          <div className="section">
            <h2 className="rb-h-major">Attempts</h2>
            {app.attempts.length === 0 ? (
              <p className="note">
                No attempt log exists for this application — it predates run tracking, so the answers
                supplied were never recorded.
              </p>
            ) : (
              <div className="timeline">
                {app.attempts.map((a, i) => (
                  <div key={i} className="tl">
                    <span className={a.outcome === "submitted" ? "pt done" : "pt"} aria-hidden="true" />
                    <div>
                      <div className="tl-line">
                        <span>attempt {i + 1}</span>
                        {isApplyState(a.outcome) ? (
                          <Stamp tone={applyStateTone(a.outcome)}>{humanize(a.outcome)}</Stamp>
                        ) : (
                          <span className="slug">{a.outcome ?? "no outcome"}</span>
                        )}
                      </div>
                      <div className="when">
                        {a.startedAt || "no start time"}
                        {attemptDuration(a) ? ` · ${attemptDuration(a)}` : ""}
                      </div>
                      {a.notes ? <p className="mono block">{a.notes}</p> : <p className="note">No notes recorded.</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col">
          <div className="section">
            <h2 className="rb-h-major">Posting</h2>
            {body ? (
              <>
                {detail.bodySource !== null && detail.bodySource !== "applied" && (
                  <p className="note">
                    From the {detail.bodySource} posting — this application was never submitted, so
                    there is no applied copy.
                  </p>
                )}
                {/* React escapes text children, so a body containing raw scraped
                    HTML renders as literal text — never as markup. Do not switch
                    this to dangerouslySetInnerHTML. */}
                <p className="jd mono block">{truncated ? body.slice(0, BODY_PREVIEW_LIMIT) : body}</p>
                {body.length > BODY_PREVIEW_LIMIT && (
                  <div>
                    <button type="button" className="btn" onClick={() => setShowFullBody(!showFullBody)}>
                      {showFullBody ? "Show less" : `Show all ${body.length} characters`}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="note">
                No jobs/applied/{app.slug}.md or jobs/queue/{app.slug}.md file exists, so no job
                description was saved.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
