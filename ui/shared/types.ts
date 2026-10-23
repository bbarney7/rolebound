// ─────────────────────────────────────────────────────────────────────────────
// Shared types for pi-jobs UI. Two layers:
//   Raw*       — on-disk shapes exactly as they exist (snake_case, all optional)
//   others     — normalized camelCase view models the API serves
// ─────────────────────────────────────────────────────────────────────────────

// ── Normalized view models ──

export type ApplyState =
  | "queued"
  | "in_progress"
  | "paused_for_user"
  | "submitted"
  | "aborted"
  | "blocked"
  | "failed";

export const APPLY_STATES: readonly ApplyState[] = [
  "queued",
  "in_progress",
  "paused_for_user",
  "submitted",
  "aborted",
  "blocked",
  "failed",
];

export type PipelineStatus =
  | "submitted"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn"
  | "no_response";

export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
];

export type LoginStatus = "success" | "failed" | "pending";

export const LOGIN_STATUSES: readonly LoginStatus[] = ["success", "failed", "pending"];

/** The exact union the job-accounts extension writes (.pi/extensions/job-accounts.ts:43). */
export type AtsKind =
  | "workday"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "icims"
  | "smartrecruiters"
  | "bamboohr"
  | "other";

export const ATS_KINDS: readonly AtsKind[] = [
  "workday",
  "greenhouse",
  "lever",
  "ashby",
  "icims",
  "smartrecruiters",
  "bamboohr",
  "other",
];

export interface MailingAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface Address extends MailingAddress {
  cityKey: string;
}

export interface Attempt {
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  notes: string | null;
}

export interface Application {
  slug: string;
  url: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  source: string | null;
  applyState: ApplyState;
  /** null is the legal value for non-submitted applications */
  pipelineStatus: PipelineStatus | null;
  /** true when the user explicitly set pipelineStatus (vs derived) */
  pipelineExplicit: boolean;
  submittedAt: string | null;
  /** true when synthesized from jobs/applied/<slug>.md (no state.json record) */
  estimated: boolean;
  resumePath: string | null;
  resumeKey: string | null;
  addressCityKey: string | null;
  addressUsed: MailingAddress | null;
  attempts: Attempt[];
  screenshot: string | null;
  verificationEmailId: string | null;
  abortReason: string | null;
  blockReason: string | null;
  jobFilePath: string | null;
  descriptionExcerpt: string | null;
  /**
   * state.json's recorded `queue_file`, verbatim. NOT always
   * `jobs/queue/<slug>.md` — the applier emits prefixed names such as
   * `jobs/queue/0-<slug>.md`, and it repoints the value at jobs/applied/ once
   * a row is submitted. The detail route needs it to find the posting for a
   * row that was never submitted.
   */
  queueFile: string | null;
  userNotes: string | null;
  /**
   * state.json top-level last_updated for tracked entries;
   * best-available date (submitted_at → applied_at → mtime) for synthesized ones.
   */
  lastUpdated: string | null;
}

export interface QueueItem {
  slug: string;
  /**
   * WORKSPACE-RELATIVE path of the backing file — always
   * `jobs/queue/<slug>.md`, with forward slashes, never an absolute path.
   * Nothing in the client needs the absolute form, and publishing it would leak
   * the server's local filesystem layout to every browser that loads the queue.
   *
   * The relative form is not a new convention: it is exactly what state.json
   * records in `queue_file` and exactly what `Application.queueFile` (:96)
   * already carries, so both path-bearing wire fields read the same way.
   */
  filePath: string;
  url: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  source: string | null;
  match: string | null;
  discoveredAt: string | null;
  /**
   * The file's ctime, ISO. Labelled "In queue since" in the UI and NOT a
   * recorded queue timestamp — no such field exists on disk. fs.rename
   * preserves mtime and birthtime, so on a gatherer-promoted file both still
   * describe when the gatherer DISCOVERED it; ctime is the only stamp that
   * moved to the promote. For a UI-authored file all of them collapse to the
   * same instant. ctime also moves on any later inode change, which is why the
   * column is labelled by provenance rather than presented as a queue time.
   */
  queuedAt: string;
  llmScore: number | null;
  llmReasoning: string | null;
  ats: string | null;
  reqId: string | null;
  /** advisory — see resumeKey */
  resume: string | null;
  /**
   * Advisory only. The applier hard-codes its resume path
   * (job-applier.ts:118-119, "Always use the single up-to-date resume
   * regardless of location") and derives the address from `location` via
   * state.json.addresses. It never opens a queue file in code — but
   * CLAUDE.md:41 tells the agent to read and parse the frontmatter, so the
   * value does reach the LLM. Write it, label it advisory, promise nothing
   * mechanical.
   */
  resumeKey: string | null;
  /** advisory — see resumeKey */
  addressCityKey: string | null;
  descriptionExcerpt: string | null;
  /**
   * Index in the applier's own consumption order: filenames INCLUDING the
   * ".md" suffix, compared as UTF-16 code units —
   * `files.filter((f) => f.endsWith(".md")).sort()` at job-applier.ts:669 and
   * :897, with /apply-next taking mdFiles[0] at :902. listQueue re-sorts to
   * match; see its JSDoc. This is NOT the same as sorting the bare slugs,
   * which is what this comment used to claim.
   */
  position: number;
}

export interface ATSAccount {
  host: string;
  username: string | null;
  emailUsed: string | null;
  ats: string | null;
  company: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  lastLoginStatus: string | null;
  notes: string | null;
  /** password is never serialized — only its existence */
  hasPassword: boolean;
}

export interface ResumeInfo {
  canonicalPath: string;
  workspaceCopy: string;
  deprecated: string[];
}

export interface UiApplicationState {
  pipelineStatus?: PipelineStatus;
  userNotes?: string;
  pipelineUpdatedAt?: string;
}

export interface UiState {
  version: 1;
  applications: Record<string, UiApplicationState>;
}

export type CorruptWorkspaceFile = "credentials.json" | "gather_state.json" | "state.json" | ".pi-jobs/captcha-spend.json";

export interface Overview {
  applications: {
    total: number;
    tracked: number;
    estimated: number;
    byApplyState: Partial<Record<ApplyState, number>>;
    byPipelineStatus: Record<string, number>;
  } | null;
  queue: number;
  discovered: number;
  accounts: number | null;
  addresses: number | null;
  lastFullGather: string | null;
  /** The effective solver: "off" unless a provider AND a key resolve. */
  captchaSolver: CaptchaProviderChoice;
  corrupt: CorruptWorkspaceFile[];
}

// ── Settings (settings.json; the contract is .pi/extensions/lib/captcha.ts) ──

export type CaptchaProviderId = "capsolver" | "2captcha";
export type CaptchaProviderChoice = CaptchaProviderId | "off";
export type CaptchaKind = "hcaptcha" | "recaptcha_v2" | "recaptcha_v3" | "turnstile";

/** GET /api/settings and the body every settings mutation answers with. */
export interface CaptchaSettingsPayload {
  provider: CaptchaProviderChoice;
  /** A key resolves from the file or the provider's env var. */
  hasApiKey: boolean;
  /** "…" + last four of a FILE-stored key, shown whenever settings.json has one — even while an env key or the "off" provider is what's effective; null only when no file key is stored. */
  keyHint: string | null;
  keySource: "env" | "file" | "none";
  /** A key is stored in settings.json, whatever the current provider — unlike hasApiKey/keySource, this ignores the env var and the "off" state. */
  fileHasKey: boolean;
  warnings: string[];
  providers: { id: CaptchaProviderId; label: string; envVar: string; supports: CaptchaKind[] }[];
  maxPaidTasksPerDay: number;
  dailyPaidTasksCount: number;
}

/** PUT /api/settings/captcha. `apiKey` absent = keep; null or "" = clear. */
export interface CaptchaSettingsUpdateBody {
  provider: CaptchaProviderChoice;
  apiKey?: string | null;
  maxPaidTasksPerDay?: number;
}

/** POST /api/settings/captcha/test. Both absent = test the stored key. */
export interface CaptchaTestBody {
  provider?: CaptchaProviderId;
  apiKey?: string;
}

export type CaptchaTestResponse =
  | { ok: true; provider: CaptchaProviderId; balance: number }
  | { ok: false; provider: CaptchaProviderId; error: string };

export interface ApplicationDetailPayload {
  application: Application;
  /** ui-state-owned; applyUiOverlay never copies it onto Application */
  pipelineUpdatedAt: string | null;
  /** full uncapped job-file body; null when neither an applied nor a queue md exists */
  body: string | null;
  /**
   * Which directory `body`/`ats`/`reqId` actually came from — the real dir, not
   * a guess from which lookup found it. A row that was never submitted
   * (in_progress/blocked/aborted) still has its posting in jobs/queue/, so the
   * detail view must distinguish "the JD we submitted against" from "the JD we
   * were about to submit against". `queue_file` can legitimately point into
   * jobs/applied/ (the applier repoints it on submit), so labelling anything
   * found via that lookup "queue" would call a submitted application unsent.
   *
   * Literal union rather than an import of workspace.ts's `JobDir` — this file
   * is a zero-import leaf and must stay one. The two are kept in step by
   * applications.ts, which assigns a `JobDir` into this field.
   */
  bodySource: "queue" | "applied" | "discovered" | null;
  ats: string | null;
  reqId: string | null;
  atsAccount: ATSAccount | null;
}

/**
 * PATCH body — a PARTIAL update. Key presence is the discriminator: a field
 * absent from the body is left untouched on disk; a field present with an
 * explicit null is deleted; a field present with a value sets it. Destructuring
 * cannot tell absent from null-valued — the handler uses hasOwnProperty.
 */
export interface PipelineUpdateBody {
  pipelineStatus?: PipelineStatus | null;
  userNotes?: string | null;
}

/**
 * POST /api/queue body — author a queue file from scratch.
 *
 * url/company/title/location are the four keys CLAUDE.md:21-35 marks required
 * ("If any required field is missing, stop and ask"), so the route rejects an
 * incomplete body with 400 BEFORE any filesystem call rather than writing a
 * file that halts the applier.
 *
 * Every value here is emitted into YAML-ish frontmatter VERBATIM — no quoting,
 * no escaping — so each is rejected with 400 if it contains a newline, a
 * carriage return, or any other C0 control character, or if the real
 * gray-matter would silently reinterpret it. `body` is the one exception: it
 * lands after the closing `---`, where a newline is ordinary text.
 */
export interface QueueCreateBody {
  url: string;
  company: string;
  title: string;
  location: string;
  source?: string;
  /** advisory override, written as `resume_key:` */
  resumeKey?: string;
  /** advisory override, written as `address_city_key:` */
  addressCityKey?: string;
  /**
   * Optional filename override. Absent, the server derives the slug from
   * company + title with the gatherer's own algorithm. Either way the value
   * must clear the write-side slug guard, and creation uses the "wx" flag, so
   * an existing name is a 409 and never a silent overwrite.
   */
  slug?: string;
  /** emitted as an `ATS: <value>` body line, which jobFiles.ts:119 parses back */
  ats?: string;
  /** free-form markdown body written after the closing `---` */
  body?: string;
}

/** POST /api/queue/promote body — move jobs/discovered/<slug>.md into the queue. */
export interface QueuePromoteBody {
  slug: string;
}

/**
 * The response shape of every queue mutation. history-view D13 generalized: a
 * mutating endpoint returns the re-derived payload, never `{ ok: true }`. The
 * client cannot recompute `position` after a change without forking the sort
 * that listQueue exists to centralize.
 */
export interface QueueMutationResult {
  /** the queue re-listed from disk AFTER the mutation, in consumption order */
  queue: QueueItem[];
  /**
   * The single item the mutation acted on.
   *
   * POST / and POST /promote: the newly written entry, re-read from disk, and
   * therefore also present in `queue` at its `position`.
   *
   * DELETE: the record as it was read IMMEDIATELY BEFORE the unlink, and
   * deliberately NOT present in `queue`. Delete is an irreversible fs.unlink
   * with no undo, so this is the user's only record of what was removed;
   * `position` is the index the file held in the pre-delete listing. It records
   * what the path held at that moment — it does not prove which inode was
   * unlinked, and no consumer may claim it does.
   *
   * Nullable: a mutation can succeed while the re-read that would describe it
   * finds nothing, and callers must handle that rather than assume.
   */
  item: QueueItem | null;
  /**
   * Non-null when the queue file operation succeeded but the best-effort
   * gather_state.json seen_urls hint did not. The request still succeeded —
   * returning 500 after the file already exists would invite a retry that then
   * 409s on the file the first attempt created.
   */
  warning: string | null;
  /** true when DELETE stopped an active apply run for this slug */
  runStopped?: boolean;
}

/**
 * A row of GET /api/queue/discovered — the promote picker's source. A metadata
 * projection of jobs/discovered/<slug>.md, deliberately without the body: the
 * directory holds 929 files and ~969KB of body text, and the picker needs only
 * enough to identify a posting.
 */
export interface DiscoveredItem {
  slug: string;
  url: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  source: string | null;
  match: string | null;
  llmScore: number | null;
  discoveredAt: string | null;
}

/**
 * GET /api/accounts/:host — the account plus the applications that resolve to
 * it. `applications` are exactly the ones `findAccount` (routes/applications.ts)
 * maps to this host, so the two directions are one rule.
 */
export interface AccountDetailPayload {
  account: ATSAccount;
  applications: Application[];
}

/**
 * POST /api/accounts body — camelCase on the wire, snake_case on disk.
 * `host` and `username` are the only required keys.
 */
export interface AccountCreateBody {
  host: string;
  username: string;
  password?: string;
  emailUsed?: string;
  ats?: AtsKind;
  company?: string;
  notes?: string;
}

/**
 * PATCH body — a PARTIAL update. Key presence is the discriminator: a field
 * absent from the body is left untouched on disk; a field present with an
 * explicit null is deleted; a field present with a value sets it. Destructuring
 * cannot tell absent from null-valued — the handler uses hasOwnProperty.
 *
 * `password` has three states and no fourth: absent keeps the stored value,
 * null removes it, and any other string replaces it VERBATIM. The empty string
 * is NOT a value this route accepts — it answers 400 rather than choosing
 * between "keep" and "delete" — so a client with nothing to change omits the
 * key entirely.
 */
export interface AccountUpdateBody {
  username?: string | null;
  emailUsed?: string | null;
  ats?: AtsKind | null;
  company?: string | null;
  notes?: string | null;
  lastLoginStatus?: LoginStatus | null;
  password?: string | null;
}

/** The one route that returns a password (Decision 1). Exactly this one key. */
export interface AccountRevealResponse {
  password: string;
}

/**
 * The response shape of every accounts mutation, modelled on
 * QueueMutationResult: a mutating endpoint returns the re-derived payload,
 * never `{ ok: true }`.
 */
export interface AccountMutationResult {
  /** every account re-read from disk AFTER the mutation, in the route's sort */
  accounts: ATSAccount[];
  /**
   * The single account the mutation acted on.
   *
   * POST / and PATCH /:host: the entry as written, mapped through the same
   * password-stripping projection the list uses, and therefore also present in
   * `accounts`.
   *
   * DELETE: the account as it was read IMMEDIATELY BEFORE removal, and
   * deliberately ABSENT from `accounts`.
   *
   * Nullable: a mutation can succeed while the re-read that would describe it
   * finds nothing, and callers must handle that rather than assume.
   */
  account: ATSAccount | null;
}

// ── Profile ──

/**
 * One member per `##`/`###` heading in `templates/profile.template.md`
 * (`:10, :22, :33, :43, :59, :67, :81, :86, :92, :137, :147, :172`).
 *
 * These are RESTATED, not imported: `shared/types.ts` imports nothing, so it
 * cannot pull `Profile` from `.pi/extensions/lib/profile.ts`. The reader maps
 * that parsed model onto the wire types below, which is what lets the contract
 * deliberately OMIT a field the parser produces (see `ProfileCityRuleView`).
 */
export type ProfileSectionId =
  | "identity"
  | "resume"
  | "resumeRegionRules"
  | "cityRules"
  | "cityNormalization"
  | "workHistory"
  | "education"
  | "authorization"
  | "qaBank"
  | "searchPreferences"
  | "candidateSummary"
  | "addressPolicy";

/** Template order, and `insertSection` derives its placement rule from it. */
export const PROFILE_SECTION_IDS: readonly ProfileSectionId[] = [
  "identity",
  "resume",
  "resumeRegionRules",
  "cityRules",
  "cityNormalization",
  "workHistory",
  "education",
  "authorization",
  "qaBank",
  "searchPreferences",
  "candidateSummary",
  "addressPolicy",
];

/**
 * The three sections this ticket can write. This is the whitelist the write
 * routes validate `:id` against, and it is also the whitelist the "add this
 * section" affordance uses: add is offered exactly where edit is offered.
 */
export type ProfileEditableSectionId = "identity" | "resume" | "resumeRegionRules" | "cityRules" | "cityNormalization" | "addressPolicy" | "workHistory" | "education" | "authorization" | "qaBank" | "searchPreferences" | "candidateSummary";

export const PROFILE_EDITABLE_SECTION_IDS: readonly ProfileEditableSectionId[] = [
  "identity",
  "resume",
  "resumeRegionRules",
  "cityRules",
  "cityNormalization",
  "addressPolicy",
  "workHistory",
  "education",
  "authorization",
  "qaBank",
  "searchPreferences",
  "candidateSummary",
];

/**
 * Presence as the raw-text locator sees it — never as `parseProfile` sees it,
 * which synthesises `candidateSummary` and cannot distinguish absent from empty.
 *
 * `heading` is the text AS IT APPEARS ON DISK, which differs from the
 * template's: the live file's is `` City → Address rules (`address_city_key`) ``.
 * `line` is 1-based. Both are null when the section is absent.
 */
export interface ProfileSectionInfo {
  id: ProfileSectionId;
  heading: string | null;
  present: boolean;
  line: number | null;
}

/**
 * One `- **Key:** value` bullet, as raw text.
 *
 * `label` is the bold text between `**` and the colon; `key` is that
 * lowercased, matching `parseBullets` (`.pi/extensions/lib/profile.ts:138`).
 * `value` is the raw text after the colon BEFORE `cleanValue` and BEFORE any
 * trailing HTML comment — so an italic aside round-trips into the form and back
 * out unchanged, while a commented tail never appears in an input the user
 * could edit. Reader and writer stop at the same index by construction: the
 * writer splices exactly the run the reader scanned.
 */
export interface ProfileBullet {
  key: string;
  label: string;
  value: string | null;
}

/**
 * `bullets` is what the form edits; `parsed` is what the agent actually reads,
 * rendered beside it — so a bullet whose value `cleanValue` discards
 * (`*(none)*`, `<FILL IN>`) is visibly NOT what the agent sees.
 */
export interface ProfileIdentityView {
  bullets: ProfileBullet[];
  parsed: {
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    fallbackEmail: string | null;
    phone: string | null;
  };
}

export interface ProfilePreferencesView {
  bullets: ProfileBullet[];
  topics: string[] | null;
  titleBlocklist: string[] | null;
}

export interface ProfileResumeRegionRuleView {
  key: string;
  terms: string[];
}

export interface ProfileResumeView {
  /** the `## Resume` path bullet, verbatim; null when there is no override */
  overridePath: string | null;
  /** `overridePath` resolved the way `resolveResumePath` resolves it */
  overrideResolved: string | null;
  /** null when there is no override at all */
  overrideExists: boolean | null;
  regionRules: ProfileResumeRegionRuleView[];
}

/**
 * A city rule as the Addresses tab renders it.
 *
 * `terms` IS DELIBERATELY ABSENT AND THAT IS LOAD-BEARING. The live table has
 * three columns, so `parseCityRules` falls back to `row[2]` for ZIPs
 * (`.pi/extensions/lib/profile.ts:280`) AND ALSO splits that same cell into
 * terms (`:277-278`), yielding
 * `terms: ["seattle", "one of {98101", "98103", …]`. `zips` is correct; `terms`
 * is garbage on real data. Do not "complete" this type by adding it back — the
 * UI would render that garbage, and case 10.6 asserts the key is absent from
 * the JSON.
 */
export interface ProfileCityRuleView {
  key: string;
  city: string;
  state: string;
  zips: string[];
}

export interface ProfileWorkEntry {
  heading: string;
  lines: string[];
}

export interface InstructionsSections {
  applying: string;
  finding: string;
  chat: string;
}

export interface InstructionsPayload {
  revision: string | null;
  data: InstructionsSections;
}

export interface InstructionsUpdateBody extends InstructionsSections {
  expectedRevision: string | null;
}

/**
 * Everything `GET /api/profile` serves. Always 200, even with no `profile.md`.
 *
 * A `null` section view means ABSENT ON DISK, and that is distinct from a
 * present-but-empty one, which is `{ bullets: [], … }`. The distinction is AC 3
 * and it exists only because `sections` comes from the raw-text locator rather
 * than from the parsed `Profile`.
 */
export interface ProfilePayload {
  /** SHA-256 of the exact profile.md bytes; required by every subsequent write. */
  revision: string | null;
  exists: boolean;
  /** whether `templates/profile.template.md` is readable at this root */
  templateAvailable: boolean;
  /** `profile.warnings` VERBATIM, so the banner matches what `/status` prints */
  warnings: string[];
  sections: ProfileSectionInfo[];
  identity: ProfileIdentityView | null;
  preferences: ProfilePreferencesView | null;
  /** the exact `[bodyStart, bodyWithSubsectionsEnd)` slice, or null when absent */
  qaBank: string | null;
  workHistory: ProfileWorkEntry[];
  /** Verbatim bodies for complex sections whose Markdown structure is user-owned. */
  markdownBodies: Partial<Record<"resumeRegionRules" | "cityRules" | "cityNormalization" | "addressPolicy" | "workHistory" | "education" | "authorization" | "candidateSummary", string>>;
  resume: ProfileResumeView | null;
  cityRules: ProfileCityRuleView[];
  /**
   * Raw count of table rows under `## City → Address rules` (header and
   * separator excluded). Larger than `cityRules.length` when `parseCityRules`
   * dropped rows, which is how the tab can say "3 of 12 rows are unusable".
   */
  cityRuleTableRows: number;
}

/**
 * PATCH body — a PARTIAL update, keyed by bullet key. Key presence is the
 * discriminator: a key absent from `bullets` is left untouched on disk; a key
 * present with an explicit null clears the value while keeping the line; a key
 * present with a value sets it. Destructuring cannot tell absent from
 * null-valued — the handler uses hasOwnProperty.
 */
export interface ProfileBulletsUpdateBody {
  revision: string | null;
  bullets: Record<string, string | null>;
}

/** PUT body — the section body, saved verbatim, nothing interpreted. */
export interface ProfileBodyUpdateBody {
  revision: string | null;
  body: string;
}

export interface ResumeUploadResult extends ResumesPayload {
  uploaded: string;
  replaced: boolean;
}

/**
 * The response shape of every profile mutation, modelled on
 * QueueMutationResult: a mutating endpoint returns the re-derived payload,
 * never `{ ok: true }` and never the in-flight text.
 */
export interface ProfileMutationResult {
  profile: ProfilePayload;
}

// ── Resume library (read-only in this ticket) ──

/**
 * Which resume a file is, from the agent's point of view
 * (`.pi/extensions/job-applier.ts:79-89` is the only code that ever picks one).
 *
 * `default`/`region` — reachable through the per-region lookup.
 * `override`        — the one file the `## Resume` path bullet pins.
 * `shadowed`        — a reachable `.pdf` an active override outranks.
 * `orphan`          — unreachable, full stop. Every non-`.pdf` is one, whatever
 *                     the override says, because `resolveResumePath` only ever
 *                     builds `resumes/<key>.pdf`.
 */
export type ResumeReachability = "default" | "region" | "orphan" | "shadowed" | "override";

export const RESUME_REACHABILITY: readonly ResumeReachability[] = [
  "default",
  "region",
  "orphan",
  "shadowed",
  "override",
];

export interface ResumeFile {
  name: string;
  /** the filename without its extension — what a `resume_key` would be */
  key: string;
  bytes: number;
  modifiedAt: string | null;
  reachability: ResumeReachability;
}

/** A region rule whose `resumes/<key>.pdf` is not on disk. */
export interface ResumeRuleGap {
  key: string;
  expectedFile: string;
}

export interface ResumesPayload {
  directoryExists: boolean;
  files: ResumeFile[];
  ruleGaps: ResumeRuleGap[];
  overrideActive: boolean;
  overridePath: string | null;
  overrideExists: boolean | null;
}

// ── Addresses (read-only in this ticket) ──

/**
 * `resolved` — a city rule and a persisted address agree on a key.
 * `pending`  — a rule with no address yet; the agent will call `generate_address`.
 * `orphan`   — an address whose key no city rule defines. `default` is NEVER
 *              one: `parseCityRules` skips that row deliberately
 *              (`.pi/extensions/lib/profile.ts:271`) and `matchResume` returns
 *              `address_city_key: "default"` for every remote posting.
 */
export type AddressRuleState = "resolved" | "pending" | "orphan";

export const ADDRESS_RULE_STATES: readonly AddressRuleState[] = ["resolved", "pending", "orphan"];

export interface AddressRow {
  key: string;
  displayCity: string;
  state: string;
  zips: string[];
  address: Address | null;
  ruleState: AddressRuleState;
}

export interface AddressesPayload {
  revision: string | null;
  rows: AddressRow[];
  stateJsonExists: boolean;
  /**
   * False means the file IS there but its JSON is malformed, or parses to
   * something `readState` then throws on. `readState` uses a bare `JSON.parse`
   * (`ui/server/readers/stateJson.ts:20`) and reads `raw.addresses` (`:21`), so
   * both a SyntaxError and a TypeError are turned into this flag rather than
   * into an HTML 500. A body that parses cleanly to a non-object — `"[]"`,
   * `"5"` — is indistinguishable from an empty address map through `readState`
   * and is reported readable-and-empty.
   */
  stateJsonReadable: boolean;
}

export interface AddressUpdateBody { revision: string | null; street: string; city: string; state: string; zip: string; }

export type SetupStepId = "connection" | "profile" | "resume" | "targets" | "readiness";
export interface ReadinessBlocker { code: string; message: string; href: string; }
export interface SetupStep { id: SetupStepId; complete: boolean; optional: boolean; blockers: ReadinessBlocker[]; }
export interface ReadinessAcknowledgement {
  at: string | null;
  policy: string | null;
  current: string;
}

export interface ReadinessWarning {
  code: string;
  message: string;
  href: string;
}

export interface ReadinessPayload {
  steps: SetupStep[];
  browseReady: boolean;
  discoverReady: boolean;
  applyReady: boolean;
  scoreReady: boolean;
  scoreBlockers: ReadinessBlocker[];
  warnings: ReadinessWarning[];
  captchaOptional: true;
  acknowledgement: ReadinessAcknowledgement;
  serverRuntime: { nodeMajor: number };
}

// ── Agent runs ──

/**
 * What the UI asked a run to do.
 *
 * `status` is DIAGNOSTIC ONLY and is never offered by the UI. It sends
 * `/status`, an extension command whose handler only calls `ctx.ui.notify`
 * (job-applier.ts:531) — it never starts an assistant turn, so it costs no
 * model call. It exists so a live smoke can prove the workspace's extensions
 * loaded without applying to anything.
 *
 * `apply-next` exists only at the route and UI layers. The route resolves the
 * first queued slug itself and starts an `apply` run for it, so every apply
 * session is named `ui:<slug>` and is resumable by that name; the run manager
 * only ever sees `apply | gather | status`.
 */
export type RunKind = "chat" | "apply" | "apply-next" | "gather" | "score" | "status";

export const RUN_KINDS: readonly RunKind[] = ["chat", "apply", "apply-next", "gather", "score", "status"];

/**
 * A deterministic function of the protocol, never of the assistant's words
 * (D2). `starting` at spawn → `running` on the first agent/message/tool start →
 * `waiting` on `agent_settled` while the process is alive → `done` on a clean
 * exit after Finish, `stopped` after Abort, `failed` on a spawn error or any
 * unrequested exit.
 *
 * `waiting` deliberately does not distinguish "finished cleanly" from "stopped
 * to ask": both are a settled agent with a live process, and the transcript's
 * last assistant paragraph is what says which.
 */
export type RunStatus = "starting" | "running" | "waiting" | "done" | "stopped" | "failed";

export interface RunHandoffSummary {
  runId?: string;
  error?: string;
}

export interface RunSummary {
  runId: string;
  /** what the CLIENT asked for — `apply-next` stays `apply-next` here */
  kind: RunKind;
  /** the queue slug for an apply run (resolved, for `apply-next`); null otherwise */
  slug: string | null;
  /** pi's session display name: `ui:<slug>`, `ui:gather`, `ui:status` */
  sessionName: string;
  /** the `--model` value this run was spawned with, from runConfig (D5) */
  model: string;
  config?: import("./config").RunConfigSnapshot;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  /**
   * Oldest and newest `seq` the server's bounded log still holds. A client that
   * reattaches with a `since` below `firstSeq` has a gap and must replace its
   * transcript from `/api/runs/current` rather than append.
   */
  firstSeq: number;
  lastSeq: number;
  /** Set on a finished chat run after start_application handoff. */
  handoff?: RunHandoffSummary;
}

/** Card discriminator plus tool-owned payload; all fields are redacted before replay. */
export const TOOL_CARD_KINDS = ["job-list", "profile-diff", "run-progress", "application", "connection"] as const;
export type ToolCardKind = (typeof TOOL_CARD_KINDS)[number];
export interface ToolCardDetails {
  card: ToolCardKind;
  [key: string]: unknown;
}

/**
 * The whole vocabulary the browser ever sees (D4). Raw RPC payloads are
 * normalized into these on the server, so the client renders a small, stable
 * set and pi's protocol can evolve behind it.
 *
 * `status` carries the full summary rather than just the new status: a client
 * that has just learned a run ended would otherwise need a second fetch to
 * render `endedAt`, and the two could disagree.
 */
export type RunEvent =
  | { type: "status"; status: RunStatus; run: RunSummary }
  /** a prompt the run manager sent to the child — the first one, or a reply */
  | { type: "user"; message: string }
  | { type: "text"; delta: string }
  /** the assistant's current text block is complete (a `message_update` sub-event) */
  | { type: "text_end" }
  | { type: "tool_start"; toolCallId: string; name: string; summary: string; args: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      isError: boolean;
      result: string;
      details?: ToolCardDetails;
      handoff?: { kind: "apply" | "apply-next"; slug: string | null };
    }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  /** an extension's `setStatus`, ANSI stripped — real pi colours this text */
  | { type: "status_line"; key: string; text: string }
  | {
      type: "ui_request";
      id: string;
      method: "confirm" | "select" | "input" | "editor";
      title: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
    }
  | { type: "ui_resolved"; id: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };

/** A `RunEvent` as it appears in the log and on the wire: replayable by `seq`. */
export type RunLogEntry = RunEvent & { seq: number };

/** POST /api/runs body. `slug` is required for `apply`, ignored otherwise. */
export interface RunStartBody {
  kind: RunKind;
  slug?: string;
  slugs?: string[];
  /** Required first user prompt for chat. */
  message?: string;
  /** Fork the saved session from a prior chat run (UUID). */
  continueFrom?: string;
}

export interface RunReplyBody {
  message: string;
}

/**
 * POST /api/runs/:id/ui-response body. Key presence is the discriminator, as in
 * pi's own `extension_ui_response`: `value` answers select/input/editor,
 * `confirmed` answers confirm, `cancelled` dismisses any of them.
 */
export interface RunUiResponseBody {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** GET /api/runs/current. The finished run stays visible until the next start. */
export interface RunCurrentPayload {
  run: RunSummary | null;
  events: RunLogEntry[];
}

/**
 * The 409 body when another run holds the lock (AC 5). `runId` is null only if
 * the holder's metadata could not be read at all — the client shows the message
 * either way.
 */
export interface RunLockedError {
  error: string;
  runId: string | null;
}

// ── Raw on-disk shapes (snake_case, everything optional/nullable) ──

export interface RawAttempt {
  started_at?: string | null;
  ended_at?: string | null;
  outcome?: string | null;
  notes?: string | null;
}

export interface RawAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface RawApplication {
  slug?: string;
  status?: string;
  url?: string | null;
  company?: string | null;
  title?: string | null;
  location_raw?: string | null;
  resume?: string | null;
  resume_key?: string | null;
  address_city_key?: string | null;
  address?: RawAddress | null;
  attempts?: RawAttempt[];
  screenshot?: string | null;
  verification_email_id?: string | null;
  submitted_at?: string | null;
  abort_reason?: string | null;
  block_reason?: string | null;
  queue_file?: string | null;
}

export interface RawStateJson {
  applications?: RawApplication[];
  addresses?: Record<string, RawAddress>;
  acknowledged_at?: string | null;
  acknowledged_policy?: string | null;
  last_updated?: string | null;
}

/** gray-matter may parse ISO date strings into Date objects — hence the unions. */
export interface RawJobFrontmatter {
  slug?: string;
  url?: string;
  company?: string;
  title?: string;
  location?: string;
  location_raw?: string;
  source?: string;
  match?: string;
  discovered_at?: string | Date;
  llm_score?: number;
  llm_reasoning?: string;
  status?: string;
  submitted_at?: string | Date;
  applied_at?: string | Date;
  resume?: string;
  resume_key?: string;
  address_city_key?: string;
  screenshot?: string;
  [key: string]: unknown;
}

export interface RawCredentialEntry {
  username?: string;
  password?: string;
  email_used?: string;
  ats?: string;
  company?: string;
  host?: string;
  created_at?: string;
  last_used_at?: string;
  last_login_status?: string;
  notes?: string;
  /**
   * The extension is free to grow fields this UI has never heard of, and the
   * writer spreads the parsed entry so they survive a round trip verbatim.
   * Declaring the index signature is what makes that type-honest rather than an
   * accident of spread (mirrors RawApplication / RawJobFrontmatter).
   */
  [key: string]: unknown;
}

export type RawCredentials = Record<string, RawCredentialEntry>;
