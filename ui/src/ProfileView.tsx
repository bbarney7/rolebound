import { useWorkspaceState, useUnsavedChanges } from "./WorkspaceDrafts";
import { useEffect, useState } from "react";
import {
  PROFILE_SECTION_IDS,
  type AddressesPayload,
  type ProfileBullet,
  type ProfileEditableSectionId,
  type ProfilePayload,
  type ProfileSectionId,
  type ResumesPayload,
} from "../shared/types";
import {
  EMPTY_DRAFTS,
  SUB_TABS,
  addProfileSection,
  assignResume,
  bodyKey,
  bulletKey,
  changedBullets,
  commitDraft,
  createProfile,
  draftsFromPayload,
  isEditableSection,
  reconcileDrafts,
  sectionFallback,
  sectionIsDirty,
  sectionLabel,
  sectionOfKey,
  updateProfileBody,
  updateProfileBullets,
  uploadResume,
  saveAddress,
  type DraftState,
  type ProfileRequestError,
  type SubTabId,
} from "./profile";
import ProfileAddresses from "./ProfileAddresses";
import ProfileBulletForm, { type ParsedRow } from "./ProfileBulletForm";
import ProfileQA from "./ProfileQA";
import ProfileResumes from "./ProfileResumes";
import ProfileWorkHistory from "./ProfileWorkHistory";
import ProfileCandidateSummary from "./ProfileCandidateSummary";
import Stamp from "./Stamp";
import "./surfaces.css";

/**
 * The Profile section: six sub-tabs over one markdown file.
 *
 * THE DRAFTS LIVE HERE, NOT IN THE LEAVES, AND THAT IS THE WHOLE DESIGN.
 *
 * `profile.md` sits at depth 0 and matches none of the six `WATCH_IGNORED`
 * patterns (`server/routes/events.ts:14-21`), so EVERY section save fires a
 * change frame and triggers a full `refresh()` within one debounce window. A
 * view that re-seeded its forms from props on each payload would silently
 * revert an unsaved edit in a sibling sub-tab — no error, no warning, the text
 * simply changes back. `reconcileDrafts` is the answer: clean keys re-seed from
 * the server, dirty keys are left alone, and a dirty key whose file value moved
 * underneath it raises a conflict instead of being overwritten.
 *
 * Keeping the drafts in this component rather than in the five leaves is the
 * second half of it. Switching sub-tabs unmounts a leaf; if the draft lived
 * there, leaving the Q&A tab would throw the edit away just as thoroughly as
 * the refresh would.
 *
 * Deliberately NOT solved by suppressing the refresh: suppression needs state
 * inside the SSE path, and this ticket freezes `sse.ts` and `events.ts`.
 */

/** The two sub-tabs whose content comes from disk rather than from the section. */
const READS_DISK: readonly SubTabId[] = ["resumes", "addresses"];

/** A `DraftKey`'s section half, labelled — and passed through when unrecognized. */
function sectionKeyLabel(key: string): string {
  const id = sectionOfKey(key);
  return (PROFILE_SECTION_IDS as readonly string[]).includes(id)
    ? sectionLabel(id as ProfileSectionId)
    : id;
}

export default function ProfileView({
  profile,
  resumes,
  addresses,
  error,
  onMutated,
  tabRequest,
  onTabChange,
}: {
  profile: ProfilePayload;
  resumes: ResumesPayload | null;
  addresses: AddressesPayload | null;
  error: string | null;
  /** Bump the refresh, exactly as an account mutation does. */
  onMutated: () => void;
  /** Bumped by App whenever a link changes `?tab=`; the view re-reads its tab from the URL. */
  tabRequest?: number;
  onTabChange?: (tab: string) => void;
}) {
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  const [tab, setTab] = useState<SubTabId>((SUB_TABS.some((item) => item.id === requestedTab) ? requestedTab : "identity") as SubTabId);
  const [drafts, setDrafts] = useWorkspaceState<DraftState>("profile-drafts", EMPTY_DRAFTS);

  // One busy key for the whole view — only one sub-tab is on screen at a time,
  // and naming the operation ("identity", "qaBank", "create", "add:qaBank")
  // keeps four independent flags from drifting out of step.
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveField, setSaveField] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  // Keyed on the incoming payload, and on nothing else. `setDrafts` is a
  // useState setter, so this adds no reactive value anywhere.
  useEffect(() => {
    setDrafts((prev) => reconcileDrafts(prev, draftsFromPayload(profile)));
  }, [profile]);

  useUnsavedChanges("profile", Object.entries(drafts.drafts).some(([key, value]) => value !== drafts.baselines[key as keyof typeof drafts.baselines]));

  const present = (id: ProfileSectionId): boolean =>
    profile.sections.find((s) => s.id === id)?.present ?? false;

  function applyError(e: unknown) {
    const err = e as ProfileRequestError;
    setSaveError(err instanceof Error ? err.message : String(e));
    // The bullets route names `bullets` rather than a single key, so only the
    // Q&A body's `field` maps onto exactly one control. Anything else is
    // reported on the form's status line, where the route's message — which
    // does name the offending bullet — is readable in full.
    setSaveField(typeof err.field === "string" ? err.field : null);
  }

function clearStatus() {
    setSaveError(null);
    setSaveField(null);
    setSaveNote(null);
  }

  function selectTab(next: SubTabId) {
    setTab(next);
    onTabChange?.(next);
    clearStatus();
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ""}`);
  }

  useEffect(() => {
    const onPop = () => {
      const requested = new URLSearchParams(window.location.search).get("tab");
      if (SUB_TABS.some((item) => item.id === requested)) setTab(requested as SubTabId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!tabRequest) return;
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (SUB_TABS.some((item) => item.id === requested)) setTab(requested as SubTabId);
  }, [tabRequest]);

  function handleChangeBullet(id: ProfileEditableSectionId, key: string, value: string) {
    const k = bulletKey(id, key);
    setDrafts((prev) => ({ ...prev, drafts: { ...prev.drafts, [k]: value } }));
    setSaveNote(null);
  }

  function handleChangeBody(value: string) {
    const k = bodyKey("qaBank");
    setDrafts((prev) => ({ ...prev, drafts: { ...prev.drafts, [k]: value } }));
    setSaveNote(null);
  }

  function handleChangeMarkdown(id: ProfileEditableSectionId, value: string) {
    const k = bodyKey(id);
    setDrafts((prev) => ({ ...prev, drafts: { ...prev.drafts, [k]: value } }));
    setSaveNote(null);
  }

  function handleAddBullet(id: ProfileEditableSectionId, label: string, value: string) {
    setBusy(id);
    clearStatus();
    updateProfileBullets(id, { [label]: value }, profile.revision)
      .then(() => {
        setBusy(null);
        setSaveNote("Bullet added.");
        setSaveNote("Saved.");
        onMutated();
      })
      .catch((e) => {
        setBusy(null);
        applyError(e);
      });
  }

  function handleSaveBullets(id: ProfileEditableSectionId, bullets: readonly ProfileBullet[]) {
    const changed = changedBullets(id, bullets, drafts.drafts);
    if (Object.keys(changed).length === 0) {
      setSaveNote("No changes to save.");
      return;
    }
    setBusy(id);
    clearStatus();
    updateProfileBullets(id, changed, profile.revision)
      .then((result) => {
        setBusy(null);
        const incoming = draftsFromPayload(result.profile);
        setDrafts((prev) => {
          let next = prev;
          for (const key of Object.keys(changed)) {
            const k = bulletKey(id, key);
            // Only settle a key the user has not typed into again while the
            // request was in flight: `commitDraft` replaces the draft with the
            // server's value, which would discard that edit without a word.
            if (prev.drafts[k] !== (changed[key] ?? "")) continue;
            next = commitDraft(next, k, incoming[k] ?? "");
          }
          return next;
        });
        setSaveNote("Saved.");
        onMutated();
      })
      .catch((e) => {
        setBusy(null);
        applyError(e);
      });
  }

  function handleSaveBody() {
    const k = bodyKey("qaBank");
    const value = Object.prototype.hasOwnProperty.call(drafts.drafts, k)
      ? drafts.drafts[k]
      : (profile.qaBank ?? "");
    setBusy("qaBank");
    clearStatus();
    updateProfileBody("qaBank", value, profile.revision)
      .then((result) => {
        setBusy(null);
        setDrafts((prev) =>
          prev.drafts[k] === value ? commitDraft(prev, k, result.profile.qaBank ?? "") : prev,
        );
        setSaveNote("Saved.");
        onMutated();
      })
      .catch((e) => {
        setBusy(null);
        applyError(e);
      });
  }

  function handleSaveMarkdown(id: ProfileEditableSectionId) {
    const k = bodyKey(id); const value = drafts.drafts[k] ?? ""; setBusy(id); clearStatus();
    updateProfileBody(id, value, profile.revision).then((result) => {
      setBusy(null); const serverValue = result.profile.markdownBodies[id as "workHistory" | "education" | "authorization" | "candidateSummary"] ?? "";
      setDrafts((prev) => prev.drafts[k] === value ? commitDraft(prev, k, serverValue) : prev); setSaveNote("Saved."); onMutated();
    }).catch((e) => { setBusy(null); applyError(e); });
  }

  function handleCreate() {
    setBusy("create");
    clearStatus();
    createProfile()
      .then(() => {
        setBusy(null);
        setSaveNote("Saved.");
        onMutated();
      })
      .catch((e) => {
        setBusy(null);
        applyError(e);
      });
  }

  async function handleUpload(file: File, replace = false) {
    const next = await uploadResume(file, replace);
    // The upload response is authoritative for the library and does not touch
    // profile drafts. Keep unsaved profile edits intact while refreshing rows.
    onMutated();
    void next;
  }

  function handleAddSection(id: ProfileEditableSectionId) {
    setBusy(`add:${id}`);
    clearStatus();
    addProfileSection(id)
      .then(() => {
        setBusy(null);
        setSaveNote("Saved.");
        onMutated();
      })
      .catch((e) => {
        setBusy(null);
        applyError(e);
      });
  }

  /**
   * The conflict banner's only control. It NEVER resolves on its own: an
   * external edit that disagrees with an unsaved draft is a decision, and the
   * one thing the UI must not do is pick for the user. This is `commitDraft`
   * again — "the file on disk is now what this form shows" — which is why the
   * same helper serves a successful save and a discard.
   */
  function handleDiscardConflicts() {
    const incoming = draftsFromPayload(profile);
    setDrafts((prev) => {
      let next = prev;
      for (const k of prev.conflicts) {
        next = commitDraft(next, k, incoming[k] ?? prev.baselines[k] ?? "");
      }
      return next;
    });
    clearStatus();
  }

  // ── The missing-file state ────────────────────────────────────────────────

  if (!profile.exists) {
    return (
      <div className="rb-surface rb-empty state">
        <span className="glyph" aria-hidden="true">
          ∅
        </span>
        {/* The reader puts `loadProfile`'s own sentence in warnings[0], so this
            is the same line `pi /status` prints (AC 6) rather than an
            approximation of it. */}
        <p>{profile.warnings[0] ?? "There is no profile.md in this workspace."}</p>
        <p>
          Everything on this screen is read from that one file. Nothing else in the workspace
          changes when it is created.
        </p>
        <div>
          <button
            type="button"
            className="btn primary"
            disabled={!profile.templateAvailable || busy === "create"}
            onClick={handleCreate}
          >
            Create profile.md from the template
          </button>
        </div>
        {!profile.templateAvailable && (
          <p className="note">
            <span className="mono">templates/profile.template.md</span> is not in this workspace,
            so there is nothing to copy. Add the template, or write profile.md by hand.
          </p>
        )}
        <p className={saveError ? "note crit" : "note"}>
          {saveError ? `Create failed: ${saveError}` : busy === "create" ? "creating…" : ""}
        </p>
      </div>
    );
  }

  // ── The six sub-tabs ──────────────────────────────────────────────────────

  const tabDef = SUB_TABS.find((t) => t.id === tab) ?? SUB_TABS[0];
  const primaryPresent = present(tabDef.primary);
  const conflictSections = Array.from(new Set(drafts.conflicts.map(sectionKeyLabel)));

  const identityParsed: ParsedRow[] = profile.identity
    ? [
        { label: "Full name", value: profile.identity.parsed.fullName },
        { label: "First name", value: profile.identity.parsed.firstName },
        { label: "Last name", value: profile.identity.parsed.lastName },
        { label: "Email", value: profile.identity.parsed.email },
        { label: "Fallback email", value: profile.identity.parsed.fallbackEmail },
        { label: "Phone", value: profile.identity.parsed.phone },
      ]
    : [];

  const preferencesParsed: ParsedRow[] = profile.preferences
    ? [
        {
          label: "Target topics",
          value:
            profile.preferences.topics && profile.preferences.topics.length > 0
              ? profile.preferences.topics.join(", ")
              : null,
        },
        {
          label: "Title blocklist",
          value:
            profile.preferences.titleBlocklist && profile.preferences.titleBlocklist.length > 0
              ? profile.preferences.titleBlocklist.join(", ")
              : null,
        },
      ]
    : [];

  const qaKey = bodyKey("qaBank");
  const qaValue = Object.prototype.hasOwnProperty.call(drafts.drafts, qaKey)
    ? drafts.drafts[qaKey]
    : (profile.qaBank ?? "");

  /**
   * AC 3's absent-section state. It names the section, says what the agent does
   * without it, and carries an add control on the three editable sections ONLY
   * (Q3): inserting `### Resume region rules` verbatim would add the template's
   * denver/chicago example rows and change which resume the agent picks, in a
   * ticket that gives no way to edit or remove them. Add is offered exactly
   * where edit is.
   */
  function renderAbsent(id: ProfileSectionId) {
    const editable = isEditableSection(id);
    return (
      <div className="rb-banner warn card">
        <div className="rb-banner-head head">
          <h2 className="rb-h-major">{sectionLabel(id)}</h2>
          <Stamp tone="warn">not in profile.md</Stamp>
        </div>
        <div className="rb-empty state">
          <span className="glyph" aria-hidden="true">
            ∅
          </span>
          <p>
            There is no <span className="mono">{sectionLabel(id)}</span> section in profile.md.
          </p>
          <p>{sectionFallback(id)}</p>
          {editable ? (
            <>
              <div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!profile.templateAvailable || busy === `add:${id}`}
                  onClick={() => handleAddSection(id)}
                >
                  Add this section
                </button>
              </div>
              <p className="note">
                {profile.templateAvailable
                  ? "Copied from templates/profile.template.md and inserted in that file's own section order. Every other byte of profile.md is left as it is."
                  : "templates/profile.template.md is not in this workspace, so there is no section text to copy."}
              </p>
            </>
          ) : (
            <p className="note">
              There is no add control here on purpose: the template&rsquo;s rows are examples, and
              inserting them would change what the agent does in a section this ticket gives you no
              way to edit or remove. Add is offered exactly where edit is.
            </p>
          )}
        </div>
      </div>
    );
  }

  function renderTab() {
    switch (tabDef.id) {
      case "identity":
        return (
          <ProfileBulletForm
            id="identity"
            bullets={profile.identity?.bullets ?? []}
            drafts={drafts.drafts}
            parsed={identityParsed}
            parsedNote="These six fields are everything the extensions read out of Identity: the email picks the address an ATS account is created with, and the name and phone fill the form."
            dirty={sectionIsDirty(drafts, "identity")}
            saving={busy === "identity"}
            error={saveError}
            note={saveNote}
            onChange={(key, value) => handleChangeBullet("identity", key, value)}
            onSave={() => handleSaveBullets("identity", profile.identity?.bullets ?? [])}
            onAddBullet={(label, value) => handleAddBullet("identity", label, value)}
          />
        );
      case "searchPreferences":
        return (
          <ProfileBulletForm
            id="searchPreferences"
            bullets={profile.preferences?.bullets ?? []}
            drafts={drafts.drafts}
            parsed={preferencesParsed}
            parsedNote="The gatherer reads these two lists when it scores a posting. A bullet it cannot split into a comma- or slash-separated list reads as nothing, and the gatherer falls back to its own built-in filters."
            dirty={sectionIsDirty(drafts, "searchPreferences")}
            saving={busy === "searchPreferences"}
            error={saveError}
            note={saveNote}
            onChange={(key, value) => handleChangeBullet("searchPreferences", key, value)}
            onSave={() => handleSaveBullets("searchPreferences", profile.preferences?.bullets ?? [])}
            onAddBullet={(label, value) => handleAddBullet("searchPreferences", label, value)}
          />
        );
      case "qaBank":
        return (
          <ProfileQA
            value={qaValue}
            dirty={sectionIsDirty(drafts, "qaBank")}
            saving={busy === "qaBank"}
            error={saveField === "body" ? null : saveError}
            fieldError={saveField === "body" ? saveError : null}
            note={saveNote}
            onChange={handleChangeBody}
            onSave={handleSaveBody}
          />
        );
      case "resumes":
        return (
          <ProfileResumes
            resumes={resumes}
            resume={profile.resume}
            hasRegionRules={present("resumeRegionRules")}
            onUploaded={handleUpload}
            onAssign={async (filename, mode, replace) => { await assignResume(filename, mode, profile.revision ?? "", replace); onMutated(); }}
            regionMarkdown={drafts.drafts[bodyKey("resumeRegionRules")] ?? ""}
            regionDirty={sectionIsDirty(drafts, "resumeRegionRules")}
            onRegionChange={(value) => handleChangeMarkdown("resumeRegionRules", value)}
            onRegionSave={() => handleSaveMarkdown("resumeRegionRules")}
            regionSaving={busy === "resumeRegionRules"}
          />
        );
      case "addresses":
        return (
          <ProfileAddresses
            addresses={addresses}
            cityRuleCount={profile.cityRules.length}
            cityRuleTableRows={profile.cityRuleTableRows}
            hasNormalization={present("cityNormalization")}
            hasAddressPolicy={present("addressPolicy")}
            onSave={async (key, address) => { await saveAddress(key, address); onMutated(); }}
            markdown={{ cityRules: drafts.drafts[bodyKey("cityRules")] ?? "", cityNormalization: drafts.drafts[bodyKey("cityNormalization")] ?? "", addressPolicy: drafts.drafts[bodyKey("addressPolicy")] ?? "" }} onMarkdownChange={handleChangeMarkdown} onMarkdownSave={handleSaveMarkdown} markdownDirty={(id) => sectionIsDirty(drafts, id)} saving={busy}
          />
        );
      case "candidateSummary":
        return (
          <ProfileCandidateSummary
            value={drafts.drafts[bodyKey("candidateSummary")] ?? profile.markdownBodies.candidateSummary ?? ""}
            dirty={sectionIsDirty(drafts, "candidateSummary")}
            saving={busy === "candidateSummary"}
            error={saveField === "body" ? null : saveError}
            fieldError={saveField === "body" ? saveError : null}
            note={saveNote}
            onChange={(value) => handleChangeMarkdown("candidateSummary", value)}
            onSave={() => handleSaveMarkdown("candidateSummary")}
          />
        );
      case "workHistory":
        return <ProfileWorkHistory values={{ workHistory: drafts.drafts[bodyKey("workHistory")] ?? "", education: drafts.drafts[bodyKey("education")] ?? "", authorization: drafts.drafts[bodyKey("authorization")] ?? "" }} dirty={(id) => sectionIsDirty(drafts, id)} saving={busy} error={saveError} note={saveNote} onChange={handleChangeMarkdown} onSave={handleSaveMarkdown} />;
    }
  }

  return (
    <div className="rb-surface rb-workspace">
      {profile.warnings.length > 0 && (
        <div className="rb-banner warn card">
          <div className="rb-banner-head head">
            <h2 className="rb-h-major">Parser warnings</h2>
            <Stamp tone="warn">
              {profile.warnings.length}{" "}
              {profile.warnings.length === 1 ? "warning" : "warnings"}
            </Stamp>
          </div>
          {/* VERBATIM. These are `profile.warnings` exactly as the parser pushed
              them, so this banner reads word for word like what `pi /status`
              prints (AC 6). Rewording any of them would break that. */}
          {profile.warnings.map((w) => (
            <p className="note count crit" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}

      {drafts.conflicts.length > 0 && (
        <div className="rb-banner crit card">
          <div className="rb-banner-head head">
            <h2 className="rb-h-major">profile.md changed on disk while you were editing</h2>
            <Stamp tone="crit">conflict</Stamp>
          </div>
          <p className="note count crit">
            Your unsaved edits to {conflictSections.join(", ")} are still here and have not been
            touched. The file behind them has changed — another tab, the agent mid-run, or an
            editor. Saving now writes your version over the newer one.
          </p>
          <div className="note count">
            <button type="button" className="btn" onClick={handleDiscardConflicts}>
              Discard my changes and reload from disk
            </button>
          </div>
        </div>
      )}

      {/* The newest refresh did not land. The data below is the last that did,
          so this says so rather than replacing a working screen with an error. */}
      {error !== null && <p className="note crit">{`Refresh failed: ${error}`}</p>}

      {/* Selection is carried by aria-current, exactly as the rail carries it
          (`App.tsx`, styled at `index.css` `.nav button[aria-current]`), so the
          visual and the assistive-tech signal cannot drift apart. */}
      <nav className="rb-profile-nav subnav" aria-label="Profile sections">
        {SUB_TABS.map((t) => {
          const missing = !present(t.primary);
          const dirty = t.reads.some((s) => sectionIsDirty(drafts, s));
          return (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
              {missing && (
                <span className="count" title={`${sectionLabel(t.primary)} is not in profile.md`}>
                  ∅
                </span>
              )}
              {dirty && <span className="count">unsaved</span>}
            </button>
          );
        })}
        {profile.warnings.length > 0 && (
          <span className="count">
            {profile.warnings.length} {profile.warnings.length === 1 ? "warning" : "warnings"}
          </span>
        )}
      </nav>

      <div className="rb-profile-tab">
        {!primaryPresent && renderAbsent(tabDef.primary)}
        {/*
          The two disk-backed tabs still render below their absent-section
          block: `resumes/` and `state.json.addresses` exist independently of
          whether profile.md declares a section over them, and hiding what is on
          disk because a heading is missing would hide the very orphans this
          section exists to surface. The other four tabs have nothing left to
          show once their section is gone.
        */}
        {(primaryPresent || READS_DISK.includes(tabDef.id)) && renderTab()}
      </div>
    </div>
  );
}
