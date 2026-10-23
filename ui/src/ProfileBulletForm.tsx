import FormSaveBar from "./components/FormSaveBar";
import { useState } from "react";
import type { ProfileBullet, ProfileEditableSectionId } from "../shared/types";
import { bulletKey, sectionLabel, type DraftKey } from "./profile";
import Stamp from "./Stamp";
import "./surfaces.css";

const MAX_BULLET_LENGTH = 512;

export interface ParsedRow {
  label: string;
  value: string | null;
}

export function bulletIssue(value: string): string | null {
  if (/[\n\r]/.test(value)) return "A bullet is one line of markdown — remove the line break.";
  if (value.length > MAX_BULLET_LENGTH) {
    return `${value.length} characters — the limit is ${MAX_BULLET_LENGTH}.`;
  }
  return null;
}

function controlId(id: string, key: string): string {
  return `profile-${id}-${key.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

/** Group identity bullets into logical sections for a two-column desktop layout. */
const IDENTITY_GROUPS: Array<{ title: string; match: (key: string) => boolean }> = [
  {
    title: "Name",
    match: (k) => /name/i.test(k),
  },
  {
    title: "Contact",
    match: (k) => /email|phone/i.test(k),
  },
  {
    title: "Links & portfolio",
    match: (k) => /linkedin|github|portfolio|website|url/i.test(k),
  },
];

function groupBullets(
  id: ProfileEditableSectionId,
  bullets: readonly ProfileBullet[],
): Array<{ title: string | null; items: ProfileBullet[] }> {
  if (id !== "identity") {
    return [{ title: null, items: [...bullets] }];
  }
  const used = new Set<string>();
  const groups: Array<{ title: string | null; items: ProfileBullet[] }> = [];
  for (const g of IDENTITY_GROUPS) {
    const items = bullets.filter((b) => g.match(b.key) && !used.has(b.key));
    items.forEach((b) => used.add(b.key));
    if (items.length > 0) groups.push({ title: g.title, items });
  }
  const rest = bullets.filter((b) => !used.has(b.key));
  if (rest.length > 0) groups.push({ title: "Other", items: rest });
  return groups.length > 0 ? groups : [{ title: null, items: [...bullets] }];
}

function FieldInput({
  id,
  bullet,
  value,
  issue,
  onChange,
}: {
  id: ProfileEditableSectionId;
  bullet: ProfileBullet;
  value: string;
  issue: string | undefined;
  onChange: (key: string, value: string) => void;
}) {
  const domId = controlId(id, bullet.key);
  return (
    <div className="rb-profile-field">
      <label htmlFor={domId}>{bullet.label}</label>
      <input
        id={domId}
        className="control"
        type={/email/i.test(bullet.key) ? "email" : /phone/i.test(bullet.key) ? "tel" : /linkedin|github|portfolio|website|url/i.test(bullet.key) ? "url" : "text"}
        autoComplete={/email/i.test(bullet.key) ? "email" : /phone/i.test(bullet.key) ? "tel" : /first.*name/i.test(bullet.key) ? "given-name" : /last.*name/i.test(bullet.key) ? "family-name" : /full.*name|^name$/i.test(bullet.key) ? "name" : "off"}
        value={value}
        onChange={(e) => onChange(bullet.key, e.target.value)}
        {...(issue ? { "aria-invalid": true as const, "aria-describedby": `${domId}-error` } : {})}
      />
      {issue && (
        <p className="rb-field-error" id={`${domId}-error`}>
          {issue}
        </p>
      )}
    </div>
  );
}

export default function ProfileBulletForm({
  id,
  bullets,
  drafts,
  parsed,
  parsedNote,
  dirty,
  saving,
  error,
  note,
  onChange,
  onSave,
  onAddBullet,
}: {
  id: ProfileEditableSectionId;
  bullets: readonly ProfileBullet[];
  drafts: Record<DraftKey, string>;
  parsed: readonly ParsedRow[];
  parsedNote: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  note: string | null;
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  onAddBullet?: (label: string, value: string) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");

  const valueOf = (b: ProfileBullet): string => {
    const k = bulletKey(id, b.key);
    return Object.prototype.hasOwnProperty.call(drafts, k) ? drafts[k] : (b.value ?? "");
  };

  const issues = new Map<string, string>();
  for (const b of bullets) {
    const issue = bulletIssue(valueOf(b));
    if (issue !== null) issues.set(b.key, issue);
  }
  const blocked = issues.size > 0;
  const groups = groupBullets(id, bullets);
  const readCount = parsed.filter((r) => r.value !== null).length;

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    onSave();
  }


  return (
    <div className="rb-profile-editor">
      <form className="rb-profile-form" noValidate onSubmit={handleSubmit}>
        <header className="rb-profile-form-head">
          <h2 className="rb-h-major">{sectionLabel(id)}</h2>
          <p className="rb-profile-lead">
            {id === "identity"
              ? "How the agent signs forms and creates ATS accounts."
              : "What the gatherer looks for when scoring new postings."}
          </p>
        </header>

        {bullets.length === 0 ? (
          <div className="rb-empty state">
            <span className="glyph" aria-hidden="true">∅</span>
            <p>
              The <span className="mono">{sectionLabel(id)}</span> heading exists but has no editable bullets yet.
            </p>
            {onAddBullet ? (
              <div className="rb-profile-grid">
                <div className="rb-profile-field">
                  <label htmlFor={`${id}-new-label`}>Bullet label</label>
                  <input
                    id={`${id}-new-label`}
                    className="control"
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                </div>
                <div className="rb-profile-field">
                  <label htmlFor={`${id}-new-value`}>Value</label>
                  <input
                    id={`${id}-new-value`}
                    className="control"
                    type="text"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!newLabel.trim() || saving}
                  onClick={() => {
                    onAddBullet(newLabel.trim(), newValue);
                    setNewLabel("");
                    setNewValue("");
                  }}
                >
                  Add bullet
                </button>
              </div>
            ) : (
              <p>Add bullets in profile.md and they will appear here.</p>
            )}
          </div>
        ) : (
          <div className="rb-profile-fields">
            {groups.map((group) => (
              <fieldset key={group.title ?? "all"} className="rb-profile-group">
                {group.title && <legend>{group.title}</legend>}
                <div className="rb-profile-grid">
                  {group.items.map((b) => (
                    <FieldInput
                      key={b.key}
                      id={id}
                      bullet={b}
                      value={valueOf(b)}
                      issue={issues.get(b.key)}
                      onChange={onChange}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}

        {bullets.length > 0 && (
          <FormSaveBar dirty={dirty} saving={saving} disabled={blocked} error={error || (blocked ? "Fix the marked field before saving." : null)} saved={note === "Saved."} label={`Save ${sectionLabel(id)}`} />
        )}
      </form>

      <aside className="rb-profile-aside">
        <button
          type="button"
          className="rb-preview-toggle"
          aria-expanded={previewOpen}
          onClick={() => setPreviewOpen((v) => !v)}
        >
          <span>Agent preview</span>
          <span className="rb-preview-count">
            {readCount}/{parsed.length} fields read
          </span>
        </button>

        {previewOpen && (
          <div className="rb-preview-panel">
            <ul className="rb-preview-list">
              {parsed.map((row) => (
                <li key={row.label} className={row.value !== null ? "read" : "skipped"}>
                  <span className="rb-preview-label">{row.label}</span>
                  {row.value !== null ? (
                    <span className="rb-preview-value">
                      <Stamp tone="good">read</Stamp> {row.value}
                    </span>
                  ) : (
                    <span className="rb-preview-value muted">
                      <Stamp tone="warn">skipped</Stamp> nothing usable
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="rb-preview-note">{parsedNote}</p>
          </div>
        )}

        <details className="rb-tech-details">
          <summary>How parsing works</summary>
          <p>
            Values are stored in profile.md exactly as you type them. The parser may ignore placeholders,
            italic asides, or bullets it has no field for — those stay in the file but are not passed to the agent.
          </p>
          <p>
            Only changed bullets are sent when you save; other sections of profile.md are left untouched.
          </p>
        </details>
      </aside>
    </div>
  );
}
