import { useRef, useState } from "react";
import type { ProfileResumeView, ResumesPayload } from "../shared/types";
import { reachabilityLabel, reachabilityNote, reachabilityTone } from "./profile";
import Stamp from "./Stamp";
import "./surfaces.css";

/**
 * The resume library shows the exact resolver state and provides upload,
 * default assignment, global override, and region-rule editing controls.
 *
 * What it does deliver is the half of the objective that matters first: which
 * of these files the agent can actually reach. `resolveResumePath`
 * (`.pi/extensions/job-applier.ts:79-89`) is the only code that ever picks a
 * resume, and on real data most of the directory is unreachable — which stays
 * invisible until something says so.
 *
 * `resume` is null when `## Resume` is absent from profile.md. ProfileView has
 * already rendered that section's empty state above this component, so the
 * override card simply does not appear; the files on disk are still worth
 * listing, which is why the tab is not replaced wholesale.
 */

/** Render as UTC, like every other date in this app. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProfileResumes({
  resumes,
  resume,
  hasRegionRules,
  onUploaded,
  onAssign, regionMarkdown, regionDirty, onRegionChange, onRegionSave, regionSaving,
}: {
  resumes: ResumesPayload | null;
  resume: ProfileResumeView | null;
  /** From the raw-text locator: is `### Resume region rules` on disk at all? */
  hasRegionRules: boolean;
  onUploaded?: (file: File, replace?: boolean) => Promise<void>;
  onAssign: (filename: string, mode: "default" | "override", replace?: boolean) => Promise<void>;
  regionMarkdown: string; regionDirty: boolean; onRegionChange: (value: string) => void; onRegionSave: () => void; regionSaving: boolean;
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

  return (
    <div className="rb-surface rb-workspace">
      {resume !== null && (
        <div className="rb-list-panel card">
          <div className="head">
            <h2 className="rb-h-major">Resume path override</h2>
            {resumes.overrideActive ? (
              <Stamp tone="warn">override set</Stamp>
            ) : (
              <Stamp tone="neutral">no override</Stamp>
            )}
          </div>
          {resumes.overrideActive ? (
            <>
              <p className="note count">
                {/*
                  The precedence rule, stated the way the source states it. An
                  override wins for EVERY application, so every other .pdf below
                  is shadowed — but a non-PDF stays an orphan, because
                  `resolveResumePath` only ever builds `resumes/<key>.pdf`
                  (`job-applier.ts:87`). "Everything below is shadowed" would
                  imply that clearing the override brings a .docx into use,
                  which is false.
                */}
                Every application uses this one file while the override is set. Every other{" "}
                <span className="mono">.pdf</span> below is shadowed by it; a file with any other
                extension stays an orphan, because the agent only ever builds{" "}
                <span className="mono">resumes/&lt;key&gt;.pdf</span>.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Declared path</th>
                      <th>Resolves to</th>
                      <th>On disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">{resume.overridePath ?? "—"}</td>
                      <td className="mono">{resume.overrideResolved ?? "—"}</td>
                      <td>
                        {resumes.overrideExists === null ? (
                          <span className="note">—</span>
                        ) : resumes.overrideExists ? (
                          <Stamp tone="good">found</Stamp>
                        ) : (
                          <Stamp tone="crit">missing</Stamp>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {resumes.overrideExists === false && (
                <p className="note count crit">
                  The override names a file that is not there. The agent attaches nothing rather
                  than falling back — the fallback only applies when there is no override at all.
                </p>
              )}
            </>
          ) : (
            <p className="note count">
              No <span className="mono">- **Resume path:**</span> bullet is active under{" "}
              <span className="mono">## Resume</span>, so the agent uses the per-region lookup
              below and falls back to <span className="mono">resumes/default.pdf</span>.
            </p>
          )}
        </div>
      )}

      <div className="rb-list-panel card">
        <div className="rb-list-panel-head head">
          <h2 className="rb-h-major">Files in resumes/</h2>
          {onUploaded && <><input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const exists = resumes.files.some((item) => item.name === file.name); if (exists && !window.confirm(`${file.name} already exists. Replace it?`)) { e.target.value = ""; return; } setUploading(true); setUploadError(null); try { await onUploaded(file, exists); } catch (err) { setUploadError(err instanceof Error ? err.message : String(err)); } finally { setUploading(false); e.target.value = ""; } }} /><button type="button" className="btn primary" disabled={uploading} onClick={() => inputRef.current?.click()}>{uploading ? "Uploading…" : "Upload PDF"}</button></>}
          <p className="note count">
            {resumes.files.length} {resumes.files.length === 1 ? "file" : "files"}
          </p>
        </div>
        {uploadError && <p className="note crit">{uploadError}</p>}
        {!resumes.directoryExists ? (
          <div className="state">
            <span className="glyph" aria-hidden="true">
              ∅
            </span>
            <p>
              There is no <span className="mono">resumes/</span> directory in this workspace.
            </p>
            <p>
              The agent looks for <span className="mono">resumes/default.pdf</span> and attaches
              nothing when it is absent.
            </p>
          </div>
        ) : resumes.files.length === 0 ? (
          <div className="state">
            <span className="glyph" aria-hidden="true">
              ∅
            </span>
            <p>
              The <span className="mono">resumes/</span> directory is empty.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th className="num">Size</th>
                  <th className="num">Modified</th>
                  <th>Reachability</th>
                  <th>What that means</th>
                  <th>Assign</th>
                </tr>
              </thead>
              <tbody>
                {resumes.files.map((f) => (
                  <tr key={f.name}>
                    <td className="mono">{f.name}</td>
                    <td className="num">{formatBytes(f.bytes)}</td>
                    <td className="num">{formatDate(f.modifiedAt)}</td>
                    <td>
                      <Stamp tone={reachabilityTone(f.reachability)}>
                        {reachabilityLabel(f.reachability)}
                      </Stamp>
                    </td>
                    <td className="note">{reachabilityNote(f.reachability)}</td>
                    <td><button type="button" className="btn" onClick={() => void onAssign(f.name, "override")}>Use for all</button><button type="button" className="btn" onClick={() => void onAssign(f.name, "default", resumes.files.some((x) => x.name === "default.pdf") && window.confirm("Replace default.pdf?"))}>Make default</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rb-section section card">
        <div className="rb-section-head head">
          <h2 className="rb-h-major">Region rules</h2>
          {resumes.ruleGaps.length > 0 && (
            <Stamp tone="warn">
              {resumes.ruleGaps.length} missing {resumes.ruleGaps.length === 1 ? "file" : "files"}
            </Stamp>
          )}
        </div>
        {!hasRegionRules ? (
          // The absent-section state names the fallback
          // and offers no "add this section" control (Q3). Inserting the
          // template's table verbatim would add its denver/chicago example rows
          // and change which resume the agent picks, in a ticket that gives no
          // way to edit or remove them. Add is offered exactly where edit is.
          <div className="state">
            <span className="glyph" aria-hidden="true">
              ∅
            </span>
            <p>
              This profile has no <span className="mono">### Resume region rules</span> table.
            </p>
            <p>
              No location maps to a region resume, so every application uses{" "}
              <span className="mono">resumes/default.pdf</span>.
            </p>
          </div>
        ) : regionRules.length === 0 ? (
          <p className="note count">
            The table is on disk but has no usable rows — a row needs a key and at least one match
            term. Every application falls back to <span className="mono">resumes/default.pdf</span>.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Match terms</th>
                  <th>Expected file</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {regionRules.map((rule) => (
                  <tr key={rule.key}>
                    <td className="mono">{rule.key}</td>
                    <td>{rule.terms.join(", ")}</td>
                    <td className="mono">{`resumes/${rule.key}.pdf`}</td>
                    <td>
                      {gapKeys.has(rule.key) ? (
                        <Stamp tone="warn">no file</Stamp>
                      ) : (
                        <Stamp tone="good">on disk</Stamp>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="rb-profile-form rb-settings-form" onSubmit={(e) => { e.preventDefault(); onRegionSave(); }}><div className="field"><label htmlFor="resume-region-rules">Region rules Markdown</label><textarea id="resume-region-rules" className="control tall wide" value={regionMarkdown} onChange={(e) => onRegionChange(e.target.value)} /></div><button className="btn primary" disabled={!regionDirty || regionSaving}>{regionSaving ? "Saving…" : "Save region rules"}</button></form>
        {resumes.ruleGaps.length > 0 && (
          <p className="note count">
            A rule with no file is not an error the agent reports: it falls back to{" "}
            <span className="mono">resumes/default.pdf</span> silently (
            <span className="mono">job-applier.ts:89</span>), so a posting that matched this region
            is applied to with the generic resume.
          </p>
        )}
      </div>

      <p className="note">
        Read-only here. Uploading a resume, setting the override and editing the region rules
        belong to the <span className="mono">resume-library-addresses</span> ticket, which owns the{" "}
        <span className="mono">resumes/</span> directory.
      </p>
    </div>
  );
}
