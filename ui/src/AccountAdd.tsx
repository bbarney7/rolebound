import { useState } from "react";
import { ATS_KINDS, type AccountCreateBody, type AtsKind } from "../shared/types";
import { createAccount, type AccountRequestError } from "./accounts";
import "./surfaces.css";

/**
 * Every field the add form owns, as one object, so a successful create resets
 * the whole form with a single setState and no field can be forgotten. Kept as
 * string-only: the two required values are validated by the server (400 before
 * any write) and the optional ones are omitted from the request body when
 * blank rather than sent as "".
 */
interface AddForm {
  host: string;
  username: string;
  password: string;
  emailUsed: string;
  company: string;
  ats: AtsKind;
  notes: string;
}

const EMPTY_FORM: AddForm = {
  host: "",
  username: "",
  password: "",
  emailUsed: "",
  company: "",
  ats: "other",
  notes: "",
};

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

/** Blank optional fields are omitted, not sent as "". */
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export default function AccountAdd({
  onMutated,
}: {
  /**
   * Signals that the create succeeded. Carries no payload: the parent does not
   * apply the response snapshot — it re-reads current state through the
   * version-fenced refresh. Creating is the only thing this form can do, so one
   * callback is the whole contract (AccountDetail needs two, because a delete
   * and a save need opposite handling).
   */
  onMutated: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  /** One setter for the six text fields; `ats` has its own, because it is typed. */
  function setField(key: Exclude<keyof AddForm, "ats">, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleCreate(event: React.SubmitEvent<HTMLFormElement>) {
    // Without this the browser navigates away and the SPA unmounts.
    event.preventDefault();
    const body: AccountCreateBody = {
      host: form.host.trim(),
      username: form.username.trim(),
      // A PASSWORD IS OPAQUE. "Blank" is `=== ""`, never `trim() === ""`, and
      // the value is sent untrimmed: " hunter2 " is a different secret from
      // "hunter2", and a trimmed credential would silently never work behind a
      // masked field. A blank one is not an error here — it just means no
      // password was recorded, which is the opposite of PATCH's refusal of an
      // explicit "".
      ...(form.password === "" ? {} : { password: form.password }),
      emailUsed: optional(form.emailUsed),
      company: optional(form.company),
      ats: form.ats,
      notes: optional(form.notes),
    };
    setFieldErrors({});
    setSubmitError(null);
    setAdded(null);
    setSubmitting(true);
    createAccount(body)
      .then(() => {
        setSubmitting(false);
        setForm(EMPTY_FORM);
        setAdded(body.host);
        onMutated();
      })
      .catch((e) => {
        setSubmitting(false);
        const err = e as AccountRequestError;
        if (typeof err.field === "string") setFieldErrors({ [err.field]: err.message });
        else setSubmitError(String(e));
      });
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  return (
    // id="add-account" is the other half of AccountsList's
    // `<a href="#add-account" className="btn">Add account</a>` — the pair is
    // what satisfies AC 6's "reachable from the list header" with no toggle
    // state, so neither identifier can be renamed on its own.
    <form className="rb-section section rb-form-column" id="add-account" onSubmit={handleCreate}>
      <h2 className="rb-h-major">Add account</h2>

      <div className="rb-field-row field-row">
        <div className="field">
          <label htmlFor="add-account-host">Host (required)</label>
          <input
            id="add-account-host"
            className="control search"
            type="text"
            required
            placeholder="acme.wd5.myworkdayjobs.com"
            value={form.host}
            onChange={(e) => setField("host", e.target.value)}
            {...invalidProps("add-account-host", fieldErrors.host)}
          />
          <FieldError id="add-account-host-error" message={fieldErrors.host} />
        </div>
        <div className="field">
          <label htmlFor="add-account-username">Username (required)</label>
          <input
            id="add-account-username"
            className="control"
            type="text"
            required
            value={form.username}
            onChange={(e) => setField("username", e.target.value)}
            {...invalidProps("add-account-username", fieldErrors.username)}
          />
          <FieldError id="add-account-username-error" message={fieldErrors.username} />
        </div>
      </div>

      <p className="note">
        The host is the key the agent looks the account up by — a bare hostname, with no
        scheme, port or path. It is stored lowercase.
      </p>

      <div className="field-row">
        <div className="field">
          <label htmlFor="add-account-password">Password</label>
          <input
            id="add-account-password"
            className="control"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setField("password", e.target.value)}
            {...invalidProps("add-account-password", fieldErrors.password)}
          />
          <FieldError id="add-account-password-error" message={fieldErrors.password} />
        </div>
        <div className="field">
          <label htmlFor="add-account-email">Email used</label>
          <input
            id="add-account-email"
            className="control"
            type="text"
            value={form.emailUsed}
            onChange={(e) => setField("emailUsed", e.target.value)}
            {...invalidProps("add-account-email", fieldErrors.emailUsed)}
          />
          <FieldError id="add-account-email-error" message={fieldErrors.emailUsed} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="add-account-company">Company</label>
          <input
            id="add-account-company"
            className="control"
            type="text"
            value={form.company}
            onChange={(e) => setField("company", e.target.value)}
            {...invalidProps("add-account-company", fieldErrors.company)}
          />
          <FieldError id="add-account-company-error" message={fieldErrors.company} />
        </div>
        <div className="field">
          <label htmlFor="add-account-ats">ATS</label>
          <select
            id="add-account-ats"
            className="control"
            value={form.ats}
            // The options are ATS_KINDS itself, so the cast is safe and is made
            // here rather than hidden inside a generic setter.
            onChange={(e) => setForm((prev) => ({ ...prev, ats: e.target.value as AtsKind }))}
            {...invalidProps("add-account-ats", fieldErrors.ats)}
          >
            {ATS_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <FieldError id="add-account-ats-error" message={fieldErrors.ats} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="add-account-notes">Notes</label>
        <textarea
          id="add-account-notes"
          className="control tall"
          value={form.notes}
          onChange={(e) => setField("notes", e.target.value)}
          {...invalidProps("add-account-notes", fieldErrors.notes)}
        />
        <FieldError id="add-account-notes-error" message={fieldErrors.notes} />
      </div>

      <div>
        <button type="submit" className="btn primary" disabled={submitting}>
          Add account
        </button>
      </div>
      <p className={submitError || hasFieldErrors ? "note crit" : "note"} aria-live="polite">
        {submitError
          ? `Add failed: ${submitError}`
          : hasFieldErrors
            ? "Add failed — see the marked field."
            : submitting
              ? "adding…"
              : added
                ? `Added ${added}.`
                : "The entry is written into credentials.json, the same file the agent reads."}
      </p>
    </form>
  );
}
