import FormSaveBar from "./components/FormSaveBar";
import { CANDIDATE_SUMMARY_MAX_LENGTH } from "../shared/profilePlaceholders";
import "./surfaces.css";

export function bodyIssue(value: string): string | null {
  if (value.length > CANDIDATE_SUMMARY_MAX_LENGTH) {
    return `${value.length} characters — the scoring prompt allows at most ${CANDIDATE_SUMMARY_MAX_LENGTH}.`;
  }
  if (/^#{1,2}\s/m.test(value)) {
    return "A `#` or `##` line would start a new section — keep this as plain text under Candidate summary.";
  }
  return null;
}

export default function ProfileCandidateSummary({
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
  fieldError: string | null;
  note: string | null;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const issue = bodyIssue(value);
  return (
    <form className="rb-profile-form rb-settings-form" onSubmit={e => {e.preventDefault(); if(dirty && !saving && !issue) onSave();}}>
      <div className="rb-candidate-summary-head">
        <h2 className="rb-h-major">Candidate summary</h2>
        {dirty && <span className="count">unsaved</span>}
      </div>
      <p className="note">
        This text is sent to the scoring model with every discovered job. Leave it blank to let the gatherer
        compose a summary from Identity and Work history instead. The HTML guidance comment in profile.md stays
        on disk when you save.
      </p>
      <textarea
        className="control wide tall"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Candidate summary"
      />
      <p className="note">{value.length} / {CANDIDATE_SUMMARY_MAX_LENGTH} characters</p>
      {issue && <p className="note crit">{issue}</p>}
      {fieldError && <p className="note crit">{fieldError}</p>}
      {error && !fieldError && <p className="note crit">{error}</p>}
      {note && <p className="note">{note}</p>}
      <FormSaveBar dirty={dirty} saving={saving} disabled={!!issue} error={fieldError ?? error} saved={note === "Saved."} label="Save candidate summary" />
    </form>
  );
}
