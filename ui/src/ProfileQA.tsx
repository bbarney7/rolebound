/**
 * The Q&A bank, as raw markdown (Decision 2).
 *
 * `.pi/extensions/lib/profile.ts` has no parser for this section — no `Profile`
 * field, no parser function — and the live one is nested sub-bullets under a
 * salary rule, a multi-line blockquote carrying a `[COMPANY]` placeholder,
 * italic stop-and-ask asides, and two `###` subsections. `parseBullets` skips
 * every one of those forms, so a structured editor here would have to invent a
 * second parser and would silently drop whatever it failed to model. A textarea
 * saved verbatim cannot drop anything, because nothing is ever interpreted.
 *
 * The value round-trips the exact `[bodyStart, bodyWithSubsectionsEnd)` slice
 * the reader handed out (Q2: the two `###` subsections are inside it, so they
 * are edited here rather than stranded in no tab at all). Writing the slice back
 * unchanged is byte-identical by construction — there is no normalization step
 * that could be wrong.
 *
 * CONTROLLED THROUGHOUT: the draft lives in ProfileView, so switching sub-tabs
 * and the full `refresh()` that every profile save fires both leave it alone.
 */
/**
 * RESTATED FROM `server/routes/profile.ts:40`, for the same reason
 * ProfileBulletForm restates its bullet cap: a client bundle cannot take a
 * value out of an Express module. `express.json()`'s own 100kb default sits
 * above it.
 */
const MAX_BODY_LENGTH = 64 * 1024;

/**
 * What the route would refuse, said before the request.
 *
 * The heading rule is the writer's (`server/profileText.ts`,
 * `hasTopLevelHeading`): a `#` or `##` line inside this body would end the Q&A
 * bank and start a new section, so the file would gain a heading the user never
 * asked for. The check here is deliberately the SIMPLE one — a raw line test.
 * The server's runs on the comment-removed line, so it also catches
 * `<!-- note -->## Injected`, which the parser reads as a real heading; that
 * case falls through to the 400, which this form renders on the control.
 */
import "./surfaces.css";

export function bodyIssue(value: string): string | null {
  if (value.length > MAX_BODY_LENGTH) {
    return `${value.length} characters — the limit is ${MAX_BODY_LENGTH}.`;
  }
  if (/^#{1,2}\s/m.test(value)) {
    return "A `#` or `##` line would start a new section — use `###` or deeper inside the Q&A bank.";
  }
  return null;
}

export default function ProfileQA({
  value,
  dirty,
  saving,
  error,
  fieldError,
  note,
  onChange,
  onSave,
}: {
  value: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** The server named `body` in a 400 — mark the control the same way. */
  fieldError: string | null;
  note: string | null;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const issue = bodyIssue(value);
  const marked = issue ?? fieldError;
  const blocked = issue !== null;
  const lines = value === "" ? 0 : value.split("\n").length;

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    // Without this the browser navigates away and the SPA unmounts.
    event.preventDefault();
    if (blocked) return;
    onSave();
  }

  return (
    <form className="rb-profile-form rb-settings-form" onSubmit={handleSubmit}>
      <h2 className="rb-h-major">Q&amp;A bank</h2>
      <p className="note">
        Saved verbatim. Nothing in this box is parsed, reformatted or
        interpreted — the agent reads it as prose, exactly as you leave it, and the rest of
        profile.md is untouched by a save here.
      </p>

      <div className="field">
        <label htmlFor="profile-qa-body">Section body</label>
        <textarea
          id="profile-qa-body"
          className="control tall wide"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...(marked
            ? { "aria-invalid": true as const, "aria-describedby": "profile-qa-body-error" }
            : {})}
        />
        {marked && (
          <p className="field-error" id="profile-qa-body-error">
            {marked}
          </p>
        )}
      </div>

      <p className="note">
        {lines} {lines === 1 ? "line" : "lines"} · {value.length.toLocaleString()} of{" "}
        {MAX_BODY_LENGTH.toLocaleString()} characters. <span className="mono">###</span>{" "}
        subsections belong in here and round-trip with the rest of the section.
      </p>

      <div>
        <button type="submit" className="btn primary" disabled={!dirty || saving || blocked}>
          Save Q&amp;A bank
        </button>
      </div>
      <p className={error || marked ? "note crit" : "note"}>
        {error
          ? `Save failed: ${error}`
          : marked
            ? "Save is held — see the message under the box."
            : saving
              ? "saving…"
              : (note ??
                (dirty
                  ? "Unsaved changes."
                  : "Every other section of profile.md is left byte for byte as it is on disk."))}
      </p>
    </form>
  );
}
