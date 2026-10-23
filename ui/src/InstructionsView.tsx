import { useEffect, useMemo, useState } from "react";
import { fetchInstructions, updateInstructions } from "./api";
import "./surfaces.css";

const MAX_SECTION_LENGTH = 20_000;

type Draft = { applying: string; finding: string; chat: string };

function sectionIssue(value: string): string | null {
  if (value.length > MAX_SECTION_LENGTH) {
    return `${value.length} characters — the limit is ${MAX_SECTION_LENGTH}.`;
  }
  return null;
}

export default function InstructionsView() {
  const [revision, setRevision] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ applying: "", finding: "", chat: "" });
  const [saved, setSaved] = useState<Draft>({ applying: "", finding: "", chat: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchInstructions()
      .then((payload) => {
        if (cancelled) return;
        setRevision(payload.revision);
        setDraft(payload.data);
        setSaved(payload.data);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(
    () =>
      draft.applying !== saved.applying ||
      draft.finding !== saved.finding ||
      draft.chat !== saved.chat,
    [draft, saved],
  );

  const blocked =
    sectionIssue(draft.applying) !== null ||
    sectionIssue(draft.finding) !== null ||
    sectionIssue(draft.chat) !== null;

  async function handleSave() {
    if (blocked || !dirty) return;
    setSaving(true);
    setNote(null);
    setError(null);
    try {
      const payload = await updateInstructions({
        applying: draft.applying,
        finding: draft.finding,
        chat: draft.chat,
        expectedRevision: revision,
      });
      setRevision(payload.revision);
      setDraft(payload.data);
      setSaved(payload.data);
      setNote("Saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="state">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <form
      className="rb-profile-form rb-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="field">
        <label htmlFor="instructions-applying">When applying</label>
        <p className="note">Followed on every application form.</p>
        <textarea
          id="instructions-applying"
          className="control tall wide"
          value={draft.applying}
          placeholder={
            "Only fill salary if required. If they post a range, use the midpoint, never under $230,000. No range: $250,000 for California roles, $230,000 elsewhere.\nSkip optional cover letters."
          }
          onChange={(e) => setDraft((d) => ({ ...d, applying: e.target.value }))}
          {...(sectionIssue(draft.applying) ? { "aria-invalid": true as const } : {})}
        />
        {sectionIssue(draft.applying) && <p className="field-error">{sectionIssue(draft.applying)}</p>}
      </div>

      <div className="field">
        <label htmlFor="instructions-finding">When finding and scoring jobs</label>
        <p className="note">Used when ranking new jobs.</p>
        <textarea
          id="instructions-finding"
          className="control tall wide"
          value={draft.finding}
          placeholder={
            "Score anything that posts a maximum under $200,000 as 1.\nPrefer companies under 500 people."
          }
          onChange={(e) => setDraft((d) => ({ ...d, finding: e.target.value }))}
          {...(sectionIssue(draft.finding) ? { "aria-invalid": true as const } : {})}
        />
        {sectionIssue(draft.finding) && <p className="field-error">{sectionIssue(draft.finding)}</p>}
      </div>

      <div className="field">
        <label htmlFor="instructions-chat">In the chat</label>
        <p className="note">How the chat talks to you.</p>
        <textarea
          id="instructions-chat"
          className="control tall wide"
          value={draft.chat}
          placeholder="Keep replies short."
          onChange={(e) => setDraft((d) => ({ ...d, chat: e.target.value }))}
          {...(sectionIssue(draft.chat) ? { "aria-invalid": true as const } : {})}
        />
        {sectionIssue(draft.chat) && <p className="field-error">{sectionIssue(draft.chat)}</p>}
      </div>

      <div>
        <button type="submit" className="btn primary" disabled={!dirty || saving || blocked}>
          Save instructions
        </button>
      </div>
      {note && <p className="note">{note}</p>}
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}
