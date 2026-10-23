# Rolebound — current UI critique

## Scope

Used the critique skill with two independent assessments: a design/source review and the deterministic Impeccable scanner. The primary review also inspected the running real-workspace UI at port 4748: chat, settings, profile, and setup, including 1024px laptop and 390px phone layouts. No product files or settings were changed. No authentication or application submission was initiated.

This reviews the current version, including the provider logos, error-row fixes, and searchable model picker. Earlier screenshots of missing logos and the native model datalist are not treated as unresolved findings.

## Anti-pattern verdict

The interface still feels like a developer configuration tool inside a polished chat shell. Its visual identity has a useful starting point: the folded-path mark, readable typography, restrained surfaces, and consistent focus treatment. The main weaknesses are repeated configuration lists, excessive transcript detail, competing navigation layers, and unclear completion states.

The deterministic scan found only two warnings, both side accent borders:

| File | Line | Finding | Judgment |
|---|---:|---|---|
| `ui/src/index.css` | 936 | Transcript speaker accent border | Low priority; has a functional distinction |
| `ui/src/surfaces.css` | 625 | Alert accent border | Low priority; has a severity distinction |

A near-clean pattern scan does not establish usability. It missed the more consequential issues found visually. No live detection overlays were injected; this environment's browser evaluation is read-only. CLI scan and ordinary browser inspection were used.

## Design health: 23/40

Qualitative heuristic scores, not a complete accessibility or functional certification. The independent source-only assessment scored 24/40; the combined review reduces system-status confidence after observing the real checklist's misleading state.

| Heuristic | Score / 4 | Key issue |
|---|---:|---|
| Visibility of status | 2 | Populated profile labeled Empty; empty-search instructions repeat completed steps |
| Match to real-world language | 2 | Internal file names, credential sources, provider IDs, and effort codes |
| User control and freedom | 2 | Keyboard focus escapes the visually modal workspace |
| Consistency | 2 | Autosave promise conflicts with explicit Save forms |
| Error prevention | 3 | Helpful validation/conflict handling; model searching immediately edits the model value |
| Recognition over recall | 3 | Labeled controls and checklist; duplicated navigation adds mapping work |
| Efficiency | 3 | Chat shortcuts and keyboard model selection; settings controls are buried |
| Aesthetic and minimalist design | 2 | Long expanded document changes and repeated connection lists compete with the task |
| Error recovery | 2 | Errors are shown, but many remain raw messages without recovery instructions |
| Help and documentation | 2 | Contextual help exists but frequently describes implementation mechanics |
| **Total** | **23/40** | **Significant usability improvements needed** |

## Five priority suggestions

### 1. Make chat results compact and properly formatted — P1

**Observed:** A profile change expands the entire updated section into the conversation. The work-history and Q&A cards become long documents. Headings display literal `###`, and a comparison table displays pipe characters as prose. Extension startup messages and storage filenames also appear in the chat.

**Why it matters:** Users lose the actual answer and next step inside a transcript of internal operations. Routine updates look unfinished even when the underlying action succeeded.

**Suggested fix:** Show concise confirmations such as “Updated your salary preferences,” with a short useful summary and a “View changes” disclosure. Render headings, nested lists, and tables correctly. Put extension startup/tool diagnostics in an optional activity view. Keep important requests for user input prominent.

**Evidence:** Live chat review; `ui/src/chat/cards/ProfileDiffCard.tsx:27` renders the full after-text; `ui/src/chat/markdown.tsx:57` supports paragraphs and simple lists but no heading/table blocks.

**Skills:** `/distill`, `/typeset`, `/polish`.

### 2. Put the active setup decision first — P1

**Observed:** Settings starts with every detected account, then saved connection management, then the active account/model controls. Setup repeats much of this. The automatic-submission acknowledgement is the most visually prominent action even while profile/company setup remains incomplete.

**Why it matters:** Users must work out whether they are choosing an account, changing a model, repairing a connection, or enabling applications. Successful connections remain part of a large configuration inventory.

**Suggested fix:** Put the current AI account/model and its working status at the top. Offer one clear “Change” action and disclose other accounts/advanced scoring settings. Guide first-time users through account → resume/profile → find jobs. Present the automatic-submission decision at the final apply-readiness step, keeping its disclosure clear and factual.

**Evidence:** Live Settings/Setup review; `ui/src/SettingsPanel.tsx:189`, `:200`; `ui/src/SetupView.tsx:149–165`.

**Skills:** `/shape`, `/distill`, `/clarify`.

### 3. Simplify navigation and give editing more room — P2

**Observed:** Nine workspace destinations coexist with seven profile tabs. Resumes and preferences appear in both. At phone width, users encounter two independent horizontal navigation strips. At 1024px, the collapsed Agent preview still reserves a separate wide column, squeezing identity fields and wrapping labels.

**Why it matters:** Too much of the available screen serves navigation and supporting controls. Important values such as email addresses are hard to read while editing.

**Suggested fix:** Group destinations by task and give each one a single home. Use a labeled section chooser on phones. Stack preview/help beneath the form until the drawer content is wide enough for both columns. Choose breakpoints using the content container rather than the whole browser width.

**Evidence:** Live laptop/phone inspection; `ui/src/chat/WorkspaceDrawer.tsx:15`; `ui/src/profile.ts:468`; `ui/src/surfaces.css:691`.

**Skills:** `/distill`, `/adapt`, `/layout`.

### 4. Make saving and readiness labels truthful — P1

**Observed:** The drawer says “Changes save as you make them,” but the profile and model forms require Save. The search checklist labels a substantially populated profile “Empty” because unfinished template content remains elsewhere. The zero-jobs message tells the user to connect a model and provide a resume even when both are already ready.

**Why it matters:** These messages make completed work look lost and leave users uncertain whether their edits will be used.

**Suggested fix:** Standardize “Unsaved changes / Saving / Saved,” with a clear Save action and a visible completion response. Use “Needs details” with the specific remaining requirement for partially complete profiles. Derive the empty-search prompt from actual readiness; for example, point to choosing companies when the account and resume are ready.

**Evidence:** Live populated-workspace review; `ui/src/chat/WorkspaceDrawer.tsx:134`; `ui/src/ProfileBulletForm.tsx:235`; `ui/src/chat/SearchRail.tsx:16`, `:48`, `:99`; `ui/src/ConnectionSelections.tsx:228`.

**Skills:** `/clarify`, `/polish`.

### 5. Finish the workspace's keyboard behavior — P1

**Observed:** Shift+Tab from the drawer's close control moved focus to “End session” in the background chat. The workspace remained visually open. Source declares `aria-modal="true"` but provides no focus containment or inert background.

**Why it matters:** Keyboard users can operate controls they cannot see behind the overlay. This is a behavior defect, not a stylistic preference.

**Suggested fix:** Use a tested dialog primitive or implement focus containment and background inertness. Preserve Escape dismissal and return focus to the workspace trigger. Include the model picker's portal in the accessibility/focus design.

**Evidence:** Live focus inspection; `ui/src/chat/WorkspaceDrawer.tsx:63–95`.

**Skills:** `/audit`, `/polish`.

## Configuration-page spacing and sizing — P1 (expanded from user feedback)

The earlier critique captured cramped form columns and weak hierarchy, but did not explicitly document the full spacing problem. The following observations were supplied by the user and need systematic visual verification across Setup, AI model/key settings, and profile configuration.

- **Excessive padding in some containers:** Large insets consume useful space and make simple configuration tasks feel sprawling.
- **Buttons touching:** Adjacent actions lack consistent gaps, making separate actions look joined or accidentally crowded.
- **Oversized buttons:** Routine secondary actions have excessive height, width, or padding and compete visually with primary actions. Some stretch across a field column unnecessarily.
- **Sections touching:** Separate sections and form groups lack enough separation to communicate their boundaries and hierarchy.
- **Inconsistent space distribution:** Generous container padding coexists with cramped internal controls and section boundaries. Adding or removing padding globally will not address this.

**Suggested fix:** Review all configuration screens as one system. Establish consistent spacing for labels/fields, related controls, action groups, and major sections. Reduce oversized insets and secondary-button widths/padding while preserving accessible touch targets. Give button groups explicit gaps and major sections clear separation. Use one primary action per task, with compact secondary actions. Check expanded, collapsed, loading, error, and success states at desktop and phone widths in both themes.

**Acceptance criteria:** No adjacent actions visually touch; section boundaries are clear; routine buttons do not dominate the form or fill a column without a reason; outer padding leaves enough width for readable values; spacing communicates which elements belong together.

**Evidence:** User-reported configuration-page observations. Related cramped-column and hierarchy issues were also seen during the earlier browser review. The newly specified symptoms have not all been independently rechecked yet.

**Skills:** `/layout`, `/adapt`, `/polish`.

## Chat composer refinement — P2 (added from user screenshot)

**Observed:** The message field has a sharp rectangular focus outline inside the rounded composer. The nested borders compete visually. The text field and attachment/send controls feel compressed into the same strip, with weak separation and uneven optical alignment.

**Suggested fix:** Treat the composer as one cohesive control. Apply a rounded focus treatment to the outer composer when the textarea is focused, preserve a distinct visible keyboard-focus indicator for each action button, remove the redundant textarea border/outline, and improve internal padding and text/button alignment. Keep the placeholder readable and ensure multiline text grows comfortably. Verify empty, focused, typing, multiline, attachment, disabled-send, and active-run states in both themes and at phone width.

**Evidence:** User-provided screenshot of the focused chat composer. This addition is a visual finding, not a new behavioral test.

**Skills:** `/layout`, `/polish`, `/audit`.

## Further refinements

- **Separate model search from model selection — P2.** Typing search text immediately changes the model field; Escape closes the list without restoring the selected model. Keep a search query separate from the committed choice. Make a custom model ID an explicit action. Evidence: `ui/src/components/ModelPicker.tsx:88–100`.
- **Make search counts useful — P2.** Found, Shortlisted, Applying, and Sent should open matching lists. Distinguish paused/blocked work from active applying. Evidence: `ui/src/chat/SearchRail.tsx:35`, `:85`.
- **Use actionable authentication feedback — P2.** Explain the failure and next action near the provider, with raw details available on demand. Generic “Sign-in status: failed” plus a backend message remains a weak recovery experience. Evidence: `ui/src/LoginButton.tsx:327–339`.
- **Correct setup test feedback — P2.** Source stores connection-test success in the error state, which is rendered with critical styling. A successful test should use success feedback. This was source-confirmed, not triggered against a live account during the review. Evidence: `ui/src/SetupView.tsx:196–200`, `:246`.
- **Unify language — P2.** Use Job preferences consistently, explain scoring in plain language, and move credential storage/parsing details into technical help.

## Cognitive load and user perspectives

The independent source review found four clear checklist failures out of eight: chunking, one decision at a time, minimal choices, and progressive disclosure. Browser inspection also confirmed weak single-task focus in the transcript and weak priority hierarchy in Settings. This is high cognitive load under the skill's rubric. The rule about four visible choices is a screening heuristic, not proof that any longer navigation menu is unusable.

- **First-time applicant:** A ready account coexists with multiple connection lists; a populated profile says Empty; automatic submission dominates setup before the remaining profile/company work is finished.
- **Returning user:** Changing the active model requires scrolling through account inventory. Search counts do not provide shortcuts. Chat confirmations expand large sections the user did not ask to reread.
- **Keyboard/phone user:** Focus escapes the drawer; two navigation strips occupy phone space; the laptop layout narrows editable fields beside a collapsed preview.

## Preserve what now works

- Local provider logos, separate account/detail lines, and full-width error rows resolve the earlier setup presentation problems.
- The searchable model picker now matches the app and supports arrows, Enter, Escape, and a visible selected checkmark.
- Labeled identity groups, field validation, draft reconciliation, and conflict handling provide useful foundations.

## Suggested order and decisions

Prioritize configuration-page spacing and button sizing alongside chat readability, the composer, and truthful save/readiness feedback. Next simplify setup/settings, then navigation and responsive form layout. Fix keyboard containment alongside that work, and end with `/polish`.

Before implementation, settle two choices: should the first-run experience lead directly to finding useful jobs, with application permissions at the end; and should the next pass start with chat/status or with setup/navigation? The recommended defaults are discovery first and chat/status first.


## Layout + Emil design engineering review

Follow-up review using the `layout` and `emil-design-eng` skills. Inspected live Setup and Settings in the real workspace and measured rendered controls. Reviewed the shared form/button styles, composer, model picker, and asynchronous provider controls. No product code, account configuration, or permissions changed.

### Main diagnosis

Legacy card styles and newer section styles are being combined on the same elements. This explains the simultaneous excessive padding, inconsistent alignment, and missing internal spacing. Fixing isolated margins will leave the underlying problem in place.

### Before / After recommendations

“After” describes the proposed treatment; these changes have not been implemented.

| Before | After | Why |
|---|---|---|
| Setup connection headings and management buttons are inset 24px while the provider description and sign-in button start at the section edge. | One shared content edge for heading, description, status, and actions; one component owns the padding. | Their alignment should communicate that they belong to the same account. |
| Saved-account sections measure 202–298px tall in Setup; legacy header padding is `22px 24px 0`, action padding is `16px 24px 24px`, with additional section padding. | Compact account summaries; a single padding layer; concise secondary management actions. | Routine account management consumes too much of the page and pushes active settings out of reach. |
| Settings puts the login component and its management action group 0px apart. The action group adds only its own 4px top padding. | Explicit 12–16px separation between status/login and management actions; preserve consistent 8px gaps within a related button row. | Spacing between groups is missing even when spacing within a row exists. |
| The Setup “Scoring override” summary has a border and 0px padding; its heading/text touch the edge. | Either a properly inset summary or an unboxed inline status. | A visible boundary needs intentional interior spacing. |
| Refresh models fills a 350px-wide column at 44px high in Settings. Many secondary buttons use the same visual weight as primary actions. | Content-sized refresh/test actions near the control they affect; distinct primary and secondary visual sizing. | Full-column secondary actions dominate simple configuration tasks. Preserve adequate touch targets. |
| Setup reserves a step-progress column beside the form throughout a long scrolling account inventory, in addition to the workspace navigation. The lower view has a large unused left area. | Compact progress above the active step, or a shorter focused step layout that lets the form use the available content width. | The current structure spends width on navigation while editable fields are squeezed. |
| The collapsed Agent preview still reserves a separate column at laptop widths. | Place preview/help below the form until the content container can comfortably support both. | A collapsed secondary control should not cost the form hundreds of pixels. |
| Composer has a sharp inner textarea focus rectangle inside a rounded outer border. | Rounded outer focus treatment for the textarea, plus distinct keyboard focus for attachment/send buttons. | The composer should read as one component with intentionally placed actions. |
| Shared configuration buttons define hover/disabled styling but no explicit pressed feedback. | Brief, restrained pointer-press feedback; immediate keyboard response. | The control should acknowledge a press without adding delay to repeated actions. |
| Connection Test buttons run an async handler without a local pending/disabled state in Setup/Settings. | “Testing…” feedback and duplicate-click prevention on the specific account. | Users need to know the request was accepted. This was source-confirmed; no real account test was initiated. |
| Account detection begins with the ordinary sign-in alternatives and later replaces that region with detected accounts. | A stable loading region, then the resolved choices. | Initial async detection should not replace the layout users are beginning to read or click. Source and live accessibility snapshots support the change in choice sets. |
| Model search edits the form's selected value; Escape closes without reverting the typed search. | Separate search query from selection; commit on choice, and provide an explicit custom-ID action. | Dismissing a search should preserve the user's selected configuration. |

### Concrete evidence

- `ui/src/SetupView.tsx:169–194` combines `.rb-connection-block`, `.form-card`, `.form-head`, and `.form-body` across a section.
- `ui/src/index.css:970–972` supplies the legacy header/body padding measured in the browser.
- `ui/src/surfaces.css:292–299` adds the newer connection-section treatment. `:274–275` and `.setup-main` also express different layout rules for the same main column. In the live view the computed main-column gap was 20px; source declarations alone should not be treated as the final rendered spacing.
- Live Setup account heights: 279px, 279px, 202px, 298px. These are observations of the current data and desktop viewport, not universal dimensions.
- Live Setup scoring summary: 1px border, 0px padding.
- Live Settings gap from the login component to the following management group: 0px for each OAuth account measured. The inner action rows have 8px gaps.
- Live Settings Refresh models: 350px wide × 44px high at the inspected desktop size.
- `ui/src/SettingsPanel.tsx:225–258` and `ui/src/SetupView.tsx:193–225` contain async test/remove handlers without local pending button state.
- `ui/src/ProviderSetup.tsx` initially stores an empty detected array and resolves it asynchronously, while sign-in alternatives are rendered from that initial value.
- `ui/src/chat/chat.css:655–691` defines the rounded composer and independent square textarea focus outline.

### Spacing and interaction direction

For this dense product UI, use a small relationship-based scale: roughly 4–6px between a label and its control, 8px within a button row, 12–16px between related groups, 16–24px of container inset, and 24–32px between major sections. Treat these as starting tokens to verify visually, not numbers to apply indiscriminately.

Keep routine secondary controls content-sized. If desktop secondary buttons become visually smaller, retain appropriate touch targets and avoid overlapping expanded hit areas. Use clear grouping and alignment before adding more borders or cards.

The Emil review does not recommend extra decorative motion. Preserve instant filtering and arrow-key selection. Improve pressed/loading/success states and preserve layout during those transitions. The existing 180ms drawer entry and reduced-motion handling are reasonable starting points; no measured animation-performance defect was found in this review.

### Updated implementation order

1. Consolidate configuration-page spacing ownership; fix shared edges, the unpadded scoring box, and separation between action groups.
2. Establish primary/secondary button sizing and remove unnecessary full-column secondary actions.
3. Reduce the space consumed by repeated account cards and multiple navigation columns.
4. Unify composer focus treatment, model search/selection behavior, and async control feedback.
5. Verify light/dark, narrow drawers, phone widths, keyboard focus, loading, success, error, and long account/model names.
