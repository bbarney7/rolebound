# Rolebound UI refinement implementation plan

Date: 2026-10-14
Branch: `codex/rolebound-ui-refinements`
Status: implemented; see [implementation and verification](implementation.md)
Source: [UI critique and layout/Emil review](critique.md)

## Outcome

Make configuration pages compact and coherent, make chat easy to read and compose, and make every setting's state understandable. Start with the spacing and oversized-control problems the owner specifically called out. Deliver in reviewable phases, each with a working UI and concrete visual checks.

This is an improvement to the existing chat-first product. Keep the current fonts, brand mark, themes, provider logos, and readable form labels. Preserve the recent OAuth and model-picker fixes already in the working tree. Existing uncommitted changes belong to the baseline and must not be reverted or accidentally omitted from final verification.

## Product and implementation decisions

- Chat remains the home screen. Configuration stays in Workspace.
- The default first-run path is connect an account → import/review resume and profile → choose companies/find jobs. Automatic-submission acknowledgement appears in a final, clearly labeled Ready to apply section.
- Configuration forms use explicit Save with accurate draft/saving/saved feedback. They do not silently become autosaving forms.
- Account/model selection leads Settings. Additional accounts, credential details, separate scoring configuration, and reasoning effort use progressive disclosure.
- Desktop navigation groups destinations by user task. Phone navigation uses one app-styled, accessible section chooser instead of two horizontal strips.
- UI simplification must preserve direct links, drafts, conflict detection, Stop, and all existing readiness/submission enforcement. Moving the acknowledgement changes presentation only; no acknowledgement is automatically recorded or reused from demo data.
- Use existing React/CSS and the native modal dialog capability. No new UI dependency or environment variable is planned. A scoped Markdown dependency is justified below.
- Browser QA uses disposable seeded fixtures and stubbed provider responses. Do not exercise real account login, paid CAPTCHA, or application submission to verify appearance.

## Phase 0 — Establish fixtures and a reliable baseline

**Files:** `ui/e2e/test-helpers.ts`, `ui/e2e/playwright.config.ts`, `ui/e2e/web-server.mjs`, `ui/e2e/fresh-web-server.mjs`, new `ui/e2e/ui-refinements.spec.ts`, existing visual-gate and relevant unit tests.

1. Record current build/typecheck/focused-test results and screenshots before editing. Inspect the test commands, rather than assuming the `--desktop-only`/`--full` script flags select projects: the current runner does not visibly branch on those flags.
2. Repair test helpers that still target the old `Workspace stages` navigation and old labels. Target the actual chat header, Workspace dialog, and stable accessible names. Keep the substantive assertions; obsolete selectors must not be mistaken for functional regressions.
3. Build fixtures for: no account; one ready account; many detected/saved accounts; partially completed profile; no companies; populated search; long account/model names; provider failure; pending test; long chat changes; streamed Markdown; interrupted and active runs.
4. Mock external auth/model-test calls. Use local placeholder data, not the real profile or personal account details.
5. Capture desktop 1440×900, laptop 1024×768, tablet 768×1024, phone 390×844, and narrow phone 360×800 in light/dark. Include targeted reduced-motion and keyboard checks.

**Exit:** Fixture navigation works with the current shell, pre-existing failures are recorded, and before screenshots demonstrate the exact critique symptoms.

## Phase 1 — Fix configuration spacing, alignment, and button hierarchy

**Files:** `ui/src/index.css`, `ui/src/surfaces.css`, `ui/src/providerSetup.css`, `ui/src/SetupView.tsx`, `ui/src/SettingsPanel.tsx`, `ui/src/ConnectionSelections.tsx`, configuration/profile components using shared classes.

1. Introduce semantic spacing tokens based on 4px increments: label gap 4px; inline-action gap 8px; related-group gap 12–16px; surface inset 16px phone/20px desktop; major-section gap 24px phone/32px desktop. These are relationship rules, not blanket padding overrides.
2. Give each configuration component a single owner of its padding. Remove legacy `.form-head` and `.form-body` hooks from migrated Setup account blocks, replacing them with the shared section/header/actions patterns. Do not delete legacy classes globally until remaining callers have been checked.
3. Align an account's heading, metadata, login controls, status, and management actions to one content edge. Separate action groups by 12–16px and related buttons by 8px. Keep gaps when actions wrap or conditional messages appear.
4. Remove the bordered, zero-padding scoring-summary box. Render a short inline summary within the scoring section; if an independent bordered surface is needed, use the shared inset token.
5. Define primary, secondary, quiet, and destructive-action treatments. Secondary actions use content width; Refresh models and Load scoring models no longer occupy a whole field column. Place refresh beside the relevant model-field label/control group.
6. Use a 36px visual secondary-button height on fine-pointer desktop layouts and at least 44px on coarse-pointer/touch layouts. Primary form actions and inputs remain 44px. Do not create overlapping invisible hit areas.
7. Make account summaries compact, with detail/repair controls disclosed when needed. Avoid imposing one fixed account height: long names, errors, and provider-specific prompts must expand naturally.
8. Add deliberate pointer pressed feedback to shared buttons, respecting reduced motion. Keyboard activation and list navigation remain immediate. No decorative stagger or delayed control entrance.

**Acceptance:** No flush-to-border text or touching action groups. Heading/text/control left edges align within a component. Secondary actions do not stretch unnecessarily. The measured 202–298px routine account blocks are substantially shorter for the same fixture, without clipping content. Existing Queue, Accounts, profile subforms, and application details are checked for shared-style regressions.

**Verification:** Browser screenshots and element geometry at laptop/phone sizes. Do not add unit tests that merely assert padding class names.

## Phase 2 — Repair the composer, picker semantics, and modal interaction

**Files:** `ui/src/chat/Composer.tsx`, `ui/src/chat/chat.css`, `ui/src/components/ModelPicker.tsx`, `ui/src/components/modelPicker.css`, `ui/src/chat/WorkspaceDrawer.tsx`, `ui/src/chat/shell.css`, `ui/src/App.tsx`; new `ui/src/chat/WorkspaceOverlayContext.tsx` if needed for the popup host.

### Composer

- Use the rounded outer composer as the textarea focus boundary. Remove its independent square outline only after the outer keyboard-focus treatment is visible. Give attachment/send controls their own focus indicators.
- Use a 12px internal gap, consistent 12–16px inset, and aligned 44px action targets. Keep the first text baseline optically aligned in the one-line state and actions bottom-aligned in the multiline state.
- Derive textarea growth from its actual line height/padding. Grow up to eight lines, then scroll internally. Long tokens and filenames must wrap without widening the page.
- Preserve IME composition, Enter/Shift+Enter behavior, attach/drop behavior, disabled send, stop, reply, and finish semantics.

### Model selection

- Split temporary query text from the committed model ID. Opening shows the selected model; typing filters without changing the saved-form draft.
- Click/Enter on an option commits its ID. Escape, Tab, and outside dismissal restore the committed display and clear the query. Selecting an unchanged option does not mark the form dirty.
- Permit a custom ID through an explicit “Use custom model ID …” option; do not turn every unmatched search into a committed custom model. Keep the provider's existing server validation.
- Preserve selected checkmark, initial selected-option visibility, viewport placement, keyboard handling, and protection against stale catalog responses.

### Workspace modal

- Make the Workspace a native `<dialog>` opened with `showModal()`, preserving current route-driven opening and styling. Browser-managed modal focus/inertness handles background isolation.
- Provide a floating-popup host inside the dialog's top layer, outside its scrolling and animated content. Render ModelPicker and the later section chooser into that host; use `document.body` only outside Workspace. This prevents native dialog inertness from disabling popup options.
- Initial focus goes to a sensible header control. Escape closes the innermost popup first, then Workspace. Escape must never stop the background agent while Workspace is open. Restore focus to the Workspace trigger on close, including direct-link routes.
- Preserve backdrop dismissal, current URLs, and scrollability. Do not re-run initial focus on every readiness refresh.

**Acceptance:** The screenshot's nested square focus rectangle is gone. Search-dismiss does not change model selection. Tab/Shift+Tab cannot reach background End session. Popup options are operable by pointer and keyboard inside the modal. No body or horizontal overflow.

**Tests:** Extend `chatComposer.test.tsx`, `ModelPicker.test.tsx`, `ConnectionSelections.test.tsx`, `WorkspaceDrawer.test.tsx`. Use real-browser tests for native modal focus/inertness; jsdom mocks cannot prove it.

## Phase 3 — Make saving, drafts, and operation feedback consistent

**Files:** `ui/src/App.tsx`, `ui/src/ProfileView.tsx`, profile leaf editors, `ui/src/ConnectionSelections.tsx`, `ui/src/SettingsPanel.tsx`, `ui/src/SetupView.tsx`, `ui/src/LoginButton.tsx`, `ui/src/ProviderSetup.tsx`, `ui/src/components/DiscoverView.tsx`; new `ui/src/components/FormSaveBar.tsx`, `ui/src/WorkspaceDrafts.tsx` where justified.

1. Replace the global autosave promise with accurate copy. Show a consistent Unsaved changes → Saving… → Saved state for manual forms. Enable Save only for valid, changed drafts; keep errors near their source.
2. Reuse one presentation component for save status/actions. Existing form handlers retain responsibility for data validation, writing, and server revision checks.
3. Keep profile, model-selection, and company-target drafts in a tab-lifetime Workspace draft owner so moving between sections or closing/reopening Workspace does not lose edits. Keep an original revision/baseline per draft; refreshed server values replace only clean fields. Preserve existing conflict reporting and never overwrite dirty values from SSE refresh.
4. Hold drafts in memory only. Do not add plaintext localStorage copies of personal data. Do not move API keys, passwords, login codes, or file-upload state into the general draft store.
5. Clear only the saved scope after a successful server response. A failed request preserves edits. Show an unsaved-data unload warning only while actual unsaved manual-form drafts exist; normal in-app navigation keeps drafts without interruption.
6. Add per-account pending state to Test and Remove. While a request is pending, show Testing…/Removing… and prevent duplicate requests for that account. Keep successful test results separate from errors; success never receives critical styling.
7. Give account detection an explicit loading state with stable space before rendering resolved choices. On failure, show Retry and intentional alternative sign-in actions.
8. Translate known provider error codes into actionable messages next to the account. Expose redacted technical detail in a disclosure. Unknown errors retain useful redacted detail; do not replace every failure with a generic retry.
9. Keep operation state scoped by connection ID and request generation. A late response from an old connection cannot update a new selection or removed account.

**Acceptance:** All manual forms accurately report persistence. Drafts survive internal navigation and clean server refresh; conflicts remain visible. No double Test requests, no green result rendered red, and no initial flash from the wrong provider choices.

**Tests:** Existing profile reconciliation tests, ConnectionSelections/SettingsPanel/ProviderSetup tests, plus targeted navigation/draft and pending-request tests. No new persistence API or credential lifecycle changes are required.

## Phase 4 — Simplify setup and put the active account/model first

**Files:** `ui/src/SetupView.tsx`, `ui/src/SettingsPanel.tsx`, `ui/src/ProviderSetup.tsx`, `ui/src/ConnectionSelections.tsx`, `ui/src/chat/FirstLaunch.tsx`, `ui/src/ApplicationsSettingsSection.tsx`, shared surface styles.

1. Settings starts with an Active AI summary: account, chosen model, signed-in/working/needs-attention state, and a concise Change action. Distinguish signed-in credentials from a successfully tested model; do not claim Working from credential presence alone.
2. Place additional accounts under Manage accounts. Render each account once in that section, merging matching detected/saved identity rather than repeating it in two lists. Reuse existing origin matching and preserve all provider options and login methods.
3. Place reasoning effort, a separate scoring account/model, credential source/provider IDs, and other advanced diagnostics under labeled disclosures. Show an explicit summary when an override is already enabled so collapse does not hide effective behavior.
4. Setup uses compact progress above one active task, eliminating the permanent second sidebar and long duplicated account-management inventory. Completed steps show concise summaries with Edit actions.
5. The sequence is Connect AI → Resume/profile → Companies/find jobs → Ready to apply. Use existing browse/discover/apply readiness independently. Do not weaken a backend requirement to make the sequence appear ready.
6. Move automatic-submission acknowledgement into Ready to apply after the relevant prerequisite summaries. Keep it accessible for review even while prerequisites remain incomplete, explain remaining blockers, and retain the existing disclosure/handler and one-time policy semantics. Never acknowledge it as a side effect of navigation, account selection, or starting discovery.
7. Use consistent user language: AI account, Model, Job preferences, Separate scoring model, Ready to apply. Raw IDs remain available in Advanced for custom setups.

**Acceptance:** A returning user can see and change the active model without scrolling past provider inventory. First-time setup has one clear next action. Account failure, no compatible account, expired credentials, and incompatible runtime remain actionable. Discovery can be used whenever its existing readiness allows it, independently of apply acknowledgement.

**Tests:** Update FirstLaunch, ProviderSetup, SettingsPanel, ConnectionSelections and fresh-onboarding assertions. Verify existing readiness/submission-policy tests still pass; this phase changes presentation, not enforcement.

## Phase 5 — Flatten navigation and make forms responsive to their container

**Files:** `ui/src/chat/WorkspaceDrawer.tsx`, `ui/src/chat/shell.css`, `ui/src/ProfileView.tsx`, `ui/src/profile.ts`, `ui/src/router.ts`, `ui/src/App.tsx`, `ui/src/surfaces.css`, `ui/src/components/DiscoverView.tsx`; new shared section-chooser/navigation helper only if needed.

1. Desktop Workspace has canonical top-level destinations: Profile, Job search, Applications, Settings, Setup. Profile owns identity, resumes, addresses, Q&A, Job preferences, work history, and candidate summary. Job search owns found jobs, shortlist/queue, and company settings. Site logins is reachable from Settings.
2. Preserve existing URLs and storage keys: `/profile?tab=…`, `/discover`, `/queue`, `/applications`, `/settings/accounts`, `/settings`, `/setup`. Old stored Resumes/Job preferences IDs still resolve to the correct nested profile destination. Direct links and browser Back/Forward select the right section.
3. On phones use one app-styled grouped section chooser covering both top-level and relevant nested destinations; remove the separate scrolling profile tab strip there. Keep desktop secondary profile navigation where it aids scanning.
4. Reuse the modal popup host/focus rules from Phase 2. Use semantic links inside a keyboard-accessible popover for destination navigation, not an improvised editable model input.
5. Use container queries for the profile editor and its field grid. Start with one form column; show a two-column field grid when the form itself is at least ~560px wide. Email/URL values can span both columns.
6. Keep Agent preview/help in an inline disclosure below the form. A side-by-side preview is optional only when actual editor width comfortably supports a ~560px form plus ~240px preview and a gap. A collapsed preview must not reserve a separate column.
7. Apply the same content-width principle to settings/setup grids, action wrapping, address/resume forms, and long names. Make company settings reachable explicitly from Job search; preserve existing draft-target behavior.

**Acceptance:** No duplicate top-level Resumes or Job preferences links. One phone navigation control. No clipped values/controls or page-level horizontal scroll at 360, 390, 768, 1024, and 1440px; test 200% zoom. All existing deep links continue to resolve and draft preservation survives navigation changes.

**Tests:** Router tests, WorkspaceDrawer tests, profile navigation tests, and browser deep-link/Back/Forward/mobile tests.

## Phase 6 — Make the conversation readable

**Files:** `ui/src/chat/cards/ProfileDiffCard.tsx`, `ui/src/chat/markdown.tsx`, `ui/src/chat/Transcript.tsx`, `ui/src/chat/chat.css`, `ui/src/useRun.ts`, `ui/shared/types.ts` only if event presentation metadata needs an additive field; related card/activity components, `ui/package.json` and root lockfile.

1. Render profile-update cards as a compact title and deterministic summary with View changes collapsed by default. For structured identity changes, show up to three changed field labels; for raw sections show the section name and availability of changes, without inventing an AI-generated summary. Put full after/before text inside the disclosure, preserving exact source content.
2. Replace the hand-written partial Markdown renderer with `react-markdown` + `remark-gfm` (pinned through the normal package/lockfile workflow). The [official renderer documentation](https://github.com/remarkjs/react-markdown#use-a-plugin) documents GFM table support and custom renderers; preserve its safe defaults. Keep raw HTML disabled; preserve safe URL handling and external-link attributes. Add heading, nested-list, blockquote, code, and table styles using existing tokens.
3. Tables scroll within their own wrapper on narrow screens. Long code/URLs cannot widen the chat. Incomplete streamed Markdown remains readable and rerenders correctly when completed; preserve the streaming caret and Jump to latest/stick-to-bottom logic.
4. Group routine tool/system activity under an optional activity disclosure. Add explicit source/severity metadata to `RunEntry` for `status_line`, `exit`, and `error` during reduction. Keep errors, failed tools, warnings, and unresolved user requests visible. Do not use text-matching to hide arbitrary assistant answers or untyped notifications.
5. Existing extension startup notifications that arrive as generic info remain visible unless they can be explicitly tagged diagnostic at their producer. If tagging is needed, make it an additive event field with replay/redaction tests; do not silently suppress all info notices.
6. Keep important applicant data requests adjacent to the assistant answer and never collapsed into activity. Store all original events; this phase changes presentation only.

**Acceptance:** One profile update no longer fills the conversation with a whole document by default. Tables look like tables and headings have hierarchy. Tool details remain inspectable. Warnings, errors, Stop-related notices, and unanswered requests remain prominent during streaming and replay.

**Tests:** Extend `chatMarkdown.test.tsx`, `chatCards.test.tsx`, `chatUiRequest.test.tsx`, and reducer tests for severity/source preservation. Include unsafe links/raw HTML, incomplete tables, long sections, and multi-run history. Run dependency audit after adding Markdown packages.

## Phase 7 — Make readiness and search progress accurate and actionable

**Files:** `ui/src/chat/SearchRail.tsx`, `ui/src/chat/rail.css`, `ui/src/SetupView.tsx`, `ui/src/App.tsx`, `ui/src/ApplicationList.tsx`, `ui/src/router.ts`; `ui/server/readiness.ts`/`ui/shared/types.ts` only if existing blocker codes prove insufficient.

1. Derive checklist text from step completion and blocker codes. Use Not started for a truly missing profile; Needs details for an existing profile with missing fields/templates; Ready for a completed step. Surface the first actionable requirement with its existing blocker link. Do not relabel a partially complete profile Empty.
2. Derive zero-job guidance from actual missing prerequisites. Once AI and resume are ready, stop asking for them. Use existing `discoverReady`, `scoreReady`, and `applyReady` separately and show one useful next action.
3. Turn funnel items into links: Found → `/discover`; Shortlisted → `/queue`; Sent → `/applications?apply=submitted`.
4. Separate activity from attention: Applying counts `in_progress`; Waiting counts execution state `queued` if nonzero; Needs you counts `paused_for_user` + `blocked`. Each row must match its destination filter exactly.
5. Add aggregate UI filter aliases to the existing `apply` query contract: `active` for `in_progress`, `waiting` for `queued`, `attention` for paused/blocked. Keep every existing concrete `ApplyState` filter valid. Implement one shared filter-expansion helper used by ApplicationList and route/count tests, rather than passing aggregate aliases to an endpoint that expects concrete states.
6. Preserve the existing backend readiness gates. If “missing” versus “incomplete” needs additional data, add an optional presentation status based on facts already read; do not remove blockers or infer readiness from a success message.

**Acceptance:** Counts equal the list reached by clicking them. A paused job never appears to be actively applying. Resume-imported profiles receive specific next-step copy. Readiness changes appear after normal refresh without erasing drafts.

**Tests:** SearchRail count/status/click tests, aggregate filter tests, partial-profile readiness fixtures, and existing server readiness tests.

## Phase 8 — Visual and behavioral completion gate

Run after each affected phase; perform the combined matrix once at the end.

| Area | Required states/checks |
|---|---|
| Configuration spacing | Setup, Settings, profile identity, addresses, resumes, Queue add, account detail; normal, long names, error, expanded/collapsed |
| Model picker | Selected, search, no matches, custom ID, Escape/Tab/outside cancellation, keyboard selection, pending/stale catalog, inside modal |
| Composer | Empty, focused, typed, multiline, attachment, upload failure, disabled, running/Stop, IME, keyboard and touch widths |
| Account setup | No accounts, detection loading/error, one/many accounts, signed-in vs tested, expired, incompatible runtime, pending test, successful/failed test |
| Save/drafts | Clean/dirty/saving/saved/error/conflict; section switch, close/reopen, SSE refresh, browser unload, successful save scope |
| Navigation | Existing direct links, legacy stored IDs, Back/Forward, phone chooser, keyboard, 200% zoom |
| Chat | Long changes collapsed/expanded, Markdown table/heading/code, streaming, replay, warnings/errors/requests, latest-message scroll behavior |
| Readiness/search | Empty/partial/ready, profile populated but Q&A incomplete, no targets, queued/active/paused/blocked/submitted, exact list counts |

- All five viewport sizes from Phase 0 in both themes for representative pages; reduced motion for drawer/press interactions.
- Use screenshots at rest and in focused/expanded/error states. Wait for drawer entrance and async layout to settle before judging geometry. Inspect computed layout as well as screenshots.
- Check keyboard focus and accessibility with the existing axe/Playwright setup. Model/navigation popups remain usable inside the native dialog.
- Check the actual final built app, plus fresh and populated fixtures. A fixture-only screenshot is not evidence that the real shell works. Do not include private profile/account data in saved review artifacts.
- Run `npm run build --prefix ui`, `npm run typecheck --prefix ui`, affected Vitest tests, and the appropriate updated Playwright projects from `ui/e2e/playwright.config.ts` and the fresh config. Expand the regression run when shared styling/navigation/event code warrants it. Do not repeatedly rerun unrelated suites without a reason.
- Resolve newly introduced failures. Record any pre-existing unrelated failures with concrete evidence; never weaken tests merely to get a green run.

**Done means:** Every critique item below has an implementation/check reference; visual symptoms have before/after evidence; no lost drafts, inaccessible popup, altered submission gate, or sensitive test data in artifacts. Re-run critique/layout/Emil review on the final screens and summarize remaining limitations without using a numeric score as the sole acceptance gate.

## Coverage map

| Critique item | Planned phase |
|---|---|
| Excessive/nested padding, touching groups/sections, misalignment | 1 |
| Oversized/full-width secondary buttons and weak pressed feedback | 1 |
| Zero-padding scoring summary | 1 |
| Composer focus, spacing, multiline behavior | 2 |
| Search query changes committed model selection | 2 |
| Workspace keyboard focus escapes; popup host/inertness | 2 |
| False autosave, no save success, draft loss on navigation | 3 |
| Missing per-account pending state; success styled as error | 3 |
| Account-detection layout shifts; raw provider errors | 3 |
| Active model buried; duplicate account inventory; advanced detail overload | 4 |
| Automatic-submission acknowledgement dominates unfinished setup | 4 |
| Duplicate/mobile navigation and inconsistent terminology | 4–5 |
| Wasted progress column; narrow profile beside collapsed preview | 4–5 |
| Expanded full-document chat updates; raw headings/tables | 6 |
| Startup/diagnostic noise without hiding important messages | 6 |
| Populated profile called Empty; stale prerequisite prompts | 7 |
| Inert funnel counts; paused/blocked counted as Applying | 7 |
| Both themes, touch targets, reduced motion, coherent interaction states | 1–8 |

The two detector warnings about accent borders are low-priority. Do not restyle semantic alerts or transcript speaker markers solely to satisfy the pattern detector; revisit only if the final visual pass finds an actual hierarchy/accessibility problem.

## Change packaging and fallback

- Implement phases in order, keeping each phase reviewable. Suggested commits follow the phase boundaries; explicitly include the existing session changes when preparing the final branch/PR, without mixing them into a claimed newly implemented phase.
- Keep backend contracts additive if touched. Keep previous URLs accepted. Avoid storage migrations, secret/environment changes, or provider credential rewrites for a UI refinement.
- If a phase regresses functionality, revert that phase's exact diff and its new dependency changes while preserving earlier phases and pre-existing session edits. Recheck the failed flow before proceeding.
- Implementation and verification are recorded in `implementation.md`; the plan and critique remain the review baseline.
