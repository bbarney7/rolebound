# UI refinement implementation and verification

Branch: `codex/rolebound-ui-refinements`
Date: 2026-10-14

Implemented the approved configuration, composition, navigation, conversation, and readiness changes. Preserved the session's provider-logo assets, custom model picker, and Codex OAuth startup repair.

## Delivered changes

| Area | Implementation |
| --- | --- |
| Form spacing and control hierarchy | Semantic spacing tokens and `config.css` own configuration insets, group gaps, section separation, wrapping actions, compact secondary buttons, touch sizes, and reduced-motion pressed feedback. Removed Setup's nested legacy account-card layout. Candidate summary now uses the same padded form structure. |
| Account/model configuration | Shared `AISettings` puts the active account and model first. Additional accounts and repairs are disclosed, with logos, per-account pending/error feedback, and matching detected identities excluded. Effective scoring overrides remain visible in the summary. Credential presence is distinguished from a tested account. |
| Model picker | Search text is separate from the committed ID. Explicit custom-ID action; Escape/Tab/outside cancellation; guarded catalog responses; popup stays in the modal top layer. Catalog failures have a concise explanation and optional technical details. |
| Workspace interaction | Native modal dialog plus an explicit Tab loop and focus restoration. Five canonical desktop destinations; one grouped phone chooser. Existing nested routes and stored aliases retained. Profile tab changes also update the phone section label. |
| Drafts and persistence feedback | Memory-only drafts for profile, model selection, company targets, addresses, and non-secret CAPTCHA options. Secret inputs remain outside the draft cache. Before-unload warning, clean/dirty/saving/saved/error feedback, original revision checks and profile conflict handling. Draft updates can settle after their editor unmounts. |
| Setup | Four compact steps above the active task. Discovery separated from application readiness. Submission disclosure/acknowledgement is in the final step, remains reviewable before prerequisites are complete, and is never recorded by navigation. New users opening Workspace start at Setup. |
| Composer | Rounded outer focus boundary, consistent inset/gaps and 44px actions. Compact empty state; measured growth to eight lines, then internal scrolling. Reflows on viewport resize. Existing send, IME, attachment, stop and finish behavior retained. |
| Conversation | Safe `react-markdown` + GFM rendering for headings, lists, code, quotes and internally scrolling tables. Profile changes collapsed under View changes. Typed routine diagnostics disclosed; errors, failed tools, warnings and requests remain visible. |
| Search/readiness | Incomplete profiles show Needs details. Guidance derives from readiness. Counts link to matching destinations. Applying excludes queued/paused/blocked; Waiting and Needs you have exact shared filter semantics. |
| Test maintenance | Updated stale navigation and fresh-onboarding helpers for the chat shell/native Workspace dialog. Retained endpoint, persistence, readiness and interaction-count assertions. Added fixture-based visual/behavioral checks. |

## Verification

- Typecheck and production build pass.
- Full Vitest run: **95 files, 1,248 tests passed**. Later focused runs cover the final composer, profile and draft adjustments.
- UI browser suite covers light/dark at 360, 390, 768, 1024 and 1440px, plus 720px (the effective layout width of a 1440px screen at 200%). Includes modal focus, picker query cancellation/selection, draft retention, save feedback, nested navigation, overflow, composer growth and a Settings accessibility scan.
- Settings accessibility scan: no serious or critical violations.
- Additional configuration checks cover Setup, profile identity/addresses/resumes, candidate summary, Q&A, work history, shortlist, site logins and company editing at phone/laptop widths.
- Fresh-workspace checks pass for acknowledgement remaining untouched by navigation, Cursor adoption, Claude adoption, and full onboarding through profile/resume/company editing, gathering, scoring and promotion. Provider adoption retains the two-interaction path.
- Actual built demo and real workspace inspected in the in-app browser. Confirmed provider logos and aligned account actions, compact settings, phone chooser/profile form, modal picker, and compact focused composer.
- Dependency audit passes with the repository's existing documented CLI-only moderate-advisory exception. Markdown dependencies are pinned in the package and lockfile.
- `git diff --check` passes.

The first broad run encountered three server-test timeouts under concurrent machine load; all passed on focused rerun and the subsequent complete run with two workers. A pre-implementation SettingsPanel fixture failure is recorded in the local baseline log; the current complete suite is green.

## Final layout/interaction review

| Before | After | Why |
| --- | --- | --- |
| Repeated tall account cards before the active model | Active summary first; compact account rows under Manage accounts | Makes the everyday model choice easy to reach and reduces routine account height. |
| Nested padding, flush text, touching actions | One inset per form, 8px action gaps, 16px groups, 24–32px sections | Restores a consistent rhythm without oversized controls. |
| Composer had nested square focus and excessive phone height | One rounded focus boundary and a compact empty state | Focus reads as part of the control and leaves room for conversation. |
| Search text became a model selection | Queries cancel; explicit options commit | Prevents accidental configuration changes. |
| Background focus and competing mobile navigation | Modal isolation, explicit focus loop, one grouped chooser | Keeps keyboard and phone navigation predictable. |
| Large profile documents and diagnostic lines dominated chat | Collapsed exact changes and routine activity; structured Markdown | Keeps the answer readable while preserving inspectable detail and important alerts. |
| Paused/blocked jobs looked active | Exact Applying/Waiting/Needs you counts and matching filters | Makes status truthful and actionable. |

## Verification limits

Screenshots use fictional fixtures; no personal profile or credential material is exported. Live third-party sign-in and real job submission were not exercised as part of design QA. Browser-chrome zoom itself was not changed; its 720px reflow equivalent was checked. The build emits a non-failing warning for the approximately 596KB main JavaScript bundle; splitting conversation rendering can be a separate performance improvement. The visual checks cover representative states, not every possible provider failure crossed with every viewport.

The original implementation was reviewed on the requested branch. Merge to the default branch was authorized on 2026-10-15.

## Default-branch integration — 2026-10-15

The repository default is `main`; there is no `master` branch. Integrated the newer separate chat/applying model changes before merging the UI work. Settings retains those independent selections and reasoning options using the custom model picker and memory-only draft/save behavior. The composer model switcher occupies its own row to preserve the message input at phone widths.

Build and root/UI typechecks pass. Root tests: 499 passing. The merge privacy scan found only 16 already-existing documentation/fixture matches; every reported line was verified against `origin/main`, with no new finding introduced by this work. No personal workspace data or screenshots were staged.

Combined integration verification: 102 UI/server test files with 1,266 passing tests, 499 root tests, and 18 browser checks. Both typechecks, production build, dependency audit and whitespace checks pass.
