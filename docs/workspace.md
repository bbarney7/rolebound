# Workspace storage contract

This document describes which components write workspace files, how they are locked, how corruption is handled, and how to recover. The canonical path table lives in `.pi/extensions/lib/workspace-files.ts` as `WORKSPACE_FILES`; the dashboard builds paths from the same names in `ui/server/workspace.ts`.

## Protection boundary

`resolveWorkspaceRoot` (launcher scripts) only accepts a directory whose real path equals this clone. There is no registered migration against arbitrary paths on disk — other checkouts are not modified by restore or init here.

**Windows is unsupported** (no hard-link guarantees, path semantics). Use macOS or Linux.

## Agent-shared JSON and profile

| File | Lock target | Writers | Atomic | Secrets | Backed up / exported |
|------|-------------|---------|--------|---------|----------------------|
| `credentials.json` | file | job-accounts tools, dashboard accounts API | yes | yes | backup yes; export **no** |
| `state.json` | file | job-applier tools, dashboard applications/profile routes | yes | yes | backup yes; export **no** |
| `gather_state.json` | file | job-gatherer tools, dashboard queue promote | yes | no | backup yes; export **no** |
| `settings.json` | file | dashboard settings store | yes | yes (keys) | backup yes; export **no** |
| `profile.md` | file | dashboard profile writer | yes | yes (PII) | backup yes; export **no** |
| `targets.md` | `targets.md.lock` | job-gatherer `add_target`, dashboard targets writer | yes | no | backup yes; export **no** |
| `APPLIED.md` | derived (regenerated after `state.json` writes) | job-applier `regenerateTracker` / `complete_application` | yes | yes (history) | backup optional; export **no**; gitignored |
| `.pi-jobs/captcha-spend.json` | file | `solve_captcha` via `lib/captcha-spend.ts` | yes | no (task metadata) | backup optional; export **no** |

**Corruption:** empty, truncated, or wrongly shaped agent-shared JSON fails **closed**. Tools and routes return an error; bytes on disk are not replaced with `{}`. A corrupt `.pi-jobs/captcha-spend.json` blocks paid CAPTCHA tasks (`budget_exhausted`) and is listed in overview `corrupt[]`; repair manually or from backup — doctor does not auto-replace it. Repair: `npm run restore -- --backup <id>`, or move the file aside and copy from `templates/<file>`. The dashboard overview lists corrupt files in `corrupt[]` and shows a repair banner.

`state.json` top-level fields include `acknowledged_at` and `acknowledged_policy` (versioned auto-submit acknowledgement). Application entries may include:

| Field | Meaning |
| --- | --- |
| `captcha_paid_tasks` | Paid provider CAPTCHA tasks reserved for this application (cap: 2), persisted across stop/resume |
| `confirmation_source` | How submit was confirmed (`greenhouse_submit_script`, `greenhouse_otp_script`, `page`, `email`, `user`) |
| `confirmation_evidence` | At least 10 characters quoting what was observed |
| `screenshot_error` | When no confirmation screenshot exists (including reconciler-recorded submissions) |
| `reopened_at` / `reopened_from_submitted_at` | Set when the user reopens a submitted application through the dashboard tool dialog |

## Job files

Discovered, queue, and applied markdown files use per-file `<file>.md.lock` side locks (`withDiscoveredJobFileLock`). Promotion, reject, and scoring take that lock. Moves use `moveJobFileNoClobber` (link or exclusive copy, verify, unlink source).

**Completion:** after submit, the agent calls `complete_application({slug})` (not a manual `mv`). That moves the queue file to `jobs/applied/<slug>.md` and repoints `queue_file` in `state.json`.

## Other server files

| File | Lock | Notes |
|------|------|-------|
| `ui/run-manager.json` | run lock (metadata writes use `atomicWriteFile` while run lock held) | not file-locked separately |
| `ui/ui-state.json` | in-process queue + atomic write | single writer |
| `.pi-jobs/runs/<id>/pi-agent/*` | per-run private dir | provider keys when not using env BYOK |
| `.pi-jobs/runs/<id>/stop.json` | none (sync write on stop) | written by `RunManager` on abort/finish/dispose before signalling the child; submission guard blocks mutating tools once present |
| `.pi-jobs/observed/<slug>.json` | none (atomic per-slug file) | written by `submission-guard.ts` when a Greenhouse submit/OTP script reports `submitted`; unreadable or corrupt content is treated as “observed” for gating and surfaced in overview `corrupt[]` |

## Demo / e2e-only writers

`scripts/demo-seed.mjs`, `demoArtifacts.mjs`, and `ui/server/routes/e2eReset.ts` write synthetic fixtures only in demo or test roots. They are not used against a normal supervised workspace.

## Lock order (D4)

Acquire in this order; never reverse:

`run-manager.json` (run lock) → discovered job `*.md.lock` → `gather_state.json` → `state.json` → `settings.json` → `profile.md` → `targets.md.lock` → `credentials.json`.

`credentials.json`, `targets.md`, and `profile.md` are **leaf** locks — do not take other locks while holding them.

Cross-process locks use `proper-lockfile` with a ~10s stale window and ~12s retry budget. After a crash, two waiters can theoretically both acquire (stale reclaim race); atomic writes prevent torn files — worst case is a lost update, not corruption.

## Reconciler (`lib/reconcile.ts`)

`reconcileWorkspace(root, { apply })` inspects inconsistent promote/complete/reject state under per-row locks and re-checks before acting.

| Row | Summary |
|-----|---------|
| R1 | Same file in discovered + queue → drop discovered, mark promoted |
| R2 | Same name, different content → conflict |
| R3 | Queue file without promoted URL → upsert promoted |
| R4 | Rejected with `reject_pending` and matching discovered identity → finish unlink |
| R4b | `reject_pending` but no discovered file → clear pending |
| R5 | Submitted but file still in queue → complete to `applied/<slug>.md` |
| R6 | Submitted with copies in queue and applied → dedupe queue copy |
| R7 | `queue_file` still points at queue but file in applied → repoint |
| R8 | Applied file without submitted state → report only |
| R9 | Stale `APPLIED.md` → regenerate |
| R10 | Discovered URL missing from `seen_urls` → upsert discovered |
| R11 | Corrupt `state.json` or `gather_state.json` → abort, change nothing |
| R12 | Old temp files (`.*.tmp`, `*.score-tmp`, `*.restore-*`, etc.) → remove |
| R13 | Persisted observation says `submitted` but state does not → record submission (no screenshot; `screenshot_error: recorded by reconciler`); ignores observations not newer than `reopened_at` |

- `npm run doctor` — report only.
- `npm run doctor -- --repair` — apply all rows; refuses while a supervised run is active.
- Run start — apply R1, R13, R5, R6, R7, R12 only (before agent spawn).

## Launcher paths

- **Workspace root:** `resolveWorkspaceRoot()` / `defaultWorkspaceRoot()` with `PI_JOBS_ROOT` set by `npm start` / `npm run dev`.
- **Agent child cwd:** workspace root (`runManager` spawn).
- **Browser profile:** `.pi/mcp.json` → `--user-data-dir ./.browser-data` (relative to spawn cwd).
- **Pi agent state:** `PI_CODING_AGENT_DIR=.pi-jobs/runs/<runId>/pi-agent` from `prepareAgentRun`.

## Backups and restore

- Migrations call `migrateWorkspace`: backup first, journal, then marker update. Interrupted migrations recover via `recoverMigration` on next `initWorkspace`.
- `npm run restore -- --backup <id>` restores from `.pi-jobs/backups/<id>/` while holding workspace file locks (D4 mapping). Writes a **persisted** pre-restore backup (`<timestamp>-pre-restore`) before replacing files. Refuses while a supervised run is active.
- **Backups are secret-bearing** (credentials, settings, state, profile). Treat `.pi-jobs/backups/` like a password store; never commit, share, or ship them in a source export.

## Shareable source export

`npm run release:export` and `release:audit` use `scripts/release-manifest.json`. Excludes include `credentials.json`, `settings.json`, `state.json`, `gather_state.json`, `APPLIED.md`, `.pi-jobs/**`, `.browser-data/**`, `jobs/**/*.md`, and `resumes/**`. Only reviewed product source is published.

## Product notes (out of scope here)

- Rejecting a job does not block re-discovery: the next gather can turn a `rejected` URL back into `discovered` (`job-gatherer` dedup rule).
- `/apply-next` skips queue files that match an applied copy or a **submitted** URL. To re-apply the same URL, use `update_application_state` with `override_submitted` — the tool asks you to confirm in the UI before it reopens a submitted entry — or remove the stale application entry first.
