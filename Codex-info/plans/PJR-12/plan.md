---
purpose: Implementation plan with tasks and verify steps; requires human approval before start.
ticket: shared-workspace-storage
status: draft
created: "2026-10-07T12:47:51Z"
updated: "2026-10-07T14:20:00Z"
---

# PJR-12: Durable shared workspace storage (implementation plan)

**Date:** 2026-10-07
**Base:** `main` at `33135c9` (PR #1 merged, CI green)
**Revision:** 5. It incorporates independent review rounds 1 to 4: 4 high and 14 medium findings, then 2 high and 4 medium, then 1 high and 3 medium, then 0 high and 1 medium. All are addressed below and listed in the review log at the end.

## Objective

Stop the agent (the Pi extensions) and the dashboard server from losing or blanking user data. When this work is done:

1. A corrupt, truncated or wrongly shaped `credentials.json`, `state.json` or `gather_state.json` makes the operation **fail closed**. The tool or route returns an error and the original bytes are untouched. The file is never read as empty state and then overwritten.
2. Every read-modify-write of agent-shared state takes **the same cross-process lock**. This holds whether the write comes from the agent child process, a terminal `pi` session or the server. Writes are **atomic**: a same-directory temp file, fsync, then rename.
3. Queue promotion (`discovered` to `queue`) and completion (`queue` to `applied`, plus `state.json`) follow an ordered, idempotent protocol. A lock-taking **reconciler** finishes or reports any interrupted operation. Application and queue state stay truthful after a crash.
4. One workspace contract document and a contract test describe:
   - which process writes which file, under which lock, and with which corruption behaviour
   - the launcher root, browser profile and Pi agent state paths

   The repo-local layout is kept.

**Out of scope:**
- PJR-15 consent and submit approval. PJR-15 depends on this ticket and rebases on its two checklist-line changes.
- A new data-directory architecture.
- Bringing `job-*.ts` under the root typecheck.
- Windows support (documented as unsupported).
- Rewriting server writers that are already atomic and locked, except for the specific gaps in D10.
- Visibility or publication changes.

## Verified baseline (inventory at `33135c9`)

### Extension writers (`.pi/extensions/`)

None takes a shared lock, and all write with a direct `fs.writeFile` unless noted.

| File | Reader behaviour on error | Read-modify-write sites |
|---|---|---|
| `credentials.json` | `job-accounts.ts:57-64` returns `{}` on **any** error | `create_account`: existence check `findExistingAccount` at `:325` **outside** the read-modify-write; read/write at `:363`/`:365`. `login_to_ats` `:401`/`:421`. `reset_password` `:452`/`:472`. `update_account` `:531`/`:549`. |
| `state.json` | `job-applier.ts:126-133` and `job-gatherer.ts:132-139` return empty on any error | `update_application_state` `:529`/`:559`. It accepts `queue_file` (`:522`, `:550`), and the applier repoints it at `jobs/applied/` on submit. Also `generate_address` `:578`/`:596` and `/acknowledge` `:768`/`:770`. |
| `APPLIED.md` | Derived file | `regenerateTracker` `:337`. Not gitignored (see D11). |
| `gather_state.json` | `job-gatherer.ts:113-120` returns empty on any error | `gatherAll` reads at `:517`, holds the state across network fetches, and writes once at `:609`. Re-discovery overwrites `rejected` with `discovered` (`:567-597`). Also `promoteToQueue` and `rejectDiscovered`. |
| `jobs/discovered/*.md` | n/a | `writeDiscoveredFile` `:491` uses a plain `writeFile` and can overwrite a scored or dismissed file. |
| `targets.md` | n/a | `add_target` `:964-976` turns a read failure into the template, then writes directly. |
| discovered to queue | n/a | `promoteToQueue` `:616-634`: an unlocked, overwriting `fs.rename`, then matches `seen_urls` **by re-derived slug**. That is the known bug in `ui/server/readers/gatherState.ts:95-102` (7 promoted entries against 77 applied files). |
| discovered to deleted | n/a | `rejectDiscovered` `:636-653`: deletes the file before matching (by slug). |
| queue to applied | n/a | **Not code.** The agent runs `mv` on prompt instruction (`job-applier.ts:396`, `ats-adapters.ts:471`). The real queue file name is **not always `<slug>.md`**: the applier emits names like `jobs/queue/0-<slug>.md` (`ui/server/routes/applications.ts:80-86`, `:144-147`). |
| slug inputs | n/a | `promote_to_queue`, `reject_discovered` and `score_job` pass the slug straight into `wsPath` with no `isSafeSlug` check. For example, `reject_discovered({slug:"../applied/x"})` can unlink outside `discovered/`. |

### Server

These writers are already locked (through `withLock` in `lock.ts`) and atomic, and fail closed on corruption:

- `accountsWriter.mutateCredentials`
- `settingsStore`
- `applicationConfigStore`
- `readers/gatherState.markSeenUrlPromoted` (keyed by **URL**)
- `profileWriter`
- `targetsWriter` (side file `targets.md.lock`)
- the addresses route in `routes/profile.ts`
- `readiness.recordSupervisedAcknowledgement`

`withLock` is proper-lockfile: it locks `realpath(target)`, the lock directory is `<realpath>.lock`, and the lock is **not reentrant**. The agent and server resolve the same repo file, so they contend on one lock directory.

Remaining gaps:
- `writeCredentials` does not force `0600` and does not refuse symlinks.
- `run-manager.json` `writeMetadata` (`runManager.ts:1119`) is a direct write. That file **is the run lock**, held for the child's whole lifetime with `retries:0` (`:300-321`).
- `createQueueFile` (`queueWriter.ts:375`) and `createProfileFromTemplate` (`profileWriter.ts:135`) are non-atomic exclusive creates.
- `lock.ts` has proper-lockfile's default `onCompromised`, which throws from a timer.
- `parseCredentialsText` treats empty text as `{}` (pinned by `accounts.test.ts:215` 7.3b and `:1210` 7.29).
- `readGatherStateSummary` is fail-open and lenient (pinned by `readers.test.ts:233`).
- `/api/overview` tolerates only settings errors (`routes/overview.ts:20-37`).

Already in place:
- `promoteQueueFile` (`queueWriter.ts:455-766`) does the safe move. One file descriptor provides the read, URL validation and bigint identity. Then `link`, with a fallback to `COPYFILE_EXCL` on EXDEV, then verify, unlink the source and roll back by identity. `queue.test.ts:931-1336` spies on its `fs.*` calls.
- Demo and e2e-only writers: `demoArtifacts.mjs` (`commitDemoApplication`, `persistDemoScores`) and `routes/e2eReset.ts`.
- `fsync` callers today: `applicationConfigStore`, `runConfig.privateWrite`, `providerService.writePrivate`, `scoring.ts:112`, `scripts/workspace.mjs`.

### Scripts and runtime

- `scripts/workspace.mjs` holds the backup and migration code: `createBackup`, `restoreBackup` and `recoverMigration`, plus `migrateWorkspace`, which is called only by tests.
  - `restoreBackup` checks only the run lock, takes no file locks, keeps its pre-restore snapshot in memory, and rolls back with a non-atomic `writeFileSync`.
  - `resolveWorkspaceRoot` (`:53-60`) requires `realpath(root) === realpath(codeRoot)`.
  - `initWorkspace` (`:68`) accepts any root containing `.pi/extensions`. The demo relies on this (`pi-jobs.mjs:35-41`).
  - Doctor runs TypeScript through tsx (`pi-jobs.mjs:75`, `doctor-readiness.mts`).
- Runs: the agent child is spawned with `cwd = root` (`runManager.ts:409-415`).
  - `reclaimOrphan` (`:403`) runs after `prepare` (`:391`).
  - Terminal `pi` sessions are a supported path (`README.md:18`, `:119-120`) and never take the run lock.
  - The browser profile is `.mcp.json` `--user-data-dir ./.browser-data`, relative to the spawn cwd.
  - Pi state is `PI_CODING_AGENT_DIR=.pi-jobs/runs/<id>/pi-agent` (`runConfig.ts:219-235`).
- Release: `scripts/release-manifest.json` `include` lists `Codex-info/plans/PJR-21/plan.md` (`:70`). Any new tracked file must be added there, or `release:audit` fails.
- Tests:
  - Extension vitest covers only `.pi/extensions/lib/**/*.test.ts`.
  - `ats-adapters.offpath.test.ts` shows how to load an extension with a fake `ExtensionAPI`.
  - The demo shows how to copy `.pi/extensions` into a temp root so that `WORKSPACE` resolves there.

## Decisions

**D1. One shared durable-storage module: `.pi/extensions/lib/durable-store.ts`.** The server imports it, following the existing pattern where the server already imports `lib/job-file-lock`, `lib/captcha`, `lib/targets` and `lib/scoring`.

- **`withFileLock(target, fn)`**
  - Uses proper-lockfile with `stale: 10_000`.
  - Has a randomized retry budget totalling about 12 s, which is at least the stale window. A crashed holder then delays contenders instead of failing them.
  - **Reentrancy guard:** an `AsyncLocalStorage` set of held realpaths. A nested acquire of the same target throws `LOCK_REENTRY` immediately instead of stalling. A test-only ordering assertion checks D4.
  - **`onCompromised`:** sets a `compromised` flag on the lock context. `atomicWriteFile` checks the flag immediately before `rename` and aborts with `LOCK_COMPROMISED`. `release()` swallows `ERELEASED`. `update` is injectable so that tests are fast.
  - The target must exist, so callers bootstrap first.
- **`atomicWriteFile(file, bytes, {mode})`**
  1. `lstat` the target and refuse a symlink or non-regular file.
  2. Write a temp file named `.<basename>.<pid>.<ts>.<rand>.tmp` in the same directory, opened `wx`. A leading dot and the `.tmp` suffix mean `routes/events.ts` already ignores it.
  3. `write`, `fsync`, `close`, then `rename`.
  4. Fsync the directory on a best-effort basis (ignore `EINVAL`, `EISDIR`, `EPERM`).
  5. Keep the existing file mode, and force `0o600` for secret files (`credentials.json`, `settings.json`, `state.json`).
  6. Remove the temp file in `finally`.
- **`atomicCreateFile(file, bytes, {mode})`**
  - Writes the temp file, then `fs.link(temp, file)`. `EEXIST` means it never overwrites. Then unlinks the temp file.
  - If `link` fails with `EPERM`, `ENOTSUP`, `EMLINK`, `ENOSYS` or `EXDEV`, it falls back to `copyFile(temp, file, COPYFILE_EXCL)` plus fsync. The doc records the small window where a partial file is possible on filesystems without hard links.
- **`readJsonFile(file, parse)`**
  - Opens with `O_NOFOLLOW`. Returns `{state:"missing"}` on `ENOENT`, otherwise `{state:"ok", value, bytes}`.
  - Throws `WorkspaceFileError{code: "CORRUPT" | "UNSAFE" | "IO", file}`.
- **`mutateJsonFile(file, {parse, serialize, bootstrapBytes, mode}, fn)`**
  1. Bootstraps the file with `atomicCreateFile` (ignoring `EEXIST`), unless `bootstrap: false`. With `bootstrap: false`, a missing file throws `WorkspaceFileError{code:"MISSING"}` and nothing is created.
  2. Takes `withFileLock`, then reads strictly.
  3. Calls `fn(value)`, which returns a new value or `NO_CHANGE`.
  4. Writes `serialize(value)` with `atomicWriteFile`.
  - **`serialize` is per file and preserves today's bytes:** extension files use `JSON.stringify(v, null, 2)` with no trailing newline (as now); server serializers stay as they are. Existing byte-pinning tests (`accounts.test.ts:577`, `gatherState.test.ts:169`) stay green.
  - `*Locked` variants, which expect the lock to be already held, are exported for callers composing several steps under one lock.

**D2.** Add `proper-lockfile` and `@types/proper-lockfile` to the root `package.json`, at the same ranges as `ui/`, so the extensions stop relying on npm hoisting. Run `npm install` to update the lockfile.

**D3. Corruption fails closed, and an empty agent-shared JSON file is corrupt.**

New writers never produce a zero-byte file, so a zero-byte file is evidence of a crash under the old code.

- **Parsers** live in `lib/workspace-files.ts`:
  - `parseCredentialsText`, moved here; `ui/server/readers/credentials.ts` re-exports it. Its null-prototype semantics are kept, and empty text now counts as `CORRUPT`.
  - `parseStateText` requires a root object, with `applications` an array and `addresses` an object when present. `null` counts as absent, matching today's `?? []` tolerance (`readers/stateJson.ts:21-29`).
  - `parseGatherStateText` requires a root object, with `seen_urls` and `per_company` as objects if present.
  - All of them preserve unknown keys.
- **Strict versus lenient summary.** `markSeenUrlPromoted` already uses strict `JSON.parse`. Trailing garbage after a valid document counts as **corrupt** for writes. The lenient `readGatherStateSummary` reports `status:"corrupt"` instead of silently using the first document.
- **Agent tools** that hit `CORRUPT` return an error that names the file and how to recover: `npm run restore -- --backup <id>`, or move the file aside and copy `templates/<file>`. They never write.
  - `dedupCheck` on a corrupt `state.json` or `gather_state.json` **fails the gather**. Answering "not a duplicate" would re-discover jobs the user has already applied to.
- **Server read paths:**
  - `/api/overview` catches `CORRUPT` from `credentials.json`, `gather_state.json` **and `state.json`** instead of returning a 500. `readers/stateJson.readState` switches to `parseStateText`, and `listApplications` (`union.ts:70-75`) propagates the typed error.
  - Exact type change in `ui/shared/types.ts` `Overview`:
    - `applications: {…existing shape…} | null`
    - `accounts: number | null`
    - `addresses: number | null`
    - `lastFullGather` unchanged
    - new `corrupt: ("credentials.json" | "gather_state.json" | "state.json")[]`, always present, empty when healthy
  - UI consumers change explicitly:
    - `ui/src/App.tsx:742-744`: the `applicationsLoaded` and `accountsLoaded` flags treat `null`, or `corrupt` containing the file, as loaded-with-error. The view shows the repair error instead of an endless loading state.
    - `ui/src/components/TodayView.tsx:186-205`: guard `overview.applications === null`.
    - A "repair needed" banner names the corrupt files.
  - Update `accounts.test.ts:211` and `:228`, which expect `accounts` to be 0, to match.
  - `readiness` adds a visible warning (it already defaults to not acknowledged).
- **Tests updated by name:**
  - `accounts.test.ts` 7.3b (`:215`) and 7.29 (`:1210`): empty is now corrupt.
  - `readers.test.ts:233`: the lenient summary now returns corrupt status.
  - Overview tests gain corrupt cases.

**D4. Lock table and global order.**

| File | Lock target | Who |
|---|---|---|
| `credentials.json`, `state.json`, `gather_state.json`, `settings.json`, `profile.md` | the file itself | agent and server (`profile.md` and `settings.json` are server only) |
| `targets.md` | the side file `targets.md.lock`, through `withTargetsLock`, which moves to the shared lib | agent and server |
| `jobs/discovered/<file>.md` | `<file>.md.lock` (`withDiscoveredJobFileLock`, unchanged) | agent and server |
| `ui/run-manager.json` | **not file-locked for metadata writes.** It *is* the run lock. `writeMetadata` uses `atomicWriteFile` only and is always called while the run lock is held. | server |
| `ui-state.json` | unchanged: an in-process queue in a single-writer server, plus `atomicWriteFile` | server |

Locks are always taken in this order, never in reverse:

```
run-manager.json → .pi-jobs/resume-run-guard → .provider-store → settings.json
.pi-jobs/resume-run-guard → resumes/ (directory lock) → profile.md
run-manager.json → discovered/<file>.md.lock → gather_state.json → state.json
```

`credentials.json`, `targets.md` and `profile.md` are leaf locks: nothing else is acquired while one is held. The reentrancy guard turns accidental nesting of the same target into an immediate error.

**D5. Job-file moves use one fd-bound primitive in `lib/job-files.ts`.**

- `moveJobFileNoClobber(src, dst, {validate?, testHooks?})` **opens `src` itself**, using `O_RDONLY | O_NOFOLLOW`.
  - Reads `raw` and the bigint identity from that one descriptor, then runs `validate(raw, identity)`.
  - Then `link` (falling back to `COPYFILE_EXCL` on `EXDEV`, `EPERM`, `ENOTSUP`, `EMLINK` or `ENOSYS`), verify, recheck the source, unlink it, and roll back by identity.
  - Returns `{ok, raw, identity} | NOT_FOUND | EEXIST | PARTIAL_CONFLICT`.
  - It adds **no** `fs.*` calls before the open and **no** directory fsync, so the `fs` spies in `queue.test.ts` still match.
- `ui/server/queueWriter.promoteQueueFile` passes its normalize and URL validation as `validate`. This extraction is a pure move in its own commit, and `queue.test.ts`, `discoveredJobLock.test.ts` and e2e `discovery-race.spec.ts` must pass unchanged.
- **Gather-state bootstrap.** The shared `upsertSeenUrl` core uses `mutateJsonFile(..., {bootstrap: false})`.
  - Server path: `markSeenUrlPromoted` keeps today's behaviour, warning instead of creating the file (`gatherState.test.ts:206` unchanged). MISSING, CORRUPT and shape errors map to the existing warning texts.
  - Extension paths (gather merge, promote, reject): bootstrap from `templates/gather_state.json` bytes, as `writeGatherState` effectively does today.
- **Gather-state matching is by the URL** in the job file's `url:` frontmatter, read from the same descriptor and never re-derived from the slug. Use the `markSeenUrlPromoted` upsert semantics, with the core moved to `lib/gather-store.ts` and the server re-exporting it.
- **Extension `promoteDiscovered(file)`:**
  1. `isSafeSlug` check.
  2. Under `withDiscoveredJobFileLock`: move with `moveJobFileNoClobber`.
  3. Under the gather-state lock: upsert `decision:"promoted"` by URL.
- **Extension `rejectDiscovered(file, reason)`:**
  1. `isSafeSlug` check.
  2. Under the discovered-job lock: open the file and read its URL and identity.
  3. Under the gather-state lock: upsert `decision:"rejected"`, `reject_reason`, and `reject_pending: {identity, at}` by URL. `identity` is the **full `FileIdentity`** (dev, ino, birthtimeNs, mtimeNs, size, serialized as strings) from `lib/job-files.ts`, because inodes are recycled immediately on Linux (`queueWriter.ts:9-12`). The prior entry is kept in memory.
  4. Unlink only if `sameFileIdentity` holds. If it does not, restore the prior entry under the gather-state lock, return a conflict, and delete nothing.
  5. Under the gather-state lock: clear `reject_pending`.

  `reject_pending` is the only proof R4 accepts that a reject was interrupted.
  - With **no URL**, it still deletes the file (today's behaviour) and reports "no seen_urls entry recorded".
  - On a changed identity it deletes nothing.
- **`writeDiscoveredJob`** uses `atomicCreateFile`. `EEXIST` is treated as already discovered and skipped. It never overwrites scored or dismissed frontmatter.
- **`isSafeSlug`** moves from `ui/server/workspace.ts:46-48` to `lib/workspace-files.ts`. The server re-exports it. It is applied in `promote_to_queue`, `reject_discovered`, `score_job`, `dedup_check` and `complete_application`.

**D6. Completion becomes a tool, `complete_application({slug})`, in `lib/applications.ts`.**

Under `withFileLock(state.json)`, using the `*Locked` read and write:

1. Read strictly, find the application by slug, and require `status === "submitted"`.
2. Resolve the source from `app.queue_file`, using `parseRecordedJobFile`, which moves to the shared lib and is re-exported for `routes/applications.ts`. If that is absent, fall back to `jobs/queue/<slug>.md`. The destination is **always `jobs/applied/<slug>.md`** (after `isSafeSlug`), whatever the source file name.

   The dashboard keys applied files by file name (`readers/jobFiles.ts:183-195`). An applied file whose name differs from the state slug becomes a second, "estimated" row (`union.ts:82-88`).
3. Act on what exists:
   - Source exists: call `moveJobFileNoClobber(src, dst)`.
   - Source missing and destination exists: already done, so continue (idempotent).
   - Neither exists: return `NOT_FOUND`.
4. Set `app.queue_file` to the destination path, then write `state.json` atomically.
5. After releasing the lock, regenerate `APPLIED.md` with `atomicWriteFile`. It is derived, so a failure is logged, not fatal.

Taking the `state.json` lock around a job-file move follows the D4 order: discovered-job locks are never held here, and queue and applied files are not locked. `update_application_state` remains the only writer of `status`.

- **`queue_file` already in `applied/`** (an old manual `mv`, for example `applied/0-x.md`): if `applied/<slug>.md` exists, completion is done, so repoint `queue_file` to it. Otherwise report and do not rename.
- **Backstop against resubmission:** `update_application_state` refuses **any** status change away from `submitted` unless `override_submitted: true` is passed. It returns an error naming the submitted date.
- **`/apply-next` guard** (`job-applier.ts:722-731`, the terminal path that never runs the dashboard reconciler):
  1. Before dispatching a queue file, run R6 for that file.
  2. Skip, and warn about, any queue file that matches an `applied/` file (same identity or same bytes), or whose `url:` matches a `submitted` application.
  3. If skipping leaves no file, report "no new queued jobs" and point to `npm run doctor -- --repair`.

The post-submit checklist text at `job-applier.ts:396` and `ats-adapters.ts:471` changes from "mv … / move queue file" to "call `complete_application`". These are the **only** prompt edits. If the agent ignores the instruction and uses `mv`, the file ends up in `applied/` while `queue_file` still points at `queue/`. The reconciler repoints it.

**D7. The reconciler is lock-taking, idempotent and conservative: `lib/reconcile.ts`.**

`reconcileWorkspace(root, {apply})` holds **per-row locks in D4 order** and **re-checks the observed state under those locks** before acting. Safety therefore does not depend on whether an agent, a terminal `pi` session or a server route is running. It only finishes operations the code itself starts.

"Same" in the table means the same bigint identity **or** byte-identical content, which covers the copy fallback. It never deletes a file whose content differs from its counterpart.

| # | Observed state, re-checked under the lock | Action |
|---|---|---|
| R1 | The same file is in `discovered/` and `queue/` and is the "same" | Unlink the `discovered/` copy. Upsert `promoted` by URL. |
| R2 | The same name is in `discovered/` and `queue/` with different content | Report a conflict. Change nothing. |
| R3 | A file in `queue/` whose URL entry is not `promoted` | Upsert `promoted` by URL. |
| R4 | A URL entry is `rejected` **with `reject_pending` set**, and a `discovered/` file with that URL and the **same full `FileIdentity`** (`sameFileIdentity`) still exists | Unlink it and clear `reject_pending`. A `rejected` entry without `reject_pending` (for example a re-discovery whose merge has not run yet) is **left alone**. Report only. |
| R4b | `reject_pending` is set but no `discovered/` file with that URL exists | Clear `reject_pending` (the reject finished). |
| R5 | `state.json` says `submitted`, and the file resolved from `queue_file` or the slug is in `queue/`, with no `applied/<slug>.md` | Complete it: move to `applied/<slug>.md`, then repoint `queue_file`. |
| R6 | **Per submitted application:** the resolved source (the recorded `queue_file`, or `queue/<slug>.md`) still exists in `queue/` **and** `applied/<slug>.md` exists. This covers a completion interrupted between `link` and `unlink` with a `0-<slug>.md` source. | Same identity or byte-identical: unlink the queue copy and repoint `queue_file`. Different: conflict, report only. R6 stays in the run-start set, so a leftover queue copy is cleared before the next `/apply-next` can pick it. |
| R7 | `queue_file` points into `queue/` but the file is only at `applied/<slug>.md` | Repoint `queue_file`. An applied file with a non-slug name (such as `applied/0-<slug>.md` left by a manual `mv`) is reported, not renamed. |
| R8 | A file is in `applied/` but `state.json` is not `submitted` | **Report only.** Never invent a submission. |
| R9 | `APPLIED.md` is older than `state.json`, or does not match its render | Regenerate it. |
| R10 | A `discovered/` file has a URL with no `seen_urls` entry (a gather killed before its merge) | Upsert `decision:"discovered"` with `first_seen` taken from the file. |
| R11 | `state.json` or `gather_state.json` is corrupt | Abort and report. Change nothing. |
| R12 | Leftover temp files in our patterns that are older than 10 minutes | Remove them. The patterns are `.<base>.*.tmp`, `*.score-tmp`, `<file>.tmp-<pid>-<hex>` (`workspace.mjs:17`) and `*.restore-<pid>`. |

**Where it runs.**

| Context | Mode | Details |
|---|---|---|
| `npm run doctor` (`doctor-readiness.mts`, which runs through tsx) | report only (`apply:false`) | Prints findings. |
| `npm run doctor -- --repair` | apply | Refuses while `activeRun(root)` is true. Otherwise applies. It is still safe alongside a terminal `pi`, because each row is locked and re-checked. |
| `RunManager.start` | apply, **limited to R1, R5, R6, R7 and R12** | Runs **after `reclaimOrphan` returns** and before spawn. Each row uses `retries: 0`: on ELOCKED it skips the row and reports it rather than waiting. After the reconciler finishes it re-checks `this.disposing`, as `startRun` does after each await. Findings go to the run transcript as one `warning` entry. A corrupt-state abort (R11) is reported but **does not block** starting the run: the agent's own tools fail closed on corrupt files. R3, R4, R9 and R10 run only from `--repair`, so fixtures and e2e roots are not rewritten on every run start. |

`initWorkspace` is **not** changed. It is synchronous `.mjs` used by `node --test` and e2e `web-server.mjs`.

A write-ahead journal is rejected because every multi-file operation is "move, then status upsert", or the reverse for reject. With the rows above, every crash point is identifiable from the files.

**D8. Workspace contract: document and test, don't restructure.**

- **`lib/workspace-files.ts`** exports `WORKSPACE_FILES`, a name table of relative paths.
  - The extensions' `wsPath` callers, and the server's `paths` in `ui/server/workspace.ts`, both build paths from it. That is a mechanical name swap with no path changes.
- **`docs/workspace.md`** (new) covers:
  - every file: its writers (agent tool, server route, script, demo/e2e only), lock target, atomicity, corruption behaviour, whether it holds secrets, and whether it is backed up or exported
  - the lock order
  - the reconciler table
  - backup and restore
  - secret-bearing backups versus the shareable source export
  - "protection of other workspaces comes from `resolveWorkspaceRoot` plus no registered migration"
  - "Windows unsupported"
  - the demo/e2e-only writers
  - a known product behaviour (out of scope here): a user's reject is undone if the next gather re-discovers the URL, because dedup lets `rejected` URLs through (`job-gatherer.ts:178`)
  - the residual proper-lockfile stale-reclaim race after a crash (`lockfile.js:56-79`)
  - `/apply-next` skips a queue file whose URL matches a `submitted` application. To deliberately re-apply at the same URL, change that application's status with `override_submitted` or remove the stale entry first.
- **`ui/server/__tests__/workspaceContract.test.ts`** (new) asserts:
  - (a) the server's `paths.*` equals `WORKSPACE_FILES` resolved against root
  - (b) every agent-shared file in `WORKSPACE_FILES` maps to the exported lock helper from D4
  - (c) launcher root: `resolveWorkspaceRoot()` equals `defaultWorkspaceRoot()` with `PI_JOBS_ROOT` set the way `pi-jobs.mjs:27` sets it
  - (d) the browser profile `.mcp.json` `--user-data-dir` is `./.browser-data` and the run spawn `cwd` is root
  - (e) Pi state: `prepareAgentRun` puts `PI_CODING_AGENT_DIR` under `.pi-jobs/runs/<id>/pi-agent`
  - (f) the release manifest and export exclude `.pi-jobs/**`, `credentials.json`, `settings.json`, `state.json`, `gather_state.json`, `APPLIED.md`, `.browser-data/**`, and the contents of `jobs/**` and `resumes/**`
  - (g) `.gitignore` covers `APPLIED.md` and `.*.tmp`
- **Stale comments to update:**
  - `ui/server/lock.ts:4-7`
  - both `workspace.ts` headers
  - `accountsWriter.ts:256-263`
  - `readers/gatherState.ts:95-120`
  - `settingsStore.ts:11-15,58-72`
- **Docs to update:**
  - `README.md` (around lines 11, 74–75, 171 and 351–354)
  - the storage rules in `AGENTS.md` and `CLAUDE.md`
  - `SECURITY.md` lines 23–34

**D9. Backups and migration.**

Keep backup-first migration, `recoverMigration`, the version marker and unknown-field preservation. In addition:

- `restoreBackup` locks every restored target **in addition to** the run-lock check. proper-lockfile's sync API rejects `retries > 0` (`ESYNC`) and `realpath: true` fails on files that don't exist yet, so it uses `lockTargetSync(target)`:
  - `lockfile.lockSync` with `retries: 0`, `realpath: false`, and `lockfilePath` set to `realpath(dirname(lockTarget)) + "/" + basename(lockTarget) + ".lock"`. That is the same directory the async side creates.
  - On ELOCKED it backs off with `Atomics.wait` and gives up after about 12 s with a clear error.
  - The lock target is the D4 mapping: the file itself, `targets.md.lock` for `targets.md`, or `<file>.md.lock` for job files. A backup path with no mapping is refused.
  - It uses an `onCompromised` that sets a flag and does not throw. Restore runs inside the long-lived `npm start` process (via `initWorkspace` → `recoverMigration`), so a throwing timer would crash the server.
  - **Order:** acquire in D4 order: job-file locks → `gather_state.json` → `state.json` → `settings.json` → `profile.md` → `targets.md.lock` → `credentials.json`.
  - **All or nothing:** try every lock with `retries: 0`. On any ELOCKED, **release every lock already held**, then back off with `Atomics.wait` and retry the whole set. Nothing is held while waiting, so the blocked event loop cannot let held locks go stale and be stolen.
  - Give up after about 12 s with a clear error.
  - Check the compromised flag before each rename.
  - Keep the critical section (pre-restore backup plus renames) well under the 10 s stale window. Backups are a handful of small files.

  Then it:
  1. Writes a **persisted** pre-restore backup (`createBackup`, id `<ts>-pre-restore`) inside those locks.
  2. Restores each file through the existing temp-file-plus-rename.
  3. Rolls back with the same atomic temp-file-plus-rename instead of `writeFileSync`.
- **Tests:**
  - `resolveWorkspaceRoot` refuses a root outside the clone.
  - `initWorkspace` refuses a root without `.pi/extensions`, and the demo path still works.
  - An interrupted `migrateWorkspace` recovers.
  - Restore leaves a pre-restore backup.
  - Restore while a dashboard write holds `credentials.json` waits for it. The dashboard write appears in the pre-restore backup, and the final file equals the restored backup.
- `readUiState` dropping unknown top-level keys (`uiState.ts:14-15`) conflicts with AC5. Fix it with a spread-preserving read and write, plus a test.

**D10. Server gap fixes, limited to real gaps:**

- `accountsWriter.writeCredentials` goes through `atomicWriteFile` (0600, symlink refusal).
- `runManager.writeMetadata` goes through `atomicWriteFile`. It gets no file lock (D4).
- `createQueueFile` and `createProfileFromTemplate` go through `atomicCreateFile`.
- `lock.ts` becomes a re-export of `withFileLock`. That gives every existing caller the compromised and reentrancy handling with no call-site change.
- Other server writers that are already atomic and locked are **not** rewritten.
- `resolveOverridePath` accepting absolute resume paths is deferred to PJR-24, which audits path escapes. A journal note will record this.

**D11. Gitignore and manifest.** Add `APPLIED.md` to `scripts/release-manifest.json` `exclude` and `sensitivePathPatterns`. Add `/APPLIED.md` (personal application history) and `.*.tmp` (a credentials temp file left by a crash must not be committable). The contract test (g) asserts both.

## Tasks

**Test conventions:**
- Unit tests use temp workspaces from `fs.mkdtemp(realpath(os.tmpdir()))`.
- Extension **handler** tests copy `.pi/extensions` into a temp root, as the demo does, so `WORKSPACE` resolves there. They load the handler module with a fake `ExtensionAPI`, following `ats-adapters.offpath.test.ts`.
- Bare imports (`typebox`, `proper-lockfile`) resolve from the importing file's directory upward, and a copy under `os.tmpdir()` has no `node_modules` above it. So the harness (`ui/server/__tests__/extensionHarness.ts`, new) **symlinks `<tmpRoot>/node_modules` to `<repo>/node_modules`** and copies `templates/`, which the gather bootstrap reads. A T1 smoke test proves a copied `job-accounts.ts` loads and executes one tool before any handler test relies on it.
- Stale-lock cases (T8d, D1 compromised) set a per-test timeout of at least 30 s.
- No test writes to the repo workspace.
- Test pauses are **injected options** (`testHooks`), not environment-variable compile flags.

**T0. Bind the workspace and record a baseline.**
1. Recheck `origin/main`. Run `syntaur worktree create` for PJR-12: repository `<rolebound repository>`, branch `codex/pjr-12-durable-storage`, from `origin/main`.
2. Copy this plan to `Codex-info/plans/PJR-12/plan.md` **with every absolute home-directory path removed**. Add that path to the `include` list in `scripts/release-manifest.json`.
3. Run `npm ci`. Record the baseline counts:
   - `npm test`
   - `npm test --workspace ui`
   - both typechecks
   - `workspace-test`
   - `lifecycle-test`
   - `release:audit`

**T1. Durable-store primitives (D1, D2).**
- Files: `lib/durable-store.ts` (new), root `package.json` and lockfile, `ui/server/lock.ts` (re-export).
- Tests in `lib/durable-store.test.ts`:
  - **Corruption:** a missing file reads as missing; corrupt, empty, whitespace and wrong-shape files each throw CORRUPT with the bytes unchanged.
  - **Unsafe targets:** a symlink or directory throws UNSAFE on both read and write.
  - **Write failure and temp files:** an injected failure after the temp write leaves the original intact, with no temp file left. The temp name matches `.<base>.*.tmp`.
  - **Mode:** preserved by default, forced to 0600 for secrets.
  - **Exclusive create:** `atomicCreateFile` returns EEXIST and leaves the file untouched. The no-hard-link fallback is exercised by injecting `link` failing with EPERM.
  - **Concurrency and reentrancy:** 20 concurrent same-process increments end at 20, and a nested same-target acquire throws `LOCK_REENTRY` immediately.
  - **Compromised lock:** with the injected `update` interval, deleting the lock directory mid-hold aborts before rename (`LOCK_COMPROMISED`), with the original intact, and the process does not crash.
- `lock.test.ts` stays unchanged and still passes.

**T2. Parsers and shared helpers (D3, D5, D8).**
- `lib/workspace-files.ts` (new): `parseCredentialsText`, `parseStateText`, `parseGatherStateText`, `isSafeSlug`, `parseRecordedJobFile` and `WORKSPACE_FILES`.
- Server re-exports, replacing their current definitions: `readers/credentials.ts`, `workspace.ts` (`isSafeSlug`, and `paths` built from `WORKSPACE_FILES`), and `routes/applications.ts` (`parseRecordedJobFile`).
- Tests:
  - every parser's valid, empty, `[]`, `null`, wrong nested type and unknown-keys-kept cases
  - null-prototype credentials still hold
  - update `accounts.test.ts` 7.3b and 7.29

**T3. Extension credentials.**
- `lib/accounts-store.ts` (new):
  - `findAccount(creds, url, company)`: a pure function holding the existing host and company-fallback logic.
  - `mutateAccounts(file, fn)`.
- `job-accounts.ts`:
  - All four read-modify-write handlers move the existence and host lookup **inside** the `mutateAccounts` callback. `create_account` returns `already_exists` from inside the lock.
  - Read-only handlers use the strict reader.
  - CORRUPT is returned as a tool error carrying the recovery text.
- Tests:
  - lib: corrupt or empty input refuses to mutate and keeps the bytes; a missing file bootstraps and saves; unknown fields are kept.
  - handler (temp-root harness): `create_account` racing the server's `createAccountEntry` for the same host gives exactly one winner and the other gets `already_exists`, with no overwrite.

**T4. Extension application state and completion (D6).**
- `lib/applications.ts` (new): `mutateApplicationState`, `readApplicationState`, `renderTracker` and `completeApplication`.
- `job-applier.ts`: `update_application_state`, `generate_address`, `/acknowledge`, `regenerateTracker`, the new `complete_application` tool, and the checklist line at `:396`.
- `ats-adapters.ts:471`: the checklist line only.
- Tests:
  - A status update on a corrupt `state.json` fails and keeps the bytes.
  - Completion refuses unless the status is `submitted`.
  - Completion for a `0-<slug>.md` `queue_file` moves the file to `applied/<slug>.md` and repoints `queue_file`. `listApplications` then returns exactly one row for that application.
  - The source missing with the destination present succeeds (idempotent).
  - `update_application_state` refuses any change away from `submitted` without `override_submitted`.
  - Harness test: with a leftover `queue/0-x.md` and `applied/x.md` pair, plus a submitted application with the same URL, `/apply-next` does not dispatch `0-x`.
  - A different existing destination returns EEXIST and moves nothing.
  - The tracker is regenerated.
  - Handler test: the `complete_application` tool runs through the harness.

**T5. Extension gather path (D3, D5).**
- Files:
  - `lib/job-files.ts` (new; `moveJobFileNoClobber`, extracted first in a pure-move commit)
  - `ui/server/queueWriter.ts` (calls the primitive)
  - `lib/gather-store.ts` (new; `mutateGatherState`, the URL-keyed `upsertSeenUrl` core moved from `readers/gatherState.ts`, which re-exports it, `mergeGatherResults`, `promoteDiscovered`, `rejectDiscovered` and `writeDiscoveredJob`)
  - `job-gatherer.ts`
- **`mergeGatherResults` is a three-way merge.**
  1. `gatherAll` snapshots `seen_urls` at start and keeps its proposed changes in memory.
  2. At the end, in `finally` so that a partial gather still records what it found, it re-reads under the gather-state lock.
  3. A change is applied only where the current entry still equals the snapshot entry. The gatherer's own rule (re-discovery after `rejected` becomes `discovered`, `:567-597`) is unchanged. Where the entry was changed concurrently, the current entry wins and unknown keys are spread.
  4. It replaces `per_company` for the companies gathered and sets `last_full_gather`.
- `dedupCheck` fails on corrupt state. `add_target` takes `withTargetsLock` plus `atomicWriteFile`. `isSafeSlug` is applied in `promote_to_queue`, `reject_discovered` and `score_job`.
- Tests:
  - A merge does not drop a `promoted` or `rejected` decision written during the gather.
  - Re-discovery of a rejected URL that nobody touched becomes `discovered`, as today.
  - Promote collision returns EEXIST and keeps both files.
  - Promote and reject match by URL when the display name differs from the file slug (for example `wandb` versus "Weights & Biases").
  - Reject with no URL still deletes the file and reports.
  - Reject on a changed identity deletes nothing.
  - `writeDiscoveredJob` does not overwrite a scored file.
  - `reject_discovered({slug:"../applied/x"})` is refused.
  - `queue.test.ts`, `discoveredJobLock.test.ts` and `gatherState.test.ts` are unchanged and still pass.

**T6. Reconciler (D7).**
- Files:
  - `lib/reconcile.ts` (new)
  - `scripts/doctor-readiness.mts` (report and `--repair`)
  - `scripts/pi-jobs.mjs` (passes `--repair` through and refuses during an active run)
  - `ui/server/runs/runManager.ts` (apply after `reclaimOrphan`, plus the transcript warning)
- Tests:
  - one fixture per row R1–R12, checking the report and the post-apply state
  - apply run twice is a no-op the second time
  - R11 changes nothing
  - a row whose state changes between observation and lock is skipped
  - a re-discovered file with a `rejected` entry and no `reject_pending` is left alone (the NH1 regression)
  - a stale `reject_pending` next to a re-discovered file with a recycled `dev`/`ino` but a different full identity is left alone, and R4b clears a pending marker with no file
  - R6: `queue/0-<slug>.md` and `applied/<slug>.md` hard-linked and submitted, so the queue copy is removed and `queue_file` repointed
  - the run-start path skips a row whose lock is busy, and returns promptly on dispose
  - `RunManager.start` proceeds when R11 is reported

**T7. Server read paths and gap fixes (D3, D9, D10, D11).**
- Files:
  - `routes/overview.ts`, `readers/stateJson.ts`, `union.ts`, `ui/shared/types.ts`, `ui/src/App.tsx` (lines 742-744 and the banner) and `ui/src/components/TodayView.tsx`
  - `scripts/release-manifest.json` (`APPLIED.md` exclude and sensitive pattern)
  - `readers/gatherState.ts` (`readGatherStateSummary` corrupt status)
  - `readiness.ts` (warning)
  - `accountsWriter.ts`, `runManager.ts` (`writeMetadata`), `queueWriter.ts` (`createQueueFile`) and `profileWriter.ts` (`createProfileFromTemplate`)
  - `uiState.ts` (unknown-key preservation)
  - `.gitignore`
- Tests:
  - the overview with zero-byte or garbage `credentials.json`, `gather_state.json` and `state.json` returns 200 with `corrupt` and nulls
  - `gatherState.test.ts:206` (missing file gives a warning, not a create) is unchanged
  - a symlinked `credentials.json` refuses writes
  - `run-manager.json` stays intact under an injected write failure
  - `ui-state` unknown keys are preserved
  - update `readers.test.ts:233`
  - a UI test rendering Today and Accounts with `corrupt: ["state.json","credentials.json"]`: banner shown, no crash, no endless loading state

**T8. Cross-process and interruption suite (AC6).**

`ui/server/__tests__/crossProcessStorage.test.ts` spawns real Node child processes through tsx against a temp-root copy with `.pi/extensions`. It uses fictional fixtures only.

| Case | What it races or interrupts | Pass condition |
|---|---|---|
| a | Extension `create_account` on hosts A1–A25 and the server `createAccountEntry` on hosts B1–B25 run concurrently. Then extension `update_account` on A1–A10 runs against server `deleteAccountEntry` on B1–B10. | A1–A25 present, with A1–A10 updated; B11–B25 present; B1–B10 absent |
| b | Extension `update_application_state` and `generate_address` against the server address `PUT` and `recordSupervisedAcknowledgement` | none lost |
| c | Extension gather merge against server promote with `markSeenUrlPromoted`, against extension reject | every decision survives |
| d | A child holding the `state.json` lock is killed with SIGKILL | the next writer proceeds after the stale window; the file holds the old or the new content, never a truncation |
| e | A child is killed at each `testHooks` pause: promote between link and unlink, reject between upsert and unlink, completion **between link and unlink with a `0-<slug>.md` source** and between move and repoint, gather between discovered writes and merge | the reconciler restores a truthful state |
| f | Traversal slugs; symlinked `jobs/queue`, `credentials.json` and `gather_state.json` | refused |
| g | Restore racing a dashboard credentials write (extends `scripts/workspace.test.mjs`) | The dashboard write appears in the persisted pre-restore backup, and the final file equals the restored backup. |

- The tests assert no lost records, no empty replacement, and no corrupt or partial file in any case.

**T9. Contract, docs and comments (D8, D9, D11).**
- Files:
  - `docs/workspace.md` (new)
  - `workspaceContract.test.ts` (new)
  - `scripts/workspace.mjs` (`restoreBackup` locks and persisted pre-restore backup)
  - `scripts/workspace.test.mjs` (the `resolveWorkspaceRoot`, `initWorkspace` and restore tests)
  - the README, AGENTS, CLAUDE and SECURITY edits
  - the stale comments listed in D8
- Add `docs/workspace.md` to the release manifest `include` list.

**T10. Branch verification and PR.**
- Run the verification below on the branch SHA.
- Open a PR against `main`. CI must pass all three jobs (macOS, Linux, release-export).
- Log the SHA, run links and counts to the ticket.

**T11. Post-merge reruns on the merged `main` SHA (AC7).**
1. Make a fresh clone into a temp directory.
2. Run `npm ci`, `npm run setup` and `npm run doctor`, then `server-smoke`, `demo-smoke`, `release:audit` and the exact export (`release:export`, then install, test and build inside the export).
3. Record the SHA and outputs on PJR-12.
4. Hand off to PJR-15 (the checklist now calls `complete_application`, and `state.json` is the source of truth for submitted status), PJR-23 and PJR-24 (including `resolveOverridePath`).

## Verification (T10, on the branch SHA, recording exact counts)

1. `npm test`: extension lib and handler-harness suites.
2. `npm test --workspace ui`: server, cross-process, contract and updated tests. Compare with the T0 baseline; any removed or renamed test must be justified.
3. `npm run typecheck` and `npm run typecheck --workspace ui`.
4. `npm run workspace-test` and `npm run lifecycle-test`.
5. `npm run build`, `npm run server-smoke`, `npm run demo-smoke`, and `npm run browser-test` (the 91 journeys still pass, including `discovery-race.spec.ts`).
6. `npm run release:audit` and a green CI exact-export job on the PR.
7. **Manual fixture check** in a temp-root copy (the T8 harness, never a live workspace):
   - Truncate `credentials.json` to half and then to zero bytes.
   - Confirm that the dashboard overview shows the repair banner.
   - Confirm that the extension `list_accounts` handler returns the corruption error.
   - Confirm `shasum` is unchanged.
   - `npm run doctor` reports the problem and changes nothing.
8. Run `crossProcessStorage.test.ts` 20 times in a loop with no flakes.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Lock wait:** a crashed holder stalls a save by up to about 12 s | Locks wrap only short in-memory mutations. `gatherAll` no longer holds state across network calls. When the budget runs out, routes return a clear "busy, retry" error. |
| **Empty counts as corrupt:** a behaviour change for any existing zero-byte file | The repair banner, doctor reporting, and a PJR-22 release note. Templates and bootstraps write `{}`, so fresh installs are unaffected. |
| **The extracted promote primitive could drift** | Pure-move commit first, the same open-first call sequence, and the existing spies and e2e suites unchanged. |
| **The agent ignores `complete_application`** | R5 and R7 repair the result. A manual `mv` without a status update is only reported, never invented. |
| **The reconciler acts concurrently with writers** | Per-row locks plus re-checks. `--repair` refuses during an active run. |
| **Hard links unsupported** (exFAT, SMB) | Copy fallback with a documented partial-file window. Windows is unsupported. |
| **fsync on macOS** does not force media flush without `F_FULLFSYNC` | The guarantee is documented as "no torn or partial files across process crashes", not "power-loss durable". |
| **Prompt overlap with PJR-15** | Only two checklist lines change. PJR-15 rebases on this. |
| **Flaky cross-process tests** | Injected deterministic pauses and a 20-run loop. |
| **proper-lockfile stale-reclaim race:** two waiters can both acquire after a crash | Rare and post-crash only. Atomic writes mean the worst case is a lost update, never a torn file. Documented in `docs/workspace.md`. |

## Review log

**Round 1 (independent plan review, 2026-10-07): 4 high, 14 medium.**

High:
- H1: `queue_file` naming → D6, R5, R7.
- H2: no-agent-running assumption → D7 per-row locks, run placement and `--repair` guard.
- H3: slug matching → D5 URL keying and the no-URL reject case.
- H4: `initWorkspace` claim → D9 tests.

Medium:
- M1 → T3 lookup inside the lock.
- M2 → D4 `run-manager` row.
- M3 → D1 reentrancy and D4 order.
- M4 → R4, R7, R9, R10 and the byte-identical rule.
- M5 → D1 link fallback and Windows note.
- M6 → D3 overview, types, UI and named tests.
- M7 → D5 fd-bound signature.
- M8 → `isSafeSlug`.
- M9 → D9 restore locks.
- M10 → T11.
- M11 → T0 manifest and path scrubbing.
- M12 → D8 contract test (c)–(e).
- M13 → `serialize` and temp-name patterns.
- M14 → handler harness.
- M15 → trimmed D10, `initWorkspace` untouched, `ui-state` lock deferred.
- M16 → three-way merge.

**Round 2 (2026-10-07): 2 high, 4 medium.**

High:
- NH1: R4 deleting re-discoveries → `reject_pending` proof, R4 narrowed, T6 regression test.
- NH2: duplicate applied rows → destination is always `applied/<slug>.md`, T4 asserts one row.

Medium:
- NM1: sync restore locking → `lockTargetSync` retry loop with an explicit `lockfilePath`, fixed acquisition order, T8(g) reworded.
- NM2: overview type and `state.json` → exact type change plus a `state.json` CORRUPT path.
- NM3: harness bare imports → `node_modules` symlink, smoke test and timeouts.
- NM4: upsert bootstrap → `bootstrap: false` on the server path.

Lows folded in:
- the resume lock edge
- the run-start reconciler (`retries: 0`, dispose check, limited rows)
- `dedup_check` slug validation
- the manifest `APPLIED.md` entry
- the R12 pattern
- the reject/re-discover note and the stale-reclaim risk
- a precise T8(a)

**Round 3 (2026-10-07): 1 high, 3 medium.**

High:
- NH-A: interrupted completion with a `0-` source could be resubmitted → R6 defined per application and kept at run start, a link/unlink pause test, and a submitted-status backstop.

Medium:
- NM-A: restore locks → acquired in D4 order, all-or-nothing with nothing held while waiting, non-throwing `onCompromised`, short critical section.
- NM-B: `reject_pending` → full `FileIdentity`, R4b, and rollback on identity mismatch.
- NM-C: UI consumers of nullable overview fields → `App.tsx` and `TodayView` changes, UI test, `accounts.test.ts` updates.

Lows folded in:
- `queue_file` already pointing into `applied/`
- `parseStateText` treating `null` as absent
- harness copies `templates/`

**Round 4 (2026-10-07): 0 high, 1 medium.**
- NM-1: a terminal `/apply-next` could re-apply to a leftover queue copy → guard in `/apply-next` (R6 for the picked file, skip on identity, bytes or URL match) plus a harness test.
- Low: the backstop now covers any change away from `submitted`.

**Round 5 (2026-10-07): 0 high, 0 medium.** NM-1 confirmed fixed. One low folded in: D8 documents how to deliberately re-apply at the same URL.

Round 1 lows L1–L7 are folded in: compromised flag and ERELEASED, demo/e2e writers documented, gitignore (D11), manual check via harness, injected hooks, `ui-state` keys, and T8a using exported functions.
