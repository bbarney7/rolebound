# pi-jobs UI revamp and public local release

Status: planning complete, with explicit foundation gates before dependent implementation; no product implementation performed.
Date: 2026-09-12. Baseline: `f5bf974`, plus existing uncommitted changes.

## Outcome

A new user clones the public repository, installs documented prerequisites, starts the UI, supplies their own model credentials, completes their profile and resume, discovers and reviews jobs, and supervises applications locally. CAPTCHA solving is optional and uses the user's own key. No maintainer cloud project, home directory, Cursor subscription, Gmail utility, or existing pi configuration is required.

The UI is rebuilt around the work: **set up → discover → review → apply → track**. Keep React 19, TypeScript, plain CSS, Express, the pi harness, and readable workspace files. This is a full interaction and visual redesign, not just a palette change.

Companion artifacts:

- [Implementation tickets](tickets.md): 22 issue-ready tickets, file ownership, dependencies, implementation steps and acceptance criteria.
- [UX specification](ux-spec.md): navigation, page composition, states and interaction contracts.
- [Foundation contracts](contracts.md): launch commands, configuration, security, scoring, existing state compatibility, migration and export details. These resolve the broad choices in the tickets and take precedence where more specific.

## Evidence and current limitations

| Finding | Evidence | Consequence |
|---|---|---|
| Personal files remain tracked despite ignore rules | `git ls-files` includes `profile.md`, `state.json`, several `resumes/*.pdf`, and job Markdown files | A normal push can expose data; adding ignore patterns does not clean the index or history |
| Machine-specific test resolution | `tsconfig.json`, `vitest.config.mts` resolve pi/typebox under a maintainer home directory | Fresh-clone checks cannot reproduce the current machine |
| No local production launcher | Root package only has test/typecheck; UI has development scripts, no build/start | End users must coordinate development processes |
| Model configuration is fragmented | `ui/server/runConfig.ts` currently defaults to Cursor; `job-gatherer.ts` uses a Synthetic endpoint and hardcoded scoring model | Supplying one key does not configure the complete workflow |
| Hidden integrations | `ui/scripts/with-secrets.sh` names a maintainer GCP project; `job-applier.ts` expects a `gmail` CLI | New users encounter unexplained prerequisites |
| UI describes internal files and parser state | `App.tsx`, `ProfileResumes.tsx`, existing overview screenshot | Product tasks compete with diagnostic information |
| Discovery is buried in queue addition | `QueueAdd.tsx`, `/api/queue/discovered` | Discover/review is not a first-class workflow |
| Resume listing is read-only | `ProfileResumes.tsx`, `routes/profile.ts` | Browser onboarding cannot finish without filesystem steps |
| UI and extension workspace resolution differ | `ui/server/workspace.ts` honors an override; `.pi/extensions/lib/workspace.ts` derives its root from module location | A UI-only fixture is not proof of an isolated working agent |
| Strong existing regression base | On this checkout: 278 root tests, 525 UI tests; both typechecks pass | Retain existing tests and lifecycle semantics while extending coverage |

Visual assessment used source and the existing local overview screenshot; this was not a fresh browser walkthrough. Existing tests ran locally, not in a clean OS or empty-home install. An independent audit run observed one watcher timeout in `ui/server/__tests__/api.test.ts`; its isolated rerun passed. The coordinator's full run passed, so T19 includes investigating the intermittent failure rather than declaring CI reliable. No live application, paid model request, or CAPTCHA solve was performed. Repository history has not been certified clean.

## Architecture decisions

1. **Keep clone-as-workspace for v1.** Do not add a database, cloud service, accounts system, Electron packaging, or separate arbitrary data directory in this release. Private runtime files remain ignored. A future data-root split would require changing all extension gates, run cwd, browser paths, watcher paths and migration logic together.
2. **Pin the actual harness.** Installed pi is `@earendil-works/pi-coding-agent` 0.84.3; use it as the first compatibility candidate, not an automatic promise that every dependency is publicly reproducible. Verify RPC, trust flags, extension imports and browser MCP from an empty home. Resolve packages locally, not through nvm paths. Select the supported Node line after checking the entire pinned dependency graph, including Vite.
3. **Use pi's provider layer.** Put one versioned application configuration over pi's provider registry/auth mechanisms; applying and scoring consume the same connection records. Support explicit agent and scoring model selections. No silent fallback to a paid provider. A missing agent model blocks running; a missing scoring override uses the selected agent connection/model with that choice visible.
4. **Isolate application-owned pi state.** Proposed local `/.pi-jobs/pi-agent/` stores application-owned auth/model/session configuration using pi's agent-directory facility, behind a tested adapter. Both CLI launcher and UI runner use it. Import existing global pi connections only through explicit selection, preserve their originals, and never indiscriminately load global extensions. If the pinned API cannot isolate reliably, resolve that in T02 before configuration implementation.
5. **Separate public configuration from credentials.** Extend `settings.json` to schema version 2 with connection metadata and execution choices. Model keys live in the application-owned pi auth store; existing CAPTCHA keys can remain in the private settings store for compatibility. Server APIs return configured/source/validation status, never key values. Do not put secrets in browser storage, URLs or process arguments.
6. **Configuration precedence is explicit.** Authorized launcher environment overrides stored connection credentials; stored credentials override absence. Pi's native order must be reconciled in the adapter rather than assumed. Show the source without showing the value. Preserve CAPTCHA's existing rule: Off disables solving even if a key exists in the environment. No automatic GCP lookup in the public path. Maintainer deployment/local scripts may retain an explicitly selected GCP backend; any newly required maintainer environment secret must be added to Secret Manager and its deployment/local loaders. Public users' BYOK is explicitly local and does not require GCP.
7. **Manual email verification is sufficient for v1.** Missing Gmail tooling must lead to a clear user handoff, not a broken run. Optional Gmail integration can be documented only when its install/auth path is reproducible. Avoid building a new OAuth integration in the critical path.
8. **One running agent per workspace.** Retain locking, redaction, SSE recovery, stale-run handling and termination guarantees. Model/credential changes apply to the next run; the active run retains a sanitized immutable configuration snapshot.
9. **Local server is still a privileged boundary.** Protect state changes and credential reveal against hostile web origins/hosts; constrain file access and uploads to intended paths. Production serves built UI and API on the same loopback origin. Development uses a narrowly allowed proxy origin.
10. **Prepare a clean public export by default.** Produce a reviewed export from an allowlist, initialize fresh history there, and leave the original checkout/history/private files intact. Do not rewrite the live repository or publish it during these tickets. A later request to preserve history requires a separate audited history-cleaning procedure.

Pi supports API-key providers and custom model endpoints; use its facilities instead of inventing a second model SDK layer. Sources: [pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [pi custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md). Local installed package/docs are the compatibility baseline; upstream main is a moving reference. T02 records pinned source links.

## Release scope

**Required:** macOS and Linux installation; clear Windows/WSL support status; one-command startup after install; empty/demo workspace; profile and resume setup; targets editing; discovery/review; queue; supervised running; application tracking; bring-your-own model keys; OpenAI, Anthropic, Google and an OpenAI-compatible connection path through pi; separate scoring choice; optional existing CAPTCHA providers; manual CAPTCHA/email handoff; tests, CI, documentation, license decision, and audited public export.

Provider support means the pinned integration has passed the capability checks needed by the feature. An OpenAI-compatible endpoint passing a text request does not establish reliable agent tool use. Other pi providers can remain advanced configurations until tested. Local endpoints may be keyless and offline; do not reject them merely because there is no paid API key.

**Deferred:** hosted/multi-user deployment, native Windows promise, containerized interactive browser as default, automatic email integration for every mailbox, new ATS adapters, mass auto-apply, payment/billing, resume generation, recruiter CRM, native desktop installers, autonomous background scheduling. Existing adapter behavior remains covered.

## Shared API contract handoff

T04 owns the new shared types; feature owners implement endpoints below. These are proposed contracts to freeze before parallel page work. Existing endpoints remain compatible until their consumers migrate.

| Contract | Owner | Required behavior |
|---|---|---|
| Settings v2/readiness types | T04 | Credential-free connection metadata, agent/scoring selection, revision, capability-specific blockers |
| `GET /api/readiness` | T12 server + UI | `{capabilities:{browse,discover,score,apply},checks:[{id,status,message,remedyRoute}]}`; each capability has `ready` and blocker IDs; no paid network probes |
| Connection CRUD/test/models | T05 | Write-only key on create/replace; explicit remove operation; sanitized status/source/test time, stable connection IDs and paged model list if needed |
| `GET/PUT /api/targets` | T14 | Parsed supported boards plus revision; PUT requires revision and preserves non-owned Markdown; field-indexed validation errors |
| Discovery list/detail/dismiss | T14 | Stable opaque cursor, bounded limit, validated filters; detail keyed by safe slug; dismissed state stored as versioned UI metadata, never deleting source jobs |
| Scoring run | T14 integration, T06 execution | Extend `RunKind` with an allowlisted scoring kind and typed bounded selection; updates go through the same lock/lifecycle stream, not a second uncontrolled process |
| Resume upload/assignment | T13 | Bounded multipart PDF upload, explicit replacement flag/revision; assignment updates existing profile semantics under conflict checks |
| Evidence retrieval | T17 | Safe slug-derived authorized artifact URL, missing artifact 404, no arbitrary filesystem path input |

For new mutations use a typed error payload `{error:{code,message,fieldErrors?},revision?}` and an expected revision on replace/update. Map invalid input to 400, missing resource to 404, stale revision or busy run to 409, oversized upload to 413, unsupported media to 415, upstream failure to 502/504. Clients normalize legacy error payloads during migration. T08 owns serialization and redaction. Connection testing returns a sanitized test result for provider rejection rather than confusing the provider's 401 with local UI authentication. Settings/readiness refresh after configuration mutations; run events preserve existing sequence/replay semantics.

## Execution order and parallel work

| Wave | Tickets | Exit criterion |
|---|---|---|
| 0: boundaries and design | T01, T02, T10 | Private/public boundaries recorded, reproducible harness contract chosen, UX composition specified |
| 1: foundations | T03, T04, T08, T11 | Portable workspace/config primitives, protected API boundary and shared visual components |
| 2: working local product | T05, T06, T07, T09, T12, T13 | Launcher starts; BYOK reaches both agent and scorer; setup can finish |
| 3: workflows | T14, T15, T16, T17, T18 | Every new page works with real contracts and synthetic fixtures |
| 4: release validation | T19, T20, T21 | CI, end-to-end fixtures, empty-home instructions and upgrade preservation pass |
| 5: public candidate | T22 | Clean export is scanned and reproducible; publication decision is concrete |

Dependencies inside a wave still apply; the table is not permission to start dependent work early. T20 can establish CI skeleton after T02/T03 and expand it as workflows land. T21 can draft documentation early, but closes only against tested commands.

Recommended critical path: T02 → T03/T04 → T05 → T06 → T09/T12 → T14/T16 → T19/T20 → T21 → T22. T01 is a separate mandatory release gate. Design T10/T11 runs beside foundations. Most tickets are 0.5–2 engineer-days; T02/T06/T14/T16/T19 may take 2–3 each. Budget roughly 25–40 engineer-days including integration and rework, or 3–5 calendar weeks with two productive implementation lanes and review. These are planning estimates, not agent-runtime or token-cost guarantees.

## Agent delivery policy

- The coordinating agent owns planning, task decomposition, review and integration decisions. **All product implementation, test changes and implementation fixes are assigned to cheaper-model subagents.** Planning documents may be authored by the coordinator.
- Default execution model: `gpt-5.6-luna`. If a task needs a different execution route, Cursor is permitted only with **`grok-4.6`, `kimi-k3`, or `composer-2.5`**, with **fast mode disabled**. No other Cursor model, automatic model choice, silent fallback, or fast mode. Stop that worker if its actual model/mode cannot be verified; use the permitted Codex worker instead.
- These restrictions concern agents implementing this project. They do not restrict the public product's end-user provider choices.
- Give each worker one ticket or a tightly coupled slice, owned paths, contracts, dependency commits, acceptance tests and model constraints. Every worker is told it is not alone and must preserve others' changes. Use isolated worktrees from a reviewed product baseline; copy only required synthetic fixtures, not private workspace files. Do not use a raw branch tip as though it included the user's uncommitted changes.
- Only one worker at a time owns `App.tsx`, `index.css`, shared types, package manifests or run-manager internals. Feature workers use agreed modules and request shared-contract edits from that owner.
- Each PR contains behavior, tests actually run, screenshots for UI, migration/rollback notes when relevant, and unresolved limitations. Coordinator reviews; corrections go back to the cheaper worker. No live submissions as automated tests.
- Run focused checks on every ticket, full root/UI suites and typechecks for shared-contract integration, and the release matrix once the integrated candidate is stable.

Example worker brief: “Implement T05 in the reviewed worktree. Own provider adapter and its tests; T04 owns shared config. Use gpt-5.6-luna. You are not alone; do not revert others' edits. Complete all T05 acceptance checks with fake credentials/local HTTP servers. Return changed paths, commands/results and limitations.”

## Release gates and rollback

1. A clean export contains only reviewed product files, synthetic fixtures and licensed assets; scan current contents, all refs of the export, archives and screenshots. Re-check after docs/screenshots are added. No personal paths or runtime data in release artifacts.
2. Empty HOME, no global pi, no gcloud, no Gmail and no provider keys: installation and UI browsing work; setup explains missing capabilities. Add a synthetic/local provider and the full mock workflow works.
3. macOS and Linux: clean `npm ci`, build, start, health, extension discovery, browser launch, root/UI tests and typechecks. Windows/WSL instructions state what was actually verified.
4. Setup → discover → review → queue → start → answer → complete → track passes against a local fake ATS and fake model. No real employers receive test submissions.
5. Invalid keys, quota/429, timeout, dropped stream, restart, missing browser, malformed workspace, concurrent updates and invalid upload all have tested recoverable states. No secrets in responses, logs, sessions presented to the UI, or exported diagnostics.
6. Upgrade tests preserve profile, state, credentials, resume hashes and custom Markdown; migration is idempotent, backup-first and fails safely on unknown versions. Restore backup and prior compatible code to roll back; never automatically downgrade a new schema.
7. License and public destination are selected before publication. Default recommendation: MIT, pending owner choice and dependency/asset review. T22 prepares the complete candidate and exact publish steps; creating a public repository or changing visibility is a later authorized action.

## Deferred owner decisions

Planning can proceed with the defaults above. Visual preference can refine T10; operating-system expansion can refine T02/T20. License, repository name/owner, and publication timing are needed only at the release gate. None requires stopping the current planning work.
