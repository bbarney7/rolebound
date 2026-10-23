---
purpose: Implementation plan with tasks and verify steps; requires human approval before start.
ticket: linux-release-ci
status: in_progress
created: "2026-10-06T13:14:45Z"
updated: "2026-10-06T13:17:20Z"
---

# PJR-21 — Linux shutdown and release CI

**Implementation plan · October 6, 2026.** Owner requested implementation. Independent review refinements below are part of the plan; passed release gates are recorded separately.

## Overview

Make shutdown of the supported Rolebound launcher predictable on macOS/Linux and prove the same reviewed source and exported artifact pass release CI. Continue the existing CI work from PR #1, preserving both scheduling and queue inode-race fixes.

### Verified baseline

- Source repository: the clean Rolebound repository; work in the ticket-bound isolated worktree, not the source checkout or live applicant workspace.
- Branch: `codex/pjr-21-linux-shutdown`, based on immutable `01bca85f79a5687f0647fbef1414ab626c0227f2` (PR #1). Parent main remains `06965d9e1110e1de501925dd3d53a6e859191c58`. Recheck both before implementation and reconcile any intervening changes.
- [PR #1](https://github.com/bbarney7/rolebound/pull/1) remains open. [Run 36745942056](https://github.com/bbarney7/rolebound/actions/runs/36745942056) passes macOS, but Linux and release-export fail the shutdown assertion at `scripts/server-smoke.mjs:87`. Subsequent Linux demo/browser checks are skipped.
- `scripts/pi-jobs.mjs` runs `npm run start --workspace ui`; the UI script runs `tsx server/index.ts`. The launcher signals only its immediate child and maps `code === null` to 1. Its signal listeners are not removed after a child completes.
- `ui/server/index.ts` calls `app.runs.dispose()` and exits 0, but does not retain/close the HTTP server explicitly. `RunManager.dispose()` sends SIGTERM without awaiting the run child exiting before cleanup. These are inspection findings, not yet a proven cause of the hosted failure.
- `server-smoke.mjs` uses a PID-derived port, registers its exit waiter after signalling, accepts a signal-only launcher termination as success, and uses `child.killed` as a cleanup test. It does not prove the listener or descendants exited. `demo-smoke.mjs` has similar unbounded exit waiting.
- Planning probe on macOS / Node 22.22.1: an owned Node child killed with SIGTERM reports `{code:null, signal:"SIGTERM"}`; the current launcher expression yields 1. This confirms the mapping bug mechanism, not a Linux/npm-chain reproduction. CI uses Node 24.14.0; reproduce the real chain there.

### Proposed design decisions

1. Treat shutdown as an owned-process lifecycle, with explicit requested signal, child exit code/signal and bounded cleanup. Unexpected child failure must remain a failure. Do not broadly replace `code ?? 1` with `code ?? 0`.
2. Prefer launching the production UI server directly through the pinned local Node/tsx loader (`node --import tsx ui/server/index.ts`) from codeRoot for start/demo. Prove equivalent module resolution and environment first. Build/dev may continue invoking npm, but they must use the same reusable lifecycle primitive without stale listeners. Do not introduce a new runtime dependency or certify Windows.
3. Expected SIGINT/SIGTERM becomes a successful launcher stop only after the server and owned run child have exited and the listener is closed. A forced timeout cleanup remains a reported failure. Unrequested signals and nonzero normal exits remain distinguishable.
4. Keep changes narrow: launcher, server shutdown, smoke/regression coverage, CI and export allowlist. Touch runManager disposal only as needed to await its existing owned child and preserve the lock/prepared-state cleanup contract.
5. No new environment variable or secret is needed. Preserve existing BYOK/runtime/demo isolation and CI directory setup. Tests use owned fictional clones, explicit ports and mock run children; no provider spend or applications.

## Tasks

### 1. Reproduce and capture the actual Linux process chain

- [x] Revalidate PR/main/worktree state and use the pinned Node 24.14.0/npm environment. Install with `npm ci` in the isolated worktree, then build. Do not run the smoke from the primary source checkout: setup writes gitignored workspace files.
- [x] Capture launcher → npm → shell/tsx → server PIDs and exit code/signal on Ubuntu 24.04, using an available isolated Linux runner or a temporary diagnostic commit on the existing PR after implementation is authorized. Drain stdout/stderr; do not dump environment variables or credentials.
- [x] Register completion promises before signalling. Prove whether SIGTERM ends only npm, whether the server/run child survives and whether the listener still accepts connections after the launcher exits. Reproduce the exact export as well as the working tree.
- [x] Store a small sanitized transcript with platform/runtime/SHA and process outcomes. If the hypothesis is wrong, revise the plan before implementing a different fix. A macOS-only probe does not satisfy the Linux reproduction criterion.

### 2. Introduce a testable child lifecycle and simplify production spawning

Files: `scripts/process-lifecycle.mjs` (new), `scripts/pi-jobs.mjs`, `scripts/process-lifecycle.test.mjs` (new).

- [x] Extract the `run` one-liner into a named helper with the same executable/argument/cwd/env/stdio inputs. Return structured completion such as `{code, signal, requestedSignal, forced}`; map this to launcher status explicitly.
- [x] Attach spawn/error/close handlers immediately and settle exactly once. Consume or inherit stdio. Remove both SIGINT/SIGTERM listeners and clear timers after completion, including spawn errors; handle shutdown requests during startup.
- [x] Forward one graceful signal only to the child this invocation owns; allow a bounded escalation to SIGKILL when that child remains alive. Use its ChildProcess handle and completion state, never `child.killed`, port-wide kills, recorded arbitrary PIDs or process-name searches.
- [x] Launch start/demo via `process.execPath` plus the pinned local tsx import, eliminating the npm/shell wrappers for the production server. Resolve the loader from installed local dependencies; validate paths containing spaces. Preserve existing root/port/env checks and demo replacement environment. Build/dev still use npm with correct failure propagation.
- [x] Define status mapping: successful normal exit stays 0; genuine code 7 stays 7; an expected graceful stop is 0 only after owned shutdown; unexpected signal/spawn error/forced shutdown is nonzero with an actionable diagnostic. Do not make all null exit codes successful.

### 3. Make server and run-child shutdown bounded and observable

Files: `ui/server/index.ts`; small helper `ui/server/shutdown.ts` and tests if needed; `ui/server/runs/runManager.ts` and existing run-manager tests only if needed.

- [x] Retain the HTTP server returned by listen. Consolidate SIGINT/SIGTERM/SIGHUP into one idempotent shutdown promise that prevents new requests, disposes active runs, closes SSE/connections and releases the listener. Handle shutdown before listen completes.
- [x] Ensure an owned active run child has actually exited before releasing its run lock/removing prepared runtime state. Reuse the run manager's current child-completion tracking and termination grace period; test a fake child, not a paid Pi session. Preserve ordinary finish/abort semantics.
- [x] Bound persistent connections/disposal waits. After the grace period, close remaining owned sockets and terminate only the owned child; emit a nonzero cleanup failure when graceful shutdown did not finish. Make rejected disposal observable instead of an unhandled rejection followed by an unconditional exit 0.
- [x] Test repeated signals and startup/occupied-port failure. An unrelated listener must remain operational. Preserve the synchronous exit fallback and acknowledge that SIGKILL cannot run asynchronous cleanup.

### 4. Strengthen the smoke tests and lifecycle regressions

Files: `scripts/server-smoke.mjs`, `scripts/demo-smoke.mjs`, `scripts/process-lifecycle.test.mjs`, supporting fixture helpers; existing UI server/run tests.

- [x] Bind a test-owned ephemeral loopback listener to select a free port, close it immediately before startup, and verify startup health identifies the expected fixture root. Handle the remaining allocation race as a safe startup failure; never reuse an occupied unrelated listener.
- [x] Drain both output streams, register close waiters before signals, and use timeouts for startup, HTTP requests and shutdown. Cleanup runs on every failure path; distinguish signal-sent from process-exited.
- [x] For normal shutdown assert launcher status, stopped server/run children, rejected health requests and successful rebind of the port. Exercise both direct launcher entry and public `npm start` entry; keep an unrelated test listener alive throughout.
- [x] Test SIGINT/SIGTERM, immediate child exit, nonzero child exit, unexpected signal, spawn failure, a child ignoring shutdown, listener cleanup across sequential commands, occupied port and path spaces. Verify forced cleanup is reported as failure.
- [x] Test populated and empty demo shutdown, temporary workspace deletion after children exit, and preservation of external-call blocking. Reuse existing fake-run facilities. Do not weaken the shutdown assertion to accept code 1.

### 5. Add complete dependency/export CI coverage

Files: `package.json`, `.github/workflows/ci.yml`, `scripts/release-manifest.json`; lockfile only if a dependency repair is actually required.

- [x] Add a root `lifecycle-test` command using Node's test runner; invoke it in both verify matrix jobs and inside the exact exported-artifact verification.
- [x] Add `npm audit --audit-level=moderate` after `npm ci`, covering the root workspace lockfile including dev dependencies. Use the same gate for the exact export. Capture failures; fix compatible vulnerabilities or require a documented, reviewed exception before proceeding. Do not hide audit-service errors or install unreviewed forced upgrades.
- [x] Keep the scheduling fix and inode reuse checks from PR #1. Preserve all existing test/typecheck/build/runtime/browser jobs; ensure Linux demo/browser steps execute after the shutdown fix.
- [x] Explicitly allowlist new lifecycle/test/helper fixture files and `Codex-info/plans/PJR-21/plan.md`. Avoid broad `scripts/**` or all-plans patterns. Add export-tool assertions that required new files exist and private files remain excluded.
- [x] Audit before startup creates runtime files. Existing planning artifacts are initially local and must not be pushed without the reviewed allowlist update; otherwise the current scanner rejects them as unreviewed.

### 6. Verify one candidate and its exported artifact

- [x] Run lifecycle tests, workspace/release-tool tests, root/UI tests and typechecks, production build and current dependency audit. Then runtime/server/demo smoke and browser journeys. Use fresh fixture state and the pinned runtime; preserve unrelated listeners and global auth.
- [x] Export to a ticket-owned empty directory. Audit before install/setup, then perform clean npm ci and the same relevant gates within that exact export. Include the lifecycle regression command there.
- [x] Obtain green verify (Ubuntu), verify (macOS) and release-export results from the same reviewed candidate SHA. Record step execution, URLs and runtime versions. If a new independent platform failure appears, investigate it; do not disable the gate to finish this ticket.

### 7. Review and integrate through PR #1, then verify main

- [x] Independently review the change and address findings. Keep commits small and reference PJR-21. Reconcile new changes in the existing PR branch without reset/force-push or discarding others' work. Update PR #1's description to reflect the final shutdown/CI fix.
- [ ] Follow the user's existing approval/workflow for pushing and merging when implementation is authorized. This planning request alone does not authorize integration. Prefer carrying reviewed commits to PR #1 instead of creating duplicate CI PRs.
- [ ] After authorized integration, confirm all jobs green at the main commit and record the exact source/export evidence in the ticket journal and current release brief. Branch-only success is insufficient for criterion 5.
- [ ] Check each acceptance criterion only when its evidence exists, log review/handoff and complete the ticket through Syntaur. Keep public visibility and the other launch gates unchanged.

## Acceptance Criteria Mapping

| Ticket criterion | Plan tasks | Required proof |
| --- | --- | --- |
| 1. Reproduce Linux failure and fix actual cause | 1–3 | Linux process-chain transcript; before/after expected stop and unexpected failure outcomes |
| 2. Preserve prior fixes; targeted shutdown regressions | 2–4 | Prior commits retained; signal/child/port/unrelated-process regression results |
| 3. Three green jobs on the same SHA | 5–6 | Matrix and exact-export run URLs; Linux demo/browser steps executed |
| 4. Complete CI and dependency audit | 5–6 | Workflow coverage, full workspace audit or reviewed exception, export test results |
| 5. Reviewed integration and green main | 7 | Review, PR integration commit and green main runs |

## Testing Strategy

Run focused lifecycle/server tests while developing, then the required full sequence once a candidate is ready. Use exact commands from package.json; the planned `lifecycle-test` command is new:

```bash
npm ci
npm run lifecycle-test
npm run workspace-test
node --test scripts/release-tools.test.mjs
npm run typecheck
npm run typecheck --workspace ui
npm test
npm test --workspace ui
npm run build
npm audit --audit-level=moderate
npm run runtime-smoke
npm run server-smoke
npm run demo-smoke
npm run browser-test
```

CI installs Playwright Chromium as already configured before browser-test. Export verification reruns the sequence applicable to its declared runtime prerequisites, including lifecycle tests, clean install, audit, tests, build and server/demo/browser checks. Existing runtime-smoke requires Chrome; do not add it to an export job without provisioning that prerequisite.

Completion requires observable shutdown of the owned server and run child, port release and correct failure propagation. A successful exit code by itself is insufficient. No full runtime suite has been run during planning.

## Risks and Open Questions

- The hosted Linux failure mechanism remains a hypothesis until Task 1 captures the npm/tsx chain. Use the immutable baseline and explicit signals to avoid attributing it to unrelated changes.
- Direct Node/tsx startup must match pinned tsx 4.23.12 behavior, source module resolution and clean-export layout. Validate before replacing the production path.
- Active SSE streams/run children can extend shutdown. Test cancellation and dispose order; do not release a run lock while its child continues operating.
- Audit results change over time. Inspect the first current result during implementation; dependency repair or an exception may require scope adjustment. Preserve the coherent workspace lockfile.
- New test and plan files must pass the strict release allowlist; sanitize tracked artifacts and omit maintainer-specific filesystem paths.
- The local planning host is macOS/Node 22.22.1; authoritative platform verification is the declared Node 24.14.0 Linux/macOS matrix. A local pass cannot certify Linux.
- PR #1 may change after this draft. Revalidate head/base and use normal commits/reconciliation. Push/merge approval is handled when there is a concrete reviewed change.

## References

- [Hosted failure](https://github.com/bbarney7/rolebound/actions/runs/36745942056) and [existing PR #1](https://github.com/bbarney7/rolebound/pull/1).
- [Node child-process lifecycle](https://nodejs.org/api/child_process.html#event-exit): signal termination yields a null exit code; child exit and stdio closure are distinct events. The killed flag does not prove exit.
- [Node process signal behavior](https://nodejs.org/api/process.html#signal-events): handlers change default signal behavior. Check equivalent pinned Node 24 docs during implementation.
- Source evidence: scripts/pi-jobs.mjs, scripts/server-smoke.mjs, scripts/demo-smoke.mjs, ui/server/index.ts, ui/server/runs/runManager.ts, .github/workflows/ci.yml, scripts/release-manifest.json.

## Pre-implementation review refinements — October 6

- RunManager disposal is a synchronous latch plus an idempotent promise. Track starts in flight, reject later starts with SHUTTING_DOWN, check cancellation after every asynchronous pre-spawn boundary, and await canceled starts unwinding before cleanup/release. Regress delayed prepare and lock acquisition; cleanup happens once and no late child spawns.
- Ordered budgets: run-child graceful termination 3 seconds, forced reaping up to 5 seconds; server deadline 12 seconds; launcher deadline 15 seconds plus bounded reaping; smoke deadline at least 20 seconds. Forced cleanup is nonzero; preserve lock/recovery metadata if a child cannot be confirmed dead.
- Production success is code 0 after completed cleanup. Preserve nonzero codes even after a signal request; null/signal-only exit is failure. Signal before server handlers exist is interrupted startup, not completed graceful shutdown.
- Resolve the local tsx loader through createRequire, convert to a file URL and spawn process.execPath with separate --import and absolute server-path arguments.
- Public terminal npm-start coverage signals an explicitly created POSIX foreground group; direct-launcher tests signal only the owned launcher. Test helpers own that group and never signal arbitrary listener PIDs.
- Build before server spawning; hold an SSE connection through shutdown, assert fixture health identity and bounded port rebind, and await exit before deleting temporary data.
- Preserve separate Linux reproduction, candidate hosted jobs, review and integrated-main gates. Any unpatched audit advisory needs a narrow documented exception independently reviewed against source reachability; unknown new findings still fail.

## Revision 1 — October 6, dependency gate and review findings

**Reason:** Current npm audit found 12 findings, including critical/high transitive vulnerabilities. The old published Pi runtime's shrinkwrap fixes undici/brace-expansion versions and ignores application-level overrides.

**What changed:** Pin Pi1.0.4, the available patched runtime, and verify compatibility through full tests plus real RPC/MCP smoke. Compatible lockfile updates repair other high/critical findings. Use an explicit audit-report gate with a single expiring moderate sprintf-js CLI-only exception (independently reviewed); unknown/severe/new/expired findings fail. Preserve previous live-orphan metadata when shutdown cancels start and propagate private cleanup errors instead of reporting success.

**Completed before revision:** Linux diagnostic reproduced code1 with a live listener; initial launcher/server/lifecycle changes and focused tests passed. Full 288 root/619 UI unit tests and 91 browser checks passed before the final review corrections; affected tests are rerun after corrections.


## Revision 2 — October 6, current advisories and runtime-smoke ownership

**Reason:** The later candidate run caught newly listed SDK OAuth and shell-quote advisories. Independent smoke review also reproduced hidden nonzero MCP cleanup and a detached Chrome surviving forced MCP shutdown.

**What changed:** Upgrade the SDK to the patched 1.x line. Retain concurrently10.0.5 and its UI command by moving the shared developer tool to the root, where a scoped shell-quote1.11.0 override resolves correctly. The runtime smoke now owns Chrome through the MCP-bundled Playwright BrowserServer API, connects MCP to that endpoint, and closes/reaps Chrome even after MCP failure. Validate MCP cleanup status and keep all deadlines bounded; no new audit exceptions.

**Completed before revision:** Shutdown implementation and independent review passed. Candidate ccda5fd passed all three hosted jobs in run37474558973; its duplicate PR run hit the original combined MCP timeout. The first revised run37564857116 stopped at the newly listed dependency findings. Real RPC/MCP smoke passes after the ownership correction; focused followup review and final candidate CI are required before handoff.
