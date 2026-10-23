import { useEffect, useState } from "react";
import {
  ATS_KINDS,
  LOGIN_STATUSES,
  type AccountDetailPayload,
  type AccountUpdateBody,
  type ATSAccount,
  type AtsKind,
  type LoginStatus,
} from "../shared/types";
import {
  accountUrl,
  deleteAccount,
  loginStatusLabel,
  loginStatusTone,
  revealPassword,
  updateAccount,
  type AccountRequestError,
} from "./accounts";
import Stamp, { applyStateTone, humanize } from "./Stamp";
import "./surfaces.css";

/** How long a revealed password stays on screen before it re-masks itself. */
const REVEAL_MS = 30_000;

const MASK = "••••••••••";

/** Render as UTC, like every other date in this app. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

/** Never render a blank cell: an absent value says so in words. */
function Value({ value, absent }: { value: string | null; absent: string }) {
  return value ? <>{value}</> : <span className="note">{absent}</span>;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id}>
      {message}
    </p>
  );
}

/** `aria-invalid` + `aria-describedby` on a control the server named in a 400. */
function invalidProps(
  id: string,
  message: string | undefined,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return message ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
}

function formFrom(account: ATSAccount) {
  return {
    username: account.username ?? "",
    emailUsed: account.emailUsed ?? "",
    company: account.company ?? "",
    ats: account.ats ?? "",
    lastLoginStatus: account.lastLoginStatus ?? "",
    notes: account.notes ?? "",
    /** Always starts blank: the stored value is never loaded into a form field. */
    password: "",
  };
}

/**
 * A text field's contribution to the PATCH body: `undefined` when it is
 * unchanged (absent means untouched), `null` when the user emptied it (the
 * route deletes the key), otherwise the trimmed value.
 *
 * THE EDIT CHECK RUNS FIRST, AND THE ORDER IS THE WHOLE POINT. This used to
 * normalize — trim, then blank→null — and compare the NORMALIZED value to the
 * loaded one, which made the normalization itself look like an edit and put a
 * field the user never touched into the PATCH body. Two real cases: a stored
 * `company: " Acme "` was silently rewritten to "Acme", and a stored
 * `email_used: ""` was silently DELETED, both by someone who only edited notes.
 * The reader passes both values through verbatim (readers/credentials.ts:163),
 * so both do reach this form.
 *
 * Comparing the RAW input against `loaded ?? ""` — exactly what `formFrom`
 * seeded the field with — means an untouched field is always `undefined`, and
 * normalization only ever applies to a field the user actually changed.
 */
export function textUpdate(loaded: string | null, input: string): string | null | undefined {
  if (input === (loaded ?? "")) return undefined;
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The same, for the two enum selects — and it can only ever produce a known
 * member or `null`.
 *
 * An account can legitimately arrive with `ats: "greenhouse-eu"` or
 * `lastLoginStatus: "expired"`: both are `string | null` on disk and the reader
 * surfaces whatever a hand-edited file holds. Such a value is rendered as its
 * own option below and is returned as `undefined` here while it is untouched,
 * so the file keeps it verbatim. The user can keep it or replace it with a known
 * member; the UI is deliberately not a route for minting new ones, and the route
 * would refuse one anyway.
 */
export function enumUpdate<T extends string>(
  loaded: string | null,
  input: string,
  allowed: readonly T[],
): T | null | undefined {
  // The edit check runs first, for the same reason it does in `textUpdate`
  // above, and against the same value `formFrom` seeded the select with. This
  // used to normalize (`"" → null`) and compare the NORMALIZED value to the
  // loaded one, so a stored `ats: ""` — which a hand edit can leave and which
  // `toAtsAccount` passes through verbatim — seeded the select with `""`,
  // normalized back to `null`, compared unequal against `""`, and DELETED the
  // key for a user who had only edited notes. Comparing the raw input first
  // makes an untouched select always `undefined`.
  if (input === (loaded ?? "")) return undefined;
  const next = input === "" ? null : input;
  if (next === null) return null;
  return (allowed as readonly string[]).includes(next) ? (next as T) : undefined;
}

/** The stored value when the enums do not recognize it, so the select can show it. */
function offList(value: string | null, allowed: readonly string[]): string | null {
  if (value === null || value === "") return null;
  return allowed.includes(value) ? null : value;
}

export default function AccountDetail({
  detail,
  onBack,
  onSelectApplication,
  onSaved,
  onDeleted,
}: {
  detail: AccountDetailPayload;
  onBack: () => void;
  onSelectApplication: (slug: string) => void;
  /**
   * The open account changed — re-read it. Deliberately separate from
   * `onDeleted`: a single `onMutated` cannot tell the parent whether the
   * account still exists, and the two cases need opposite handling.
   */
  onSaved: () => void;
  /** The open account is gone — leave the detail. */
  onDeleted: () => void;
}) {
  const account = detail.account;
  const host = account.host;
  const href = accountUrl(host);

  const [form, setForm] = useState(() => formFrom(account));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  /**
   * THE REVEALED PASSWORD LIVES HERE AND NOWHERE ELSE (Decision 1).
   *
   * Not the URL, not localStorage, not a ref, not a parent, never a child prop,
   * never an aria-label, never logged. Leaving the view unmounts this component,
   * which destroys it.
   */
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretNote, setSecretNote] = useState<string | null>(null);

  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /**
   * Re-mask and re-seed when the open account changes.
   *
   * This is what makes "re-masked on host change" true of the component itself
   * rather than of how a parent happens to mount it: the timer effect below
   * cannot do it, because re-running only re-arms the timeout while `revealed`
   * stays set — one account's secret would be on screen under another account's
   * heading. Re-seeding the form here is the same argument: the fields must
   * describe the account the header names.
   */
  useEffect(() => {
    setRevealed(null);
    setRevealing(false);
    setSecretError(null);
    setSecretNote(null);
    setForm(formFrom(detail.account));
    setFieldErrors({});
    setSaveError(null);
    setSaveNote(null);
    setConfirmingRemoval(false);
    setConfirmingDelete(false);
    setDeleteError(null);
    // Only the host is a dependency on purpose: a refresh of the SAME account —
    // an SSE tick, or the re-read after a save — must not throw away what the
    // user is in the middle of typing.
  }, [detail.account.host]);

  /**
   * Re-mask after 30s. A plain setTimeout: sse.ts's injectable scheduler is the
   * codebase's precedent for a TESTABLE timer, but there is no way to exercise
   * this one without a DOM, so injection would buy nothing. The cleanup means
   * the timer never outlives the value it is protecting.
   */
  useEffect(() => {
    if (revealed === null) return;
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealed, host]);

  function setField(key: keyof ReturnType<typeof formFrom>, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleReveal() {
    setRevealing(true);
    setSecretError(null);
    setSecretNote(null);
    revealPassword(host)
      .then((value) => {
        setRevealed(value);
        setRevealing(false);
      })
      .catch((e) => {
        setSecretError(String(e));
        setRevealing(false);
      });
  }

  function handleCopy() {
    if (revealed === null) return;
    // localhost is a secure context, but a browser that withholds the API must
    // say so rather than fail silently.
    if (!navigator.clipboard) {
      setSecretNote("clipboard unavailable");
      return;
    }
    setSecretError(null);
    navigator.clipboard.writeText(revealed).then(
      () => setSecretNote("copied"),
      () => setSecretError("the browser refused the clipboard write"),
    );
  }

  /**
   * Only what changed. `password` is the key that matters: the route rejects an
   * explicit "" with a 400, so a blank input must produce NO password key at
   * all — and "blank" is `=== ""`, never `trim() === ""`, because a password may
   * legitimately begin or end with a space and " spaced " is a different secret
   * from "spaced". The value is sent verbatim, untrimmed. Every other text field
   * keeps the ordinary trim treatment.
   */
  function buildUpdate(): AccountUpdateBody {
    const body: AccountUpdateBody = {};
    const username = textUpdate(account.username, form.username);
    if (username !== undefined) body.username = username;
    const emailUsed = textUpdate(account.emailUsed, form.emailUsed);
    if (emailUsed !== undefined) body.emailUsed = emailUsed;
    const company = textUpdate(account.company, form.company);
    if (company !== undefined) body.company = company;
    const notes = textUpdate(account.notes, form.notes);
    if (notes !== undefined) body.notes = notes;
    const ats = enumUpdate<AtsKind>(account.ats, form.ats, ATS_KINDS);
    if (ats !== undefined) body.ats = ats;
    const status = enumUpdate<LoginStatus>(
      account.lastLoginStatus,
      form.lastLoginStatus,
      LOGIN_STATUSES,
    );
    if (status !== undefined) body.lastLoginStatus = status;
    if (form.password !== "") body.password = form.password;
    return body;
  }

  function applyError(e: unknown) {
    const err = e as AccountRequestError;
    if (typeof err.field === "string") setFieldErrors({ [err.field]: err.message });
    else setSaveError(String(e));
  }

  function handleSave(event: React.SubmitEvent<HTMLFormElement>) {
    // Without this the browser navigates away and the SPA unmounts.
    event.preventDefault();
    const body = buildUpdate();
    setFieldErrors({});
    setSaveError(null);
    if (Object.keys(body).length === 0) {
      setSaveNote("No changes to save.");
      return;
    }
    setSaving(true);
    setSaveNote(null);
    updateAccount(host, body)
      .then(() => {
        setSaving(false);
        // A typed password never lingers in a field after it has been stored.
        setForm((prev) => ({ ...prev, password: "" }));
        onSaved();
      })
      .catch((e) => {
        setSaving(false);
        applyError(e);
      });
  }

  /**
   * The one place in the client that ever sends `password: null`. Destroying a
   * stored credential gets its own button and its own confirm; it is never a
   * side effect of clearing a text input.
   */
  function handleRemovePassword() {
    setRemoving(true);
    setSaveError(null);
    setSaveNote(null);
    updateAccount(host, { password: null })
      .then(() => {
        setRemoving(false);
        setConfirmingRemoval(false);
        setRevealed(null);
        onSaved();
      })
      .catch((e) => {
        setRemoving(false);
        applyError(e);
      });
  }

  function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    deleteAccount(host)
      .then(() => {
        setDeleting(false);
        // Stop here: this component knows nothing about how App unwinds the
        // selection. onDeleted() is the whole contract.
        onDeleted();
      })
      .catch((e) => {
        setDeleting(false);
        setDeleteError(String(e));
      });
  }

  const atsOffList = offList(account.ats, ATS_KINDS);
  const statusOffList = offList(account.lastLoginStatus, LOGIN_STATUSES);
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  return (
    <div className="rb-surface">
      <div className="rb-detail-crumb crumb">
        Accounts / <b>{host}</b>
      </div>
      <header className="rb-detail-header topbar">
        <div className="rb-detail-title title-block">
          <h2>{host}</h2>
          <div className="rb-detail-status-row meta">
            <Stamp tone={loginStatusTone(account.lastLoginStatus)}>
              {loginStatusLabel(account.lastLoginStatus)}
            </Stamp>
            <span>{account.company ?? "no company"}</span>
            <span>·</span>
            <span>{account.ats ?? "unknown ATS"}</span>
          </div>
        </div>
        <button type="button" className="btn" onClick={onBack}>
          ← All accounts
        </button>
      </header>

      <div className="rb-detail-grid detail">
        <div className="col">
          <div className="section">
            <h3>Account</h3>
            <dl>
              <dt>Host</dt>
              <dd>
                {/*
                  credentials.json keys are addressed verbatim (Decision 2), so a
                  hand-edited key that is not hostname-shaped does reach this
                  component and must render as text rather than as a broken or
                  unsafe href. Mixed-case and host:port keys DO get links —
                  accountUrl accepts both — so the plain-text path is the
                  exception, not the rule.
                */}
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {host}
                  </a>
                ) : (
                  <span className="mono" title="not a hostname — shown as text, not linked">
                    {host}
                  </span>
                )}
              </dd>
              <dt>Company</dt>
              <dd>
                <Value value={account.company} absent="no company" />
              </dd>
              <dt>ATS</dt>
              <dd>
                <Value value={account.ats} absent="unknown ATS" />
              </dd>
              <dt>Username</dt>
              <dd>
                <Value value={account.username} absent="no username" />
              </dd>
              <dt>Email used</dt>
              <dd>
                <Value value={account.emailUsed} absent="no email used" />
              </dd>
              <dt>Last login</dt>
              <dd>
                <Stamp tone={loginStatusTone(account.lastLoginStatus)}>
                  {loginStatusLabel(account.lastLoginStatus)}
                </Stamp>
              </dd>
              <dt>Last used</dt>
              <dd>
                {account.lastUsedAt ? (
                  formatDate(account.lastUsedAt)
                ) : (
                  <span className="note">never used</span>
                )}
              </dd>
              <dt>Created</dt>
              <dd>
                {account.createdAt ? (
                  formatDate(account.createdAt)
                ) : (
                  <span className="note">no creation date recorded</span>
                )}
              </dd>
              <dt>Notes</dt>
              <dd>
                {account.notes ? (
                  <p className="mono block">{account.notes}</p>
                ) : (
                  <span className="note">no notes</span>
                )}
              </dd>
            </dl>
          </div>

          <div className="section">
            <h3>Password</h3>
            {!account.hasPassword ? (
              <p className="note">no password on file</p>
            ) : (
              <>
                <span className="row-actions">
                  <span className="secret mono">{revealed ?? MASK}</span>
                  {revealed === null ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={revealing}
                      onClick={handleReveal}
                    >
                      Reveal
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setRevealed(null);
                          setSecretNote(null);
                        }}
                      >
                        Hide
                      </button>
                      <button type="button" className="btn" onClick={handleCopy}>
                        Copy
                      </button>
                    </>
                  )}
                </span>
                {/* One status line for this section, the QueueAdd rule. The
                    copy/clipboard note is scoped to the revealed state so it
                    cannot outlive the value it describes. */}
                <p className={secretError ? "note crit" : "note"}>
                  {secretError
                    ? `Reveal failed: ${secretError}`
                    : revealing
                      ? "revealing…"
                      : revealed !== null
                        ? (secretNote ?? "Visible for 30 seconds, then masked again.")
                        : "Shown only on this click — never in the list, the URL or the run transcript."}
                </p>
              </>
            )}
          </div>

          <form className="section" onSubmit={handleSave}>
            <h3>Edit</h3>

            <div className="field-row">
              <div className="field">
                <label htmlFor="account-username">Username</label>
                <input
                  id="account-username"
                  className="control"
                  type="text"
                  value={form.username}
                  onChange={(e) => setField("username", e.target.value)}
                  {...invalidProps("account-username", fieldErrors.username)}
                />
                <FieldError id="account-username-error" message={fieldErrors.username} />
              </div>
              <div className="field">
                <label htmlFor="account-email">Email used</label>
                <input
                  id="account-email"
                  className="control"
                  type="text"
                  value={form.emailUsed}
                  onChange={(e) => setField("emailUsed", e.target.value)}
                  {...invalidProps("account-email", fieldErrors.emailUsed)}
                />
                <FieldError id="account-email-error" message={fieldErrors.emailUsed} />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="account-company">Company</label>
                <input
                  id="account-company"
                  className="control"
                  type="text"
                  value={form.company}
                  onChange={(e) => setField("company", e.target.value)}
                  {...invalidProps("account-company", fieldErrors.company)}
                />
                <FieldError id="account-company-error" message={fieldErrors.company} />
              </div>
              <div className="field">
                <label htmlFor="account-ats">ATS</label>
                <select
                  id="account-ats"
                  className="control"
                  value={form.ats}
                  onChange={(e) => setField("ats", e.target.value)}
                  {...invalidProps("account-ats", fieldErrors.ats)}
                >
                  <option value="">— none —</option>
                  {ATS_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                  {/*
                    A stored value the enum does not recognize keeps its own
                    option, so the control shows what is on disk instead of
                    falling back to the first option and reading as blank — which
                    is how an edit of an unrelated field would quietly rewrite it.
                  */}
                  {atsOffList && <option value={atsOffList}>{`${atsOffList} (unrecognized)`}</option>}
                </select>
                <FieldError id="account-ats-error" message={fieldErrors.ats} />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="account-status">Last login status</label>
                <select
                  id="account-status"
                  className="control"
                  value={form.lastLoginStatus}
                  onChange={(e) => setField("lastLoginStatus", e.target.value)}
                  {...invalidProps("account-status", fieldErrors.lastLoginStatus)}
                >
                  <option value="">— none —</option>
                  {LOGIN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  {statusOffList && (
                    <option value={statusOffList}>{`${statusOffList} (unrecognized)`}</option>
                  )}
                </select>
                <FieldError id="account-status-error" message={fieldErrors.lastLoginStatus} />
              </div>
              <div className="field">
                <label htmlFor="account-password">New password</label>
                <input
                  id="account-password"
                  className="control"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setField("password", e.target.value)}
                  {...invalidProps("account-password", fieldErrors.password)}
                />
                <FieldError id="account-password-error" message={fieldErrors.password} />
              </div>
            </div>
            <p className="note">
              Leave blank to keep the stored password. Use Remove stored password below to clear
              it.
            </p>

            <div className="field">
              <label htmlFor="account-notes">Notes</label>
              <textarea
                id="account-notes"
                className="control tall"
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
                {...invalidProps("account-notes", fieldErrors.notes)}
              />
              <FieldError id="account-notes-error" message={fieldErrors.notes} />
            </div>

            <div>
              <button type="submit" className="btn primary" disabled={saving}>
                Save changes
              </button>
            </div>
            <p className={saveError || hasFieldErrors ? "note crit" : "note"}>
              {saveError
                ? `Save failed: ${saveError}`
                : hasFieldErrors
                  ? "Save failed — see the marked field."
                  : saving
                    ? "saving…"
                    : (saveNote ??
                      "Only the fields you change are sent; everything else in the entry is left exactly as it is on disk.")}
            </p>
          </form>

          {account.hasPassword && (
            <div className="section">
              <h3>Remove stored password</h3>
              <p className="note">
                Deletes the password from credentials.json and leaves the rest of the entry
                alone. The file is the only copy.
              </p>
              <span className="row-actions">
                {confirmingRemoval ? (
                  <>
                    <button
                      type="button"
                      className="row-btn"
                      disabled={removing}
                      onClick={handleRemovePassword}
                    >
                      Confirm removal
                    </button>
                    <button
                      type="button"
                      className="row-btn"
                      onClick={() => setConfirmingRemoval(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="row-btn"
                    onClick={() => setConfirmingRemoval(true)}
                  >
                    Remove stored password
                  </button>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="col">
          <div className="section">
            <h3>Applications that used this account</h3>
            {detail.applications.length === 0 ? (
              <div className="state">
                <span className="glyph" aria-hidden="true">
                  ∅
                </span>
                <p>No applications used this account.</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Company · role</th>
                      <th>Apply state</th>
                      <th className="num">Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.applications.map((app) => (
                      <tr
                        key={app.slug}
                        className="row"
                        onClick={() => onSelectApplication(app.slug)}
                      >
                        <td>
                          <button
                            type="button"
                            className="row-open"
                            aria-label={`Open ${app.company ?? app.slug} — ${app.title ?? "untitled role"}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectApplication(app.slug);
                            }}
                          >
                            {app.company ?? app.slug}
                          </button>
                          <div className="role">{app.title ?? "—"}</div>
                        </td>
                        <td>
                          <Stamp tone={applyStateTone(app.applyState)}>
                            {humanize(app.applyState)}
                          </Stamp>
                        </td>
                        <td className="num">{formatDate(app.submittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="section">
            <h3>Delete this account</h3>
            <p className="note">
              Removes the entry from credentials.json. The agent will create a new one the next
              time it hits this login wall. This cannot be undone.
            </p>
            <span className="row-actions">
              {confirmingDelete ? (
                <>
                  <button
                    type="button"
                    className="row-btn"
                    disabled={deleting}
                    onClick={handleDelete}
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    className="row-btn"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="row-btn"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </button>
              )}
            </span>
            {(deleteError || deleting) && (
              <p className={deleteError ? "note crit" : "note"}>
                {deleteError ? `Delete failed: ${deleteError}` : "deleting…"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
