---
purpose: Implementation plan with tasks and verify steps; requires human approval before start.
ticket: safe-public-application-defaults
supersedes: plan.md
status: draft
created: "2026-10-08T10:37:25Z"
updated: "2026-10-08T10:37:25Z"
---

# PJR-15: Deliberate, visible auto-submit with enforced submission boundaries (implementation plan)

**Date:** 2026-10-07
**Base:** `main` `27a32e1` (PR #2, PJR-12, squash-merged 2026-10-07). Its tree is identical to `cbbd061` (`git diff cbbd061 27a32e1` is empty), so every `cbbd061` line reference below holds on `main`. References marked `main` mean the pre-PJR-12 `33135c9`. Spot-checked on `27a32e1` before revision 4.
**Revision:** 4. Revision 3 incorporated review rounds 1-3 and was approved 2026-10-07T16:32Z. Revision 4 rebases the plan on merged `main` and closes one PJR-12 interaction found while re-validating: the agent can clear a `submitted` status with `override_submitted` and resubmit (F13, P11). Review rounds 4-9 are folded in; round 9 had no high or medium findings. See the review log at the end.
**Status:** revision 4, review clean (round 9: no high or medium findings), awaiting re-approval. Q1 and Q2 answered by the owner 2026-10-07 (T1 in scope; daily CAPTCHA cap added to T8). T1 and T11-B still depend on the T0 spike results.

## Objective

Rolebound's public default is automatic submission. This ticket makes that default deliberate, visible and truthful, and puts code (not just prompt text) behind the boundaries that matter. When this work is done:

1. A user cannot start applying until they have acknowledged, once, a disclosure that says plainly: Rolebound submits each application without asking you first. The acknowledgement is recorded with a policy version and is never described as per-application authorization. Settings shows the same policy at any time.
2. SECURITY.md, README.md, AGENTS.md, the injected agent prompt and the Greenhouse tool guidance describe what actually happens. The false "explicit submit confirmation" claim is gone, and every claimed limit (one-time acknowledgement, ten-minute rate limit, CAPTCHA spend cap) is enforced in code or removed.
3. A code-enforced **submission guard** (a pi `tool_call` handler) blocks browser-mutating and paid tool calls after a supervised run is stopped or finished, for an application whose queue item was removed or that is already submitted, before acknowledgement, and inside the rate-limit window. Stop also kills the run's whole process group.
4. A `submitted` status needs recorded evidence. For Greenhouse it must match a script result the guard actually observed.
5. CAPTCHA stays off/manual by default. Optional BYOK CapSolver/2Captcha keeps working, with a per-application paid-task cap that counts real provider tasks and survives stop/resume.
6. Supplied identity and addresses stay truthful. Missing required information pauses. Fixtures prove it.
7. Every supported submit path has regression coverage against local fixtures, and the plan, SECURITY.md and the release notes carry one table of which boundaries are code-enforced and which remain agent instructions.

**Out of scope:**
- A per-application approval gate (owner decision 2026-10-07).
- Real employer submissions, paid model calls or paid CAPTCHA solves. The real-provider pilot belongs to PJR-23 and needs separately approved scope.
- Repository visibility changes and publishing a release.
- `check_gmail_confirmations` shell interpolation (`job-applier.ts:687`, `execSync(\`gmail search '${query}'\`)` with a frontmatter company name). This is routed to PJR-24 (see Findings F11).

## Binding decisions

### Owner (2026-10-07T15:51Z)

- Auto-submit is the fresh-install default. It must be deliberate, visible and documented in onboarding and settings.
- No per-application approval gate is required for this release.
- SECURITY.md, README and the prompts must be corrected to match.
- CAPTCHA: off/manual by default, with optional BYOK CapSolver/2Captcha retained (prior owner direction, September 30). There is no blanket solver-removal requirement.

### Upstream (PJR-12, binding)

- **D1/D2:** All agent-shared state writes go through `.pi/extensions/lib/durable-store.ts` (`withFileLock`, `atomicWriteFile`, strict reads). New state fields in this ticket use `mutateApplicationState` from `lib/applications.ts`. No new direct writes.
- **D3:** Corrupt `state.json` fails closed. The guard treats a corrupt or unreadable `state.json` as "block" for every gated call (`STATE_CORRUPT`).
- **D5/D6:** Completion is the `complete_application` tool. `state.json` is the source of truth for `submitted`. `update_application_state` refuses any change away from `submitted` without `override_submitted`. `/apply-next` skips queue files that match a submitted application.
- **D7:** The run-start reconciler (R1, R5, R6, R7, R12) runs in `RunManager.start` after `reclaimOrphan`. This ticket's new start refusals run **after** the reconciler, so a leftover queue copy is repaired before eligibility is judged.
- **D8/D9:** `docs/workspace.md`, the `WORKSPACE_FILES` table and `ui/server/__tests__/workspaceContract.test.ts` are the workspace contract. Every new file or state field in this ticket is added there.
- PJR-12 changed two checklist lines (`job-applier.ts:339`, `ats-adapters.ts:471`) to call `complete_application`. Consent wording was left to this ticket.

### Plan decisions (this ticket; logged with `syntaur log PJR-15 -t decision`)

- **P1. One code-enforced guard.** A new always-loaded extension `.pi/extensions/submission-guard.ts` registers a `tool_call` handler (and a `tool_result` observer). It calls a pure policy module, `.pi/extensions/lib/submission-policy.ts`. pi 1.0.4 documents that `tool_call` handlers apply to MCP tools, including calls made inside `codemode` scripts (`docs/mcp.md:252`), and that a handler that throws blocks the call (`docs/extensions.md:260`). The guard is fail-closed: unknown tool shapes from the `job-playwright` server count as browser-mutating.
- **P2. Stop fence.** `RunManager.abort()`, `finish()` and `dispose()` write `.pi-jobs/runs/<runId>/stop.json` synchronously, **before** the abort RPC. Once that marker exists, or its run directory is gone (cleanup removes it after a normal exit, which is intended), the guard blocks the **action classes** of that run: browser-mutating calls, submit scripts, Greenhouse submit/OTP preparation, `solve_captcha`, and `bash`/`write`. It always allows state and read tools (`read_application_state`, `update_application_state`, `complete_application`, `match_resume`, read-only browser calls). The one exception is a reopen request (`update_application_state` with `override_submitted: true`, class `state_override`), which is blocked after Stop (P11). A click that was dispatched before Stop and succeeded can therefore still be recorded truthfully, and that queue item cannot be resubmitted later. Abort and finish then signal the process group (`-pid`), as `disposeOwned` already does, so the MCP server and browser cannot outlive the run. The honest boundary is "no new tool call starts after Stop is accepted". An action already dispatched to the browser cannot be recalled, and the docs say so.
- **P3. Acknowledgement becomes a code gate with a policy version.** `state.json` gains `acknowledged_policy: "auto-submit-v1"` next to `acknowledged_at`. An older acknowledgement without the policy field (given under the "fills application forms … under your supervision" wording) must be re-acknowledged once. The server refuses apply runs without it. The guard refuses, without it, browser-mutating calls in an apply-kind UI run (`PI_JOBS_RUN_KIND` of `apply` or `apply-next`), submit scripts, Greenhouse submit/OTP preparation and `solve_captcha`. In a terminal session with no run context, only the slug-bearing classes are gated, so account sign-in and ordinary browsing in a terminal keep working. `/acknowledge` shows the same disclosure. The POST token stays `ACKNOWLEDGE` (`readiness.ts:143-158`). The server adds the policy field itself.
- **P4. The documented ten-minute rate limit is implemented.** SECURITY.md:66 and README.md:215 already promise "at most one application per ten minutes", but no code enforces it. It is enforced at apply-run start (server and `/apply-next`) and by the guard for Greenhouse submit/OTP and for browser-mutating calls in an apply context. It is measured from the newest non-demo `submitted_at`. `update_application_state` stamps `submitted_at` itself (server clock) on the transition into `submitted`, and ignores an agent-supplied value. A later update to an entry that is already `submitted` keeps the stored `submitted_at` (the `status` parameter is required, so follow-up updates resend `submitted`). A stored `submitted_at` more than 60 s in the future is treated as invalid and blocks with `STATE_INVALID`, so a bad timestamp cannot lock applying forever or open the window early. The constant is `MIN_SUBMIT_INTERVAL_MS = 600_000`, injectable in tests. No new environment variable.
- **P5. Removing the item being applied to stops the run.** `DELETE /api/queue/:slug` for the slug of the active apply run calls `manager.abort()` (P2) before unlinking, and the response says `runStopped: true`. Independently, the guard blocks mutating calls for an apply-context slug whose queue file is gone and which is not `submitted`.
- **P6. `submitted` needs evidence.** On the transition into `submitted` (not on follow-up updates of an entry that is already `submitted`, which keep their evidence fields), `update_application_state({status:"submitted"})` requires `confirmation_source` (`greenhouse_submit_script` | `greenhouse_otp_script` | `page` | `email` | `user`) and `confirmation_evidence` (at least 10 characters quoting what was observed). It also requires a `screenshot` that exists under `screenshots/`, or an explicit `screenshot_error`. A Greenhouse source must match a `state:"submitted"` result for that slug that the guard's `tool_result` observer recorded. Observations are **persisted** to `.pi-jobs/observed/<slug>.json` (`{slug, state, source, at, runId}`, written with `atomicWriteFile`), so they survive stop, crash and resume and do not depend on two extension modules sharing memory. An observed `submitted` that `state.json` does not yet record also counts as "submitted" for every gate (`SUBMIT_OBSERVED_UNRECORDED`). It is resolved by a new reconciler row **R13** in PJR-12's `lib/reconcile.ts`. R13 is included in the run-start set and in `npm run doctor -- --repair`. When an observation says `submitted` and `state.json` does not, R13 writes `status: submitted`, `confirmation_source` from the observation, `confirmation_evidence: "observed <state> from <source> at <at> (run <runId>)"`, and stamps `submitted_at` with the observation time, under the state lock. It never invents a screenshot; `screenshot_error: "recorded by reconciler"` is set instead. After R13 the slug is plainly `ALREADY_SUBMITTED`, which is the truth, and the next queue item can run. If R13 cannot apply (for example, corrupt state), the 409 tells the user to run `npm run doctor -- --repair`.
- **P7. CAPTCHA spend cap is persistent and counts real provider tasks.** Today's cap is 2 `solve_captcha` calls per slug per pi process, in memory (`job-applier.ts:263`). It resets on every run or resume, and one call can create several billed provider tasks through the task-type chain (`captcha.ts:378-393`). New rule: at most `MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION = 2` provider tasks per application. The count is stored as `captcha_paid_tasks` in the application's `state.json` entry, checked before each task in the chain, and kept across stop/resume. A cross-application cap also applies (owner answer to Q2, 2026-10-07): at most `captcha.max_paid_tasks_per_day` provider tasks (default 20, range 1-200) in any rolling 24-hour window across the whole workspace, recorded in `.pi-jobs/captcha-spend.json` under PJR-12's `withFileLock`. Both caps are checked before each task; whichever is hit first stops the chain.
- **P8. The demo stops showing a submit confirmation the product does not have.** `demoFakePi.mjs:204-215` asks "Demo submit confirmation", which implies real runs confirm. It is replaced by a demo **verification-code** request (the real manual-OTP shape), so the RunPanel "Required action" region is still exercised.
- **P9. Email code retrieval stays and is documented truthfully.** The prompt (`job-applier.ts:301-313`) lets the agent read verification emails through an installed `gmail` CLI or a webmail tab in the agent's own browser profile. SECURITY.md:58 ("does not … harvest codes from your mail provider") is rewritten to describe exactly that, and the fallback to `request_manual_verification`.
- **P10. Address truthfulness is verified, not rebuilt.** `generate_address` already refuses to invent an address (`job-applier.ts:270-281`). This ticket removes the stale "ZIP candidates the agent may use" wording, adds fixtures, and keeps the tool name for compatibility.
- **P11. Only the user can reopen a submitted application.** PJR-12's agent tool `update_application_state` exposes `override_submitted` (`job-applier.ts:476`) and passes the agent's params straight into `mutateApplicationState` (`:490`), so the agent can change a `submitted` application back to another status. That clears `ALREADY_SUBMITTED`, the `/apply-next` skip and the server start refusal, and it can then submit again (F13). New rules:
  - **Trigger.** Only a reopen counts: the stored status is `submitted` and the requested status is not. This is the same condition as the PJR-12 lock (`lib/applications.ts:97-102`). Any other call ignores the flag.
  - **The agent's flag is never forwarded.** The tool removes `override_submitted` from the params it passes on. To reopen, it reads the entry and asks the user with `ctx.ui.confirm(title, "Reopen <company> — <title>? Its status is submitted (<submitted_at, or "unknown date">). Reopening allows Rolebound to submit it again.", { signal })`. The tool's abort `signal` is passed, so Esc or Stop closes the dialog. The tool refuses with `OVERRIDE_REQUIRES_USER` and writes nothing in three cases:
    - there is no UI (`!ctx.hasUI`)
    - the user declines, or the dialog is cancelled (which includes Stop's `cancelPendingDialogs`)
    - the run's stop marker exists

    Code cannot tell whether a person or a `bash` call answered the dialog; T3's speed bump and SECURITY.md cover that gap.
  - **The lock re-checks.** After the user confirms, the tool passes an internal `reopenApproval: { submitted_at }` (never the agent's flag) to `mutateApplicationState`. `MutateApplicationStateParams.override_submitted` is replaced by `reopenApproval`, and the existing lock check (`lib/applications.ts:97-107`, which runs inside the file lock before `merge`) becomes, when `prior.status === "submitted"` and the new status is not `submitted`:
    - no `reopenApproval`: throw `SUBMITTED_LOCKED`, as today. This also covers the parallel race, where the entry was not `submitted` when the tool read it.
    - a `reopenApproval` whose `submitted_at` differs from `prior.submitted_at` (both compared as `?? null`): throw `OVERRIDE_REQUIRES_USER`.
    - otherwise allow the reopen and apply the record step below inside the lock.
    The merge callback in `job-applier.ts:490` (the only production caller) stays field-only.
  - **Record.** A confirmed reopen moves `submitted_at` to `reopened_from_submitted_at`, deletes `submitted_at`, and sets `reopened_at` from the tool clock. The tool, not the agent, also deletes `.pi-jobs/observed/<slug>.json` in the same flow. R13 (P6) and the Greenhouse evidence check ignore any observation whose `at` is not later than `reopened_at`. An old observation therefore cannot block the reopen, cannot undo it at the next run start, and cannot stand as evidence for the resubmission.
  - **Rate limit.** `reopened_from_submitted_at` always counts toward the ten-minute window (P4), including for the slug being judged. Reopening cannot open the window early for any application.
  - **Docs.** `docs/workspace.md:97` is updated to say the override needs the user's confirmation.

### Open questions (logged with `-t question`; the plan proceeds on the stated default)

- **Q1. Who provisions the browser MCP for public installs?** See finding F1. Note that `.pi/mcp.json` is read only after project trust (`mcp.md:32`). UI runs pass `-a`; terminal users must trust the project once, and T1 documents how. **Answered 2026-10-07: T1 stays in PJR-15.** If the T0 spike confirms the gap, T1 fixes it here, because AC 3 and AC 7 require testing the submit paths users will actually have. If T0 shows browser tools already load in a fresh install, T1 shrinks to documenting how they load.
- **Q2. Is a cross-application CAPTCHA spend cap wanted?** For example, a daily cap of paid tasks. **Answered 2026-10-07: yes.** Implemented in T8 as a rolling 24-hour workspace cap (default 20 paid tasks, configurable 1-200 in Settings). Docs still recommend a provider-side balance limit as a second safeguard.

## Findings (code contradicting the ticket or the docs)

Verified read-only on `origin/main` `33135c9` and `origin/codex/pjr-12-durable-storage` `cbbd061`.

- **F1. The public install may have no browser tools at all.** pi 1.0.4's built-in MCP reads `~/.pi/agent/mcp.json` and `.pi/mcp.json` (`node_modules/@earendil-works/pi-coding-agent/docs/mcp.md:32`). A string search of the 1.0.4 `dist` finds no reference to the repo-root `.mcp.json` that Rolebound ships. The Greenhouse `callLine` emits `mcp({server, tool, args})` (`ats-adapters.ts:221-228`), which is the proxy shape of the third-party `pi-mcp-adapter`. That adapter is installed only in the owner's global `~/.pi/agent/settings.json`. UI runs set `PI_CODING_AGENT_DIR` to a per-run directory (`runConfig.ts:237`), so even that global adapter may not load. The ticket assumes generic browser and Greenhouse submission work in a public install, and this has not been shown. T0 verifies it. Q1 covers scope.
- **F2. The ethics acknowledgement is a UI hint, not a gate.** `POST /api/runs` (`routes/runs.ts:50-109`) does not check `acknowledged_at`. The Queue "Apply now" button is disabled only while a run is active (`App.tsx:844`, `applyDisabled={runActive}`), so it bypasses the Today-view readiness check. In a UI run the prompt asks the user to reply `ACKNOWLEDGE` (`job-applier.ts:332`), but no tool records that reply. Only the `/acknowledge` command and the Setup card write `acknowledged_at`.
- **F3. The acknowledgement text does not disclose auto-submit.** `SetupView.tsx:166-170` says "fills application forms on your behalf under your supervision". It never says that applications are submitted without asking first.
- **F4. The ten-minute rate limit is documented but not implemented.** SECURITY.md:66 and README.md:215 make the claim. A repository-wide search finds no implementation.
- **F5. Stop does not reliably end the browser side.** `abort()` (`runManager.ts:610-625`) sends the abort RPC and arms `armKill()`. After 3 s that SIGTERMs, then SIGKILLs, **only the pi child** (`runManager.ts:1030-1050`). Only `disposeOwned` signals the process group (`runManager.ts:677`). No code stops a tool call that is issued, or already queued, after Stop.
- **F6. Removing a queue item mid-run does not stop the agent.** `DELETE /api/queue/:slug` (`routes/queue.ts:350-405`) has no run check. The agent keeps the posting in context, and the Greenhouse sidecar keeps the job id, so it can still submit.
- **F7. Apply-run start does not check submitted status.** It checks only that the queue file exists (`routes/runs.ts:68-78`). PJR-12's R6 and the `/apply-next` skip cover leftovers, but a UI `apply` for a slug that is already `submitted` is not refused.
- **F8. Contradictory agent guidance.**
  - `ats-adapters.ts:264`, `:312` and `:361` say "stop and ask per CLAUDE.md", but CLAUDE.md has no stop-and-ask list. That list is in the `job-applier.ts` prompt.
  - `ats-adapters.ts:497` still says "move the queue file". PJR-12 changed `:471` to `complete_application`.
  - AGENTS.md:94 says profile rows declare "ZIP candidates the agent may use". `templates/profile.template.md:53` has a "Real-ZIP candidates" column, and the `job-applier.ts:265-269` comment says addresses are generated "using only the ZIP candidates". The code no longer uses ZIPs.
  - AGENTS.md:13 says "Three pi extensions". There are four, and five after this ticket.
- **F9. The demo misrepresents the product.** See P8. `ui/e2e/journey.spec.ts:163-178`, `ui/e2e/visual-gate.spec.ts:85-88` and `ui/server/__tests__/demo.test.ts:58-105` depend on that confirm dialog.
- **F10. The CAPTCHA budget is weaker than its disclosure implies.** See P7. It is per process and in memory, and it counts calls rather than billed tasks.
- **F11. Out of scope:** the `check_gmail_confirmations` shell interpolation (`job-applier.ts:673-692`). It is routed to PJR-24.
- **F12. The ticket's line references are mostly confirmed.** The `main:394` "Auto-submit" line is `cbbd061:337`. SECURITY.md `main:50-52` is `cbbd061:57-59`. `ats-adapters.ts:458-485` prepares the submit script with only workspace, slug and sidecar checks, as the ticket says.
- **F13. The agent can reopen a submitted application by itself.** `update_application_state` accepts `override_submitted: true` from the model (`job-applier.ts:476`, enforced at `lib/applications.ts:98-105`) with no user involvement. `docs/workspace.md:97` presents it as the way to re-apply. Every resubmission boundary keys off `status === "submitted"`, so this is an agent-reachable bypass of B7 on retry or resume. Fixed by P11.

## Supported submission paths (inventory)

| # | Path | Where | Reaches the network through |
| --- | --- | --- | --- |
| S1 | Generic browser: click or keyboard on a submit control, `fill_form`, `select_option`, `browser_evaluate` code that submits (inline `browser_run_code_unsafe` is blocked, T2) | `job-applier.ts` prompt, step 10 | `job-playwright` MCP tools (direct, deferred or `codemode` exposure; T0 records the exact names) |
| S2 | Greenhouse submit script | `greenhouse_prepare_submit` writes `.pi-jobs/scripts/<slug>-submit.js`, and the agent runs it with `browser_run_code_unsafe` | the same MCP server |
| S3 | Greenhouse OTP script (re-submits) | `greenhouse_prepare_otp` writes `<slug>-otp.js` | the same |
| S4 | Legacy Greenhouse OTP by `browser_type` into the first box, then click | prompt `job-applier.ts:341-346` | S1 tools |
| S5 | Solver CAPTCHA workflow: inject the token, then click submit (twice at most) | `captchaWorkflowPrompt` step 4, `job-applier.ts:253` | S1 tools plus paid `solve_captcha` |
| S6 | Manual CAPTCHA/OTP resume after a user dialog | `request_manual_verification` | S1 tools |
| S7 | Off-pipeline routes: `bash`/`write` running a separate Playwright, `ctx.executeTool` from a third-party extension | none intended | outside the MCP tool pipeline when the agent writes its own process; cannot be code-gated (documented gap) |
| S8 | Demo | `ui/server/demoFakePi.mjs` | none (synthetic) |

Each path also runs under **retry** (the agent re-runs a script or click), **resume** (a new run with the same `ui:<slug>` session name continues prior context) and **terminal** (`pi` started by hand, with no RunManager and no stop marker).

## Boundary table: code-enforced vs agent-instruction-only

Rows are boundary ids B1-B16, top to bottom. Tests and SECURITY.md cite them. "Before" is `cbbd061` (PJR-12 merged). "After" is this plan. Anything still not code-enforced after this ticket is listed as an open gap in SECURITY.md and in the PJR-15 handoff.

| Boundary | Before | After | Remaining limitation |
| --- | --- | --- | --- |
| Auto-submit disclosed before the first application | Prompt only. The ack text omits auto-submit (F3). | **Code.** Versioned ack is required by server run start, `/apply-next` and the guard (apply-kind runs and slug-bearing calls). Disclosure appears in Setup, Settings and `/acknowledge`. | A terminal session's generic browser calls without a slug are not ack-gated (so account sign-in works); its scripts and solver calls are. The agent cannot record the ack through `write`/`edit` (`STATE_DIRECT_WRITE`); `bash` is only speed-bumped. |
| One-time ack is not per-application authorization | Docs ambiguous | Docs and UI copy state it explicitly | — |
| Stopped or finished UI run starts no new browser, submit or paid action | Abort RPC only. SIGTERM goes to the pi child, not the group (F5). | **Code.** Stop marker is checked on every action-class call (including MCP and `codemode` inner calls) plus a process-group kill. State tools stay allowed so an in-flight result can be recorded. | An action already dispatched to the browser when Stop arrives can complete. It is then recorded from the persisted observation or the page. |
| Terminal `pi` session stop | pi's own Esc/abort | Unchanged (pi's abort) | No marker. Documented. |
| Removed queue item is not submitted | None (F6) | **Code.** DELETE stops the active run for that slug. The guard blocks mutating calls when the apply-context or tool slug's queue file is gone and the app is not submitted. Neither pi's `write`/`edit`, a browser tool's `filename`, nor inline `browser_run_code_unsafe` code can recreate a queue file. | Terminal generic browser calls carry no slug context, so this is prompt-only there. |
| Dismissed (rejected) discovery is not applied to | **Code.** Only `jobs/queue/` is consumed. Promote and add mark the URL `promoted` (`routes/queue.ts:263`, `:327`). | Unchanged, plus a regression test (T4) | — |
| No resubmission of a submitted application (retry/resume) | **Code (partial).** `SUBMITTED_LOCKED`, the `/apply-next` skip, R6. The agent can lift the lock itself with `override_submitted` (F13). | **Code.** Server apply start refuses (F7). The guard blocks mutating calls and S2/S3 scripts for a submitted slug. The submit script returns `submitted` without clicking when the page already shows confirmation (T6). Reopening needs the user's confirmation dialog, re-checked inside the state lock (P11). Direct `write`/`edit` of `state.json` is blocked (`STATE_DIRECT_WRITE`). | Terminal generic calls without a slug are prompt-only. `bash` could still edit `state.json` or call the local dashboard API to answer its own dialog; the guard only speed-bumps the obvious forms. Documented in SECURITY.md. |
| Ten-minute rate limit | **None** (F4) | **Code.** Server start, `/apply-next`, guard (S2/S3, apply context). `submitted_at` is stamped by the tool, not the agent. | Terminal free-form generic calls without a slug are prompt-only. |
| `submitted` needs genuine confirmation | Prompt only | **Code (partial).** Evidence fields and an existing screenshot are required. Greenhouse claims are cross-checked against the persisted observation of the script result. | For S1, deciding that the page shows a confirmation is still the model's judgment. The observation file and `screenshots/` are hard-blocked for `write`/`edit` but only speed-bumped for `bash`, so an agent could still forge them through `bash`. Documented. |
| Missing required information pauses | **Code** for the Greenhouse adapter (`validateAnswers`; no script while anything is unanswered). Prompt for S1. | Unchanged, plus fixtures | S1 is prompt-only. |
| Address never fabricated | **Code** in `generate_address` | Unchanged, plus fixtures and wording fixes | The model could still type a different address directly into a form (prompt-only). |
| CAPTCHA off by default; env alone cannot enable a solver | **Code** (`captcha.ts:14-20`, `:113`) | Unchanged, plus a fresh-install test | — |
| CAPTCHA spend cap | Code, but weak (F10) | **Code.** Persistent per-application cap that counts provider tasks. `solve_captcha` is also blocked after Stop and for ineligible apps. Plus a persistent rolling 24-hour workspace cap (default 20). | Spend in a second Rolebound workspace on the same provider key is not counted |
| Manual CAPTCHA/OTP dialogs end on Stop | **Code** (`cancelPendingDialogs`) | Unchanged, plus a test that a cancelled dialog leaves the app paused | — |
| Browser driven outside the MCP pipeline (S7) | Prompt only | **Code (partial).** `write`/`edit` to protected paths are hard-blocked (`STATE_DIRECT_WRITE`). Inline or non-generated `browser_run_code_unsafe` is hard-blocked (`UNSAFE_CODE`). Browser-tool `filename` writes are confined to `screenshots/` and `.playwright-mcp/`. `bash` is speed-bumped on the T3 pattern list. | **Open gap:** `bash` can still run its own Playwright, edit files or call the local dashboard API. Stated in SECURITY.md. |
| Demo never submits | **Code** (synthetic runner) | Unchanged. The confirm dialog is removed (P8). | — |

## Spike results (T0, 2026-10-08)

Spike harness: `node .pjr15-spike/run-spike.mjs` (scratchpad under `.pjr15-spike/`, git-excluded). Temp app layout matches `scripts/runtime-smoke.mjs` (`HOME`, `PI_CODING_AGENT_DIR=<app>/.pi-jobs/pi-agent`, copied `.pi/extensions`, symlinked `node_modules`, `PI_OFFLINE=1`). Loopback model: `PI_CODING_AGENT_DIR/models.json` provider `pjr15-spike` → `http://127.0.0.1:<port>/v1` from `.pjr15-spike/scripted-model.mjs`; pi RPC args `--provider pjr15-spike --model scripted`. Browser stub: `.pjr15-spike/stub-browser-mcp.mjs` via `.pi/mcp.json` unless noted.

**(a) Repo-root `.mcp.json` vs `.pi/mcp.json` (with `-a` / `--approve`).** Copying repo `.mcp.json` to `<app>/.mcp.json` and RPC with `--approve` produced **zero** `mcp__job_playwright__*` tools (`mcpLoading.repoRootDotMcpJson.browser: []`). **F1 confirmed:** pi 1.0.4 built-in MCP does not read repo-root `.mcp.json`. With stub in `<app>/.pi/mcp.json` and `--approve`, three tools appeared (`mcpLoading.piMcpWithApprove.browser`). With the same `.pi/mcp.json` and **no** trust flag, **zero** MCP browser tools (`piMcpWithoutApprove.browser: []`). With stub in `PI_CODING_AGENT_DIR/mcp.json` (no project trust), three tools still loaded (`agentDirMcp.browser`) — matches UI runs that isolate agent config.

**(b) Tool names and exposure.** With `exposure: "direct"` in `.pi/mcp.json`, pi registers `mcp__job_playwright__browser_click`, `mcp__job_playwright__browser_snapshot`, `mcp__job_playwright__browser_run_code_unsafe` (namespace `mcp__job_playwright`, all `exposure: "direct"`). No bare `browser_*` names and no `mcp` proxy tool in built-in MCP (unlike owner `pi-mcp-adapter`). `codemode` is `model-only`; MCP tools with `exposure: "codemode"` are callable only from `codemode` scripts, not declared to the model.

**(c) `readOnlyHint` / `destructiveHint` via `getAllTools()`.** Stub declared `browser_snapshot` read-only and `browser_click` destructive; observed `browser_snapshot` → `{ readOnlyHint: true, destructiveHint: false }`, `browser_click` → `{ readOnlyHint: false, destructiveHint: true }`, `browser_run_code_unsafe` → `{ destructiveHint: true }` (readOnly omitted).

**(d) `tool_call` handler sees and can block direct MCP and codemode inner calls.** Logger extension (`.pjr15-spike/extensions/tool-event-logger.ts`) on direct click: `tool_call` with `toolName`, `toolCallId`, `parentToolCallId: null`, `input`. Block via `return { block: true, reason }` logged `tool_call` only (no `tool_result` extension event). Codemode inner (MCP `exposure: "codemode"`, follow-up run): outer `tool_call` `codemode` / `call_code`; inner `tool_call` `mcp__job_playwright__browser_click` / `toolCallId: "call_code/1"` / `parentToolCallId: "call_code"`.

**(e) `tool_result` for MCP text.** Successful direct click: `tool_result` with same `toolCallId`, `content: [{ type: "text", text: "clicked btn@e1" }]`, `isError: false`, `structuredContent: { content: [...] }`. Blocked-at-`tool_call` calls do **not** emit `tool_result` to extensions (transcript still gets an error `toolResult`).

**(f) `ToolCallEventResult.terminate`.** `return { block: true, reason: "terminate spike", terminate: true }` yielded transcript `toolResult` `isError: true`, text `"terminate spike"`. Per `types.d.ts`, early agent stop only if every tool in the batch sets `terminate: true`.

**(g) Abort RPC during in-flight MCP.** Slow stub (`PJR15_STUB_SLOW_MS=15000`), `abort()` ~2s after prompt: `tool_result` `isError: true`, `content: [{ type: "text", text: "MCP request aborted" }]`.

**(h) Trust without `-a`.** Same `.pi/mcp.json` stub: without `--approve`/`-a`, `mcp__job_playwright__*` count 0; with `--approve` or `-a`, count 3 (`trustFlags`).

**(i) Shared module instance (informational).** Two `-e` extensions importing `.pjr15-spike/lib/shared-counter.ts` logged `counter-a:1` and `counter-b:1` (separate module instances per extension entry). Do not rely on in-memory sharing across extensions; use `.pi-jobs/observed/` (P6).

**(j) Throwing `tool_call` handler.** Throw blocks execution; transcript `toolResult` text `"spike throwing tool_call handler"`, `isError: true` (no MCP call).

**(k) Trust flag spelling.** RpcClient `--approve` and `-a` both load project `.pi/mcp.json` (3 MCP tools). `scripts/runtime-smoke.mjs:29` uses `--approve`. `pi mcp list` with a connected server hung in this environment; RPC trust probes used instead.

**(l) Real `@playwright/mcp` cwd and screenshot path.** `node .pjr15-spike/real-playwright-l.mjs` with `cwd=<app>`, `--output-dir <tmp>/pw-out`, headless Chrome: `browser_take_screenshot({ filename: "screenshots/x.png" })` wrote **`<app>/screenshots/x.png`** (`exists.cwdShot: true`, `exists.outDirShot: false`). Requires `screenshots/` to exist first. File-path tools (0.0.80 listing): `browser_console_messages`, `browser_evaluate`, `browser_file_upload`, `browser_drop`, `browser_network_requests`, `browser_network_request`, `browser_run_code_unsafe`, `browser_take_screenshot`, `browser_snapshot` (full MCP list is larger).

**Built-in `browser_run_code_unsafe` / `callLine()`.** Works as a **direct** tool call: `mcp__job_playwright__browser_run_code_unsafe({ filename: ".pi-jobs/scripts/spike-submit.js" })` (not `mcp({server,tool,args})` proxy). T1 should change `ats-adapters.ts` `callLine()` to emit that name (or a `codemode` one-liner if exposure is not `direct`).

**T1 recommendation.** Add `.pi/mcp.json` mirroring `.mcp.json` with `exposure: "direct"` so agents see stable `mcp__job_playwright__*` names; keep repo `.mcp.json` for non-pi MCP clients. Document that UI runs need `--approve`/`-a` (or prior trust) for project `.pi/mcp.json`, while `PI_CODING_AGENT_DIR/mcp.json` can provision the server without project trust. Update `callLine()` to built-in direct MCP shape; add `runtime-smoke` assertion for MCP tools in a clean temp HOME.

## Tasks

Each task lists files, tests and the acceptance criteria (AC 1-8, in ticket order) it serves. Use TDD: write the listed test first, watch it fail, then implement.

### T0. Worktree, baseline and tool-surface spike (AC 3, 7, 8)

1. PR #2 is merged (`27a32e1`). From `~/rolebound-public`:
   - `git fetch origin` and confirm `origin/main` is still `27a32e1`; if it moved, re-check this plan's line references first.
   - `syntaur worktree create --ticket PJR-15 --project pi-jobs-release --branch codex/pjr-15-submission-consent --parent-branch origin/main --worktree-path ~/rolebound-worktrees/pjr-15-submission-consent`
   - Run `npm ci` in the worktree.
   - Do not touch the `~/rolebound-public` working tree, which is on another branch.
2. Copy this plan to `Codex-info/plans/PJR-15/plan.md` in the worktree (tracked, the repo's plan convention) and link it from ticket.md.
3. Baseline: run the full verify list (below) on the untouched worktree and record the counts.
4. **Spike** (throwaway script in the scratchpad, not committed). Use a temp HOME, a temp app copy, ticket-owned runtime paths under `$TMPDIR/pjr15-*`, the loopback scripted model from `scripts/runtime-smoke.mjs`, and `PI_CODING_AGENT_DIR` set the way `prepareAgentRun` sets it. Record:
   - (a) whether the repo-root `.mcp.json` and/or a `.pi/mcp.json` connects `job-playwright` under pi 1.0.4 with `-a`
   - (b) exact tool names and exposure (`mcp__job_playwright__browser_click`, or `codemode` only)
   - (c) `readOnlyHint`/`destructiveHint` annotations from `pi.getAllTools()`
   - (d) that a `tool_call` handler sees, and can block, a direct MCP call and a `codemode` inner call (with `parentToolCallId`)
   - (e) that `tool_result` sees MCP results
   - (f) the `ToolCallEventResult.terminate` semantics
   - (g) what the abort RPC does to an in-flight MCP call
   - (h) (a) again with and without `-a`, to confirm the project-trust requirement for `.pi/mcp.json`
   - (i) whether `submission-guard.ts` and `job-applier.ts` share one module instance under pi's loader (informational; P6 no longer depends on it)
   - (j) that a `tool_call` handler that throws blocks the call (pi's documented fail-safe), using a deliberately throwing test extension
   - (k) the accepted trust flag spelling (`-a` vs `--approve`; `runtime-smoke.mjs:29` uses `--approve`)
   - (l) the `job-playwright` MCP server's cwd, where `browser_take_screenshot({filename:"screenshots/x.png"})` actually lands, and the full list of exposed tools with file-path arguments (input for the T2 `browser_file_write` rule)
5. Record the results in a "Spike results" section of `Codex-info/plans/PJR-15/plan.md` and log them as `progress` on PJR-15. If (a) shows no browser tools, proceed to T1 (Q1 answered: in scope).

### T1. Browser MCP provisioning for public installs (AC 3, 7; conditional on T0 and Q1)

In scope (Q1 answered). Full provisioning work applies if T0 confirms F1; otherwise T1 only documents how browser tools load.

- **Files:**
  - Add `.pi/mcp.json` with the `job-playwright` server, the same command and args as `.mcp.json`. Choose an exposure that keeps the agent's tool names stable, per the spike.
  - Keep `.mcp.json` for other clients, or delete it, per the spike, and record why.
  - `ats-adapters.ts` `callLine()`: emit the call form the built-in MCP accepts. If only `codemode` is available, emit a codemode one-liner calling `tools.mcp__job_playwright__browser_run_code_unsafe({filename})`.
  - Update the README run-it text and `docs/runtime-matrix.md`.
  - Add `.pi/mcp.json` to `scripts/release-manifest.json`.
  - README: state that `.pi/mcp.json` loads only in a trusted project. UI runs trust it with `-a`; a terminal user runs `pi` once in the checkout and accepts the trust prompt (exact wording taken from the spike).
- **Tests:**
  - `ats-adapters.offpath.test.ts`: the call-line format.
  - `scripts/runtime-smoke.mjs`: assert `job-playwright` tools are listed in a clean HOME.

### T2. Pure submission policy (AC 3, 6, 7)

- **New `.pi/extensions/lib/submission-policy.ts`.** No pi imports, all I/O injected. It holds:
  - The constants `AUTO_SUBMIT_POLICY_VERSION = "auto-submit-v1"`, `MIN_SUBMIT_INTERVAL_MS`, `MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION`.
  - `classifyToolCall(toolName, input, annotations?)`. It returns one of:
    - `read_only`: an explicit name allowlist only (`browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_wait_for`, `browser_tabs` with `action: "list"`). Server-supplied `readOnlyHint` annotations are ignored for `job-playwright`, because trusting them would not be fail-closed.
    - `browser_navigation`: `browser_navigate`, `browser_navigate_back`, `browser_tabs` (new/select/close), `browser_resize`, `browser_close`. These are mutating for the stop fence and the removed-item rule, but are allowed after `submitted` so step 11 (checking a webmail tab) still works.
    - `browser_mutating`: every other `job-playwright` tool, including click, type, press_key, fill_form, select_option, evaluate, file_upload, drag and handle_dialog
    - `submit_script`, with the slug parsed from a `browser_run_code_unsafe` filename `.pi-jobs/scripts/<slug>-(submit|otp).js` in direct, `codemode`-inner or `mcp` proxy form
    - `paid` (`solve_captcha`)
    - `greenhouse_submit_prep` (`greenhouse_prepare_submit` and `greenhouse_prepare_otp`, with their slug)
    - `state` (always allowed): `read_application_state`, `update_application_state`, `complete_application`, `match_resume`, `list_queued_jobs`, `generate_address`, `request_manual_verification`
    - `state_override`: `update_application_state` with `override_submitted === true`. It is in the stop scope (P2, P11); otherwise it is allowed, because the tool itself requires the user's confirmation.
    - `browser_file_write`: `@playwright/mcp` 0.0.80 tools write output files to `path.resolve(<mcp cwd>, filename)` anywhere in the workspace. That covers `browser_take_screenshot`, `browser_snapshot`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_evaluate`, `browser_pdf_save`, `browser_storage_state` and the video tools. Tracing, recording and downloads take no path and write only into the MCP output directory. The rule runs on the unwrapped arguments: direct, `codemode` inner, and the `mcp` proxy form, whose `args` is a JSON string that is parsed first (an unparseable `args` is blocked).
      - For known 0.0.80 tools, the `filename` argument must resolve, with T3's normalization, ancestor `realpath` and darwin case rules, under `screenshots/` or `.playwright-mcp/`.
      - For unknown `job-playwright` tools, as a fail-closed fallback, every string or array-of-string argument whose key matches `/file|path|dir/i` must do the same.
      - Cookie tools' `path` is a URL path, not a file, and is not checked.
      - Read-direction tools are exempt: `browser_file_upload` and `browser_drop` (resume upload, `paths` array), `browser_set_storage_state`, and `browser_run_code_unsafe`, whose `filename` is a read governed only by `unsafe_code` below.
      - A violation is `state_direct_write`, checked before the tool's own class.

      Without this, `browser_take_screenshot({filename:"jobs/queue/<slug>.md"})` would recreate a removed queue item (bypassing B5), and a `filename` of `state.json` would overwrite user data, even after Stop.
    - `unsafe_code`: `browser_run_code_unsafe` runs arbitrary JavaScript in the MCP server process (the 0.0.80 description calls it "RCE-equivalent"). It is allowed only with a `filename` that resolves to `.pi-jobs/scripts/<safe-slug>-(fill|submit|otp).js`, which only Rolebound's tools write. Those three names are then classed `submit_script` (submit and OTP) or `browser_mutating` (fill). The slug is parsed from all three, so the removed, submitted and rate-limit gates apply to fill scripts too, including in terminal mode. Any inline `code`, and any other `filename` (for example a file saved under `screenshots/` by `browser_network_request`), is blocked with `UNSAFE_CODE` in every context, in all three call forms. No prompt uses inline code; the only use is `callLine()` with `filename` (`ats-adapters.ts:221-228`).
    - `state_direct_write`: `write`/`edit` whose resolved `path` is `state.json`, `settings.json`, `credentials.json`, `gather_state.json`, or anything under `.pi-jobs/`, `jobs/` or `screenshots/`. (`jobs/` matters because writing `jobs/queue/<slug>.md` would re-queue a removed item. `screenshots/` matters because a hand-written file would satisfy P6's screenshot check; the browser MCP writes screenshots itself, not through pi's `write`.) The `path` field is structured, so this is a real block in every context (code `STATE_DIRECT_WRITE`), not a speed bump. It stops the agent changing `status`, `acknowledged_policy`, `captcha_paid_tasks`, `demo` or `queue_file` by editing files instead of through the tools.
    - `other`

    It recognises the pi 1.0.4 names `mcp__job_playwright__*` (and the hashed collision form), bare `browser_*`, adapter-prefixed `job_playwright_browser_*`, and the `mcp` proxy (`input.tool`/`input.server`). It is fail-closed: an unknown `job-playwright` tool is `browser_mutating`.
  - `evaluateGate(call, ctx)`. `ctx` holds the run context (`runId`, `runDir`, `kind`, `applySlug` from env), `stopMarkerExists`, `runDirExists`, `state` (strict result or a corrupt error), `queueFileExists(slug)`, and `now`. It returns `{allow:true}` or `{allow:false, code, reason, terminate}`. The codes, in the order they apply, are `STATE_DIRECT_WRITE` and `UNSAFE_CODE` (first, in every context), `OFF_PIPELINE_BROWSER`, `RUN_STOPPED`, `STATE_CORRUPT`, `STATE_INVALID`, `ACK_REQUIRED`, `ALREADY_SUBMITTED`, `SUBMIT_OBSERVED_UNRECORDED`, `QUEUE_ITEM_REMOVED`, `RATE_LIMITED` and `CAPTCHA_BUDGET`. Their scopes:
    - stop: `browser_navigation`, `browser_mutating`, `submit_script`, `greenhouse_submit_prep`, `paid`, `state_override`, and `bash`/`write`/`edit`, for a UI run (`PI_JOBS_RUN_DIR` set). `read_only`, `state` and pi's own read-only tools (`read`, `grep`, `find`, `ls`) stay allowed. This matches P2.
    - ack: browser classes in an apply-kind UI run; submit scripts, Greenhouse submit prep and paid calls everywhere (including terminal)
    - removed and rate limit: browser classes, submit scripts, Greenhouse prep and paid calls, only when a slug is known (apply context, script filename or tool parameter)
    - submitted (`ALREADY_SUBMITTED`, or `SUBMIT_OBSERVED_UNRECORDED` from a persisted observation whose `at` is later than the entry's `reopened_at`, if any): the same, except `browser_navigation` is allowed
    - `STATE_INVALID`: a stored `submitted_at` more than 60 s in the future (P4)
  - `latestRealSubmissionAt(state, exceptSlug)`, which ignores `demo: "true"` entries. It skips the `submitted_at` of the slug being judged only while that entry's status is `submitted` (then `ALREADY_SUBMITTED` wins by ordering). It always counts every entry's `reopened_from_submitted_at`, including the judged slug's, so a reopened application cannot be resubmitted inside its own ten-minute window (P11). There is a test for each.
  - `readObservation(root, slug)` and `writeObservation(root, obs)` for `.pi-jobs/observed/<slug>.json`, path-checked with `isSafeSlug`, written with `atomicWriteFile`.
- **Tests (new `.pi/extensions/lib/submission-policy.test.ts`; each case carries a `// boundary: B<n>` comment that matches the boundary table, numbered B1-B16 top to bottom):**
  - A classifier table over every S1-S6 shape, using recorded inputs from the T0 spike and the `pi-mcp-adapter` v2.10.0 proxy shape.
  - A `browser_file_write` table: a screenshot to `jobs/queue/x.md` and a snapshot to `state.json` are blocked in every context; a screenshot to `screenshots/x.png` is allowed after Stop; `browser_file_upload` and `browser_drop` of the resume are allowed; an unknown tool with a `path` argument outside the allowed folders is blocked; `browser_cookie_set` with `path: "/"` is allowed; a proxy-form call with the filename inside its `args` JSON string is checked; a generated `<slug>-submit.js` passes `browser_file_write` and reaches `unsafe_code`.
  - An `unsafe_code` table, in direct, `codemode` and proxy forms: inline `code` is blocked; a `filename` under `screenshots/` is blocked; the generated `<slug>-fill.js`, `<slug>-submit.js` and `<slug>-otp.js` are allowed (subject to the other gates).
  - A gate matrix: each code, each scope, ordering, corrupt state, a legacy ack without the policy field, a demo entry excluded from the rate limit, the rate limit's boundary at exactly 10 min, an unknown `job-playwright` tool blocked, a tool carrying `readOnlyHint` but not on the allowlist still classed as mutating, navigation allowed after `submitted` while a click is blocked, a future `submitted_at` giving `STATE_INVALID`, a persisted observation giving `SUBMIT_OBSERVED_UNRECORDED`, and an observation older than `reopened_at` being ignored.

### T3. Submission guard extension (AC 3, 6, 7)

- **New `.pi/extensions/submission-guard.ts`.** It is always registered and not gated by `PI_JOBS_ATS_ADAPTERS`.
  - Workspace root: `WORKSPACE` from `lib/workspace.ts` (the module-relative root the other extensions use), and the guard is inert outside it (`isInWorkspace(ctx.cwd)`), like the other extensions. With none of the run env vars present the guard runs in **terminal mode**: no stop fence, ack and slug rules only for slug-bearing classes.
  - `pi.on("tool_call")` builds the context: env `PI_JOBS_RUN_ID`, `PI_JOBS_RUN_DIR`, `PI_JOBS_RUN_KIND` and `PI_JOBS_APPLY_SLUG`, `fs.existsSync` of the marker, `readApplicationStateStrict()`, and the slug's queue file. The recorded `queue_file` is used only when it parses (with `parseRecordedJobFile`) to the `queue` directory and its name is `<slug>.md` or `<digits>-<slug>.md`. A recorded `applied` path never counts as a queued item for an application that is not `submitted`. Anything else falls back to `jobs/queue/<slug>.md`. This keeps the agent from passing `QUEUE_ITEM_REMOVED` by pointing `queue_file` at an existing applied file. It calls `evaluateGate` and returns `{block:true, reason, terminate}`. Each block reason names the code and says "stop; do not retry through another tool".
  - Correlation: the `tool_call` handler records `{toolCallId → {slug, kind, parentToolCallId}}` for allowed `submit_script` calls in a module `Map`, cleared on `session_shutdown`.
  - `pi.on("tool_result")` looks up the result's `toolCallId` (for `codemode` inner calls, the inner id that pi assigns as `<parent>/<n>`). A result with no match is ignored and logged. A matched result whose content cannot be parsed is logged as a warning in the result text, so a silent miss cannot hide a submit. It never guesses a slug. T0 (d) records the real inner-id format; `parentToolCallId` is the fallback key. It parses the `### Result` JSON, whose exact `content` shape is recorded by T0 (e). On `state` `submitted` or `otp_required` it calls `writeObservation` (P6). A write failure is reported in the result text, not swallowed.
  - `write`/`edit` to protected workspace files is blocked with `STATE_DIRECT_WRITE` (T2 class `state_direct_write`). The guard normalizes the `path` the way pi does before writing (`resolveToCwd` in `dist/core/tools/path-utils.js`): strip a leading `@`, expand `~`, normalize Unicode spaces, resolve against `ctx.cwd`. It then runs `realpath` on the nearest existing ancestor and appends the rest, so a new file under a symlinked directory is caught. On darwin the comparison is case-insensitive (APFS default). A path that cannot be resolved is blocked. The block reason names the right route: the tools for state, the dashboard Queue add (or `/gather` then `promote_to_queue`) for `jobs/queue/`, and Settings for `settings.json`.
  - `bash` calls that reference `.pi-jobs/`, `state.json`, `settings.json`, `credentials.json`, `screenshots/`, `jobs/`, `playwright`, `127.0.0.1:`, `localhost:` or `/api/` are blocked with `OFF_PIPELINE_BROWSER` (the S7 speed bump). The loopback and `/api/` patterns stop the obvious route of fetching the dashboard's CSRF token from `GET /api/session` (exempt from the CSRF check, `localAccess.ts:20`, `app.ts:56`) and answering the agent's own dialogs through `POST /api/runs/:id/ui-response`. This is a speed bump, not tamper-proofing, because `bash` can build any string. SECURITY.md says so.
- **Tests (new `ui/server/__tests__/extensionHarness.submissionGuard.test.ts`):** use PJR-12's `createExtensionHarnessWorkspace`, extended with a fake `pi.on` capture. Cases:
  - a stop marker blocks a mutating call and `solve_captcha`; a read-only call (screenshot to `screenshots/`) is still allowed
  - a missing run dir with `PI_JOBS_RUN_DIR` set blocks
  - no ack blocks
  - a legacy ack blocks
  - a removed queue file blocks
  - a submitted app blocks a submit script and a click, but allows a screenshot
  - the rate limit blocks a different slug inside 10 min and allows it at 10 min
  - corrupt `state.json` blocks
  - terminal context (no env) still enforces ack and the slug rules for scripts
  - `tool_result` persists a submitted observation, and a fresh module import (a simulated new process) still sees it
  - two interleaved submit-script calls for different slugs, plus one `codemode` inner call, each map to the right slug; an unmatched result writes nothing
  - a `write` to `.pi-jobs/observed/x.json` is blocked
  - after a stop marker, `update_application_state` and `complete_application` are allowed while a click is blocked (an in-flight submit can be recorded)
  - after a stop marker, `update_application_state` with `override_submitted: true` is blocked (P11)
  - `edit`/`write` of `state.json`, `settings.json`, a file under `.pi-jobs/` or a file under `screenshots/` is blocked with `STATE_DIRECT_WRITE`, in a UI run and in terminal mode, including `@state.json`, `STATE.JSON` (darwin only), a symlinked path and a new file under a symlinked directory; `bash` with `curl http://127.0.0.1:4747/api/session` is blocked
  - a slug whose queue file was removed and whose recorded `queue_file` is forged to `jobs/applied/<other>.md` or `jobs/queue/<other>.md` is still `QUEUE_ITEM_REMOVED`
  - a terminal session (no env) with no ack allows a generic click with no slug (account sign-in), but blocks a submit script and `solve_captcha`

  The pi fail-safe for a throwing handler is not asserted here, because the harness is a fake. It is checked by the T0 spike (j) and T11-B.

### T4. Server, run lifecycle and UI gating (AC 1, 3, 6, 7)

- **`ui/server/runConfig.ts` (`prepareAgentRun`):** set `PI_JOBS_RUN_ID`, `PI_JOBS_RUN_DIR` (absolute `.pi-jobs/runs/<runId>`), `PI_JOBS_RUN_KIND`, and `PI_JOBS_APPLY_SLUG` for apply runs. The child env must not inherit stale values from the server env.
- **`ui/server/runs/runManager.ts`:**
  - `writeStopMarker(reason)` uses `fs.writeFileSync(<runDir>/stop.json, {runId, reason, at})`, ignores ENOENT, and is called first in `abort()`, `finish()` and `disposeOwned()`.
  - `armKill()` signals `-pid` on non-win32, reusing the `disposeOwned` pattern, with PJR-21 ownership semantics unchanged.
  - For fake and test runs without `prepare`, create the run dir so the marker contract holds.
- **`ui/server/routes/runs.ts` / `RunManager.start`:** the gate runs **inside** `start()` (position below), after the PJR-12 run-start reconcile, and refuses `apply`/`apply-next` with:
  - `409 {code:"ACKNOWLEDGEMENT_REQUIRED"}` when the versioned ack is missing
  - `409 {code:"ALREADY_SUBMITTED"}`. The gate reads `readApplicationState(root)` and refuses when an entry has `slug === slug && status === "submitted"`, when a submitted entry's URL matches the queue file's URL, or (as `SUBMIT_OBSERVED_UNRECORDED`) when a persisted observation newer than any `reopened_at` says `submitted`. It does not use `shouldSkipQueueFileForApply`, because that resolves paths through the extension's own `WORKSPACE` (`lib/applications.ts:454`, `:459`; `lib/workspace.ts:23`) rather than `root`, and it skips a slug only when a duplicate queue copy exists. If the implementation reuses it anywhere else, add an optional `root` parameter.
  - `409 {code:"RATE_LIMITED", retryAfterMs}`

  These checks need state that the reconciler may repair, so implement them as a `RunManager` pre-spawn hook:
  - `RunManagerOptions.applyGate?: (root, slug) => Promise<null | {code, message, retryAfterMs?}>`, constructed in `ui/server/app.ts` (the `new RunManager({...})` at about `:112`) from the T2 policy module. Demo mode passes a gate that skips only the rate limit.
  - Inside `startRun`, call it after the run-start reconcile block (`runManager.ts:416-433`) and the `this.disposing` re-check, and before `spawn` (`:439`), only for the `apply` behaviour. On refusal, use the existing `cancelStart`/`failStart` path so the run lock is released and no child is spawned.
  - `StartResult` gains the codes `ACK_REQUIRED`, `ALREADY_SUBMITTED`, `SUBMIT_OBSERVED_UNRECORDED`, `RATE_LIMITED` (with `retryAfterMs`) and `STATE_INVALID`. `routes/runs.ts:100-105` maps these to 409 `{error, code, retryAfterMs?}`. Everything else still maps to 500.
- **`ui/server/routes/queue.ts` DELETE:** if `manager.current()` is an active apply run for `slug`, call `manager.abort()` before `removeQueueFile` and return `runStopped: true`. The router needs the manager injected (as `runsRouter` has it). In `app.ts`, `queueRouter(root)` is mounted at `:102`, before the `RunManager` is constructed at `:112`, so construct the manager first and pass it in.
- **`.pi/extensions/job-applier.ts` `/apply-next`:** apply the same ack and rate-limit checks and notify.
- **UI:**
  - `ui/src/App.tsx:844`: `applyDisabled={runActive || !readiness?.applyReady}`, with a reason tooltip.
  - `ui/src/QueueList.tsx`: a remove note when the row is the active apply ("Removing stops the current run").
  - `ui/src/runs.ts`/`useRun.ts`: surface the 409 codes verbatim, including the rate-limit wait.
- **Tests:**
  - `ui/server/__tests__/runs.test.ts`: the stop marker is written before the abort frame is sent (fakePi records the order and the marker); `finish` and `dispose` also write it; abort kills a fakePi **grandchild** (a new fakePi mode spawns a sleeper and reports its pid; assert it is dead after the grace period); the three 409s; the gates run after the reconcile; the env vars are present in the child.
  - `queue.test.ts`: deleting the active slug stops the run and removes the file; deleting another slug leaves the run alone.
  - Dismissed-discovery regression (`queue.test.ts` and `runs.test.ts`): `POST /api/runs {kind:"apply", slug}` for a slug that exists only in `jobs/discovered/` (dismissed or not) returns 404; promoting a URL that was rejected marks it `promoted` before the queue file appears.
  - The grandchild kill test is `skipIf(process.platform === "win32")`. Windows is unsupported and CI runs on ubuntu and macOS.
  - `ui/src/__tests__`: Apply-now is disabled without readiness.
  - `ui/server/__tests__/workspaceContract.test.ts`: the marker path.

### T5. Disclosure, acknowledgement versioning, onboarding and settings (AC 1, 2)

- **`ui/server/readiness.ts`:**
  - `acknowledged` now means `acknowledged_at && acknowledged_policy === AUTO_SUBMIT_POLICY_VERSION`.
  - The blocker message for a legacy ack is "Rolebound now states plainly that it submits applications automatically. Review and acknowledge again."
  - `recordSupervisedAcknowledgement` sets both fields and re-acknowledges a legacy ack.
  - Payload: `acknowledgement: {at, policy, current}`.
- **`.pi/extensions/lib/applications.ts`:** `setAcknowledgedAt(policy)` sets both fields.
- **`templates/state.json`:** add `"acknowledged_policy": null`.
- **`job-applier.ts` `/acknowledge`:** show the disclosure through `ctx.ui.confirm` and set both fields only on confirm.
- **Disclosure text**, one shared constant in `ui/shared/` imported by the UI and mirrored in the prompt:

  > Rolebound submits applications for you automatically. Once a form is complete and valid it clicks Submit without asking you first. This acknowledgement is a one-time setting, not approval of any particular application. Stop the run, or remove a job from the queue, to prevent its submission. At most one application is submitted every ten minutes. CAPTCHAs stop the run unless you enable a paid solver in Settings.
- **`ui/src/SetupView.tsx:161-177`:** use the disclosure, and the button label "I understand — enable automatic submission".
- **`ui/src/SettingsPanel.tsx`:** a new "Applications" section above the CAPTCHA section, showing:
  - Submission: Automatic (no per-application confirmation)
  - the ack date and policy, with a link to Setup when it is missing or legacy
  - the rate limit
  - what Stop and Remove do
  - CAPTCHA spend facts (P7)
- **`ui/src/RunPanel.tsx:121`:** the placeholder "Reply — e.g. ACKNOWLEDGE" becomes "Reply to the agent…".
- **Tests:**
  - `ui/server/__tests__/readiness.test.ts`: legacy ack, then a blocker, then re-ack, then ready.
  - `ui/src/__tests__/settings.test.ts`: the Applications section renders the policy.
  - `ui/e2e/journey.spec.ts` "fresh user acknowledgement": assert the disclosure text, and that Queue "Apply now" is disabled before ack.
  - Harness: `/acknowledge` declined leaves state unchanged.

### T6. Truthful `submitted` state (AC 6, 7)

- **`job-applier.ts` `update_application_state`:** new params `confirmation_source`, `confirmation_evidence` and `screenshot_error`. On the transition into `submitted` (the stored status is not already `submitted`), stamp `submitted_at` from the clock (ignoring any supplied value, P4) and enforce P6:
  - the screenshot path is resolved inside `screenshots/` (reject traversal) and must exist and be non-empty
  - Greenhouse sources need a persisted observation (`readObservation`) for the slug with `state: "submitted"`
  - on success, the observation file is kept, as evidence, until `complete_application` removes it with the scripts (T7)

  On violation, return a `SUBMITTED_EVIDENCE_REQUIRED` error that explains how to proceed (set `paused_for_user` and ask the user).
- **`job-applier.ts` `update_application_state`, `override_submitted` (P11):** pi does not drop unknown tool arguments (`validateToolArguments` never calls `Value.Clean`), so the tool schema gets `additionalProperties: false`, and the tool builds the `mutateApplicationState` params from an explicit allowlist (`slug`, `status`). `reopenApproval` is always set by the tool to the confirmed value or `undefined`, never read from `params`. The merge callback no longer copies `params.submitted_at` (`job-applier.ts:501`). The parameter stays in the schema, described as "ignored; Rolebound records the time itself", so existing prompts and resumed sessions that still send it are not rejected by `additionalProperties: false`. T10's step 12 stops asking for it. Then: strip the agent's flag, check the reopen trigger, `ctx.hasUI` and the stop marker, then `ctx.ui.confirm(..., { signal })`. Only then call `mutateApplicationState` with `reopenApproval: { submitted_at: entry.submitted_at ?? null }`. After a successful reopen, delete `.pi-jobs/observed/<slug>.json`; a delete failure is reported in the tool result and is harmless, because every reader ignores an observation older than `reopened_at`. The parameter description becomes "Reopens a submitted application; the user will be asked to confirm".
- **`lib/applications.ts`:** in `MutateApplicationStateParams` (`:68`), replace `override_submitted?: boolean` with `reopenApproval?: { submitted_at: string | null }`. Rewrite the lock check at `:97-107` as P11 describes, applying the record step (`reopened_from_submitted_at` ← `submitted_at`, delete `submitted_at`, `reopened_at` = now) inside the lock before `merge`. Add `{ code: "OVERRIDE_REQUIRES_USER"; message }` to `MutateApplicationStateResult` and map it in the catch at `:118-131`. Change the `:127` message to "Reopening needs the user's confirmation (override_submitted)." Update `applications.test.ts` for the new parameter.
- **`lib/applications.ts`:** persist the new fields, and render them in `APPLIED.md`.
- **`lib/adapters/greenhouse/scripts.ts`:** verify, and if missing add, a pre-click check in the submit and OTP scripts. If the page already shows confirmation text, return `{state:"submitted", detail:"already confirmed; not clicked"}` without clicking. This makes a retry or resume idempotent.
- **Demo:** `demoArtifacts.mjs` already writes `demo:"true"` and `demo_label`. Add `confirmation_source:"demo"` and assert the UI labels it synthetic.
- **Tests:**
  - `.pi/extensions/lib/applications.test.ts`: fields persist.
  - Harness: submitted without evidence is refused; a Greenhouse source without an observation is refused; with an observation written by a different module instance (a new process) it is accepted; screenshot traversal is refused; a supplied future `submitted_at` is ignored and replaced.
  - Harness (P11; `// boundary: B7`, `// boundary: B8`):
    - `override_submitted` with no UI is refused and the state is unchanged.
    - A declined or cancelled confirm is refused.
    - A confirmed reopen writes `reopened_at` and `reopened_from_submitted_at`, removes `submitted_at`, and deletes the observation file.
    - After a confirmed reopen, both the same slug and a different slug are `RATE_LIMITED` until ten minutes after the original `submitted_at`.
    - Concurrency: `{status:"submitted", …evidence}` and `{status:"queued", override_submitted:true}` sent in parallel for an `in_progress` entry leave the status `submitted`, and no dialog is skipped.
    - `override_submitted: true` with `status: "submitted"` shows no dialog, writes no reopen fields and ignores the flag; other supplied fields merge as usual.
    - An agent-supplied `reopenApproval` matching the stored `submitted_at`, with no dialog, is rejected by the schema (or, if it reached the tool, returns `SUBMITTED_LOCKED`) and the status stays `submitted`.
    - A reopen call carrying `submitted_at` cannot restore it (the value is ignored), and a normal submit call carrying `submitted_at` is accepted, with the value replaced by the tool's clock.
    - A call with an unknown extra field is rejected with pi's validation error and writes nothing. The harness's `createRecordingExtensionApi` (`extensionHarness.ts:64-66`) stores only `execute`, so extend it to record `def.parameters`, and run this test through `validateToolArguments` from `@earendil-works/pi-ai`.
    - A `submitted` entry without `submitted_at` shows "unknown date" and reopens on confirm; a `reopenApproval` with a different `submitted_at` returns `OVERRIDE_REQUIRES_USER`.
    - Direct unit test of `mutateApplicationState`: a reopen without `reopenApproval` is `SUBMITTED_LOCKED`; a matching approval writes the record fields inside the lock.
    - A follow-up update of a submitted entry keeps `submitted_at` and does not ask for evidence again.
  - `greenhouse.test.ts` fake-page suite: a page already confirmed returns `submitted` with zero clicks; a job description containing confirmation words still clicks (the existing `:2498` case keeps passing).

### T7. Greenhouse tool boundary and guidance fixes (AC 2, 3, 7)

- **`ats-adapters.ts`:**
  - `greenhouse_prepare_submit` and `greenhouse_prepare_otp` call the T2 `evaluateGate` for the slug before writing a script. On refusal they delete any existing `<slug>-submit.js`/`<slug>-otp.js` and return the code.
  - Replace "per CLAUDE.md" at `:264`, `:312` and `:361` with "per the Stop and ask triggers in your instructions".
  - `:471` (the "After submitted" checklist) and `:497` name the P6 fields: `confirmation_source: greenhouse_submit_script` (or `greenhouse_otp_script`), `confirmation_evidence`, `screenshot`, and drop `submitted_at`. `:497` also becomes "call `complete_application`".
  - Add one guideline: "A blocked tool call (submission guard) means stop and report; never retry through another tool."
- **`.pi/extensions/lib/reconcile.ts`:** add R13 (P6) to the row table, `reconcileRowsForRunStart()` and `docs/workspace.md`'s reconciler section. `RUN_START_ROWS` is a set, not an order (`reconcile.ts:37`, `:162`), so place the R13 code before the R5-R7 block (`reconcile.ts:351`); a submission R13 records is then completed by R5 in the same pass. R13 ignores an observation whose `at` is not later than the entry's `reopened_at` (P11). Tests in `reconcile.test.ts`:
  - an observation with no state record gets recorded
  - an already-submitted state is left alone, with the observation kept
  - a corrupt state aborts and changes nothing
  - an unsafe slug filename is ignored
  - an observation older than `reopened_at` is ignored, and the reopened status is kept
  - R13 then R5 in one run-start pass leaves the application `submitted` and its queue file moved to `jobs/applied/`
- **`lib/applications.ts` `completeApplication`:** after a successful completion, remove `.pi-jobs/scripts/<slug>-{fill,submit,otp}.js`, `<slug>.json` and `.pi-jobs/observed/<slug>.json` (best effort, path-checked). The submitted status in `state.json` is then the lasting record.
- **Tests:**
  - `ats-adapters.offpath.test.ts` or the harness: prepare_submit is refused for no ack, a submitted app, a removed queue file and the rate limit, and stale scripts are deleted.
  - Completion removes the scripts.
  - A grep test asserting no `CLAUDE.md` stop-and-ask references remain in the adapter guidance.

### T8. CAPTCHA defaults, persistent spend cap and disclosure (AC 5, 7)

- **`.pi/extensions/lib/captcha.ts` `solveCaptcha`:** a new optional dep `beforeTask(): Promise<boolean>` is called before each `createTask`, and the chain stops with `code:"budget_exhausted"` when it returns false. A `onTaskCreated()` dep is called after the provider accepts a task. The pure API stays backward compatible.
- **`job-applier.ts` `solve_captcha`:**
  - Replace the in-memory `solvesBySlug` with `captcha_paid_tasks` on the application entry, via `mutateApplicationState` under the state lock. Reserve before the task and keep the count even when the task fails.
  - On `budget_exhausted`, `disabled` or `unsupported_kind`, keep the manual recovery dialog and the `blocked` instruction.
  - The tool description states the cap.
- **Daily workspace cap (Q2):**
  - New `lib/captcha-spend.ts`: `reservePaidTask(workspace, now)` reads `.pi-jobs/captcha-spend.json` (`{ tasks: [{ at, slug, provider }] }`) under PJR-12's `withFileLock` (`.pi/extensions/lib/durable-store.ts`), prunes entries older than 24 hours, refuses when the remaining count is at or above `captcha.max_paid_tasks_per_day`, otherwise appends and writes atomically. A missing file means zero; a corrupt file fails closed (`budget_exhausted`) and is reported by doctor rather than replaced.
  - `beforeTask` in `solve_captcha` reserves against both the per-application count and the daily cap; the error text names which cap was hit and when the daily window frees up.
  - Settings schema gains `captcha.max_paid_tasks_per_day` (integer 1-200, default 20) in `templates/settings.json`, the settings validator and the Settings CAPTCHA section, which also shows tasks used in the last 24 hours.
- **`lib/application-limits.ts`:** replace `MAX_SOLVES_PER_APPLICATION` with the policy constant (re-export for compatibility) and update `application-limits.test.ts`.
- **Docs and UI:** the Settings CAPTCHA section (`SettingsPanel.tsx:322`), README:204-215 and the SECURITY CAPTCHA section say:
  - off by default, and a stop for manual completion when off
  - an environment variable alone never enables a solver
  - each paid task bills the user's provider account
  - at most 2 paid tasks per application, kept across stop and resume
  - at most N paid tasks per rolling 24 hours across all applications (default 20), and a provider-side balance limit is still recommended
  - Lever hCaptcha requires 2Captcha
- **CAPTCHA prompt accuracy:** `captchaWorkflowPrompt` tells the agent to call `browser_evaluate` "passing the token as the first argument and the kind as the second", but the 0.0.80 `browser_evaluate` schema has no arguments field (`element`, `target`, `function`, `filename`). Move the injection source out of the prompt template (`job-applier.ts:203-245`) into one exported constant, `CAPTCHA_INJECT_SRC`, and drop the inline copy from the prompt so the agent cannot rebuild it by hand. On success, `solve_captcha` returns `inject_function`, the zero-argument expression `() => (<CAPTCHA_INJECT_SRC>)(<JSON.stringify(token)>, <JSON.stringify(kind)>)`. The prompt step tells the agent to pass it unchanged as `browser_evaluate`'s `function`, without `element` or `target`; with those set, the evaluated value is called as `value(element)`. Update the `solve_captcha` description (`job-applier.ts:614-619`) to name `inject_function`. Test: `inject_function` parses (`new Function`) for a token containing quotes and a newline, and when run against a small fake DOM, the token reaches `g-recaptcha-response`.
- **Tests:**
  - `ui/server/__tests__/captchaLib.test.ts`: the chain stops at the budget, and `onTaskCreated` counts each accepted task, using the fake fetch already used there.
  - Harness: the count persists across a module re-import (a simulated new process), and a stopped run blocks `solve_captcha` (T3).
  - `captchaSpend.test.ts`: the daily cap blocks the 21st task across three applications, frees up after the 24-hour window (fake clock), two concurrent reservers never exceed the cap (cross-process lock test in the style of PJR-12's `crossProcessStorage` suite), a corrupt spend file fails closed, and an out-of-range setting is rejected by the validator.
  - A fresh install from `templates/settings.json` resolves to `off` even with `CAPSOLVER_API_KEY` exported.
  - The fallback dialog is cancelled by Stop.

### T9. Truthful identity and addresses (AC 4, 7)

- **Files:**
  - Fix the `job-applier.ts:265-269` comment.
  - Rewrite AGENTS.md:90-96.
  - `templates/profile.template.md:43-65` and `:173-177`: rename the column to "ZIP (reference only; Rolebound never generates an address)", or drop it if `lib/profile.ts` tolerates its absence. Check `profile.test.ts`.
  - Adjust the `generate_address` tool description: "Persists a user-supplied address".
  - No behavior change to address persistence.
- **Tests (fixtures, harness):**
  - A profile with city rules and ZIPs, where `generate_address` without an address persists nothing and returns ask-user.
  - Partial fields are refused.
  - City key `default` gives null.
  - An existing address is returned unchanged.
  - `match_resume` never returns an invented address.
  - Greenhouse `validateAnswers`: a required phone, address or "Why us" question left empty produces no script (existing cases are confirmed, and one explicit "missing required identity pauses" case is added).
  - `ui/server/__tests__/addressWrite.test.ts`: still passes.

### T10. Prompt, agent instructions, docs and demo (AC 1, 2, 3, 6)

- **`job-applier.ts` prompt (`:293-374`):**
  - Step 5 becomes: "Automatic submission must be acknowledged once (`acknowledged_policy: auto-submit-v1`). If `read_application_state` shows it missing, stop and tell the user to acknowledge in Setup or run `/acknowledge`. You cannot record it yourself."
  - Step 10 becomes: "**Submit automatically.** The user enabled automatic submission at setup, so do not ask before submitting. Submit only when the form is complete, valid and truthful per profile.md."
  - Step 12 lists the P6 evidence fields and no longer asks for `submitted_at`.
  - Step 4 (`:328`) names the schema field `location_raw`, not `location`, because the strict schema (T6) rejects unknown fields. The schema also accepts `location` as an ignored alias for sessions resumed under the old prompt.
  - The T6 fields (`confirmation_source`, `confirmation_evidence`, `screenshot_error`) are added to the schema in the same change as `additionalProperties: false`.
  - Add a short "Submission guard" section: blocked calls, never retry through another tool, bash or a new process, and that Stop/Remove mean stop.
  - Keep the CAPTCHA conditional sections and align their wording with T8.
- **AGENTS.md:** the extension list (including `submission-guard.ts`), a "Submission policy" section with the boundary table summary, and the address fix (T9).
- **CLAUDE.md:** one line pointing to SECURITY.md's submission section.
- **SECURITY.md:**
  - Replace "Manual OTP and human gates" and "Automated submission risks" with: an "Automatic submission" section (the policy, the one-time versioned ack, no per-application confirmation), "What stops a submission" (the boundary table, condensed, with the remaining limitations stated verbatim), "Verification codes" (the P9 truth), CAPTCHA (T8), and the rate limit (code-enforced).
  - Keep "Corrupt agent-shared JSON …" from PJR-12.
- **README.md:204-215** ("Safety and terms" area), the Project layout table at `:147` (add the guard), and `:362` (PJR-12 text).
- **`docs/workspace.md`:** the stop marker and `.pi-jobs/observed/<slug>.json` (writer: guard; lock: none, atomic per-slug file; corruption: unreadable means "observed" for gating and is reported), plus new state fields (`acknowledged_policy`, `confirmation_source`, `confirmation_evidence`, `screenshot_error`, `captcha_paid_tasks`, `reopened_at`, `reopened_from_submitted_at`), the line-97 re-apply text (P11) in the agent-shared JSON table, and `WORKSPACE_FILES` updated.
- **Demo (P8):**
  - `ui/server/demoFakePi.mjs:204-215`: replace the confirm with `dialog({method:"input", title:"Demo verification code", message:"Enter any code. This fictional flow mimics an emailed security code; no employer is contacted."})`. An empty value or cancel leaves the run paused with no artifact.
  - Update `ui/server/__tests__/demo.test.ts:58-105`, `ui/e2e/journey.spec.ts:163-178` (fill in the input instead of clicking Yes) and `ui/e2e/visual-gate.spec.ts:85-88`.
- **Tests:**
  - A prompt snapshot test in the harness: the prompt contains no "explicit submit confirmation", contains the "Submit automatically" wording and the guard section, and does not ask the user to reply ACKNOWLEDGE.
  - A node test, `scripts/submission-docs.test.mjs` (added to the `workspace-test` script): SECURITY.md and README contain no "explicit submit confirmation". For each id B1-B16 in SECURITY.md's boundary table that is marked code-enforced, at least one `// boundary: B<n>` comment exists under `.pi/extensions/lib/` or `ui/server/__tests__/`.

### T11. Fixture regression suites for every submit path (AC 3, 6, 7)

- **A. Real-browser script fixtures:**
  - New `ui/e2e/fixtures/ats/`: static HTML pages served by a tiny loopback server on an ephemeral port, which counts `POST /submit` hits per scenario. Pages:
    - a Greenhouse-shaped form under `/boards/fixture/jobs/1234567`: success, validation errors, `otp_required`, then OTP, then success, a CAPTCHA challenge, `unknown`, already-confirmed, and a wrong page
    - a generic form: a button submit, Enter-key submit, and a JS `form.submit()`
  - New spec `ui/e2e/submission-boundary.spec.ts`, which runs in the existing `browser-test` Playwright project (chromium, `--desktop-only` safe). It loads each page and runs the **actual generated** `generateSubmitScript`/`generateOtpScript` source with Playwright's `page` (the same contract as `browser_run_code_unsafe`), then asserts:
    - the state mapping
    - submit counts (0 for validation errors, CAPTCHA, wrong page and already-confirmed; exactly 1 for success)
    - that the OTP flow re-submits once
    - that the fill script never clicks submit
- **B. Real pi tool-pipeline boundary smoke.** This is new infrastructure, time-boxed to one day. New `scripts/submission-smoke.mjs` and npm script `submission-smoke`. It drives pi directly through `RpcClient` (as `runtime-smoke.mjs:28-35` does), not through `RunManager`. Stop-marker ordering and the process-group kill are covered only by `runs.test.ts` with fakePi (T4). Here the marker is written by hand between tool calls.
  - The scripted model is an OpenAI-compatible `/v1/chat/completions` loopback endpoint that answers `stream: true` requests with SSE `chat.completion.chunk` frames carrying `delta.tool_calls[{index, id, type:"function", function:{name, arguments}}]` and `finish_reason:"tool_calls"`, one scripted step per request, then a final text answer. Write it once in `scripts/fixtures/scripted-model.mjs`, with a unit test for the frame format.
  - The stub MCP server (`scripts/fixtures/stub-browser-mcp.mjs`) uses `@modelcontextprotocol/sdk` (already a root devDependency) over stdio. It registers `browser_click({element, ref})`, `browser_snapshot({})` and `browser_run_code_unsafe({filename})`. Each mutating call POSTs `{tool, args}` to the fixture server and returns a text result.
  - Fallback if the time-box is exceeded or T0 shows MCP cannot be wired in a temp app: register the same three tool names from a test-only pi extension loaded with `-e`. That still exercises pi's real `tool_call` pipeline, but not MCP naming. Record the gap in the handoff.
  - Setup:
    - a temp HOME and app, with the extensions copied and `node_modules` symlinked
    - a stub stdio MCP server named `job-playwright` (`scripts/fixtures/stub-browser-mcp.mjs`). It exposes `browser_click`, `browser_snapshot` (readOnly) and `browser_run_code_unsafe`, and each mutating call POSTs to the loopback fixture server.
    - the server configured through `.pi/mcp.json` (or whatever T0/T1 established)
    - a loopback scripted OpenAI-compatible model that emits a fixed sequence of tool calls
  - Script calls in the scenarios use the generated pattern `.pi-jobs/scripts/<slug>-submit.js`, written by the real `greenhouse_prepare_submit` or by the test setup; any other name gets `UNSAFE_CODE`.
  - Scenarios, through real pi 1.0.4 RPC with `-a`:
    - (1) no ack: the click is blocked and there are 0 submits
    - (2) ack plus a queued slug: the click is allowed and there is 1 submit
    - (3) the stop marker is written by hand mid-sequence, before the next tool call: later clicks are blocked, there are 0 further submits, and `update_application_state` is still allowed
    - (4) the queue file is removed mid-sequence: blocked
    - (5) the slug is already submitted: blocked
    - (6) another app submitted 1 minute ago: `RATE_LIMITED`
    - (7) a `codemode` inner call is blocked the same way, if the spike showed `codemode` exposure
    - (7b) an inline-code `browser_run_code_unsafe` call is blocked with `UNSAFE_CODE` through real pi
    - (8) with `PJR15_THROWING_GUARD=1`, a test extension whose `tool_call` handler throws: the click is blocked (pi's fail-safe)
  - It uses no network beyond loopback, no paid calls and no Playwright browser, so it runs on CI.
- **C. RunManager stop/resume with fakePi.** In `runs.test.ts` (T4): stop during a pending manual-CAPTCHA dialog cancels the dialog, writes the marker, and the next start for the same slug (resume) is evaluated by the same gates, including refusal when the queue item was removed in between.
- **CI:** add `npm run submission-smoke` after `runtime-smoke` in `.github/workflows/ci.yml` (verify job, both OSes).
- **Release export:** add the new scripts and fixtures to `scripts/release-manifest.json` and rerun `release:export` and `release:audit`. Fixtures are fictional (`example.invalid` or loopback only).

### T12. Verification, review and handoff (AC 7, 8)

- Run the full verify list. Fix every failure at its root cause.
- Request an independent review of plan and code: second-opinion or code-review, with no high or medium findings left open.
- Push the branch and open a PR. CI must be green on both OSes plus release-export.
- Update the ticket: tick each AC with its evidence, and log a `handoff` listing the remaining limitations in the boundary table (for PJR-16 and PJR-24) and that the real-provider pilot (PJR-23) can now be scheduled under separate authorization.

## Acceptance-criteria map

| AC | Tasks |
| --- | --- |
| 1 Policy recorded; onboarding and settings disclose auto-submit; ack is not per-application authorization | T5, T4 (UI gating), T10 |
| 2 SECURITY, README and agent instructions truthful; false confirmation claim removed | T10, T7, T8, T9 |
| 3 Contradictions removed; boundaries verified for generic, Greenhouse submit/OTP, cancellation, retries and resume; prompt-only limits documented; release-blocking bypasses fixed | T0, T1, T2, T3, T4, T6, T7, T10, T11 |
| 4 Truthful identity and addresses; missing information pauses; fixtures | T9 |
| 5 CAPTCHA off by default, BYOK retained, docs/settings/prompt aligned, fallback and spend limits disclosed | T8, T10 |
| 6 Rate limits, state transitions, validation errors, stop/resume, stale/cancelled runs on local fixtures; submitted needs observed confirmation; demo synthetic | T4, T6 (including P11 reopen), T10 (demo), T11 |
| 7 Regression coverage for every submit path and stopped/cancelled runs; enforced-vs-prompt table; gaps kept open | T2, T3, T11, the boundary table above, T12 |
| 8 Tests, typechecks and build; pilot only after fixtures; no real submissions or spend | T12 plus the verify list; pilot handed to PJR-23 |

## Verification (exact commands, run in the worktree)

```bash
cd ~/rolebound-worktrees/pjr-15-submission-consent
npm ci
npm run audit:deps
npm run lifecycle-test
npm run workspace-test
node --test scripts/release-tools.test.mjs
npm run typecheck
npm run typecheck --workspace ui
npm test                                   # root: policy, captcha, greenhouse, applications
npm test --workspace ui                    # server harness, runs, queue, readiness, demo, contract
npm test --workspace ui -- server/__tests__/extensionHarness.submissionGuard.test.ts
npm test --workspace ui -- server/__tests__/runs.test.ts server/__tests__/queue.test.ts server/__tests__/readiness.test.ts
npm run build
npm run runtime-smoke
npm run submission-smoke                   # new: real pi 1.0.4 + stub MCP + scripted model, loopback only
npm run server-smoke
npm run demo-smoke
npm run browser-test                       # includes ui/e2e/submission-boundary.spec.ts and the updated journeys
npm run release:export -- --output "$TMPDIR/pjr15-release"
npm run release:audit -- --candidate "$TMPDIR/pjr15-release"
! grep -rn "explicit submit confirmation" SECURITY.md README.md AGENTS.md CLAUDE.md .pi/ ui/src
```

Manual check (fixture workspace only):

```bash
npm run build
PI_JOBS_ROOT="$(npm run --silent seed:fixture --workspace ui)" npm start -- --port 4915   # confirm flag/env per README before running
```

Then, at `http://127.0.0.1:4915`:
- Setup shows the disclosure, and Queue "Apply now" is disabled before acknowledgement.
- Settings shows the Applications section.
- `npm run demo` shows the demo verification-code prompt and no submit confirmation.

Never point the fixture at a real ATS.

## Runtime isolation

- **Worktree and branch:**
  - Worktree: `~/rolebound-worktrees/pjr-15-submission-consent`
  - Branch: `codex/pjr-15-submission-consent`, off `main` `27a32e1`
- **Ticket-owned runtime:** temp roots under `$TMPDIR/pjr15-*`, ephemeral loopback ports in automated tests, and `4915` for manual UI checks only.
- **Never touch:** `~/job-applier-agent`, `~/code/pi-jobs-live`, global `~/.pi`, auth, browser profiles (`.browser-data`), or listeners on 4747.
- **Spikes and smokes:** set HOME and `PI_CODING_AGENT_DIR` to temp directories.
- **Out of scope until separately authorized:** real-provider model calls, CAPTCHA provider calls and employer submissions (PJR-23 pilot).

## Risks

| Risk | Mitigation |
| --- | --- |
| pi 1.0.4 MCP tool naming, exposure or hook behavior differs from the docs | T0 spike first. The classifier has a fail-closed default. T11-B exercises the real pipeline. |
| F1 holds and T1 provisioning turns out larger than expected | T1 stays in PJR-15 (owner answer). Log the size as progress and raise it with the owner before splitting anything out; the guard is meanwhile tested on recorded tool shapes so T2-T10 are not blocked. |
| The guard blocks legitimate gather or account flows | Outside an apply-kind run, only slug-bearing classes are gated. Account sign-in (`job-accounts.ts` drives Playwright) and terminal browsing keep working without a slug. The harness covers a gather-kind run and a terminal click without ack. |
| A dispatched submit is not recorded after Stop | State tools are exempt from the stop fence, observations persist, and an unrecorded observed submit blocks the next start for that slug (`SUBMIT_OBSERVED_UNRECORDED`). |
| Process-group kill on abort regresses PJR-21 shutdown ownership | Reuse the `disposeOwned` pattern. Run `lifecycle-test`, the shutdown tests and the T4 grandchild test on both OSes in CI. |
| `state.json` reads on every tool call add latency | Read only for gated classes (not read-only calls). One strict read per call is a small JSON file. |
| An in-flight click at Stop still submits | This cannot be prevented. It is documented in SECURITY.md and the UI Stop tooltip, and state is recorded truthfully from what was observed. |
| Legacy acknowledgement forces the owner to re-acknowledge | Intended (P3), with one click in Setup. |
| `STATE_DIRECT_WRITE` blocks an edit a terminal user asks the agent for | Every agent workflow already writes these files through tools (checked on `27a32e1`: no prompt asks for a direct `write`/`edit`). The block reason names the route to use instead: a tool, the dashboard Queue add (or `/gather` then `promote_to_queue`) for a new queue item, or Settings. Users editing the files by hand are unaffected. |
| Rate limit annoys during development | Tests inject the clock and interval. Demo mode is exempt. |
| Prompt edits overlap PJR-12 text | Rebase on merged `main`. Only the lines named in T7 and T10 change. |

## Follow-ups (not in this ticket)

- PJR-24: `check_gmail_confirmations` shell interpolation (F11).
- PJR-23: fresh-user MCP provisioning, if Q1 routes it there. Real-provider pilot.
- Optional future: run the Greenhouse submit/OTP scripts inside the tool via `ctx.executeTool` instead of handing the agent a call line, so the eligibility check and the click are one step.

## Review log

**Round 1 (independent plan-completeness review, 2026-10-07). 3 high, 8 medium, 7 low. All addressed:**

- **High:**
  - H1: the stop fence blocked state tools, so an in-flight submit could not be recorded. Fixed by stopping only action classes (P2, T2 scopes) and adding a T3 test.
  - H2: the in-process observation map did not survive stop, crash or resume. Fixed by persisting `.pi-jobs/observed/<slug>.json` (P6, T2, T3, T6, T7), recording it in `docs/workspace.md`, and adding a cross-process test.
  - H3: the ack rule would block account sign-in and terminal browsing. Fixed by scoping ack to apply-kind runs and slug-bearing classes (P3, T2), with a terminal harness case.
- **Medium:**
  - M1: post-submit navigation was blocked. Added the `browser_navigation` class, which is allowed after `submitted`.
  - M2: `applyGate` was under-specified. Added the signature, position, codes, 409 mapping and `app.ts` wiring.
  - M3: `submission-smoke` was unscoped new infrastructure. Split it from the RunManager tests; specified the SSE and stub MCP; added a time-box and a fallback.
  - M4: the fake-harness fail-safe assertion was replaced by spike (j) and smoke scenario (8).
  - M5: the project-trust requirement was added to Q1, T0 (h) and T1.
  - M6: the dismissed-discovery regression test was added to T4.
  - M7: `readOnlyHint` was replaced by a name allowlist.
  - M8: `submitted_at` is now stamped by the tool, and a future value is invalid.
- **Low:**
  - L1: the token stays `ACKNOWLEDGE` (P3).
  - L2: run-dir cleanup is stated as intended (P2).
  - L4: the grandchild test skips on win32.
  - L5: workspace root and terminal mode are defined (T3).
  - L6: the boundary-id comment format and docs test are concrete (T2, T10).
  - L7: the status line marks T1 and T11-B as dependent on T0 and Q1.
  - L3 (citing handler names) is covered by T7 naming `greenhouse_prepare_submit` and `greenhouse_prepare_otp`.

**Round 2.** All round-1 fixes were verified. 0 high and 3 new medium findings, all addressed:

- M-A: an observed-but-unrecorded submit could deadlock its slug. Fixed by reconciler row R13 (run start and doctor `--repair`) with tests.
- M-B: the agent could forge the observation file. Fixed by extending the speed bump to `.pi-jobs/observed` plus `edit`, a test, and documenting B9 as partial.
- M-C: observation correlation was unspecified. Fixed with a `toolCallId → slug` map, the codemode inner id, a no-guessing rule and an interleaving test.

Lows L-a to L-d are also fixed: the stop-scope lists are aligned, the gate position is reworded, the rate limit excludes the slug being judged, and the trust flag is added as spike item (k).

**Round 3.** No high or medium findings. Two low notes are folded into T3: verify the inner-id format in T0, and warn on parse failures.

**Revision 4 (2026-10-08, re-validation on merged `main` `27a32e1`).** The merged tree equals `cbbd061`, and the cited lines were spot-checked: `job-applier.ts:263`, `:337-339`, `:476`, `:687`; `ats-adapters.ts:264`, `:471`, `:497`; the `runManager.ts` reconcile, `disposing` re-check and `spawn` order; `app.ts` router and `RunManager` order; `routes/runs.ts` 409 mapping; `App.tsx:844`; `SECURITY.md:57-59`; `demoFakePi.mjs` confirm dialog. `complete_application` refuses unless the status is already `submitted` (`lib/applications.ts:303`), so it cannot bypass P6. One new finding, F13 (agent-reachable `override_submitted`), is fixed by P11 with T3 and T6 tests. The base, status, T0 worktree command and branch line were updated.

**Round 4 (independent review of revision 4, 2026-10-08). 0 high, 6 medium, 7 low. All addressed:**

- M1: the agent's `override_submitted` was forwarded, and the reopen was checked before the lock, so two parallel calls could reopen with no dialog. Fixed: the flag is stripped, an internal `reopenApproval` is re-checked inside the lock, with a concurrency test (P11, T6).
- M2: `latestRealSubmissionAt` skipped the judged slug, so a reopened application could be resubmitted at once. Fixed: `reopened_from_submitted_at` always counts, with a same-slug test (T2, T6).
- M3: a leftover observation blocked the reopen, was re-applied by R13 and served as evidence for the resubmission. Fixed: the reopen deletes it, and R13 and P6 ignore observations older than `reopened_at` (P11, T7).
- M4: the agent could edit `state.json` directly, or fetch the CSRF token from `/api/session` and answer its own dialog. Fixed: `STATE_DIRECT_WRITE` blocks `write`/`edit`, the `bash` speed bump is extended to loopback and `/api/`, and the remaining `bash` gap is documented on B1, B7 and in SECURITY.md (T2, T3). Verified: `localAccess.ts:20` exempts `/api/session` from the CSRF check, and `app.ts:56` returns the token on a GET.
- M5: `shouldSkipQueueFileForApply` resolves paths through the extension's `WORKSPACE`, not the server's `root`. Fixed: `applyGate` reads `readApplicationState(root)` itself (T4). Verified at `lib/applications.ts:454`.
- M6: a recorded `queue_file` could be forged to pass `QUEUE_ITEM_REMOVED`. Fixed: only a `queue` path naming the slug counts (T3).
- Low:
  - L1: `state_override` is in the stop scope.
  - L2: the trigger matches the lock condition.
  - L3: stamping and evidence apply only on the transition into `submitted`.
  - L4: `submitted_at` moves to `reopened_from_submitted_at`.
  - L5: the abort signal is passed, and the wording is fixed.
  - L6: R13 sits before R5-R7.
  - L7: P11 and F13 are moved into order.

**Round 5 (2026-10-08). 0 high, 2 medium, 4 low. All addressed:**

- M-A: PJR-12's lock check runs before `merge` and keys on `override_submitted`, so stripping the flag would make every confirmed reopen throw `SUBMITTED_LOCKED`. Fixed: `MutateApplicationStateParams` takes `reopenApproval`, the lock check and the record step run inside the lock in `lib/applications.ts`, `OVERRIDE_REQUIRES_USER` is mapped in the result, and a direct unit test is added (P11, T6). Verified at `lib/applications.ts:64-131`.
- M-B: path matching weaker than pi's own resolution (`@` prefix, `~`, Unicode spaces, APFS case, new files under symlinks). Fixed: pi-equivalent normalization, ancestor `realpath`, case-insensitive on darwin, fail closed, with tests (T3).
- Low:
  - L-A: the guard's observation gate now ignores observations older than `reopened_at`.
  - L-B: the `evaluateGate` code list is complete and ordered.
  - L-C: block reasons name the dashboard Queue add or `/gather`.
  - L-D: a missing `submitted_at` compares as `null` and displays "unknown date".
  - Reviewer note: `screenshots/` is added to the hard block, and the B9 row is updated.

**Round 6 (2026-10-08). 0 high, 2 medium, 3 low. All addressed:**

- M-C: pi keeps unknown tool arguments, so the agent could pass `reopenApproval` itself. Fixed: `additionalProperties: false`, an allowlisted params build, `reopenApproval` set only by the tool, and a test (T6).
- M-D: `@playwright/mcp` tools on the read-only allowlist (and others) write a `filename` anywhere in the workspace, so they could recreate a removed queue file or overwrite `state.json`, even after Stop. Fixed: the `browser_file_write` rule confines every write-direction file argument to `screenshots/` or `.playwright-mcp/`. Added T0 spike item (l), a test table, and a B5 note. Verified in the installed 0.0.80 bundle, which exposes PDF, storage-state, tracing and video tools beyond the four named.
- Low:
  - L-E: the merge callback no longer copies `submitted_at`. The field stays in the schema as accepted but ignored, so `additionalProperties: false` does not reject existing step-12 calls.
  - L-F: `screenshots/` and `jobs/` are added to the `bash` speed bump.
  - L-G: the test wording is made precise.

**Round 7 (2026-10-08). 0 high, 1 medium, 6 low. All addressed:**

- M-E: `browser_run_code_unsafe` (inline `code`, or a `filename` saved by another browser tool) could write anywhere and run arbitrary code. Fixed: the `unsafe_code` class allows only the generated `.pi-jobs/scripts/<slug>-(fill|submit|otp).js` and blocks everything else with `UNSAFE_CODE`, in every context and call form, with tests (T2). The B5 row is corrected.
- Low:
  - L-1: step 4 names `location_raw`, the schema accepts `location` as an ignored alias, and the T6 fields are added with the strict schema.
  - L-2: the harness records `parameters` and validates through pi-ai.
  - L-3: the Greenhouse checklist lines `:471` and `:497` name the P6 fields.
  - L-4: only `filename` is checked on known tools, the regex is a fallback for unknown tools, and cookie `path` is not checked.
  - L-5: proxy `args` are parsed before checking.
  - L-6: `browser_drop` is exempt, and array values are checked.

**Round 8 (2026-10-08). 0 high, 1 medium, 2 low. All addressed:**

- M-F: the `browser_file_write` rule would have rejected the generated scripts' `.pi-jobs/scripts/` filename before `unsafe_code` ran. Fixed: `browser_run_code_unsafe` is exempt from `browser_file_write` and governed only by `unsafe_code`, with a test case.
- Low:
  - L-H: the slug is parsed from fill scripts too.
  - L-I: T11-B uses generated script names, and adds an inline-code scenario through real pi.
- Reviewer note, taken into T8 because AC 5 covers prompt alignment: the CAPTCHA `browser_evaluate` step referred to an arguments field that 0.0.80 does not have.

**Round 9 (2026-10-08). 0 high, 0 medium, 4 low. All addressed:**

- L-1: the T3 stop test now keeps read-only calls allowed, matching P2.
- L-2: the B15 (S7) row and the S1 inventory reflect the hard blocks and the remaining `bash` gap.
- L-3: T6 stamps and requires evidence only on the transition into `submitted`.
- L-4: the `inject_function` shape, the `CAPTCHA_INJECT_SRC` constant, the tool description and a fake-DOM test are specified.

Review is clean. Revision 4 needs the owner's re-approval.
