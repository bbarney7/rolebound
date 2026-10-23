# Implementation tickets

All tickets start **planned**. These are local, issue-ready specifications, not issues posted to an external tracker. Paths are repository-relative. P0 blocks the public release foundation; P1 is required for this release's product experience. Size is approximate focused engineer effort: S = 0.5–1 day, M = 1–2 days, L = 2–3 days. Product implementation must follow the cheaper-model worker policy in [plan.md](plan.md).

Read [contracts.md](contracts.md) before implementation; its concrete decisions refine these ticket descriptions. T02 must close with a verified runtime matrix and T04 with implemented/tested shared schemas before their dependents start. Existing payloads stay sourced from `ui/shared/types.ts`, not redefined per feature.

## T01 — Establish the public-source boundary

**P0 · M · Depends on:** none. **Owner:** release worker; `.gitignore`, `scripts/audit-personal-data.sh`, new release allowlist/scanner tests. Do not change the user's tracked personal files or history.

**Implement:** Inventory tracked files, staged/unstaged changes, refs, ignored runtime files, generated scripts, PDFs, images, browser sessions and prior planning artifacts. Report filenames/counts only. Classify product, synthetic fixture, private runtime, and unresolved ownership. Harden the scanner to inspect an export/index rather than dumping the working tree. Use generic credential rules plus a private local denylist; do not commit the owner's identifiers as test expectations. Include `.pi/settings.json`, root scratch scripts, backups, screenshots and test artifacts in the decision, not just known workspace names.

**Acceptance:** A synthetic sensitive-file fixture causes failure; valid placeholder templates pass; scanner output never prints a matching secret. A manifest explicitly excludes all currently tracked applicant artifacts. Existing local files and Git history remain byte-for-byte untouched by audit/export preparation. Document that history must be cleaned or omitted, not merely ignored. If actual credential exposure is established, record rotation requirements privately.

**Verify/rollback:** Scanner tests in a disposable Git repo, including historical blobs and an allowlisted template. Remove new scanner/config to roll back; no user-data migration.

## T02 — Prove and pin a portable pi/browser runtime

**P0 · L · Depends on:** none. **Owner:** runtime worker; root `package*.json`, `tsconfig.json`, `vitest.config.mts`, `.mcp.json`, new runtime adapter/bootstrap modules. Coordinate manifest ownership with T09.

**Implement:** Verify publicly obtainable pi package/version against RPC methods/events, `-a` trust behavior, model/provider registry, extension virtual imports, agent-directory isolation, and process shutdown. Begin with installed 0.84.3. Pin a tested pi and Playwright MCP dependency; remove `@latest`, absolute user-data paths, and nvm aliases. Resolve executable/package exports portably without shell interpolation. Confirm which browser executable/channel is supported; provide explicit installation/check rather than silently downloading on every run. Select Node engine after checking all dependencies, not just pi. Inventory undeclared global extensions and commands that the current setup relied upon.

**Acceptance:** Empty HOME and PATH without global pi can install and load all four extensions plus browser tools, with no network model call. Root tests/typecheck resolve locally. A local fake RPC session exercises start/request/reply/abort/shutdown. Browser profile is confined to the selected clone. A capability manifest records exact versions, public sources and supported OSes. Every claimed required tool is present without maintainer global config.

**Verify/rollback:** Temporary clean clone and fake ATS/browser page on macOS/Linux; preserve the old launcher path only for explicit maintainer use until migration completes. Missing package capability must be resolved here before T05, not hidden behind an assumed API.

## T03 — Make workspace initialization and upgrades dependable

**P0 · M · Depends on:** T02. **Owner:** workspace worker; `scripts/init-workspace.sh`, new Node bootstrap/migration module, `templates/`, workspace resolver tests.

**Implement:** Provide cross-platform Node initialization with the shell script as a compatibility wrapper. Keep clone-as-workspace and require extension root, child cwd, UI root and browser profile to agree. Scaffold missing files idempotently; reject symlink escapes and invalid roots. Create private directories with restrictive permissions. Add a workspace version marker, backup-first migrations and atomic writes. Generalize applicant templates and examples. Create separate empty and populated synthetic demo modes; demo cannot start a real provider/browser submission. Do not treat today's UI fixture as a runnable pi workspace until extensions and config are explicitly present.

**Acceptance:** Re-running initialization preserves existing file hashes. Missing template, corrupt JSON, partial setup, path with spaces and unsupported future version produce useful errors. Migrate legacy fixture without losing unknown fields/custom Markdown. Interrupted migration is recoverable; restoring backup works. Demo mode cannot resolve real user credentials or mutate the live workspace.

**Verify/rollback:** Temporary-directory initialization/migration tests including old and future versions. Backup manifest identifies restored paths; never overwrite the live checkout as a test.

## T04 — Define versioned settings and configuration contracts

**P0 · M · Depends on:** T02. **Owner:** config worker; `.pi/extensions/lib/config.ts` or new application-config module, `ui/shared/types.ts`, `ui/server/settingsStore.ts`, `templates/settings.json`, config tests.

**Implement:** Schema v2 contains `connections[]` metadata (`id`, `provider`, optional `baseUrl`, label), `agent` (`connectionId`, `modelId`, supported reasoning choice), optional `scoring` override, and compatible `captcha`. Credentials are not part of public DTOs. Preserve legacy CAPTCHA settings via migration. Specify precedence, missing-value semantics, unknown-version handling and immutable active-run snapshots. Use revisions for optimistic concurrency; writes are lock-protected and atomic. Publish shared input/output types before feature workers begin.

**Acceptance:** Legacy Off/2Captcha/CapSolver fixtures migrate without losing keys; malformed settings fail without overwriting. Empty model never spawns `--model ""`; unknown provider/model/reasoning is an actionable validation error. Concurrent update returns 409 with sanitized latest revision. UI receives only credential status/source, not raw key. Environment override behavior has explicit tests.

**Verify/rollback:** Pure schema/precedence tests and store integration tests. Back up v1 before migration; rollback requires restoring that backup with compatible code.

## T05 — Implement user-owned provider connections

**P0 · M · Depends on:** T02, T04, T08. **Owner:** provider worker; new server provider adapter/store/routes and tests, app-owned pi configuration. T04 owner merges shared types; app route registration is coordinated.

**Implement:** Adapt pinned pi auth/model registry into list/configure/delete/test connection operations. Proposed routes: `GET/POST /api/connections`, `PUT/DELETE /api/connections/:id`, `POST /api/connections/:id/test`, `GET /api/connections/:id/models`. Keys are write-only and kept under `/.pi-jobs/pi-agent/`; build a connection-to-pi-provider mapping that handles two endpoints of the same type without credential collisions. Support API-key OpenAI/Anthropic/Google and a custom OpenAI-compatible endpoint, including keyless local endpoints where supported. Custom URLs allow HTTP loopback and HTTPS remote endpoints; URL credentials and executable config interpolation from the UI are rejected. Do not import arbitrary pi `!command` config through form input.

**Acceptance:** Add/replace/remove/test credentials with fake HTTP servers; no key leaks to response, error, SSE, process argv or browser storage. Bad auth, missing model, quota, unsupported tools, timeout and unreachable endpoint are distinguished. Model catalog unavailability supports validated manual model ID entry. Removing an in-use default requires reassignment; running work keeps its snapshot. Explicit optional import leaves original global pi config untouched. Minimal credential test is described before it sends a potentially billed request; tests never solve a CAPTCHA.

**Verify/rollback:** Contract tests plus provider-adapter tests for two same-type connections and precedence. Removing the feature does not delete stored credentials; restore config backup for schema rollback.

## T06 — Route both running and scoring through configured models

**P0 · L · Depends on:** T04, T05. **Owner:** execution worker; `ui/server/runConfig.ts`, `ui/server/runs/runManager.ts`, `.pi/extensions/job-gatherer.ts`, new scoring adapter and tests. Preserve the user's uncommitted runConfig change when selecting the baseline.

**Implement:** Replace hardcoded UI default and Synthetic scoring transport with shared connection resolution. Use pi's provider API for scoring while retaining validated score 1–5/reason/date output. UI and documented CLI launcher agree on connection, model and app-owned pi state. Extend run summary with sanitized model/connection identity. Validate agent tool capability and supported reasoning options before spawn. Bound scoring batch size/concurrency, retries and cancellation; keep partial successes and record per-job failures. Remove stale process-cached keys after configuration changes. Migrate maintainer-only scoring script functionality or omit that script from public export.

**Acceptance:** Two fake providers demonstrate agent A/scorer B, inherited scorer A, and no hardcoded Synthetic dependency. Missing key blocks only the capability needing it. 401 is not endlessly retried; 429/timeouts have bounded retry; malformed scoring JSON does not corrupt job files. Cancellation stops future requests. No fallback to an unexpected paid model. Run configuration remains fixed until that run terminates. Existing lock/SSE/redaction/adapter tests pass.

**Verify/rollback:** Mock RPC and local provider fixtures; never a live application. Feature rollout can retain legacy migration input but all new launches use one resolver. Revert adapter with preserved legacy config backup if needed.

## T07 — Finish portable CAPTCHA and manual verification behavior

**P0 · M · Depends on:** T04, T06. **Owner:** verification worker; `.pi/extensions/lib/captcha.ts`, `.pi/extensions/job-applier.ts`, `.pi/extensions/job-accounts.ts`, CAPTCHA routes/tests and prompt compatibility tests.

**Implement:** Preserve existing provider selection and key overrides; remove mandatory Gmail/GCP assumptions from generic prompts. Missing email integration asks for manual OTP/link completion with a structured run request. Off/manual CAPTCHA hands control to the user; solver error offers manual recovery. Preserve existing paid-attempt limits and provider-specific challenge support; document the verified matrix rather than assuming parity. Update legacy `CLAUDE.md` guidance to match actual integrations. Maintainer GCP secrets loader becomes explicitly optional.

**Acceptance:** No keys/no Gmail/no gcloud can finish a fake OTP/CAPTCHA workflow manually. Configured solver uses only chosen provider and masks its key. Invalid key, unsupported challenge, no balance, timeout and cancellation recover with useful states. Existing solve limit remains enforced. New public prompts do not insist on nonexistent tools. Confirmation records distinguish receipt evidence from uncertain completion.

**Verify/rollback:** Mock solver/email challenge fixtures; no purchased solve. Preserve old settings compatibility and existing stop/acknowledgement behavior.

## T08 — Protect localhost APIs and private artifacts

**P0 · M · Depends on:** T02. **Owner:** security/API worker; `ui/server/app.ts`, shared middleware, `runs/redact.ts`, `runs/secrets.ts`, upload/evidence helpers and security tests.

**Implement:** Validate allowed Host/Origin and fetch metadata; require a same-origin session/CSRF mechanism for writes and credential reveal, compatible with the selected SSE transport. Bind loopback only. Normalize expected errors to sanitized JSON; keep actionable messages separate from internal details. Define containment checks for served files/uploads including symlink and traversal cases. Redact all configured provider/CAPTCHA/account credentials from stored and streamed diagnostics; disable response caching for private data. Define the local trust model without pretending encryption can protect against a compromised OS account.

**Acceptance:** Hostile Origin/Host fails on mutate/reveal/read boundaries as specified; valid same-origin UI/CLI flow works; no permissive CORS. Traversal and symlink fixtures cannot read/write outside allowed roots. Secret sentinels do not appear in errors, logs, replay or diagnostics. SSE reconnect still works. Raw parser/stack errors are never the API default response.

**Verify/rollback:** Middleware and integration tests; maintain loopback-only binding during any rollback. T09 must consume this contract for production assets and T13/T17 for file endpoints.

## T09 — Ship one install/build/start path and a doctor command

**P0 · M · Depends on:** T02, T03, T04, T08. **Owner:** packaging worker; root/UI package scripts, `ui/server/index.ts`, `ui/vite.config.ts`, new launcher/doctor; manifests transferred from T02 owner.

**Implement:** Implement the exact root commands in contracts.md for dependency install, setup, build, start, dev, demo and doctor; final commands documented by T21. Use one locked npm workspace graph, with migration from the two lockfiles in this ticket. Serve built SPA and API from one loopback origin with history fallback excluding `/api`. Resolve assets independent of cwd. Doctor reports Node/pi/browser/tool/config/readiness by capability, without secrets and without paid requests. Avoid mandatory gcloud/Gmail. Handle occupied port, browser absence and graceful shutdown.

**Acceptance:** Root `npm ci` (or the explicitly chosen deterministic root install command), `npm run build`, `npm start` work from clean checkout. No development watcher is required. Direct page reload works; missing API returns JSON 404. SIGTERM closes child/browser resources as designed. Doctor exits nonzero for required blockers and distinguishes optional integration absence. Demo works without credentials or external services.

**Verify/rollback:** Clean-install/start smoke with temporary HOME, paths with spaces, port collision and termination. Use previous build with compatible settings for rollback.

## T10 — Produce the redesigned screen and interaction specification

**P1 · M · Depends on:** none. **Owner:** cheaper-model design worker; design artifacts under this plan directory, following [ux-spec.md](ux-spec.md). No product code in this ticket.

**Implement:** Inventory current feature parity, map primary journeys and create mockups for Today/Discover/Run/Setup/Settings plus narrow variants. Define typography/spacing/color/component tokens and a route map. Explicitly design loading, empty, error, reconnecting and waiting states; show the new page hierarchy with synthetic jobs. Incorporate owner style feedback when available. Avoid gratuitous dependencies or decorative motion that obscures work.

**Acceptance:** Reviewable mockups and feature-parity checklist resolve page compositions before implementation. Every primary task has a visible next action. Active run/user request is visible outside the run page. Design preserves meaningful existing safeguards and settings. Coordinator review finds no undefined primary flow; routine choices can be approved against the plan without blocking on owner feedback.

**Verify/rollback:** Visual review at specified viewports; no runtime rollback needed.

## T11 — Build shared visual components and durable navigation

**P1 · M · Depends on:** T10. **Owner:** frontend foundation worker; `ui/src/App.tsx`, `index.css`, new shell/router/components, `main.tsx`. Sole owner of these shared files during this ticket.

**Implement:** Decompose monolithic app into route-level views while preserving refresh fencing and `useRun` ownership. Use a small tested routing approach; add a router dependency only if justified. Routes: `/`, `/discover`, `/queue`, `/applications`, `/applications/:slug`, `/runs/current`, `/profile`, `/settings`, `/settings/accounts/:host`. Define URL query state for filters and selection. Add semantic navigation, shared fields/status/error/skeleton/dialog primitives, responsive layout and light/dark/system preference. Keep font assets local or use system fallback.

**Acceptance:** Back/forward/reload/direct link preserve view and relevant selection/filter state. Not-found route has recovery. Active run hook is not remounted by navigation. Shared primitives support keyboard/focus/reduced motion. No whole-page overflow at 390px. Resource-local error does not disable unrelated pages. Existing pages remain reachable while migration proceeds.

**Verify/rollback:** Router and focused component tests with synthetic fixtures; maintain feature-parity routes until replacement pages pass.

## T12 — Add setup and connection settings UI

**P1 · M · Depends on:** T03, T05, T07, T11; completion integration requires T13/T14. **Owner:** settings/onboarding worker; `SettingsPanel.tsx`, `settings.ts`, new setup and connection forms, server readiness service/route and tests; shared edits through T11 owner.

**Implement:** Five-step setup with saved progress and server-computed readiness. Provider forms support label/key/base URL/model plus separate scoring selection. Show configured credential source, test result and next-run activation. CAPTCHA stays optional with Off default. Link exact missing profile/resume/target fields to their editors. Existing configured workspace enters Today rather than an unnecessary wizard. Keep account CRUD/reveal/copy under Settings and preserve masking timeout; login/reset automation remains via the agent unless separately specified.

**Acceptance:** New user can configure a fake provider without editing files; invalid key/model errors attach to fields; refresh preserves progress. Save never echoes key. Optional steps are skippable, required capabilities cannot be falsely marked ready. Existing accounts/settings remain usable. Changing a model mid-run clearly applies next run. Config conflict is resolved without losing draft fields.

**Verify/rollback:** Setup/settings browser journey using fake provider and legacy workspace; no paid credential tests in CI.

## T13 — Make profile and resume setup complete in the UI

**P1 · M · Depends on:** T03, T08, T11. **Owner:** profile worker; `ProfileView.tsx`, `Profile*.tsx`, `server/routes/profile.ts`, profile/resume writers and tests.

**Implement:** Editable required identity, work history, education, authorization, Q&A and job preferences while preserving custom Markdown/comments. Add revision-checked writes for existing section semantics. Add bounded multipart PDF upload (proposed `POST /api/resumes`), explicit replace and validated assignment to default/region/override; validate filename/type/magic bytes/size, containment, and atomic write. Default 10 MiB limit is documented and tested. Address/rule UI must collect truthful user input, distinguish saved address from matching rules, and preserve unmatched custom content. Defer arbitrary resume deletion unless references can be safely reconciled.

**Acceptance:** User finishes a valid profile and uploads/selects resume entirely in browser. Agent resolves the same chosen file shown by UI. Missing required fields and unsupported custom sections are explicit. Concurrent edit does not overwrite silently. Invalid/traversal/oversized/non-PDF upload leaves old file intact. Replacing a resume referenced by an active run is blocked or safely snapshotted, with behavior tested. Custom Markdown round-trips.

**Verify/rollback:** Profile writer tests plus upload/setup browser journey; backup-first profile changes and explicit resume replacement preserve recoverability.

## T14 — Add target management and a first-class Discover workflow

**P1 · L · Depends on:** T06, T11, T13. **Owner:** discovery worker; new Discover/Targets views, `QueueAdd.tsx` extraction, new targets reader/writer/routes, queue/discovery API additions, gatherer preference handling. Shared types via designated owner.

**Implement:** Parse/edit Greenhouse/Ashby/Lever board groups with revision checks and lossless unknown Markdown preservation. Make role/level/topic/location filters user-configurable; remove hidden maintainer-specific engineering defaults. Extend discovered list with validated filters, stable sort, cursor/limit and detail payload (proposed `/api/discoveries`); preserve old queue discovery endpoint during transition. Use existing run mechanism for gather and add an explicit allowlisted score operation instead of arbitrary shell commands. Display score/reason/unscored/error. Promote one reviewed job using existing dedup/locking; add dismiss state without deleting discovered source, and restore. Bulk operations are deferred to keep v1 bounded.

**Acceptance:** User can edit targets, gather mocked sources, score, inspect and promote a job without terminal. Non-engineering preference fixture is honored. Duplicate across discovered/queue/applied is explained and not re-created. Stale revision/removed posting yields recoverable error. Dismiss survives refresh without corrupting gather dedup history. Invalid ATS slug cannot inject commands or write paths. Large fixture of 1,000+ jobs is paged predictably; selected detail survives refresh.

**Verify/rollback:** Reader/writer/filter/dedup tests and complete fake discovery browser journey. New dismiss metadata is versioned; legacy discovery files remain consumable.

## T15 — Rebuild Today and Queue around next actions

**P1 · M · Depends on:** T11, T12, T14. **Owner:** worklist worker; new Today view, `QueueList.tsx`, `QueueAdd.tsx` manual entry, overview presentation. Shared shell edits by T11 owner.

**Implement:** Today prioritizes setup blockers and waiting work, then next job, useful counts/drill-downs and recent outcomes. Queue shows actual consumption order and next marker with job detail, source URL and safe remove confirmation. Separate add-by-URL from Discover promotion. Use existing `POST /api/runs` with `{kind:"apply-next"}` for Apply next and `{kind:"apply",slug}` for a selected queued job; preserve queue-membership validation and label the two actions accurately. Do not offer drag sorting without a matching runtime order contract.

**Acceptance:** Next shown job is the job a fake `/apply-next` consumes. Empty list routes to Discover or Add. Active lock disables conflicting mutations/actions with explanation. Invalid URL, duplicate, failed removal and concurrent movement have useful recovery. Counts link to filtered destinations. Keyboard and narrow-screen actions remain usable.

**Verify/rollback:** UI journey for setup/no jobs/queued/active/blocked states; preserve existing queue files and deletion contract.

## T16 — Redesign supervised running and recovery

**P1 · L · Depends on:** T06, T07, T11. **Owner:** run worker; `RunPanel.tsx`, `useRun.ts`, run API/client helpers and lifecycle tests. Coordinate backend manager edits with T06 owner.

**Implement:** Persistent status bar plus dedicated run view; current job/phase, human-readable transcript and collapsed tools; pin select/confirm/input requests above reply controls. Preserve sequence/gap replay, stale-response fencing, redaction and one-run lock. Distinguish starting/running/waiting/completed/aborted/failed/interrupted/reconnecting. Keep Finish versus Abort semantics accurate. After restart, show interrupted outcome and supported next action; never claim to resume a dead process. Surface manual OTP/CAPTCHA handoff without automatic paid retry or duplicate submission.

**Acceptance:** Start/reply/select/confirm/cancel/finish/abort work through fake RPC. Navigation and disconnect preserve transcript and unsent reply. Duplicate/missing/out-of-order SSE frames recover as current contracts intend. Server restart does not silently submit again; expired request responses are rejected. Agent-finished and application-confirmed remain distinct. Keyboard focus reaches pending request and stop control; new log lines do not steal focus.

**Verify/rollback:** Existing lifecycle suite plus browser scripted failure/reconnection cases. Revert visual changes without changing persisted run records; lifecycle migrations require compatible readers.

## T17 — Rebuild application tracking and evidence detail

**P1 · M · Depends on:** T08, T11. **Owner:** applications worker; `ApplicationList.tsx`, `ApplicationDetail.tsx`, `server/routes/applications.ts`, evidence-serving route and tests.

**Implement:** Routeable list/detail with filters, attempt timeline, distinct execution/hiring status, receipt evidence and editable pipeline stage. Reuse existing payload/timeline before adding redundant fields. If screenshots are exposed, use an authorized slug-to-file endpoint and containment checks, never arbitrary file paths. Email evidence without a configured integration is a readable reference, not a broken link. Show estimated/orphaned/missing job records truthfully. Preserve draft status changes during background refresh.

**Acceptance:** Filter/back/reload restores list state. Pipeline edit persists and refreshes counts; conflicts preserve draft. Missing screenshot/job file shows useful fallback. Encoded traversal/symlink cannot serve unrelated files. Attempts remain chronological; receipt evidence is distinguished from inferred submission. Large fixture remains responsive through pagination/windowing chosen on measured need.

**Verify/rollback:** Existing union/detail tests plus browser tracking journey and evidence endpoint tests; no invented application outcomes.

## T18 — Finish resource refresh, errors and responsive consistency

**P1 · M · Depends on:** T12–T17. **Owner:** integration frontend worker; resource hooks and common error/state layer, remaining page polish. Coordinate page edits explicitly.

**Implement:** Replace unconditional whole-app refresh with event/resource invalidation where practical, retaining cold-start full resync after connection loss. Standardize actionable errors, inline validation, local retries, empty/loading and stale states. Preserve working data on partial failure. Finish theme, focus return/live regions and responsive behavior across all migrated screens. Bound transcript rendering without losing pending controls or historical replay.

**Acceptance:** Profile change does not refetch every unrelated detail unnecessarily; reconnect still reconciles all visible state. One API failure leaves other views usable. No raw stack/path dumps in default copy. All primary journeys keyboard-operable at desktop and 390px. Reduced-motion and light/dark contrast reviewed. Measure large lists/transcripts rather than assuming optimization success.

**Verify/rollback:** Targeted fetch/SSE tests and synthetic large-data browser measurements. Preserve the old full-refresh fallback until selective invalidation is proven.

## T19 — Add deterministic end-to-end and visual regression coverage

**P0 · L · Depends on:** T09, T12–T18. **Owner:** QA worker; new browser test harness, fake ATS/model/RPC fixtures, screenshot baselines. No real personal fixtures.

**Implement:** Isolated temporary HOME/workspace, local fake model and ATS, fake solver and no external write access. Cover setup → discover → promote → apply → answer → confirmed outcome → hiring-stage update. Add invalid credentials/quota/missing browser/OTP/CAPTCHA/reconnect/restart/concurrent edit/upload paths. Distinguish a mocked UI run from a pinned pi integration smoke. Stabilize the observed watcher timeout in `ui/server/__tests__/api.test.ts` through deterministic readiness/event synchronization, not blind retries.

**Acceptance:** No paid API or employer call in automated suite. Screenshots match T10 compositions at 1440/1024/768/390 light/dark using fictional data. Accessibility automation plus manual keyboard check catches missing labels/focus. All old tests retained unless behavior deliberately changes with equivalent coverage. Watcher failure root cause is addressed or documented with a bounded tracked blocker; retry alone is not release proof.

**Verify/rollback:** Full integrated checks once stable; repeat only for changes/failures. Baselines contain no private content. Broken test harness changes can be reverted independently of product data.

## T20 — Enforce clean-install and release checks in CI

**P0 · M · Depends on:** T01, T02, T03, T09; final gate requires T19. **Owner:** CI worker; `.github/workflows/`, scan/build scripts and test orchestration.

**Implement:** Clean npm install, root/UI typechecks/tests, build, start/health/shutdown, secret/private-file scan and local mock browser tests. Test supported Node on Linux and macOS; use an empty agent directory with no gcloud/global pi. Add a fixture upgrade matrix and release-artifact scan. Keep network/provider credentials out of PR workflows. Label optional live provider checks separately and never submit real jobs. Publish only synthetic screenshots/test logs with sanitized errors.

**Acceptance:** Fresh export passes with no maintainer secrets. Intentional tracked private-file/sensitive synthetic fixture fails. No absolute home path imports remain. UI build resolves offline after dependencies are installed. A failed job blocks release. Platform matrix states verified and unsupported combinations; no native Windows claim without testing process/locking/browser behavior.

**Verify/rollback:** Run on disposable branch/export when repository CI is available; local equivalent commands remain runnable. Do not enable publication in this workflow.

## T21 — Write the public quickstart and contributor documentation

**P0 · M · Depends on:** T09, T12, T19, T20 for closure. **Owner:** docs worker; `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, license candidate, examples and screenshots. Keep runtime `AGENTS.md` concise and synchronize inaccurate legacy guidance.

**Implement:** Exact tested install/build/start/demo/doctor commands, supported OS/Node/browser, provider/API-key and custom endpoint examples, optional CAPTCHA/manual OTP, profile/targets/resume guide, configuration precedence, local plaintext data boundaries, upgrades/backups/removal and troubleshooting. Explain external calls to selected model/ATS/solver; no absolute privacy promise. Document actual automation behavior, existing acknowledgement/rate limits and how to stop a run. License/dependency/font review and owner-selected license before release. Contributor guide states cheap worker/Cursor constraints for this project without forcing those restrictions on end users.

**Acceptance:** An independent empty-home walkthrough succeeds using only README and fictional data. No placeholder clone URL remains in the final release candidate after destination is selected. No private project ID, home path, real resume/screenshot or paid key in docs. Commands match package scripts. License is explicit and assets have documented origins. Optional integrations do not masquerade as required dependencies.

**Verify/rollback:** Documentation links/command walkthrough plus scan after screenshots are generated. No user-data writes outside the walkthrough fixture.

## T22 — Assemble and verify the public GitHub candidate

**P0 · M · Depends on:** T01–T21. **Owner:** release worker; export tooling/manifest, release checklist, candidate directory and report. Original checkout is read-only for export.

**Implement:** Export only reviewed product files from the integrated baseline plus intended product changes; omit private blobs, scratch applications, history and local configuration. Initialize fresh Git history in a separate candidate directory; scan candidate content and all reachable refs, dependency/package artifacts, docs and images. Run clean-install and workflow smoke on this exact tree. Record candidate commit/hash, included files, checks and known support limits. Prepare exact GitHub repository name/visibility/license/publish actions once owner choices are available; do not perform publication as part of planning.

**Acceptance:** Candidate has no applicant data or historical private blobs, passes release matrix, includes plan/docs and chosen license, and can be cloned/run independently. Source private files and original history are unchanged. Report makes the final publication action reviewable. Any failed gate blocks publishing; do not certify an unaudited original history as clean. If the owner instead requests historical continuity, replace fresh-export step with a separately scoped history scrub and re-run the same gates.

**Verify/rollback:** Recreate candidate from manifest and compare hashes; deleting a failed candidate does not affect live workspace. Actual public push occurs only under a later publication instruction.
