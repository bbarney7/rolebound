import { useRef, useState } from "react";
import type { ProfileResumeView, ResumesPayload } from "../shared/types";
import { resumeFileUsageSentence, resumeRegionRuleSentence } from "./profile";
import "./profileResumes.css";
import "./surfaces.css";

function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb < 0.1 ? "< 0.1 KB" : `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function overrideFileName(resume: ProfileResumeView | null): string | null {
  if (!resume?.overrideResolved) return null;
  const parts = resume.overrideResolved.split(/[/\\]/);
  return parts[parts.length - 1] || resume.overridePath;
}

export default function ProfileResumes({
  resumes,
  resume,
  hasRegionRules,
  onUploaded,
  onAssign,
  regionMarkdown,
  regionDirty,
  onRegionChange,
  onRegionSave,
  regionSaving,
}: {
  resumes: ResumesPayload | null;
  resume: ProfileResumeView | null;
  hasRegionRules: boolean;
  onUploaded?: (file: File, replace?: boolean) => Promise<void>;
  onAssign: (filename: string, mode: "default" | "override", replace?: boolean) => Promise<void>;
  regionMarkdown: string;
  regionDirty: boolean;
  onRegionChange: (value: string) => void;
  onRegionSave: () => void;
  regionSaving: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (resumes === null) {
    return (
      <div className="state">
        <p>Loading…</p>
      </div>
    );
  }

  const regionRules = resume?.regionRules ?? [];
  const gapKeys = new Set(resumes.ruleGaps.map((g) => g.key));
  const gapCount = resumes.ruleGaps.length;
  const advancedSummary =
    gapCount > 0
      ? `Location-specific resumes (advanced) — ${gapCount} location${gapCount === 1 ? "" : "s"} ${gapCount === 1 ? "has" : "have"} no resume yet`
      : "Location-specific resumes (advanced)";

  async function handleUploadChange(
    e: React.ChangeEvent<HTMLInputElement>,
    payload: ResumesPayload,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    const exists = payload.files.some((item) => item.name === file.name);
    if (exists && !window.confirm(`${file.name} already exists. Replace it?`)) {
      e.target.value = "";
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      await onUploaded?.(file, exists);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  const overrideName = overrideFileName(resume);

  return (
    <div className="rb-surface rb-workspace rb-profile-resumes">
      <div className="rb-resumes-header">
        <h2 className="rb-h-major">Your resumes</h2>
        {onUploaded && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => void handleUploadChange(e, resumes)}
            />
            <button
              type="button"
              className="btn primary"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload PDF"}
            </button>
          </>
        )}
      </div>

      {uploadError && <p className="note crit" style={{ margin: "0 var(--space-inset)" }}>{uploadError}</p>}

      {!resumes.directoryExists ? (
        <div className="state">
          <span className="glyph" aria-hidden="true">∅</span>
          <p>No resume folder yet. Upload a PDF to get started.</p>
          <p>Rolebound needs a default resume before it can attach one to applications.</p>
        </div>
      ) : resumes.files.length === 0 ? (
        <div className="state">
          <span className="glyph" aria-hidden="true">∅</span>
          <p>No resumes uploaded yet.</p>
        </div>
      ) : (
        <ul className="rb-resume-file-list">
          {resumes.files.map((f) => (
            <li key={f.name} className="rb-resume-file-row">
              <div className="rb-resume-file-name" title={f.name}>
                {f.name}
                {f.reachability === "default" && (
                  <span className="rb-resume-default-label">Default</span>
                )}
              </div>
              <div className="rb-resume-file-meta">
                <span>{formatDateShort(f.modifiedAt)}</span>
                <span>{formatBytes(f.bytes)}</span>
              </div>
              <p className="rb-resume-file-note">{resumeFileUsageSentence(f, regionRules)}</p>
              <div className="rb-resume-file-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void onAssign(f.name, "override")}
                >
                  Use for all jobs
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void onAssign(
                      f.name,
                      "default",
                      resumes.files.some((x) => x.name === "default.pdf") &&
                        window.confirm("Replace default.pdf?"),
                    )
                  }
                >
                  Make default
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="rb-advanced rb-resumes-advanced">
        <summary>{advancedSummary}</summary>

        {resume !== null && (
          <div>
            <h3 className="rb-h-minor">One resume for every job</h3>
            {resumes.overrideActive ? (
              <>
                <p className="note">
                  Every application uses {overrideName ?? "the file you chose"} until you turn this
                  off. Other PDFs here are ignored while this is on.
                </p>
                {resumes.overrideExists === false && (
                  <p className="note crit">
                    That file is missing. Rolebound will not attach a resume until you upload it or
                    clear this setting.
                  </p>
                )}
              </>
            ) : (
              <p className="note">
                Rolebound picks a resume from this list using the job&apos;s location. When nothing
                else matches, it uses default.pdf.
              </p>
            )}
          </div>
        )}

        <div>
          <h3 className="rb-h-minor">Location rules</h3>
          {!hasRegionRules ? (
            <p className="note">
              You have not set up location-specific resumes. Every application uses default.pdf.
            </p>
          ) : regionRules.length === 0 ? (
            <p className="note">
              Your location rules are empty or incomplete. Every application uses default.pdf until
              you add valid rows.
            </p>
          ) : (
            <ul className="rb-resume-region-rules">
              {regionRules.map((rule) => (
                <li key={rule.key}>
                  {resumeRegionRuleSentence(rule, !gapKeys.has(rule.key))}
                </li>
              ))}
            </ul>
          )}
          {gapCount > 0 && (
            <p className="note">
              When a location has no matching file, Rolebound falls back to default.pdf without
              asking you.
            </p>
          )}
        </div>

        <form
          className="rb-profile-form rb-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            onRegionSave();
          }}
        >
          <div className="field">
            <label htmlFor="resume-region-rules">Edit location rules</label>
            <textarea
              id="resume-region-rules"
              className="control tall wide"
              value={regionMarkdown}
              onChange={(e) => onRegionChange(e.target.value)}
            />
          </div>
          <button className="btn primary" type="submit" disabled={!regionDirty || regionSaving}>
            {regionSaving ? "Saving…" : "Save location rules"}
          </button>
        </form>
      </details>
    </div>
  );
}
