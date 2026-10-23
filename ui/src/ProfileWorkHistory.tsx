import FormSaveBar from "./components/FormSaveBar";
import type { ProfileEditableSectionId } from "../shared/types";
import "./surfaces.css";

const SECTIONS = [
  ["workHistory", "Work history", "Use ### headings for roles, with dates, responsibilities and measurable results."],
  ["education", "Education", "Include schools, credentials, subjects and dates that you can truthfully support."],
  ["authorization", "Work authorization", "Record citizenship, sponsorship and location constraints exactly as they apply to you."],
] as const;

export default function ProfileWorkHistory({ values, dirty, saving, error, note, onChange, onSave }: {
  values: Partial<Record<ProfileEditableSectionId, string>>;
  dirty: (id: ProfileEditableSectionId) => boolean;
  saving: string | null;
  error: string | null;
  note?: string | null;
  onChange: (id: ProfileEditableSectionId, value: string) => void;
  onSave: (id: ProfileEditableSectionId) => void;
}) {
  return <div className="rb-surface rb-settings-stack">{SECTIONS.map(([id, label, help]) =>
    <form className="rb-profile-form rb-settings-form" key={id} onSubmit={(e) => { e.preventDefault(); onSave(id); }}>
      <div className="head"><h2 className="rb-h-major">{label}</h2></div><p className="note">{help} Markdown is preserved verbatim.</p>
      <div className="field"><label htmlFor={`profile-${id}`}>{label} section body</label><textarea id={`profile-${id}`} className="control tall wide" value={values[id] ?? ""} onChange={(e) => onChange(id, e.target.value)} /></div>
      <FormSaveBar dirty={dirty(id)} saving={saving === id} error={error} saved={note === "Saved."} label={`Save ${label.toLowerCase()}`} />
    </form>)}</div>;
}
