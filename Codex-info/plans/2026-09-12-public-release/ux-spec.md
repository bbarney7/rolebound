# UI revamp specification

Status: proposed design direction, to be validated in T10 with synthetic-data mockups.

## Product structure

The interface should answer “What should I do next, and what is the agent doing?” before showing aggregate metrics. Use a calm, compact workspace with strong typography, restrained neutral surfaces and a single primary accent; semantic success/warning/error colors remain distinct. Keep plain CSS and existing React rather than introducing a framework migration.

Primary navigation: Today, Discover, Queue, Applications. Secondary navigation: Profile and Settings. Accounts live under Settings but retain their current capabilities. Running work appears in a persistent status bar with an “Open run” action and a dedicated full run page. Browser back, reload, direct links and selected-job URLs work.

## Screen contracts

| Screen | Composition and primary action | Required states |
|---|---|---|
| Setup | Five steps: connection, profile, resume, targets, readiness. CAPTCHA optional within connection/settings. Save each step; show completion and blockers | Brand-new workspace, partially complete, unavailable model/browser, invalid key, save conflict, skip optional step |
| Today | Needs-attention list first; next queued job second; compact pipeline totals and recent results below. Primary action follows actual readiness | No setup, ready/no jobs, paused agent, active run, recent failure, stale connection |
| Discover | Filterable job list with detail pane: company, role, location, score/reason, source and posting age. Review next/previous; promote selected job; gather/score controls | Not gathered, gathering, unscored, scoring error, no filter matches, stale/removed posting, already queued/applied |
| Queue | Ordered list using actual agent consumption order; selected-job details; next-job marker; add URL and remove actions | Empty, malformed entry, duplicate, pending removal, active run lock, item moved elsewhere |
| Applications | Search/filter by outcome and hiring stage; detail shows attempts, receipt evidence and editable pipeline status | No history, estimated versus confirmed record, missing evidence, retryable error, conflicting edit |
| Run | Current job and phase, readable activity, required user action pinned above reply controls; technical tool output collapsed | Starting, running, waiting for input, manual CAPTCHA/email handoff, reconnecting, stopped, failed, completed, interrupted restart |
| Profile | Human-readable grouped forms for identity, work history, Q&A, search preferences, resume and address rules. Preview actual resolved resume/rules | Missing required fields, unsupported/custom Markdown preserved, upload pending/error, unsaved changes, conflict, missing file |
| Settings | Model connections, agent/scoring choices, CAPTCHA, browser diagnostics, accounts and advanced workspace details | Key stored/environment-provided/absent, test not run/failed/passed, provider unsupported, key removed, active-run changes pending |

## Interaction details

- On desktop, discovery and applications use a list/detail workspace; selected item remains stable when new events arrive. On small screens, detail becomes a full page with a Back action restoring filters and scroll.
- Use real job title/company as primary text; file slugs, absolute paths, parser diagnostics, process IDs and raw JSON live behind Details. Do not use internal paths as default empty-state instructions.
- Keep application execution outcome separate from hiring pipeline stage. “Agent finished” alone is not proof the application was submitted. Show confirmed receipt, estimated record or unknown outcome explicitly.
- During a run, preserve the user's draft reply on reconnection. Keep stop available, distinguish abort from finishing a conversation, and explain whether a new start is required after interruption. Do not promise resumability unless the runtime supports it.
- Key inputs are write-only. After save, show “Key saved” and replacement/removal controls. Connection test uses a disclosed minimal request where needed; no automatic paid calls on every keystroke. No fabricated cost estimates.
- New-user readiness is capability-based: browsing needs no model; discovery needs valid sources/network; scoring needs a configured scoring route; applying needs profile/resume/browser/agent model and the existing acknowledgement gate. CAPTCHA and automated email are optional.
- Resume upload includes chosen filename, valid PDF check, size limit, explicit replacement, active-resume assignment and clear failure. Address fields require truthful user-provided values; do not silently fabricate application answers while generalizing templates.
- Targets UI exposes supported ATS board type and slug with a validation preview. Generic role/level/location preferences must not silently retain maintainer-specific engineering filters.
- Loading uses layout-shaped placeholders. Empty states give one relevant next action. Errors name the problem and offer retry or navigation to the exact setup field. Preserve good data during a partial fetch failure and mark stale data during reconnection.

## Visual system and accessibility

Use a 4/8px spacing rhythm, compact 14–16px body text, 24–32px page headings, tabular numeric columns, clear 3-level text hierarchy and restrained separators. Reuse existing fonts if they can be bundled with appropriate licenses; otherwise use system fonts initially. No required external font CDN. Avoid all-caps monospace field labels as the default language of the product.

Reusable primitives: page header, primary/secondary/destructive button, labeled field/help/error, status badge, loading/empty/error block, data list/table, tabs, job detail shell, confirmation dialog, toast/live status, run status bar. Semantic controls, visible focus, focus return after dialogs, labels, keyboard row opening, reduced motion, sufficient contrast and non-color status signals are required. No hover-only actions.

Validate mockups and final implementation at 1440, 1024, 768 and 390 CSS pixels in light and dark themes. At narrow widths use horizontal scrolling only for intentionally tabular content, not the whole page. Large job descriptions wrap; long transcripts do not hide the action box; focus remains visible under sticky UI.

## Required design evidence

T10 produces a screen map and mockups of Today, Discover with detail, active Run, Setup and Settings. Each has empty/error/waiting variants and at least one narrow-width version. Use fictional data only. Review these before broad page implementation; resolve ordinary visual decisions autonomously using this specification unless the owner provides direction. T19 captures matching screenshots and keyboard walkthrough evidence from the working mock app. A token swap alone does not satisfy the redesign.
