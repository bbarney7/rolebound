export default function FormSaveBar({ dirty, saving, error, saved, label = "Save changes", disabled = false }: {
  dirty: boolean; saving: boolean; error?: string | null; saved?: boolean; label?: string; disabled?: boolean;
}) {
  return <footer className="rb-save-bar">
    <button type="submit" className="btn primary" disabled={disabled || !dirty || saving}>{saving ? "Saving…" : label}</button>
    <p className={`rb-form-status${error ? " crit" : ""}`} role="status">{error || (saving ? "Saving changes…" : dirty ? "Unsaved changes" : saved ? "Saved" : "Up to date")}</p>
  </footer>;
}
