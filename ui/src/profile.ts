import {
  ADDRESS_RULE_STATES,
  PROFILE_EDITABLE_SECTION_IDS,
  RESUME_REACHABILITY,
  type AddressesPayload,
  type AddressUpdateBody,
  type AddressRuleState,
  type ProfileBodyUpdateBody,
  type ProfileBullet,
  type ProfileBulletsUpdateBody,
  type ProfileEditableSectionId,
  type ProfileMutationResult,
  type ProfilePayload,
  type ProfileSectionId,
  type ResumeReachability,
  type ResumesPayload,
  type ResumeUploadResult,
} from "../shared/types";
import type { Tone } from "./Stamp";
import { httpFetch as fetch } from "./http";

/**
 * A mutation failure that names the control the form should mark invalid.
 *
 * The same shape `AccountRequestError` (`accounts.ts:21`) carries, and for the
 * same reason: the profile write routes answer a validation failure with
 * `{ error, field }`, and a plain `errorMessage` collapses the body to a string
 * — losing `field` between the wrapper and the form that needs it.
 */
export type ProfileRequestError = Error & { field?: string };

/**
 * `errorMessage`'s fallback ladder, reproduced rather than called — forced by
 * the code, not preferred. `errorMessage` consumes the response itself
 * (`api.ts:63`, `const text = await res.text()`), and a `Response` body can be
 * read only once, so a helper that delegated to it would have nothing left to
 * parse `field` out of. `accounts.ts:24-30` spells the same reasoning out; this
 * is its twin, and the two must stay behaviourally identical.
 */
async function requestError(res: Response, route: string): Promise<ProfileRequestError> {
  const fallback = `${route} failed: ${res.status}`;
  let message = fallback;
  let field: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const body = parsed as { error?: unknown; field?: unknown };
        if (typeof body.error === "string") message = body.error;
        if (typeof body.field === "string") field = body.field;
      }
    }
  } catch {
    // a body that is missing, empty or not JSON keeps the bare status line
  }
  return Object.assign(new Error(message), field !== undefined ? { field } : {});
}

/**
 * The GETs throw the bare status line and the mutations read the body — the
 * rule `api.ts:44-58` records. Every profile mutation qualifies: a 409 names a
 * file that is missing or already there, and a 400 names the rejected field and
 * the cap it broke. A failing GET says nothing the URL does not.
 */
export async function fetchProfile(): Promise<ProfilePayload> {
  const res = await fetch("/api/profile");
  if (!res.ok) throw new Error(`GET /api/profile failed: ${res.status}`);
  return res.json() as Promise<ProfilePayload>;
}

export async function fetchResumes(): Promise<ResumesPayload> {
  const res = await fetch("/api/resumes");
  if (!res.ok) throw new Error(`GET /api/resumes failed: ${res.status}`);
  return res.json() as Promise<ResumesPayload>;
}

export async function fetchAddresses(): Promise<AddressesPayload> {
  const res = await fetch("/api/addresses");
  if (!res.ok) throw new Error(`GET /api/addresses failed: ${res.status}`);
  return res.json() as Promise<AddressesPayload>;
}

export async function saveAddress(key: string, address: AddressUpdateBody): Promise<AddressesPayload> {
  const res = await fetch(`/api/addresses/${encodeURIComponent(key)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(address) });
  if (!res.ok) throw await requestError(res, "PUT /api/addresses/:key");
  return res.json() as Promise<AddressesPayload>;
}

export async function uploadResume(file: File, replace = false): Promise<ResumeUploadResult> {
  const body = new FormData(); body.append("file", file, file.name); body.append("replace", String(replace));
  const res = await fetch("/api/resumes", { method: "POST", body });
  if (!res.ok) throw await requestError(res, "POST /api/resumes");
  return res.json() as Promise<ResumeUploadResult>;
}
export async function assignResume(filename: string, mode: "default" | "override", revision: string, replace = false): Promise<{ profile: ProfilePayload; resumes: ResumesPayload }> { const res = await fetch("/api/resumes/selection", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename, mode, revision, replace }) }); if (!res.ok) throw await requestError(res, "PUT /api/resumes/selection"); return res.json(); }

/** Create `profile.md` from `templates/profile.template.md`. 201, or a 409 that says why not. */
export async function createProfile(): Promise<ProfileMutationResult> {
  const res = await fetch("/api/profile", { method: "POST" });
  if (!res.ok) throw await requestError(res, "POST /api/profile");
  return res.json() as Promise<ProfileMutationResult>;
}

/** Append one absent section, in `templates/profile.template.md` order. */
export async function addProfileSection(
  id: ProfileEditableSectionId,
): Promise<ProfileMutationResult> {
  const res = await fetch(`/api/profile/sections/${encodeURIComponent(id)}`, { method: "POST" });
  if (!res.ok) throw await requestError(res, "POST /api/profile/sections/:id");
  return res.json() as Promise<ProfileMutationResult>;
}

export async function updateProfileBullets(
  id: ProfileEditableSectionId,
  bullets: ProfileBulletsUpdateBody["bullets"],
  revision?: string | null,
): Promise<ProfileMutationResult> {
  const res = await fetch(`/api/profile/sections/${encodeURIComponent(id)}/bullets`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bullets, revision: revision ?? "" } satisfies ProfileBulletsUpdateBody),
  });
  if (!res.ok) throw await requestError(res, "PATCH /api/profile/sections/:id/bullets");
  return res.json() as Promise<ProfileMutationResult>;
}

export async function updateProfileBody(
  id: ProfileEditableSectionId,
  body: string,
  revision?: string | null,
): Promise<ProfileMutationResult> {
  const res = await fetch(`/api/profile/sections/${encodeURIComponent(id)}/body`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, revision: revision ?? "" } satisfies ProfileBodyUpdateBody),
  });
  if (!res.ok) throw await requestError(res, "PUT /api/profile/sections/:id/body");
  return res.json() as Promise<ProfileMutationResult>;
}

// ── Drafts, and why they exist ──────────────────────────────────────────────

/**
 * A COMPOSITE KEY, AND THAT IS WHAT MAKES ONE FUNCTION SERVE BOTH FORM SHAPES.
 *
 * A body section keys as its `ProfileSectionId` (`"qaBank"`); a bullet keys as
 * `` `${ProfileSectionId}.${bulletKey}` `` (`"identity.email"`). Both are flat
 * strings, so `reconcileDrafts` needs no branch and the dirty rule is identical
 * for a textarea and a text input. Without the composite, the helper would
 * serve the Q&A tab alone and the Identity form would have no dirty tracking at
 * all — which is the SSE clobber back again, on the form the user edits most.
 *
 * `bodyKey`, `bulletKey` and `sectionOfKey` are the ONLY three places that know
 * the format. Nothing else may take a key apart.
 */
export type DraftKey = string;

export function bodyKey(id: ProfileSectionId): DraftKey {
  return id;
}

export function bulletKey(id: ProfileSectionId, key: string): DraftKey {
  return `${id}.${key}`;
}

/** The `ProfileSectionId` half of either key shape. */
export function sectionOfKey(key: DraftKey): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * What the forms are showing, what the server last said, and where the two have
 * diverged behind the user's back.
 *
 * A key is DIRTY when `drafts[k] !== baselines[k]`. That single comparison is
 * the whole dirty rule; there is no separate flag to keep in step.
 */
export interface DraftState {
  drafts: Record<DraftKey, string>;
  baselines: Record<DraftKey, string>;
  conflicts: DraftKey[];
}

export const EMPTY_DRAFTS: DraftState = { drafts: {}, baselines: {}, conflicts: [] };

/** Every editable value in a payload, flattened onto its `DraftKey`. */
export function draftsFromPayload(profile: ProfilePayload): Record<DraftKey, string> {
  const incoming: Record<DraftKey, string> = {};
  if (profile.identity) {
    for (const b of profile.identity.bullets) {
      incoming[bulletKey("identity", b.key)] = b.value ?? "";
    }
  }
  if (profile.preferences) {
    for (const b of profile.preferences.bullets) {
      incoming[bulletKey("searchPreferences", b.key)] = b.value ?? "";
    }
  }
  if (profile.qaBank !== null) incoming[bodyKey("qaBank")] = profile.qaBank;
  for (const id of ["resumeRegionRules", "cityRules", "cityNormalization", "addressPolicy", "workHistory", "education", "authorization", "candidateSummary"] as const) {
    if (profile.markdownBodies[id] !== undefined) incoming[bodyKey(id)] = profile.markdownBodies[id] ?? "";
  }
  return incoming;
}

/**
 * THIS IS THE ANSWER TO "A PROFILE SAVE FIRES AN SSE FRAME".
 *
 * `profile.md` sits at depth 0 and matches none of the six `WATCH_IGNORED`
 * patterns (`server/routes/events.ts:14-21`), so EVERY section save triggers a
 * full `refresh()` within one debounce window. A view that re-seeded its forms
 * from props on every payload would silently revert an unsaved draft in a
 * sibling sub-tab — no error, no warning, the text simply changes back. That
 * invisibility is what makes it the subtlest bug in this ticket.
 *
 * Per key:
 *   - unseen                                  → seed draft and baseline
 *   - clean (`drafts[k] === baselines[k]`)    → replace both
 *   - dirty, `incoming[k] === baselines[k]`   → keep the draft untouched
 *   - dirty, `incoming[k] !== baselines[k]`   → keep the draft, keep the OLD
 *                                               baseline, raise a conflict
 *
 * The third arm is the save-a-sibling case; the fourth is an EXTERNAL edit to
 * `profile.md` while a draft is dirty, which is made visible rather than
 * silently overwritten. A key that disappears from the payload — its section
 * was deleted on disk — drops out of all three maps.
 *
 * Deliberately NOT solved by suppressing the refresh: suppression would need
 * state inside the SSE path, which this ticket freezes.
 */
export function reconcileDrafts(
  prev: DraftState,
  incoming: Record<DraftKey, string>,
): DraftState {
  const drafts: Record<DraftKey, string> = {};
  const baselines: Record<DraftKey, string> = {};
  const conflicts: DraftKey[] = [];

  for (const key of Object.keys(incoming)) {
    const next = incoming[key];
    const seen = Object.prototype.hasOwnProperty.call(prev.baselines, key);
    if (!seen) {
      drafts[key] = next;
      baselines[key] = next;
      continue;
    }
    const baseline = prev.baselines[key];
    const draft = prev.drafts[key] ?? baseline;
    if (draft === baseline) {
      drafts[key] = next;
      baselines[key] = next;
      continue;
    }
    drafts[key] = draft;
    baselines[key] = baseline;
    if (next !== baseline) conflicts.push(key);
  }

  return { drafts, baselines, conflicts };
}

/**
 * Clear one key's dirty flag and its conflict by setting both sides to the
 * server's value. Used after a successful save, and by the conflict banner's
 * "discard my changes" control — the two are the same operation, because both
 * mean "the file on disk is now what this form should show".
 */
export function commitDraft(prev: DraftState, key: DraftKey, value: string): DraftState {
  return {
    drafts: { ...prev.drafts, [key]: value },
    baselines: { ...prev.baselines, [key]: value },
    conflicts: prev.conflicts.filter((c) => c !== key),
  };
}

/** Whether any key belonging to `id` is dirty — the sub-nav's "unsaved" marker. */
export function sectionIsDirty(state: DraftState, id: ProfileSectionId): boolean {
  return Object.keys(state.drafts).some(
    (k) => sectionOfKey(k) === id && state.drafts[k] !== state.baselines[k],
  );
}

/**
 * Only the keys the user actually touched.
 *
 * THIS IS THE EXACT BUG `5eaede0` AND `2abba75` FIXED ON `main` for the accounts
 * form: a PATCH that carries a field nobody edited rewrites it, and the writer
 * stores raw text, so "rewrites it" can mean trimming a value the user never
 * looked at. Cheaper to build in than to fix twice.
 *
 * An emptied value is sent as `null`, not `""` (Q6): the route clears the value
 * and keeps the bullet, its label and its position. Whitespace is NOT trimmed
 * (Q4) — the writer stores raw text and `cleanValue` does the trimming on the
 * read side, so trimming here would silently discard an edit and break the
 * byte-level round-trip claim.
 */
export function changedBullets(
  id: ProfileSectionId,
  bullets: readonly ProfileBullet[],
  drafts: Record<DraftKey, string>,
): Record<string, string | null> {
  const changed: Record<string, string | null> = {};
  for (const bullet of bullets) {
    const key = bulletKey(id, bullet.key);
    if (!Object.prototype.hasOwnProperty.call(drafts, key)) continue;
    const draft = drafts[key];
    if (draft === (bullet.value ?? "")) continue;
    changed[bullet.key] = draft === "" ? null : draft;
  }
  return changed;
}

// ── Tones and labels ────────────────────────────────────────────────────────

/**
 * Widened to `string` on purpose, exactly as `loginStatusTone` (`accounts.ts:153`)
 * is: the payload is typed, but a tone lookup is the wrong place to crash a
 * whole table if a server of a different vintage sends a sixth word. Text
 * carries the state and the `Stamp` glyph carries the shape (`index.css:435-487`);
 * colour only reinforces both.
 */
export function isReachability(value: string): value is ResumeReachability {
  return (RESUME_REACHABILITY as readonly string[]).includes(value);
}

export function reachabilityTone(value: string): Tone {
  if (!isReachability(value)) return "neutral";
  switch (value) {
    case "default":
    case "region":
    case "override":
      return "good";
    case "shadowed":
      return "neutral";
    case "orphan":
      return "warn";
  }
}

/** The stored word, so an unrecognized state stays visible rather than hidden. */
export function reachabilityLabel(value: string): string {
  return value;
}

/** One sentence per state — the table's "why" column, and the honest part. */
export function reachabilityNote(value: string): string {
  if (!isReachability(value)) return "unrecognized state";
  switch (value) {
    case "default":
      return "the fallback for every unmatched location";
    case "region":
      return "picked when a posting matches this region rule";
    case "override":
      return "the one file every application uses while the override is set";
    case "shadowed":
      return "reachable, but the resume-path override outranks it";
    case "orphan":
      return "no rule and no override can select this file";
  }
}

export function isAddressRuleState(value: string): value is AddressRuleState {
  return (ADDRESS_RULE_STATES as readonly string[]).includes(value);
}

export function addressStateTone(value: string): Tone {
  if (!isAddressRuleState(value)) return "neutral";
  switch (value) {
    case "resolved":
      return "good";
    case "pending":
      return "neutral";
    case "orphan":
      return "warn";
  }
}

export function addressStateLabel(value: string): string {
  return value;
}

// ── Sections and sub-tabs ───────────────────────────────────────────────────

/**
 * Exhaustive by construction: a `Record` over the union, so adding a
 * `ProfileSectionId` without a label fails to compile, and case 13.14 asserts
 * the same thing at runtime for anyone reading the JSON rather than the type.
 */
const SECTION_LABELS: Record<ProfileSectionId, string> = {
  identity: "Identity",
  resume: "Resume",
  resumeRegionRules: "Resume region rules",
  cityRules: "City → address rules",
  cityNormalization: "City normalization rules",
  workHistory: "Work history",
  education: "Education",
  authorization: "Authorization",
  qaBank: "Q&A bank",
  searchPreferences: "Job search preferences",
  candidateSummary: "Candidate summary",
  addressPolicy: "Address policy reminder",
};

export function sectionLabel(id: ProfileSectionId): string {
  return SECTION_LABELS[id];
}

/**
 * What the agent does when a section is absent. Rendered in the empty state so
 * "this section is missing" is never the whole message — the user needs to know
 * whether the absence costs them anything.
 */
const SECTION_FALLBACKS: Record<ProfileSectionId, string> = {
  identity:
    "Without it the agent has no name, email or phone to put in a form, and stops to ask on the first field.",
  resume:
    "Without it there is no single-resume override, so the agent uses the per-region lookup and falls back to resumes/default.pdf.",
  resumeRegionRules:
    "Without it no location maps to a region resume, so every application uses resumes/default.pdf.",
  cityRules:
    "Without it no posting maps to an address key, so the agent stops and asks whenever a form needs a real address.",
  cityNormalization:
    "Without it the agent applies its own normalization when a posting's city does not match a row exactly.",
  workHistory:
    "Without it the gatherer composes its candidate summary from Identity alone, which scores postings poorly.",
  education: "Without it the agent stops and asks whenever a form requires a degree or institution.",
  authorization:
    "Without it the agent stops and asks about work authorization, sponsorship and clearance on every form that requires them.",
  qaBank:
    "Without it the agent has no pre-decided answers, so it stops and asks on salary, notice period and every open-ended question.",
  searchPreferences:
    "Without it the gatherer applies its own built-in topic and title filters instead of yours.",
  candidateSummary:
    "Without it the gatherer composes a summary from Identity and Work history instead of the one you wrote.",
  addressPolicy:
    "Without it the reminder that generate_address may use only the declared ZIPs is not in the prompt the agent reads.",
};

export function sectionFallback(id: ProfileSectionId): string {
  return SECTION_FALLBACKS[id];
}

export function isEditableSection(id: ProfileSectionId): id is ProfileEditableSectionId {
  return (PROFILE_EDITABLE_SECTION_IDS as readonly string[]).includes(id);
}

export type SubTabId =
  | "identity"
  | "resumes"
  | "addresses"
  | "qaBank"
  | "searchPreferences"
  | "workHistory"
  | "candidateSummary";

export interface SubTab {
  id: SubTabId;
  label: string;
  /** The section whose absence renders the tab's empty state. */
  primary: ProfileSectionId;
  /** Every section the tab reads, `primary` first. */
  reads: readonly ProfileSectionId[];
}

/** The six sub-tabs of AC 1, in the order the rail's own sections read. */
export const SUB_TABS: readonly SubTab[] = [
  { id: "identity", label: "Identity", primary: "identity", reads: ["identity"] },
  { id: "resumes", label: "Resumes", primary: "resume", reads: ["resume", "resumeRegionRules"] },
  {
    id: "addresses",
    label: "Addresses",
    primary: "cityRules",
    reads: ["cityRules", "cityNormalization", "addressPolicy"],
  },
  { id: "qaBank", label: "Q&A bank", primary: "qaBank", reads: ["qaBank"] },
  {
    id: "searchPreferences",
    label: "Job preferences",
    primary: "searchPreferences",
    reads: ["searchPreferences"],
  },
  { id: "workHistory", label: "Work history", primary: "workHistory", reads: ["workHistory"] },
  {
    id: "candidateSummary",
    label: "Candidate summary",
    primary: "candidateSummary",
    reads: ["candidateSummary"],
  },
];
