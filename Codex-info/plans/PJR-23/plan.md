---
purpose: Implementation plan with tasks and verify steps; requires human approval before start.
ticket: fresh-user-provider-pilot
status: draft
created: "2026-10-08T20:45:02Z"
updated: "2026-10-08T21:40:00Z"
---

# fresh-user-provider-pilot: Implementation Plan

**Date:** 2026-10-08 (draft r7: D9/T5b any-provider + Cursor (incl. Cursor sign-in, owner direction 2026-10-08), revised after review rounds 5-7)
**Base:** `main` at `27d6206` (PJR-15 merged; PJR-12 and PJR-21 were merged before it).
**Worktree:** `~/rolebound-worktrees/pjr-23-fresh-user-pilot` on branch `codex/pjr-23-fresh-user-pilot`, created from `~/rolebound-public`.

## Objective

Prove, with reproducible evidence on the candidate SHA, that a new user can do all of the following:

- install Rolebound in a clean environment;
- connect their own model provider;
- set up their profile, resume, address and targets in the UI;
- run gather, then score, then review, then promote.

Then, separately and only with the owner's explicit authorization, record a small real-provider smoke and a supervised real application.

Real evidence is kept apart from fixture and synthetic evidence. Anything not verified is said to be unverified, never implied.

### Two phases, in order

**Phase A** requires no spend and no authorization. It covers:

- the fixes the walkthrough finds;
- deterministic smokes and tests, including real-RPC manual-verification and interruption tests;
- the support walkthrough.

Phase A completes acceptance criteria 1, 3 and 6, plus the fixture half of 2. It ends with a **code freeze**: the PR head SHA at the end of Phase A is the pilot SHA.

**Phase B** requires owner authorization (questions Q1 and Q2) and the owner present. It runs on the pilot SHA and covers:

- the owner's real UI onboarding (the rest of criterion 2);
- one real-provider smoke (criterion 4);
- one supervised application pilot (criterion 5).

Without authorization, criteria 2, 4 and 5 stay unchecked, the ticket is blocked with that reason, and nothing is reported as passed.

## Current state (verified on origin/main 27d6206; review round 1 confirmed and extended)

**Install and launcher**

- The install steps are `npm ci`, `npm run setup`, `npm run build`, `npm start`, `npm run doctor` (README:31-39).
- Pi comes from `node_modules`, so no global pi, auth, GCP or Synthetic key is needed.
- The server listens on 127.0.0.1:4747. When the port is taken, `ui/server/index.ts:29-35` prints `port N is already in use` and exits 1.
- `resolveWorkspaceRoot` only accepts the clone's own root (`scripts/workspace.mjs:172-179`).

**Doctor** (`scripts/pi-jobs.mjs:68-81`, `scripts/doctor-readiness.mts`)

- There is no port check and no Node version gate, and `package.json` has no `engines` field.
- A missing browser prints only `BLOCKED browser: missing`. The browser lookup runs through a login shell (`pi-jobs.mjs:70`).
- Readiness lines are bare codes.
- There is no doctor test, and there is no root node-test glob: `workspace-test` names its scripts one by one (`package.json:25`).

**Readiness** (`ui/server/readiness.ts`)

- A fresh workspace reports `AGENT_MODEL_MISSING`, not `CREDENTIAL_MISSING` (`:43`).
- The template's `example-co` targets count as configured (`templates/targets.template.md`, `readiness.ts:142`).
- Only the agent selection is checked (`:141`). Nothing checks the scoring override.
- Capabilities are `browseReady`, `discoverReady` and `applyReady`. There is no score capability, and the Discover "Gather now" and "Score unscored" buttons do not consult readiness (`DiscoverView.tsx:173,176`).

**Providers**

- Run-start preparation errors such as `CREDENTIAL_MISSING` become HTTP 500 (`routes/runs.ts:120`, `runManager.ts:1433`).
- A loopback openai-compatible connection is deliberately allowed to have no key (`providerService.ts:86`).
- `RunConfigSnapshot` records only the agent selection (`ui/shared/config.ts:17`).
- Scoring runs 2 concurrent workers (`job-gatherer.ts:300-321`) and retries 429, 5xx and timeouts up to 3 attempts (`lib/scoring.ts:142`).

**UI-only onboarding gaps**

- `## Candidate summary` (`templates/profile.template.md:148`) contains `<FILL IN …>` placeholders and is sent to the scorer word for word.
- It is not in `PROFILE_EDITABLE_SECTION_IDS` (`ui/shared/types.ts:537`), and the profile reader excludes it from editable bodies (`ui/server/readers/profile.ts:178`).
- `ProfileBulletForm.tsx:169` says "Add bullets in profile.md".
- README:103-105 tells users to hand-edit `profile.md` and `targets.md`.

**Gather**

- Gather hard-codes the ATS hosts (`job-gatherer.ts:348,387,425`), and `fetch` follows redirects by default.

**End-to-end harness** (`ui/e2e/web-server.mjs:80,120`)

- It is demo-only: it writes a demo marker and sets `PI_JOBS_DEMO=1`.
- Every spec runs in 5 Playwright projects (`playwright.config.ts:25`).
- `scripts/fixtures/scripted-model.mjs` has no `/models` route, but Test connection requires one (`providerService.ts:104`).

**Manual verification**

- `request_manual_verification` (`job-applier.ts:690`) is answered through `/api/runs/:id/ui-response`.
- Existing coverage is route-level (`runs.test.ts:910`) and demo (`demo.test.ts:101`).
- The `submission-boundary.spec.ts` OTP and CAPTCHA tests call generated scripts directly, bypassing the run panel.

**Backup and upgrade**

- `createBackup(root, relativePaths)` has no user-facing command. Users only get migration and pre-restore backups (`workspace.mjs:27,121,166`).
- `restoreBackup` lock mapping covers only `jobs/**.md`, `targets.md`, root JSON files and `profile.md`. Resumes and the `.pi-jobs/pi-agent/auth.json` key store are not backed up (`workspace.mjs:36-45`).
- Restore is `npm run restore -- --backup <id>`, and there is no list command.
- `WORKSPACE_VERSION` is 2 on both 33135c9 and main.

**Interruption**

- After a restart the run manager has no current run. The orphan is reclaimed when the next run starts (`runManager.ts:227,237,470`).
- The apply rate limit is the minimum interval between submits (`APPLY_RATE_LIMIT_MS = MIN_SUBMIT_INTERVAL_MS`, `readiness.ts:246`). It has no test override.

**Platforms**

- macOS and Linux are supported; Windows is unsupported.
- CI runs ubuntu-24.04 and macos-15 on Node 24.14.0 with an empty HOME. The macOS verify job has no export or install steps.
- This Mac has no Docker, VM or container tooling, and runs Node 22.22.1.

## Decisions

### D1. Clean-environment matrix

| Platform | Clean environment | Notes |
|---|---|---|
| Linux | The GitHub Actions ubuntu-24.04 runner: a fresh VM with an empty HOME | No local Linux option exists |
| macOS | The macos-15 runner, plus a local run on this Mac | The local run uses a fresh `release:export` at a path containing a space and non-ASCII characters, with `HOME` and `PI_CODING_AGENT_DIR` pointing at empty temp directories, provider env vars unset, and ticket-owned ports 148xx |
| Windows | Not tested | Stays documented as unsupported |

The local Node 22.22.1 is an extra data point near pi's minimum. It is not a substitute for 24.14.0.

### D2. Fix small onboarding, doctor and readiness gaps here

Fix rather than document when a gap is at most one component plus one route plus their tests. That covers:

- Candidate summary editing.
- Placeholder detection for profile and targets.
- Score readiness that includes the scoring override.
- Typed run-start errors.
- Doctor checks and messages.
- A `backup` command and a `restore --list` option.

Anything larger found during the walkthrough is recorded as an unresolved blocker and a ticket question, not built here.

### D3. Deterministic gather fixture: `PI_JOBS_ATS_FIXTURE_ORIGIN`

- It is test-only and replaces the three ATS hosts.
- It is accepted only as a canonical origin `http://127.0.0.1:<port>` or `http://localhost:<port>`, with no credentials, path, query or fragment. Any other value fails closed with an error.
- When it is set, fetches use `redirect: "error"`.
- The launcher and the documentation never set it.
- The real walkthrough uses real public boards.

### D4. Pilot workspace isolation

- The pilot runs in a ticket-owned clone outside every worktree: `~/rolebound-pilot-pjr23`, a fresh `release:export` of the pilot SHA followed by `npm ci`.
- It has its own `.browser-data` and runs on port 14823.
- The owner types the API key into Settings. The key never goes into a file the agent writes, into this session's environment, or into a log.
- Nothing from that workspace is committed.
- The tracked `docs/pilot-report.md` holds versions, OS, provider kind and model id, counts, timings and outcome codes. Employer and role are reduced to labels such as "Greenhouse employer A, engineering role". Full genuine receipts go only in the private Syntaur journal.

### D5. Real-run gating and spend

- No real-model call, paid CAPTCHA call or employer submission happens until the owner answers Q1 or Q2. The answer must give a provider and model, a spend cap and an application scope.
- **Provider answered 2026-10-08: Cursor.** Usage bills to the owner's Cursor plan request pool, so no separate monetary limit is required. The owner chooses the model.
- **Accounting.** The provider dashboard is the authoritative usage record. The bounded upper estimate is:
  - connection tests plus catalog fetches, counted from the owner's clicks, since these are not run-logged (`providerService.ts:114,125`);
  - scoring attempts, which T3 step 7 makes visible as a sanitized per-job `attempts` count in the score summary;
  - agent turns from the run log.
- **Scoring is bounded by explicit slugs.** "Score unscored" can score up to 50 jobs, so Phase B scoring uses `POST /api/runs {kind:"score", slugs:[≤10]}`, sent by Claude with the owner watching. The chosen slugs are recorded.
- **Stop conditions.** Stop if any of these happens:
  - usage cannot be bounded;
  - the provider dashboard shows 80% of the cap used;
  - a plan count is reached.

  The plan counts are:
  - at most 10 jobs scored, which means at most 30 scoring attempts;
  - at most 2 apply runs;
  - an apply run aborts beyond 80 agent turns. The measured figure for v3 Greenhouse is about 36.
- Fixture-backed tests cover the same paths in Phase A, so Phase B produces evidence, not discovery. If a Phase B run hits a defect, stop, then follow D6.

### D6. Code freeze and evidence invalidation

The pilot SHA is frozen at the end of Phase A. After the freeze, the branch may change only these paths:
- `docs/**` and `*.md`;
- test files (`**/*.test.*`, `**/__tests__/**`, `ui/e2e/**`);
- `scripts/*smoke*.mjs` and `scripts/fixtures/**`;
- `scripts/release-manifest.json`;
- `Codex-info/**`.

**Any other change** invalidates both T10 and T11 evidence by default, because the runtime inputs are broad: `ui/shared/**`, `applyGate`, readiness, onboarding routes, extensions, `runConfig` and providers.

Evidence may be kept only where an independent reviewer records, per changed file, why it cannot affect that evidence.

| Evidence invalidated | Rerun requirement |
|---|---|
| T10 | Rerun within the Q1 authorization |
| T11 | Rerun on the new SHA. This needs a fresh Q2, because a used posting cannot be resubmitted |

The report names the SHA each piece of evidence was taken on.

### D7. Upgrade baseline

The upgrade smoke installs 33135c9 (pre-PJR-12/15) first and seeds data through that version's HTTP API. It then moves the same clone to the candidate, mirroring the documented `git pull` path.

It needs git history, so it runs locally, not in the export job.

### D9. Any pi provider, including Cursor (owner direction 2026-10-08)

The owner's direction: "users should be able to use whatever provider they want. i use cursor." The owner also said Rolebound should **not** gain extra safety layers ("this is just an opensource thing. if they want more safety they can add it").

- **API-key providers.** The closed `ProviderKind` set becomes every provider in pi-ai 1.0.4's model registry that authenticates with an API key, which is about 30 ids. Examples: openrouter, groq, xai, mistral, deepseek, together, fireworks, cerebras, huggingface, zai, moonshotai, minimax, nvidia, opencode and opencode-go. The existing `openai-compatible` custom endpoint stays.
- **Cursor.** Cursor is supported through the `pi-cursor-sdk` pi extension (MIT, 0.5.3), pinned, which brings `@cursor/sdk` 1.0.37 with it.
  - Its key is a user API key from the Cursor dashboard, stored in the app store like any other key.
  - It runs with the extension's defaults (local runtime, pi tool bridge on).
  - No extra warning, sandbox or consent is added.
  - One honest sentence goes in SECURITY.md and the provider docs: the submission guard sees pi tools, including the browser through the bridge, but not Cursor's own Shell/Edit tools. That makes Cursor's coverage like the existing documented bash gap, only wider.
- **Out of scope, as a follow-up ticket:**
  - providers that need ambient or extra credentials: amazon-bedrock, google-vertex, azure, cloudflare-*;
  - OAuth/subscription logins: Claude Pro, ChatGPT/openai-codex, github-copilot. Their login is pi's interactive `/login`, and token refresh writes back to a persistent `auth.json`, which the per-run agent dir would discard.
- **License note for PJR-22.** `@cursor/sdk` is proprietary-licensed (Anysphere, "SEE LICENSE IN LICENSE.md") and ships native binaries. It is installed as a dependency, never vendored, so the license choice and third-party notices in PJR-22 must account for it.

### D8. Scope limits

- No new runtime dependencies except `pi-cursor-sdk` and its pinned tree (D9). These must pass `audit:deps` and the release audit.
- No new public environment variables beyond D3.
- No new run-history or recovery UI. Interruption evidence uses existing APIs.
- The scorer is not added to `RunConfigSnapshot`. Scoring routing is verified by the requests the scripted servers receive, and the pilot report records the scoring selection from settings.
- No repository visibility change or publication.

## Tasks

Each task gets its own commit (`PJR-23: <summary>`). A failing test lands before or with each fix.

### T0. Worktree and baseline

1. Create the worktree:
   ```bash
   syntaur worktree create --ticket PJR-23 --project pi-jobs-release \
     --branch codex/pjr-23-fresh-user-pilot --parent-branch main \
     --worktree-path ~/rolebound-worktrees/pjr-23-fresh-user-pilot
   ```
2. Run `npm ci`.
3. Copy the approved plan to `Codex-info/plans/PJR-23/plan.md` and add it to the manifest.
4. Run the full local CI mirror and record the counts as the baseline.

### T1. Doctor: actionable errors, wired into CI

**Files:** `scripts/pi-jobs.mjs`, `scripts/doctor-readiness.mts`, new `scripts/doctor.test.mjs`, `package.json`, manifest.

1. **Node version.**
   - Add `"engines": { "node": ">=22.19.0" }`.
   - Doctor compares the running version and prints `BLOCKED node: <v> is too old — install Node 22.19+ (24.14.0 is tested)`.
2. **Port.**
   - Doctor binds 127.0.0.1 at `--port` or 4747 and closes it immediately.
   - On a foreign listener it prints `BLOCKED port <p>: in use — stop the other process or run npm start -- --port <n>`.
   - If `/api/health` answers as Rolebound, it prints `OK port <p>: Rolebound already running`. First read the health route and use a field that identifies the server. If none distinguishes this workspace, print "a Rolebound server" without claiming it is this workspace.
3. **Browser.**
   - Move the browser lookup behind an injectable function, which is the test seam.
   - The missing-browser message includes an OS hint: on macOS, install Google Chrome into /Applications; on Linux, install google-chrome or chromium on PATH.
4. **Readiness lines.** Print each code with the same human message the UI uses, taken from the readiness blockers. Do not duplicate the strings.
5. **Root.** Print the workspace root path, quoted.
5a. **`--repair` forwarding (shipped bug).** `npm run doctor -- --repair` never reaches `doctor-readiness.mts`: `pi-jobs.mjs:75` passes only `root`, so the repair path that PJR-12 documented does nothing.
   - Forward `--repair`.
   - Without `--repair`, doctor prints the reconciler findings report-only (`reconcileWorkspace(root, {apply:false})`) as `RECONCILE <row>: <msg> (run npm run doctor -- --repair)`, which is PJR-12 D7's intended behavior.
   - Test both modes.
6. **Tests.** `doctor.test.mjs` runs doctor in a temp workspace and covers:
   - Node too old, through the seam;
   - a foreign listener on the port;
   - Rolebound itself on the port;
   - a missing browser, through the seam;
   - readiness messages printed;
   - a blocked run exits 1;
   - a fully ready workspace exits 0, set up with a loopback connection, a filled profile, a resume, targets and the acknowledgement;
   - a usage error behaves as the README documents (exit 2). If the code does not match the README, fix whichever is wrong.
7. **CI.** Add `scripts/doctor.test.mjs` to the explicit `workspace-test` script list, which CI already runs.

### T2. Fresh-install smoke (Linux and macOS CI, plus local macOS)

**Files:** new `scripts/fresh-user-smoke.mjs`, `.github/workflows/ci.yml`, manifest, and `package.json` (`"fresh-user-smoke"`).

**Inputs and environment**

- `--root <dir>` is an already exported, `npm ci`'d candidate directory.
- Every command runs with `cwd` set to that directory, so `resolveWorkspaceRoot` binds to the export itself.
- The child environment uses:
  - an empty temp `HOME` and `PI_CODING_AGENT_DIR`;
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CAPSOLVER_API_KEY` and `TWOCAPTCHA_API_KEY` deleted. Take the exact CAPTCHA variable names from `ui/server/captcha.ts`.

**Steps**

1. **Setup twice.** Run `npm run setup` twice. The second run leaves `profile.md`, `targets.md`, `settings.json` and `state.json` byte-identical.
2. **Build.** Run `npm run build`.
3. **Doctor on a fresh workspace.**
   - Run `npm run doctor`. It exits 1.
   - Assert the **actual** scaffold blockers with messages:
     - `AGENT_MODEL_MISSING`;
     - the profile blockers, including the new `PROFILE_PLACEHOLDERS`;
     - `RESUME_MISSING`;
     - the new `TARGETS_PLACEHOLDER`;
     - `ACKNOWLEDGEMENT_MISSING`.
   - Before asserting, record them from a first run so the expectation comes from the shipped behavior.
4. **Start and stop.**
   - Run `npm start -- --port <p>`.
   - Assert `/api/health` is ok, `/api/readiness` has the same blockers, and the dashboard HTML is served.
   - Send SIGINT and assert the port is released.
5. **Occupied port.** Pre-bind a foreign listener on `<p>`.
   - `npm start` exits 1 with the in-use message.
   - Doctor prints the T1 port blocker.
6. **Global auth is ignored.**
   - Write a hostile `$HOME/.pi/agent/auth.json` containing a fake key, then start.
   - Readiness still reports `AGENT_MODEL_MISSING` or `CREDENTIAL_MISSING` when a credential-required connection is added through the API without a key.
   - Grep every file the server wrote under `--root` for the fake key and expect no match.
7. **Missing browser.** This is covered only by T1's seam test. PATH stripping is not used, because a login shell and `/usr/bin` can still find Chrome.

**CI changes**

- In the `release-export` job (Linux), export to `"$RUNNER_TEMP/rolebound pilot ü"`.
- In the macOS `verify` job, add explicit export, audit, `npm ci` and `npm run fresh-user-smoke -- --root <that path>` steps. These steps already exist in the export job; mirror them.

### T3. UI-only onboarding: readiness, profile and targets fixes

**Files:**

- `ui/shared/types.ts`;
- `ui/server/readers/profile.ts` and `ui/server/routes/profile.ts`, plus their tests;
- `ui/src/profile.ts` and the profile section editor;
- `ui/server/readiness.ts` and `readiness.test.ts`;
- `ui/server/routes/runs.ts` and `ui/server/runs/runManager.ts`, plus `runs.test.ts`;
- `DiscoverView.tsx`, SetupView and their tests;
- `ProfileBulletForm.tsx`;
- README install step 4.

1. **Candidate summary.**
   - Add `candidateSummary` to `PROFILE_EDITABLE_SECTION_IDS`.
   - Include it in the reader's editable bodies (`readers/profile.ts:178`) and in the profile payload.
   - Add a plain-text editor with the same revision and conflict handling as the other sections, and a 2,000-character cap. If the scorer has its own budget, use that instead and document it.
   - Saving writes the body below the template's HTML comment, which is preserved.
   - Clearing the text clears the body, and the gatherer falls back to its documented composed summary. Add a test of that fallback.
2. **Placeholders.** Use one shared detector.
   - **Enumerate** every placeholder form in `templates/profile.template.md`. There are several: `<FILL IN …>`, `<One-paragraph …>`, `<Project or theme>` and the other bracketed angle forms, including those at lines 69, 83, 88, 99, 101 and 133. HTML guidance comments are excluded.
   - Commit the list as a table in the detector's test.
   - `PROFILE_PLACEHOLDERS` lists each section that still contains a placeholder.
   - **Apply** blocks only on placeholders that are both sent to employers and editable or removable in the UI. If a section with placeholders cannot be edited in the UI, that is a D2 gap: make it editable within D2's threshold, or record it as a blocker. Never block on something the user cannot fix in the UI.
   - **Score** blocks on placeholders in identity and the candidate summary. If the candidate summary is empty, the gatherer composes a summary from identity and work history (`.pi/extensions/lib/profile.ts:345`), so score also blocks on work-history placeholders. Test fallback scoring against an untouched template work history: it must be blocked, and must not send placeholder text.
   - `TARGETS_PLACEHOLDER` fires when the only targets are the template's `example-co` entries. It blocks **discover**.
3. **Score readiness.**
   - Add `scoreReady` and `scoreBlockers` to readiness. They include **both** of a score run's real dependencies.
     - The agent selection: `runConfig.ts:201-208` resolves the agent selection and its credential for every run kind.
     - The scoring selection (`settings.scoring ?? agent`).
   - Both are computed with the `agentModelBlockers` logic, so a credential-required connection without a key yields `CREDENTIAL_MISSING`.
   - Score placeholders also count.
   - Test a valid scorer with a missing or invalid agent: it must not be ready, and must return the same code at run start.
   - Setup shows a scoring line when an override is set.
   - "Gather now" is disabled while `discoverReady` is false, and "Score unscored" while `scoreReady` is false. Each shows the first blocker message with a Fix link.
4. **Typed run-start errors.**
   - Map run preparation errors to HTTP 422 with `{error, code}`. This covers `CREDENTIAL_MISSING`, `AGENT_MODEL_MISSING`, `MODEL_UNAVAILABLE`, `TOOLS_UNSUPPORTED` and `CONFIG_INVALID`, along with the existing 409 codes.
   - At run start the server re-checks readiness for that run kind and returns the same codes.
     - `gather` checks discover readiness.
     - `score` checks score readiness.
     - `apply` and `apply-next` check apply readiness, including `PROFILE_PLACEHOLDERS`, inside `applyGate` (`ui/server/applyGate.ts`) alongside the policy checks. The guard is not a substitute for this check.
   - Direct HTTP tests prove that `apply` and `apply-next` with placeholder blockers return 422 and spawn no run.
   - **Tests:** discover, score and apply readiness are each tested independently, and each typed error has a route test.
5. **Bullets.**
   - If bullets cannot be added in the UI, add that with the existing bullet form, as long as it stays within one component plus one route.
   - Otherwise, record it as a walkthrough blocker and a ticket question.
   - The commit message says which choice was made.
7. **Scoring attempt count.** Extend the score summary to include the number of attempts per job, retries included. The count contains no prompt or response text. It is used by D5's accounting and appears in the run log.
6. **README step 4.** Describe the UI path instead, and add one line saying the Markdown files remain editable. Log a note on PJR-22 that the quickstart was touched for accuracy.

### T4. Deterministic UI onboarding journey and gather fixture

**Files:**

- `.pi/extensions/job-gatherer.ts` and its tests;
- `scripts/fixtures/scripted-model.mjs` and its test;
- a new `ui/e2e/fixtures/ats-json/server.mjs`;
- a new `ui/e2e/fresh-web-server.mjs`;
- a new `ui/e2e/fresh-onboarding.spec.ts`;
- `ui/e2e/playwright.config.ts` and `run-suite.mjs`;
- the manifest.

1. **`resolveAtsOrigin()`** implements D3.
   - It must accept 127.0.0.1 and localhost.
   - It must reject:
     - `https://evil`;
     - `http://10.0.0.1`;
     - `http://127.0.0.1.evil.com`;
     - `http://user@127.0.0.1:1`;
     - a path, query or fragment;
     - `file:`.
   - In fixture mode a 302 to a non-loopback URL produces an error, and the redirect target receives no request. Test this with a second listener that counts requests.
2. **Scripted model.** Add `GET /models`, which returns the configured model id.
   - Add request capture: method, path, headers and body, readable through a test endpoint or callback.
   - Add per-request scripted responses: status codes, delays and malformed bodies.
   - Keep `scripted-model.test.mjs` passing and extend it.
3. **ATS JSON fixture server.** It serves Greenhouse, Ashby and Lever board JSON shapes for a few fictional slugs. Reuse `lib/adapters/__fixtures__` data where its shape fits.
4. **`fresh-web-server.mjs`** builds a non-demo workspace by **reusing the app-directory builder that `scripts/submission-smoke.mjs` and `runtime-smoke.mjs` already use**. `npm run setup` cannot target an external root, because `workspace.mjs:177` rejects it.
   - The builder produces a temp app directory with these copied in: `.pi/`, `lib/`, `ui/shared`, `templates/` and `package.json`.
   - `node_modules` is linked, not copied.
   - The workspace is scaffolded with the exported `initWorkspace()` function, which is the same scaffold `npm run setup` writes.
   - If the builder is not yet a shared module, extract it into `scripts/fixtures/app-dir.mjs` and use it from all three places.

   The server is started directly (tsx `ui/server/index.ts`) with:
   - `PI_JOBS_ROOT` set to that directory;
   - `PI_JOBS_ATS_FIXTURE_ORIGIN` pointing at the ATS JSON fixture;
   - an empty HOME and `PI_CODING_AGENT_DIR`;
   - no demo marker.

   It runs alongside the ATS JSON fixture and the scripted model. The scripted model serves `/models` and deterministic score JSON.

   **Reset per test.** A test-only reset endpoint is not added. Instead, the spec's fixture calls a harness helper that creates a **fresh app directory and server per test**, and passes `baseURL` to that test. Tests do not share a workspace. The corruption test also uses this helper.

   **Separate config.** Add `ui/e2e/playwright.fresh.config.ts`, which runs one chromium project using only `fresh-*.spec.ts`. `run-suite.mjs` invokes it as a second Playwright run after the demo suite. The existing config gets `testIgnore: fresh-*.spec.ts`, so that suite's five projects and its demo server are unchanged.
5. **`fresh-onboarding.spec.ts`** uses page interactions only. The steps are:
   1. Setup shows the actual scaffold blockers.
   2. Add an openai-compatible connection and use Test connection.
   3. Create the profile: name, email, phone, links, work history and candidate summary.
   4. Upload a fictional PDF and make it the default.
   5. Add a fictional address.
   6. Replace the targets with fixture slugs.
   7. Acknowledge auto-submit.
   8. Run Gather now.
   9. Run Score unscored. Assert the captured scorer request body contains the UI-entered summary and no placeholder token.
   10. Open a job's detail.
   11. Dismiss a job, then restore it.
   12. Promote a job.
   13. Setup reports every step complete.

   Step 3 also replaces or removes every placeholder that T3 classifies as blocking (the enumerated table), using the UI.

   After the steps, the spec asserts that the workspace files reflect the UI input. It never writes workspace files itself.

   Second test, starting from a fresh workspace: the Score button is disabled and shows its blocker while the candidate summary still has placeholders.

6. **`fresh-run-panel.spec.ts`** covers the real run panel through the real RPC path (resolves review finding 3). It uses the same fresh harness, plus the stub browser MCP and the Greenhouse fixture from submission-smoke. The scripted model drives an apply run on a fixture application.
   - **OTP:** the panel shows the verification prompt. The test types a code into the rendered input and submits it. The scripted model echoes the code it received, the run proceeds, and the panel shows completion.
   - **CAPTCHA pause:** with CAPTCHA off, the panel shows the manual CAPTCHA prompt, and a CAPTCHA-provider stub receives 0 requests. Clicking the rendered "done" control resumes the run.
   - **Stop:** while a prompt is pending, the test clicks the rendered Stop button.
     - While the run is still alive, capture pi's PID from `ui/run-manager.json` (`runManager.ts:576,931-938`), not from the run directory.
     - Before cleanup, observe the stop marker. Use the harness's file watcher on `.pi-jobs/runs/<runId>/stop.json`, started before the click, which records that the marker appeared. Completion deletes the run directory (`runConfig.ts:272`), so the marker cannot be asserted afterwards.
     - After the panel shows the run ended, assert:
       - the captured PID is gone;
       - the stub browser receives no further calls;
       - the run directory has been cleaned up.

### T5. Provider and scoring selection matrix (real run path)

**Files:** a new `ui/server/__tests__/providerJourney.test.ts`. It uses the real `runManager`, real pi RPC, a keyless environment, and two loopback scripted servers, A and B, from T4 step 2.

The tests use the shipped connections API only; no new API is added. Native kinds reject `baseUrl` (`ui/shared/config.ts:69`), and loopback openai-compatible connections may be keyless (`providerService.ts:86`). So request-level scenarios use loopback openai-compatible connections **with stored keys**: a stored key is resolved before the keyless branch, so the `Authorization` header is observable. The missing-credential scenario (#4) uses a native `openai` connection with no key and is asserted at the readiness and run-start layer, where no request may be sent at all.

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Agent on A, scoring override on B, score 3 jobs | B gets 3 scoring requests, A gets 0 |
| 2 | Override cleared | Scoring goes to A |
| 3 | Two connections of the same kind with different keys | Each request carries its own `Authorization` header |
| 4 | Scoring connection is credential-required and has no key | Readiness gives `scoreReady:false` with `CREDENTIAL_MISSING` naming the scoring connection; score run start returns 422 `CREDENTIAL_MISSING`; no request is sent |
| 5 | B returns 401 | The error is "rejected the credential"; exactly 1 request; the job stays unscored |
| 6 | B returns 429, then 200 | 2 requests; the job is scored |
| 7 | Malformed responses: `{"score":7}`, non-JSON, a reason over 1000 characters | "invalid scoring JSON"; the job stays unscored; a rerun with a valid response scores it |
| 8 | Cancel with 2 workers | B answers job 1, then holds jobs 2 and 3 at a barrier. After job 1's file shows `llm_score`, abort the run. Assert the run ended cancelled, the persisted set is exactly {job 1}, a rerun requests only the slugs that are unscored on disk, and the final state is all scored |
| 9 | New app instance on the same root | Scores, reasons and template persist and are served by the Discover API |
| 10 | Hostile global `~/.pi/agent/auth.json` and a parent-environment `OPENAI_API_KEY` | Neither appears in any captured request |

### T5b. Any pi provider and Cursor (D9)

**Files:**
- `ui/shared/config.ts` and `ui/shared/types.ts` (readiness `warnings`);
- `ui/server/providers/providerService.ts` and `routes.ts`;
- `ui/server/runConfig.ts` and `ui/server/readiness.ts`;
- `.pi/extensions/lib/scoring.ts` (spike-dependent, see step 1);
- connection form components (`SettingsPanel`, `ConnectionSelections`, Setup);
- `package.json` and the lockfile;
- `scripts/pi-jobs.mjs` (doctor);
- `docs/runtime-matrix.md`, SECURITY.md (one sentence), and the T8 walkthrough provider section;
- tests next to each file.

**1. Spike (first, in the worktree, no real calls).**
- Both loading mechanisms exist: a local path in settings.json `packages` (pi-coding-agent `docs/packages.md:36-40`) and `-e/--extension` (`docs/cli.md:194`). Pick the per-run `settings.json` `packages` entry pointing at the installed `node_modules/pi-cursor-sdk`. Fall back to `-e` only if that fails.
- Confirm `pi --list-models` in the per-run dir lists `cursor/*` fallback models without a key.
- **Scoring through Cursor.** `lib/scoring.ts:149-152` builds its own `ModelRuntime`, and that runtime never sees extension-registered providers (`registerProvider` populates only the session runtime). Check whether scoring can use the session's model registry for a `cursor` scorer. Scoring runs inside the `score_discovered` and `score_job` tool `execute` functions (`job-gatherer.ts:1069,1097`), not in the `/score-discovered` command. The session context, including `modelRegistry`, is the fifth `execute` argument (`types.d.ts:494`). Pass it through `scoreAllDiscovered`/`scoreDiscoveredSlug` into `completeScoringRequest`.
  - If it can, and a Cursor completion with no tools returns plain text through `cursor-sdk`'s stream, implement that path for extension providers only.
  - Otherwise, **Cursor is agent-only.** `validateSelection`, the UI and readiness reject `cursor` as the scorer.
  - The default scorer also counts. With `settings.scoring` null and a cursor agent, the scorer falls back to the agent (`runConfig.ts:206,215`). In that case readiness reports `SCORING_MODEL_MISSING` ("choose a scoring model"), and `prepareAgentRun` leaves `PI_JOBS_SCORING_READY` unset. Add a test for both the explicit and the default case.
  - The result decides the Q1 follow-up and is recorded.
- Record all results in `Codex-info/plans/PJR-23/plan.md` under "Spike results".

**2. Config: the allowed provider list.**
- `ProviderKind` becomes a validated string.
- The set is computed as `isolatedMetadataRuntime().getProviders()` (pi-coding-agent `model-runtime.d.ts:68`), keeping providers whose auth exposes `apiKey`, **minus an explicit denylist**.
  - The denylist is `amazon-bedrock`, `google-vertex`, `azure`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `github-copilot`, and `radius`.
  - These report `apiKey` but need ambient credentials, extra fields or OAuth.
- Add `openai-compatible` and `cursor`.
- Do not import pi-ai directly. It is not a direct dependency (D8).
- Drop providers with no models, such as `typesafe`. Deny `radius` outright: it uses `pi-messages` and needs private gateway configuration.
- **Shared catalog file.** `validateConnection` is synchronous, shared with the client, and runs on every settings read (`ui/shared/config.ts:34,62`; `applicationConfigStore.ts:43`). So the list is committed as a generated `ui/shared/providerCatalog.ts`, containing ids, display names, API-key env names and scrub env names.
  - A generator script, `scripts/gen-provider-catalog.mts`, computes it from the pi runtime.
  - A unit test asserts the committed file matches the generator's output for pi 1.0.4, so a future pi upgrade fails that test until the file is regenerated.
- `baseUrl`/`api` stay `openai-compatible`-only.
- Existing settings v2 openai/anthropic/google connections load unchanged; add a test.

**3. Credentials and environment.**
- **Env var names per provider.** pi-ai's `getApiKeyEnvVars` is private (`env-api-keys` is not exported). Derive the names by calling each provider's `auth.apiKey.resolve` with a recording `ctx.env`; helpers loop over every candidate name.
  - If that does not reach every name, use a hand map. Either way, snapshot it in a test.
  - A provider can have several names; anthropic has three. Cursor uses `CURSOR_API_KEY`.
- The recorded names include things that are not API keys. Anthropic records four: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_FEDERATION_RULE_ID`. So the catalog keeps two lists:
  - `apiKeyEnv`: the single API-key name (`*_API_KEY`, `HF_TOKEN`, etc.). It is used for env precedence and the UI hint.
  - `scrubEnv`: every recorded name.
- The `runConfig` child-environment scrub deletes every `scrubEnv` name for every provider, plus `CURSOR_API_KEY`.
- **Aliasing.** Registry providers use the existing `pi-jobs-<id>` alias with `serializeNativeModel`.
- **Cursor cannot be aliased**, because the extension registers `cursor` itself. Spell out the Cursor branches:
  - `providerConfig` skips `registry.getModel` for `cursor` (`runConfig.ts:138-139`). Otherwise prepare throws `MODEL_UNAVAILABLE`, even for gather or apply runs.
  - The `auth.json` key goes under `cursor`.
  - `cfg.model`, `PI_JOBS_AGENT_MODEL` and `PI_JOBS_SCORING_MODEL` use `cursor/<model>`, not the alias (`runConfig.ts:226-229, 267-271`).
  - One Cursor connection per run; this is documented.
- The per-run `packages` entry for pi-cursor-sdk is written **only** when the agent or scorer connection is `cursor`. Runs on other providers do not load the extension, so they keep Node 22 support and its extra tools stay out.
- **Thinking for Cursor.** Validate the selected level against the extension's thinking map. If no map is exposed for the model, force `off`. Do not let readiness's catalog-model rule (`readiness.ts:56-58`) block Cursor.
- **Config isolation, not a safety gate.** Bring Cursor in line with the existing per-run `PI_CODING_AGENT_DIR` isolation, so runs do not inherit the user's Cursor IDE setup.
  - runConfig sets `PI_CURSOR_SDK_STATE_ROOT=<runDir>/cursor-state` and `PI_CURSOR_SETTING_SOURCES=none`. Without them, the SDK's store goes to `~/.cursor/projects/...` and runs pick up `~/.cursor/mcp.json` and the user's settings.
  - A unit test asserts both in the child env.

**4. Catalog and test connection.**
- **Registry providers.** Models come from the registry, with no live call.
  - "Test connection" makes one minimal authenticated models request where the API is OpenAI, Anthropic or Google shaped and a base URL is known.
  - Otherwise it shows "key saved, not verified".
- **Cursor.** The model list uses **pi model ids**, not raw fallback ids.
  - Build it by importing `pi-cursor-sdk/shared/cursor-model-selection-identities.mjs` and `dist/cursor-fallback-models.generated.js`. The package has no `exports` field, so these deep imports resolve; both are pure JS.
  - That gives about 249 selectable ids (e.g. `composer-2.5`, `gpt-5.5@1m`). Raw ids such as `gpt-5.5` are not valid.
  - Test that `composer-2.5` is in the list and `gpt-5.5` is not.
  - The connection shows "key saved, not verified" until sign-in or the canary.

**4b. Cursor sign-in, not just pasted keys (owner direction 2026-10-08).** `@cursor/sdk` exposes `Cursor.auth.login({apiKeyName, openBrowser, onLoginUrl, store, apiKeyTtlMs})`. It returns `{apiKey, email, apiKeyExpiresAtMs}`, and with `store: null` it does not write `~/.cursor/sdk/auth.json` (`dist/esm/auth/login.d.ts:4-54`).
- **"Sign in with Cursor"** on the Cursor connection form, in both Setup and Settings.
  - **Login lifecycle.** There is at most one in-flight login per connection, held in server memory with its own `AbortController`.
    - `POST /api/connections/:id/cursor-login` starts `Cursor.auth.login({apiKeyName: "Rolebound", openBrowser: true, store: null, signal, onLoginUrl})`.
    - It replies only after `onLoginUrl` fires, and the reply contains the URL. It races that wait against the `login` promise's rejection, so an early failure returns `failed` instead of hanging.
    - The UI **always** shows that URL as a link. The SDK silently skips opening the browser under SSH or `NO_OPEN_BROWSER`.
  - **Status.** `GET .../cursor-login` reports one of `pending`, `succeeded`, `cancelled` (SDK `AuthenticationError` "Login was cancelled.") or `failed` (including the SDK's roughly 20-minute poll timeout).
  - **Cancel.** `DELETE .../cursor-login` aborts the login through the signal.
  - The entry is cleared when the login settles. A dashboard restart drops a pending login, and the UI then shows "sign-in interrupted, try again".
  - On success, the minted key is stored through the same `setConnectionCredential` path as a pasted key.
  - Non-secret metadata is stored on the connection: `email` and `expiresAt`.
  - The UI shows "Signed in as <email> · key expires <date>". The SDK's `email` is optional, so without one it shows "Signed in · key expires <date>".
  - "Cursor needs Node 24+" is shown next to the button when the server runs on Node below 24. Sign-in itself works on Node 22.13 and later, but runs would be blocked.
- **"Use my existing Cursor login"** appears only after an explicit click.
  - It calls `new FileCredentialStore().load()`, the SDK's public export. `status()` never returns the key. The default location is `~/.cursor/sdk/auth.json`.
  - `load()` checks neither expiry nor backend, so Rolebound does:
    - if `apiKeyExpiresAtMs <= now`, reject with "Your Cursor login expired, sign in again";
    - if `apiKeyExpiresAtMs` is missing, treat the key as never expiring;
    - if `backendUrl` (trailing slashes stripped) is not `https://api2.cursor.sh`, the SDK default production backend, store it and show a warning.
  - It then copies the key into the app store with its email and expiry.
  - If there is no stored login, it says "Not signed in to Cursor on this computer".
- **Readiness.**
  - A Cursor key expiring within 14 days gives a `CURSOR_LOGIN_EXPIRING` warning: "Sign in with Cursor again".
  - An expired key is a `CREDENTIAL_EXPIRED` blocker with the same fix link.
  - A pasted key without expiry metadata gets neither.
- **Tests.**
  - Inject the SDK auth module in route tests. Cover:
    - success stores the key and metadata and never echoes the key;
    - success without an email;
    - cancel through `DELETE`, which aborts the signal;
    - failure and timeout;
    - the URL is always returned, including with `openBrowser` injected as a no-op;
    - a second concurrent login for the same connection is refused.
  - Existing-login import with an injected `FileCredentialStore`: logged in, logged out, expired, no expiry, and a non-production backend.
  - Expiry warning and blocker.
  - Neither the key nor the login URL's one-time challenge is logged.
- **Real evidence.** The owner signs in with the button during the step 9 canary and T10.

**5. Readiness.**
- Add a `warnings` list to the readiness payload (`ui/shared/types.ts`), separate from blockers, and show it in Setup.
- A typed Cursor model id that is not in the fallback list gives a `MODEL_UNVERIFIED` **warning**, not a blocker.
- `TOOLS_UNSUPPORTED` does not apply to `cursor`.
- **Doctor and readiness block a selected `cursor` connection on Node below 24.** pi-cursor-sdk requires `engines.node >=24`. The message is "Cursor needs Node 24+".

**6. UI.**
- The provider dropdown has three groups:
  - Popular: OpenAI, Anthropic, Google, OpenRouter, Cursor.
  - All providers A-Z.
  - Custom: OpenAI-compatible.
- Each entry shows its env var name as the alternative to pasting a key.

**7. Dependencies.**
- Put `pi-cursor-sdk@0.5.3`, pinned exactly, in the same dependency section as `@earendil-works/pi-coding-agent`.
- Also add `@cursor/sdk@1.0.37`, pinned exactly. The server imports it directly for sign-in. A test asserts this pin equals pi-cursor-sdk's own `@cursor/sdk` dependency.
- The server loads it only with `await import()` inside the Cursor sign-in routes. The SDK's `index.js` is 2.2 MB, so non-Cursor users never load it.
- Confirm:
  - the lockfile carries the `@cursor/sdk` platform packages for linux-x64 and darwin-arm64;
  - `npm ci` in CI installs them;
  - `audit:deps` and the release audit pass.

**8. Tests.**
- **`runConfigProvider`:**
  - openrouter and groq produce the correct alias, `auth.json` entry and `--model`;
  - cursor produces the package load, the `cursor` key, `cursor/<model>` in `cfg.model` and both env names, and Cursor state and settings isolation;
  - the env scrub removes every mapped name, including `GROQ_API_KEY`, every anthropic `scrubEnv` name and `CURSOR_API_KEY`.
- **`providerService`:** env precedence for a registry provider.
- **`readiness`:** the cursor warning versus blockers, and the Node 24 block.
- **Cursor-scorer:** either the routing test or the rejection test, matching the spike outcome.
- **`providerJourney`:** gains a registry-kind scorer row asserted at the run-start layer.
- **`runtime-smoke`:** gains a keyless check that, with pi-cursor-sdk loaded, the run's tool list still includes the job tools and `job-playwright`.

**9. Cursor canary (owner present, before the T9 freeze, within Q1).**
- Use the owner's Cursor key in a throwaway ticket workspace on Node 24.14.0, with the sanitized env from T10, so `CURSOR_API_KEY` is unset in the parent.
- Run one no-tool prompt, then one `gather` run.
- Confirm:
  - the bridge exposes the job tools and the `job-playwright` tools;
  - the `credentialSource` is `app-store`;
  - nothing is written under `~/.cursor/projects` (compare before and after).
- Log the result.
- Any fix found here happens **before** the freeze, which keeps Phase B as evidence rather than discovery (D5/D6).

### T6. Manual verification and interruption through the real run path (API level)

**Files:** `.pi/extensions/job-applier.ts`, the extension harness tests, and `scripts/submission-smoke.mjs` (real pi RPC, scripted model, stub browser MCP, dashboard server) with its fixtures. These API-level scenarios run in CI next to T4's browser-level run-panel spec.

0. **The OTP never reaches the model (shipped defect).** `request_manual_verification` returns the user's code or link only in `details`. The model-visible `content` says just "User supplied a otp" (`job-applier.ts:700-701`), so on a generic site the agent cannot type the code.
   - First confirm nothing else reads `details.value`.
   - Then put the value in `content`, scoped: "Verification code: <value> — use it only for the current verification step."
   - Keep the response redacted wherever run output is persisted or shown, if such redaction exists. Follow the existing redaction path, and add one if UI-response values are persisted in clear today.
   - Harness test, plus the T6.1 assertion: the scripted model's **captured next provider request** contains the entered value.

1. **OTP through the API.** The scripted model calls `request_manual_verification` with kind `otp`. Assert:
   - the runs API shows a pending UI request;
   - a code answered through `/api/runs/:id/ui-response` reaches the model, which echoes it in its next call;
   - the run completes.
2. **CAPTCHA default pause.** With CAPTCHA off, assert:
   - kind `captcha` pauses the run;
   - the CAPTCHA-provider stub receives 0 requests;
   - a "done" response resumes the run.
3. **Stop while paused.** Assert:
   - the stop marker is written;
   - later browser calls are blocked with `RUN_STOPPED`;
   - no pi process remains, using the PID captured from `ui/run-manager.json` while the run was live;
   - the marker is observed before cleanup, as in T4 step 6.
4. **Interruption before submit, with progress preserved.**
   1. Seed the application as `in_progress` in `state.json`, with a non-zero CAPTCHA count from an earlier simulated pause.
   2. Start an apply run, and wait until the stub MCP has received at least one fill call.
   3. Kill **both** owned process groups with SIGKILL:
      - the dashboard server's;
      - pi's detached group (`runManager.ts:519`), using the pgid recorded in the run directory or lock.
   4. Assert no owned process survives.
   5. Restart the server on the same root, then assert:
      - the application entry is unchanged: still `in_progress`, the CAPTCHA count is preserved, and there is no `submitted_at`;
      - the run lock is stale.
   6. Start apply again on the same application. If the stale-lock threshold has not yet passed, the start reports the documented busy or stale code, and the test then waits through that threshold. Use the configured lock stale time; do not add a test-only override unless one already exists.
   7. The orphan is reclaimed (`reclaimOrphan` at run start), and the new run is accepted. No submit happened, so the rate limit does not apply.
   8. The run completes with exactly one fixture submit and is recorded as `submitted` with evidence. The CAPTCHA count carries over.
5. **Interruption after an observed submit.**
   1. Seed the application as `in_progress`.
   2. The scripted model runs the **observed Greenhouse submit-script path** (`submission-smoke.mjs:306,315`), so the guard writes `.pi-jobs/observed/<slug>.json`.
   3. The scripted model then pauses before `update_application_state`.
   4. The test waits until the observation file exists and is durable, then kills both process groups.
   5. Restart and assert:
      - R13 records `submitted` from the observation. The fixture app directory has no launcher, and the repository launcher rejects external roots (`workspace.mjs:177`), so invoke `tsx scripts/doctor-readiness.mts <fixture-root>` directly: first report-only, which T1 step 5a adds, then with `--repair`. T1's `doctor.test.mjs` separately proves that `npm run doctor -- --repair` forwards the flag.
      - a new apply is refused with `ALREADY_SUBMITTED`;
      - the fixture still shows exactly one submit.

**Rules for this task:**

- Assertions use existing APIs and files.
- When a behavior is missing, the failing test lands first. It is fixed only within D2's threshold; otherwise it is recorded as a blocker.
- This task adds no run-history UI (D8).

### T7. Upgrade, backup, restore and corrupt-file recovery

**Files:** `scripts/pi-jobs.mjs` (`backup`, `restore --list`), `scripts/workspace.mjs` (`DEFAULT_BACKUP_PATHS`), `package.json` (`"backup"`, `"upgrade-smoke"`), `scripts/workspace.test.mjs` or the existing workspace tests, a new `scripts/upgrade-smoke.mjs` (local only, per D7), and the manifest.

1. **`npm run backup`**
   - Calls `createBackup` with the lock-mapped set, held under the restore lock order:
     - `profile.md`, `targets.md`;
     - `settings.json`, `state.json`, `gather_state.json`, `credentials.json`;
     - `jobs/**/*.md`.
   - Refuses during an active run.
   - Prints the id.
2. **`npm run restore -- --list`** lists the backups with their ids, dates and file counts.
3. **Limits stated in the CLI output and in T8.** Resumes (`resumes/`) and model keys (`.pi-jobs/pi-agent/auth.json`) are **not** in backups. Copy `resumes/` yourself, and re-enter keys after a restore to a new machine.
4. **Tests:** the backup → change → restore round trip; refusal during an active run; `--list`.
5. **`upgrade-smoke.mjs --from 33135c9`**
   1. Clone the repo into a temp directory at `--from`. Run `npm ci`, setup and build, then start on a ticket port.
   2. Seed fictional data through that version's HTTP API:
      - the profile;
      - a resume PDF with a known sha256, made the default;
      - an address;
      - an openai-compatible loopback connection;
      - targets;
      - the legacy acknowledgement.

      Create one discovered job and one queued job by writing fixture files with the exact frontmatter used at that SHA, as a fresh install would produce them. Then stop the server.
   3. Check out the candidate SHA in the same clone, then run `npm ci`, `npm run build` and `npm run doctor`. Assert:
      - `ACKNOWLEDGEMENT_LEGACY` appears with its message, and nothing is corrupt.
      - After start, the resume sha256 and the default selection are unchanged.
      - The profile, address, targets and connection are intact.
      - The jobs are where they were.
      - Re-acknowledging clears the blocker.
   4. Backup and restore with `npm run backup`.
      - Change backed-up content: a profile section, an address, and a queued job's frontmatter.
      - Run `npm run restore -- --backup <id>`.
      - Assert those three are restored and a `-pre-restore` backup exists.
      - Separately, assert every PDF under `resumes/` keeps its sha256 through backup and restore. PDFs are not backed up; `default.pdf` is the physical default (`routes/profile.ts:320-323`). Do not expect restore to recreate deleted PDFs.
      - Assert restore is refused while a run is active.
   5. Corrupt-file recovery: write a zero-byte `state.json`. Assert:
      - the overview API returns `corrupt[]`;
      - doctor shows `STATE_CORRUPT` with its message;
      - restore recovers it.
6. **Browser assertion for the banner.** Add a test to `fresh-onboarding.spec.ts` (or a sibling spec in the same project) that corrupts `state.json` through the fixture helper, asserts the repair banner text is visible, restores, and asserts the banner is gone.

### T8. Support walkthrough

**Files:** a new `docs/support-walkthrough.md`, the manifest entry, and a docs test that checks every `npm run …` command it names exists in `package.json` (reuse the `scripts/submission-docs.test.mjs` pattern).

The walkthrough contains:

1. Prerequisites for each OS. Windows is unsupported.
2. The clean install, with the doctor output at each stage taken from T2.
3. UI onboarding, step by step, per T4, including what the auto-submit acknowledgement permits.
4. Provider setup:
   - one example per kind;
   - the scoring override;
   - Test connection;
   - each code and its fix.
5. Gather, score, review, promote and apply:
   - Stop;
   - manual OTP;
   - the CAPTCHA default pause;
   - optional BYOK CAPTCHA, marked unverified unless Phase B verified it.
6. Backup, the restore list, restore, upgrade, repair and corrupt-file recovery, with the T7 limits.
7. A table mapping each symptom to its doctor code and its fix, covering every `BLOCKED` line doctor can print.
8. Known unresolved blockers: the PJR-15 handoff limitations plus anything left open by T1-T7 and Phase B.

### T9. Phase A close and code freeze (after the T5b step 9 Cursor canary)

1. Run the full verification list below locally.
2. Push and get CI green on all three jobs.
3. Request an independent implementation review and resolve it to 0 high and 0 medium findings.
4. Record the head SHA as the **pilot SHA** in the journal (D6).

Criteria 1, 3 and 6 are ticked from this evidence. Criterion 2 is ticked only after T10.

### T10. Phase B: owner onboarding and real-provider smoke (needs Q1)

This runs in the D4 workspace on the pilot SHA, with the owner present.

1. Confirm the provider-side spend limit (D5).
2. Run `npm ci`, setup, build and doctor, then start on 14823.
   - Launch in a **sanitized environment** on **Node 24.14.0**, because pi-cursor-sdk needs Node 24 or newer and this Mac has 22.22.1. Use a ticket-owned Node 24.14.0 binary, and do not change the system Node.
   - Use `env -u` for `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, **`CURSOR_API_KEY`** (the owner's `~/.zshrc` exports it), every name in the T5b env map, any custom `envKeyName`, `PI_JOBS_ATS_FIXTURE_ORIGIN` and the CAPTCHA key variables.
   - The reason: environment keys win over stored keys (`providerService.ts:83-85`). Without this, an inherited key could be used instead of the owner-entered one.
   - Before the first scoring request, confirm `credential.source` is `app-store` for every selected connection: in the Settings connection view, and in the run snapshot's `credentialSource` after the first run.
3. The owner completes onboarding **in the UI only**:
   - enters the key and uses Test connection;
   - fills in identity, work history and candidate summary;
   - uploads their actual resume PDF and makes it the default;
   - enters their real address;
   - sets 1-3 real targets;
   - acknowledges auto-submit.

   - The owner then clears **every** placeholder blocker that readiness reports, through the UI. These come from the T3 enumerated table and include education, work authorization and the application Q&A. Setup must show apply ready before T11.

   If the owner had to touch any Markdown, record which file and why. That is a criterion-2 finding.
4. Run Gather.
5. Score at most 10 jobs that the owner picks, using an explicit-slug score run (D5). Do not use "Score unscored".
6. Review the scores.
7. Promote one job.
8. Record the following:
   - the Node, npm, pi, `@playwright/mcp` and Chrome versions;
   - the OS;
   - the pilot SHA;
   - the provider kind and model id for both the agent and the scorer;
   - the D5 accounting: connection tests and catalog fetches counted from clicks, scoring attempts from the summary, and provider-dashboard usage, which is the authority;
   - the outcomes as counts and score values, with job titles redacted.
9. Confirm the key's last 6 characters appear nowhere in the workspace except the key store.

### T11. Phase B: supervised application pilot (needs Q2)

This runs in the same workspace with the same model, and the owner is present throughout. There are at most 2 apply runs (D5 caps).

Cancel goes **first**, because a submit starts the 10-minute interval (`submission-policy.ts:847`). The rate limit stays on.

1. **Cancel.** Start an apply on the owner's chosen "cancel" posting, and the owner presses Stop before the submit step. Assert:
   - `RUN_STOPPED` blocks follow;
   - there is no submit observation;
   - the state is not `submitted`;
   - no owned process remains.
2. **Submit.** Apply to the owner's chosen "submit" posting. Record:
   - the guard's allow and block classes, from the run log;
   - the observation file;
   - `submitted` with confirmation evidence and a screenshot;
   - the employer's genuine receipt.

   If the employer sends a code, the owner types it into the run panel. That is the real manual OTP; otherwise it is recorded as "not encountered", with T6 as the deterministic evidence.
3. **CAPTCHA.** With the setting off, if a CAPTCHA appears, check that the run pauses and the owner solves it. If none appears, record "not encountered", with T6 as the deterministic evidence. Do not provoke CAPTCHAs.
4. **Paid CAPTCHA.** Test it only if Q2 authorizes it, with the provider and task cap given there. Otherwise disclose it as unverified.
5. **`docs/pilot-report.md`:**
   - "Genuine employer receipts", redacted;
   - "Fixture receipts", by test name;
   - the matrix: OS, Node, runner, SHA and result;
   - Phase A evidence;
   - Phase B evidence, with the SHA of each item;
   - unverified items;
   - unresolved blockers.
   - The real manual OTP and the CAPTCHA pause are each marked "encountered" or "not encountered", with the T4/T6 deterministic evidence cited separately.

   Add it to the manifest. Commit only docs, tests and the manifest after the freeze (D6). Tick criteria 2, 4 and 5 from this evidence. Push, wait for CI to go green, then review.

## Verification

Run these in the worktree. Before running, the implementer corrects any script name to the exact one in `package.json`.

```bash
npm run audit:deps && npm run lifecycle-test && npm run release:audit && npm run workspace-test   # includes doctor.test.mjs
npm run typecheck && (cd ui && npm run typecheck) && npm test && (cd ui && npm test)              # includes providerJourney, readiness, runs, profile
npm run build && npm run runtime-smoke && npm run server-smoke && npm run demo-smoke && npm run submission-smoke   # T6 scenarios
npm run browser-test            # demo suite + playwright.fresh.config.ts (fresh-onboarding, fresh-run-panel)
out="$TMPDIR/rolebound pilot ü" && rm -rf "$out" && npm run release:export -- --output "$out" \
  && node scripts/release-audit.mjs --candidate "$out" && (cd "$out" && npm ci) \
  && HOME="$(mktemp -d)" npm run fresh-user-smoke -- --root "$out"
npm run upgrade-smoke -- --from 33135c9
```

Then:

- CI on the PR must be green for `verify (ubuntu-24.04)`, `verify (macos-15)` (now including the export and fresh-user smoke) and `release-export` (Unicode path plus fresh-user smoke).
- Phase B: run T10 and T11 only after Q1 and Q2 are answered and the spend limit is confirmed.

## Risks

- **Real submission is irreversible and uses the owner's real identity.**
  - The owner chooses postings they actually want and is present throughout.
  - Stop is tested on a separate posting.
  - There is no batch apply.
  - The guard and rate limit stay on.
- **Spend.**
  - Cursor usage bills to the owner's plan (D5). Attempt counts are logged and the count caps apply.
  - The model is nondeterministic, so Phase B proves the paths work but not output quality.
- **Key exposure.**
  - The key is entered only through the UI.
  - Global auth and the parent environment are proven to be ignored (T2 step 6, T5 #10).
  - The workspace is grepped before the report is written.
  - Pilot data is never committed.
- **Live systems.** Never touch:
  - `~/job-applier-agent`;
  - `~/code/pi-jobs-live`;
  - global pi auth;
  - existing Chrome profiles;
  - existing listeners.

  Ports are ticket-owned.
- **The fixture-origin env var is a new trust input.** It accepts canonical loopback only, fails closed, refuses redirects, and the launcher never sets it (D3).
- **Readiness changes can block existing users.**
  - `TARGETS_PLACEHOLDER` and `PROFILE_PLACEHOLDERS` match only exact template tokens.
  - Fixtures and demo seeds are updated in the same commit.
  - Demo mode still passes `demo-smoke` and `journey.spec.ts`.
- **CI time.** The fresh-user smoke adds about 1-2 minutes to the export job and about 3 minutes to the macOS job (export plus `npm ci`), and the new project adds about 1 minute. The upgrade smoke stays local.
- **Evidence staleness.** The D6 freeze and invalidation rules apply. Each piece of evidence carries its SHA.
- **Scope creep.** D2's threshold applies. Anything larger becomes a blocker and a question.

## Owner questions (logged on the ticket)

- **Q1 (provider answered 2026-10-08: Cursor, owner's plan).** Still open:
  - which Cursor model to use for the agent (e.g. `composer-2.5`);
  - the scorer: if the T5b spike shows Cursor cannot score, an API-key provider, model and key for scoring;
  - you sign in with Cursor (button) or reuse your existing Cursor SDK login in the pilot workspace's Settings; a pasted dashboard key also works;
  - 1-3 public boards to gather.
- **Q2:** For the supervised application pilot, authorize:
  - one real Greenhouse posting to submit;
  - one posting to start and then Stop before submit;
  - use of your real profile, resume and address in `~/rolebound-pilot-pjr23`;
  - paid CAPTCHA testing, either yes with a provider and task cap, or no. No is the default, and leaves it disclosed as unverified.

  If apply or guard code changes after the pilot, a fresh Q2 is needed (D6).

## Spike results (T5b step 1, 2026-10-08)

1. **Per-run loading.** Use per-run `PI_CODING_AGENT_DIR/settings.json` with `"packages": ["<abs path>/node_modules/pi-cursor-sdk"]` (string path form). `-e` is fallback only if packages loading fails.
2. **`pi --list-models`.** With that `settings.json`, `pi --list-models --offline -a` in an isolated agent dir lists Cursor fallback models (e.g. `composer-2.5`) with **no** `CURSOR_API_KEY` set.
3. **State root.** `PI_CURSOR_SDK_STATE_ROOT` is read by `pi-cursor-sdk` (`resolveCursorLocalStoreRoot` in `cursor-config.ts`) and selects persistent LOCAL storage under that canonical root instead of `~/.cursor/projects/...`.
4. **Scoring through Cursor.** **Agent-only.** `completeScoringRequest` uses an isolated `ModelRuntime` that never sees extension-registered providers. Even session `modelRegistry.complete` is unsupported for Cursor (`cursor-provider-binding.ts`: bare registry calls lack session ownership receipts). Implement `SCORING_MODEL_MISSING` when the agent is Cursor and no API-key scoring override is configured; reject `cursor` as an explicit scoring connection.
