import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { isSafeSlug, paths } from "../workspace";
import { resolveApplyNextSlug } from "./applyStart";
import { createLineSplitter, type LineSplitter } from "./jsonl";
import { normalizeRpcEvent } from "./normalize";
import { normalizeSecrets, redactEvent, splitHoldback } from "./redact";
import { asSecretsReader, createSecretsReader, MIN_SECRET_LENGTH, type SecretsReader } from "./secrets";
import type { RunEvent, RunKind, RunLogEntry, RunStatus, RunSummary } from "../../shared/types";
import type { PreparedRun } from "../runConfig";
import { reconcileRowsForRunStart, reconcileWorkspace } from "../../../.pi/extensions/lib/reconcile";
import { parseRunPrepareError, readinessBlockerForRunKind, isRunStartRefusalCode } from "../runReadiness";
import { resolveQueueJob } from "../../../.pi/extensions/lib/queue-slug";
import { runStopMarkerPath } from "../../../.pi/extensions/lib/submission-policy";
import type { ProviderRuntime } from "../providers/hostDeps";

const execFileAsync = promisify(execFile);

/** proper-lockfile's staleness window, matching lock.ts:10. */
const STALE_MS = 10_000;
/** Entries kept per run. Beyond this the oldest are dropped and `firstSeq` moves. */
const LOG_CAP = 5000;
/** Bytes of the child's stderr kept to explain a failed exit. */
const STDERR_TAIL = 4096;
/** How long a SIGTERM has to work before SIGKILL, in abort() and finish(). */
const FORCE_KILL_MS = 5000;
/** ELOCKED re-read budget: the holder writes its metadata microseconds after locking. */
const LOCKED_READ_ATTEMPTS = 10;
const LOCKED_READ_INTERVAL_MS = 20;
const RUN_CREDENTIAL_UNREADABLE_MARKER = "[redacted: run credential file unreadable]";

/**
 * The events that END an assistant text block, and so must release whatever
 * `emit` is holding back before they are published. `text_end` is the real
 * terminator; `tool_start`, `status` (where `agent_settled` lands) and `exit`
 * are the safety net for a block pi never terminated.
 *
 * A `notify` or a `status_line` is deliberately NOT here: an extension can fire
 * one BETWEEN two deltas of the same block, and flushing on it would publish
 * the first half of a secret that the next delta completes.
 */
const ENDS_TEXT = new Set<RunEvent["type"]>(["text_end", "tool_start", "status", "exit"]);

/**
 * Everything the manager needs to spawn a run. ONE shape, used by production
 * and by tests alike, so the test seam cannot drift from the real options.
 *
 * `args` is always a FUNCTION of the session name, never a fixed array: the
 * manager is what decides a run's session name (`ui:<slug>`), so the argv
 * cannot be known before `start()`. Production passes
 * `(name) => piArgs(cfg, name)`; tests pass `() => [fakePiPath]`.
 *
 * `model` is reported in `RunSummary.model` and in run-manager.json. It is
 * carried separately rather than parsed back out of `args` because only the
 * caller knows which of those strings was the model.
 */
export interface RunManagerOptions {
  root: string;
  command: string;
  args: (sessionName: string) => string[];
  model: string;
  env?: NodeJS.ProcessEnv;
  /** Provider credentials and runtime capability used consistently by readiness and preparation. */
  providerRuntime?: ProviderRuntime;
  /** Turn-end fallback when pi never starts a turn (a slash command). */
  idleGraceMs?: number;
  /** Grace given to a polite shutdown before signals escalate. */
  killGraceMs?: number;
  /**
   * The values every emitted event is scrubbed of. Defaults to the workspace's
   * own credentials.json plus the two `GOOGLE_OAUTH_*` variables; a test
   * injects its own sentinels. Synchronous, and called per event — see
   * secrets.ts for why both of those are deliberate.
   */
  secrets?: SecretsReader | (() => readonly string[]);
  prepare?: (
    runId: string,
    sessionName: string,
    kind: RunKind,
    runtime: ProviderRuntime,
    continueFrom?: string,
  ) => Promise<PreparedRun>;
  applyGate?: (
    root: string,
    slug: string,
  ) => Promise<null | { code: string; message: string; retryAfterMs?: number }>;
}

export interface RunStartInput {
  kind: RunKind;
  slug?: string | null;
  slugs?: string[];
  message?: string;
  continueFrom?: string;
}

export type StartResult =
  | { ok: true; run: RunSummary }
  | { ok: false; code: "LOCKED"; runId: string | null }
  /**
   * A run that has ENDED whose pi is still on its way out. Distinct from
   * LOCKED because it is the one refusal that fixes itself: the route says so,
   * and the operator's next click succeeds. See `start()`.
   */
  | { ok: false; code: "SHUTTING_DOWN"; runId: string | null }
  | { ok: false; code: "SPAWN_FAILED"; message: string }
  | { ok: false; code: string; message: string; retryAfterMs?: number };

export type ActionResult =
  | { ok: true; run: RunSummary }
  | { ok: false; code: "NOT_ACTIVE"; message: string }
  | { ok: false; code: "NOT_FOUND"; message: string };

export interface RunUiAnswer {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * What run-manager.json holds. Written twice per start — once under the lock
 * before anything can fail, once with the real pid — and read by whoever loses
 * the lock race (to answer 409 with the right id) and by the next start (to
 * find an orphan left by a sidecar that was killed).
 */
interface RunMetadata {
  runId: string;
  pid: number | null;
  sessionName: string;
  kind: string;
  slug: string | null;
  model: string;
  startedAt: string;
  endedAt?: string;
}

/** Run behaviours; apply-next resolves to apply before spawning. */
type Behaviour = "chat" | "apply" | "gather" | "score" | "status";

function behaviourOf(kind: RunKind): Behaviour {
  // `apply-next` is resolved to a concrete slug by the route before it gets
  // here (AC 6), so it runs the apply behaviour under its own name.
  return kind === "apply-next" ? "apply" : kind;
}

export function maskUnreadableChildEvent(event: RunEvent): RunEvent {
  switch (event.type) {
    case "text":
      return { ...event, delta: RUN_CREDENTIAL_UNREADABLE_MARKER };
    case "tool_start":
      return {
        ...event,
        name: RUN_CREDENTIAL_UNREADABLE_MARKER,
        summary: RUN_CREDENTIAL_UNREADABLE_MARKER,
        args: RUN_CREDENTIAL_UNREADABLE_MARKER,
      };
    case "tool_end":
      return { ...event, result: RUN_CREDENTIAL_UNREADABLE_MARKER, details: undefined };
    case "notify":
      return { ...event, message: RUN_CREDENTIAL_UNREADABLE_MARKER };
    case "status_line":
      return {
        ...event,
        key: RUN_CREDENTIAL_UNREADABLE_MARKER,
        text: RUN_CREDENTIAL_UNREADABLE_MARKER,
      };
    case "ui_request":
      return {
        ...event,
        title: RUN_CREDENTIAL_UNREADABLE_MARKER,
        ...(event.message === undefined ? {} : { message: RUN_CREDENTIAL_UNREADABLE_MARKER }),
        ...(event.options === undefined
          ? {}
          : { options: event.options.map(() => RUN_CREDENTIAL_UNREADABLE_MARKER) }),
        ...(event.placeholder === undefined ? {} : { placeholder: RUN_CREDENTIAL_UNREADABLE_MARKER }),
        ...(event.prefill === undefined ? {} : { prefill: RUN_CREDENTIAL_UNREADABLE_MARKER }),
      };
    case "error":
      return { ...event, message: RUN_CREDENTIAL_UNREADABLE_MARKER };
    default:
      return event;
  }
}

/**
 * Owns exactly one pi child process per workspace.
 *
 * Three invariants hold the design together:
 *
 *   1. The proper-lockfile lock on `<root>/ui/run-manager.json` is taken BEFORE
 *      any metadata is written and held for the child's whole lifetime (D3).
 *      A lock says nothing about a file's contents, so writing first would let
 *      a second starter clobber the id it is about to be told to report.
 *   2. Every byte written to the child's stdin goes through `send()`, which
 *      refuses after exit and turns a broken pipe into an event instead of an
 *      exception. Nothing here throws because pi died.
 *   3. Status is a function of the protocol, never of the assistant's words
 *      (D2), and every transition is idempotent.
 */
export class RunManager {
  private readonly options: RunManagerOptions;
  private readonly idleGraceMs: number;
  private readonly killGraceMs: number;
  private readonly secrets: SecretsReader;
  private readonly readSecrets: () => readonly string[];
  private readonly providerRuntime: ProviderRuntime;
  private runAuthSecretPath: string | null = null;

  private run: RunSummary | null = null;
  private child: ChildProcess | null = null;
  private childExited = false;
  private splitter: LineSplitter | null = null;
  private release: (() => Promise<void>) | null = null;

  private log: RunLogEntry[] = [];
  private seqCounter = 0;
  private readonly listeners = new Set<(entry: RunLogEntry) => void>();

  /** Dialog ids pi is blocked on. Emptied by respondUi, abort and finish. */
  private readonly pendingUi = new Set<string>();

  private abortRequested = false;
  private finishRequested = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;

  private stderrTail = "";
  private stdinBlocked = false;
  private stdinQueue: string[] = [];
  /** A shutdown that arrived while stdin was backpressured. See `endStdin`. */
  private endAfterFlush = false;
  /**
   * The tail of the current assistant text block, unemitted because it could
   * be the first half of a secret pi is splitting across deltas. See `emit`.
   */
  private textHoldback = "";
  /**
   * True between `spawn()` and the resolution of the spawn/error race below.
   * While it is set, `start()` owns failure reporting: an ENOENT reaches BOTH
   * the child's `error` listener and that race, and `failStart` is the one that
   * knows how to unwind a start.
   */
  private spawnPending = false;
  /** `closeOut` in flight, so a start that lost its pi can let it finish first. */
  private closing: Promise<void> | null = null;
  /**
   * True from the spawn until `start()` returns. `closeOut` reads it to word an
   * exit as a startup failure — while it is set, closeOut is the ONLY reporter
   * of that failure, because everything after it runs without the lock.
   */
  private startPending = false;
  /**
   * `start()`'s pid write, still in the air. `closeOut` waits for it before
   * stamping the record: the stamp has to be the LAST write, and it is the only
   * one of the two that still happens under the lock.
   */
  private startWrite: Promise<void> | null = null;
  /** In-flight `writeMetadata` calls; drained on close-out and dispose. */
  private readonly metadataWrites = new Set<Promise<void>>();
  /**
   * Every secret value seen while `textHoldback` has been non-empty, kept until
   * it drains. credentials.json can be rewritten BETWEEN two deltas of one
   * block — `create_account` does exactly that — and the list that arrives with
   * the second half of a split password may no longer name the first. See
   * `secretsForText`.
   */
  private heldSecrets = new Set<string>();
  /** OTPs and verification links from `respondUi`, not present in workspace files. */
  private runScopedSecrets = new Set<string>();
  private prepared: PreparedRun | null = null;
  private runDir: string | null = null;
  private disposing = false;
  private disposal: Promise<void> | null = null;
  private pendingHandoff: { kind: "apply" | "apply-next"; slug: string | null } | null = null;
  private handoffProcessing = false;
  private cleanupError: unknown = null;
  private readonly starts = new Set<Promise<StartResult>>();

  constructor(options: RunManagerOptions) {
    this.options = options;
    this.idleGraceMs = options.idleGraceMs ?? 10_000;
    this.killGraceMs = options.killGraceMs ?? 3000;
    this.providerRuntime = options.providerRuntime ?? {
      env: options.env ?? process.env,
      nodeMajor: Number(process.versions.node.split(".")[0]) || 0,
    };
    this.secrets = asSecretsReader(
      options.secrets ?? createSecretsReader(options.root, this.providerRuntime.env),
    );
    this.readSecrets = () => this.secrets.read();
  }

  // ── Public surface ──────────────────────────────────────────────────────

  /** The current or most recent run. A finished run stays visible until the next start. */
  current(): RunSummary | null {
    return this.run ? { ...this.run } : null;
  }

  events(): RunLogEntry[] {
    return [...this.log];
  }

  /** Replay everything after `since`, then stream. Returns the unsubscribe. */
  subscribe(since: number, listener: (entry: RunLogEntry) => void): () => void {
    for (const entry of this.log) {
      if (entry.seq > since) listener(entry);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(input: RunStartInput): Promise<StartResult> {
    if (this.disposing) return Promise.resolve({ ok: false, code: "SHUTTING_DOWN", runId: this.run?.runId ?? null });
    const pending = this.startRun(input);
    this.starts.add(pending);
    const done = () => { this.starts.delete(pending); };
    void pending.then(done, done);
    return pending;
  }

  private writeStopMarker(reason: string): void {
    const runId = this.run?.runId;
    if (!runId) return;
    const file = this.runDir ? path.join(this.runDir, "stop.json") : runStopMarkerPath(this.options.root, runId);
    try {
      writeFileSync(
        file,
        `${JSON.stringify({ runId, reason, at: new Date().toISOString() })}\n`,
      );
    } catch (error) {
      this.emit({ type: "notify", level: "warning", message: `Could not write stop marker: ${error instanceof Error ? error.message : String(error)}` });
      try {
        rmSync(path.dirname(file), { recursive: true, force: true });
      } catch (removeError) {
        this.emit({ type: "notify", level: "warning", message: `Could not remove stopped run directory: ${removeError instanceof Error ? removeError.message : String(removeError)}` });
      }
    }
  }

  private async refuseApplyStart(
    prev: RunMetadata | null,
    metadata: RunMetadata,
    owner: string,
    refusal: { code: string; message: string; retryAfterMs?: number },
  ): Promise<StartResult> {
    if (this.run?.runId !== owner) {
      return { ok: false, code: refusal.code, message: refusal.message, retryAfterMs: refusal.retryAfterMs };
    }
    try {
      await this.cleanupPrepared(true);
    } finally {
      try {
        await this.writeMetadata(paths.runManager(this.options.root), {
          ...metadata,
          pid: null,
          endedAt: new Date().toISOString(),
        });
      } catch {
        // best effort
      }
      await this.releaseLock();
    }
    this.setStatus("stopped");
    return { ok: false, code: refusal.code, message: refusal.message, retryAfterMs: refusal.retryAfterMs };
  }

  private async cancelStart(prev?: RunMetadata | null, published?: RunMetadata): Promise<StartResult> {
    try {
      await this.cleanupPrepared(true);
    } finally {
      // Publishing a replacement record does not transfer an old child's
      // ownership. Preserve it for the next manager if shutdown interrupts reclaim.
      if (published && this.release) {
        await this.writeMetadata(paths.runManager(this.options.root), prev ?? {
          ...published, pid: null, endedAt: new Date().toISOString(),
        });
      }
      await this.releaseLock();
    }
    if (published && this.run?.runId === published.runId && this.isActive()) this.setStatus("stopped");
    return { ok: false, code: "SHUTTING_DOWN", runId: this.run?.runId ?? null };
  }

  private async startRun(input: RunStartInput): Promise<StartResult> {
    if (input.kind === "chat" && (typeof input.message !== "string" || !input.message.trim())) {
      return { ok: false, code: "BAD_MESSAGE", message: "message must be a non-empty string" };
    }
    // THE LIVE RUN IN THIS PROCESS WINS, and is consulted before the lock file
    // is touched at all. The lock is the CROSS-PROCESS guard and cannot be the
    // only one: `onCompromised` below drops `release` while the child is still
    // alive and running — a system sleep or a long event-loop stall is enough —
    // and from that moment `lockfile.lock()` here would be granted the stale
    // lock, reset the transcript out from under a live pi, and point
    // `reclaimOrphan` at this manager's own child. While this manager has a run
    // that has not ended, a second start is a 409 whatever the lock file says.
    const active = this.run;
    if (active && this.isActive()) return { ok: false, code: "LOCKED", runId: active.runId };

    // THE CHILD, NOT THE STATUS, IS THE AUTHORITY on whether a start may
    // proceed. `abort()` sets `stopped` the moment it asks pi to stop (D2:
    // status is a function of the protocol, and the operator is owed an
    // immediate answer), but the process is still exiting — it holds
    // `.browser-data` until it does, and its SIGTERM is still on a timer here.
    // A start let through in that window resets `child` and `clearTimers()`s
    // the kill away, leaving the old pi alive and racing the new one for the
    // same browser profile. It refuses for a few hundred milliseconds at most,
    // which is why the route words it as a retry rather than a conflict.
    if (this.child && !this.childExited) {
      return { ok: false, code: "SHUTTING_DOWN", runId: this.run?.runId ?? null };
    }
    if (this.prepared) {
      try {
        await this.cleanupPrepared(true);
      } catch (error) {
        return {
          ok: false,
          code: "SPAWN_FAILED",
          message: `Previous OAuth write-back is still pending: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const readinessBlocker = await readinessBlockerForRunKind(
      this.options.root,
      input.kind,
      input.slug ?? null,
      this.providerRuntime,
    );
    if (readinessBlocker) {
      return { ok: false, code: readinessBlocker.code, message: readinessBlocker.message };
    }

    const file = paths.runManager(this.options.root);
    // makeFixtureWorkspace does not create <root>/ui, and neither does a fresh
    // clone — uiState.ts:34 makes the same directory for the same reason.
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (this.disposing) return { ok: false, code: "SHUTTING_DOWN", runId: this.run?.runId ?? null };
    // proper-lockfile requires the target to exist. "wx" so an existing file is
    // never truncated: it holds the id a concurrent starter is about to report.
    await fs.writeFile(file, "{}", { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "EEXIST") throw err;
    });

    if (this.disposing) return { ok: false, code: "SHUTTING_DOWN", runId: this.run?.runId ?? null };
    try {
      this.release = await lockfile.lock(file, {
        stale: STALE_MS,
        retries: 0,
        onCompromised: (err) => {
          // proper-lockfile's DEFAULT onCompromised throws from a timer, which
          // in a long-held lock means an uncaught exception takes the whole
          // sidecar down mid-run. Record it in the transcript and keep going:
          // the run itself is unaffected, the in-memory guard at the top of
          // `start()` — not this lock — is what refuses a second run in THIS
          // sidecar while this one lives, and a start in a new sidecar finds a
          // stale lock it can reclaim.
          this.release = null;
          this.emit({ type: "error", message: `run lock compromised: ${err.message}` });
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ELOCKED") {
        return { ok: false, code: "LOCKED", runId: await this.readLockedRunId(file) };
      }
      throw err;
    }

    // THE VERY NEXT THING after the lock resolves, before any `ps` or kill:
    // publish this run's id. Everything below can take seconds, and every
    // ELOCKED reader in that window must already see the right id.
    if (this.disposing) return this.cancelStart();
    const prev = await this.readMetadata(file);
    if (this.disposing) return this.cancelStart();
    const behaviour = behaviourOf(input.kind);
    const slug = behaviour === "apply" ? (input.slug ?? null) : null;
    const sessionName = behaviour === "apply" ? `ui:${slug ?? "apply"}` : `ui:${behaviour}`;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const metadata: RunMetadata = {
      runId,
      pid: null,
      sessionName,
      kind: input.kind,
      slug,
      model: this.options.model,
      startedAt,
    };
    try {
      await this.writeMetadata(file, metadata);
    } catch (err) {
      await this.releaseLock();
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "SPAWN_FAILED", message };
    }
    if (this.disposing) return this.cancelStart(prev, metadata);

    // Reset per-run state, then publish `starting`. Done BEFORE the orphan
    // reclaim so the reclaim's warnings land in THIS run's transcript, which is
    // where the user will look for an explanation of what was killed.
    this.log = [];
    this.child = null;
    this.childExited = false;
    this.splitter = null;
    this.pendingUi.clear();
    this.abortRequested = false;
    this.finishRequested = false;
    this.stderrTail = "";
    this.stdinBlocked = false;
    this.stdinQueue = [];
    this.endAfterFlush = false;
    this.textHoldback = "";
    this.heldSecrets.clear();
    this.runScopedSecrets.clear();
    this.spawnPending = false;
    this.closing = null;
    this.startPending = false;
    this.startWrite = null;
    this.prepared = null;
    this.pendingHandoff = null;
    this.handoffProcessing = false;
    this.runDir = path.join(this.options.root, ".pi-jobs", "runs", runId);
    await fs.mkdir(this.runDir, { recursive: true, mode: 0o700 });
    this.clearTimers();
    this.run = {
      runId,
      kind: input.kind,
      slug,
      sessionName,
      model: this.options.model,
      status: "starting",
      startedAt,
      endedAt: null,
      pid: null,
      firstSeq: 0,
      lastSeq: 0,
    };
    this.emit({ type: "status", status: "starting", run: this.summary() });

    if (this.options.prepare) {
      try {
        this.prepared = await this.options.prepare(
          runId,
          sessionName,
          input.kind,
          this.providerRuntime,
          input.continueFrom,
        );
        if (this.disposing) return this.cancelStart(prev, metadata);
        const agentDir = this.prepared.env?.PI_CODING_AGENT_DIR;
        if (agentDir) {
          this.runAuthSecretPath = path.join(String(agentDir), "auth.json");
          this.secrets.addPath(this.runAuthSecretPath);
        }
        this.run.model = this.prepared.model;
        this.run.config = this.prepared.snapshot;
        metadata.model = this.prepared.model;
        await this.writeMetadata(file, metadata);
      } catch (error) {
        const parsed = parseRunPrepareError(error);
        if (parsed && isRunStartRefusalCode(parsed.code)) {
          try {
            await this.cleanupPrepared(true);
          } finally {
            if (this.release !== null) {
              try {
                await this.writeMetadata(
                  file,
                  prev ?? { ...metadata, pid: null, endedAt: new Date().toISOString() },
                );
              } catch {
                // best effort
              }
              await this.releaseLock();
            }
            this.run = null;
            this.log = [];
          }
          return { ok: false, code: parsed.code, message: parsed.message };
        }
        return this.failStart(error, file, prev, false, metadata, runId);
      }
    }

    if (this.disposing) return this.cancelStart(prev, metadata);
    const prevAlive = await this.reclaimOrphan(prev);
    if (this.disposing) return this.cancelStart(prev, metadata);

    try {
      const reconcileFindings = await reconcileWorkspace(this.options.root, {
        apply: true,
        rows: reconcileRowsForRunStart(),
        lockRetries: 0,
      });
      for (const finding of reconcileFindings) {
        this.emit({
          type: "notify",
          level: "warning",
          message: `reconcile ${finding.row}: ${finding.message}`,
        });
      }
    } catch (error) {
      this.emit({
        type: "notify",
        level: "warning",
        message: `reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (this.disposing) return this.cancelStart(prev, metadata);

    if (behaviour === "apply" && slug && this.options.applyGate) {
      const refusal = await this.options.applyGate(this.options.root, slug);
      if (refusal) return this.refuseApplyStart(prev, metadata, runId, refusal);
    }
    if (this.disposing) return this.cancelStart(prev, metadata);

    let child: ChildProcess;
    try {
      const spawnEnv: NodeJS.ProcessEnv = {
        ...(this.prepared?.env ?? this.options.env ?? process.env),
        ...(input.kind === "score" && input.slugs ? { PI_JOBS_SCORE_SLUGS: JSON.stringify(input.slugs) } : {}),
      };
      for (const key of ["PI_JOBS_RUN_ID", "PI_JOBS_RUN_DIR", "PI_JOBS_RUN_KIND", "PI_JOBS_APPLY_SLUG"]) {
        delete spawnEnv[key];
      }
      spawnEnv.PI_JOBS_RUN_ID = runId;
      spawnEnv.PI_JOBS_RUN_DIR = path.resolve(this.runDir!);
      spawnEnv.PI_JOBS_RUN_KIND = input.kind;
      if (behaviour === "apply" && slug) spawnEnv.PI_JOBS_APPLY_SLUG = slug;
      child = spawn(this.prepared?.command ?? this.options.command, this.prepared?.args ?? this.options.args(sessionName), {
        cwd: this.options.root,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Public terminal signals reach the server; it owns the run's shutdown.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return this.failStart(err, file, prev, prevAlive, metadata, runId);
    }

    // WIRED SYNCHRONOUSLY, BEFORE EVERY AWAIT BELOW. `exit` is emitted
    // asynchronously, and pi can die inside the window this function spends
    // awaiting — an unknown flag, an extension that throws at load — while the
    // sidecar's event loop is busy enough to make that window wide. An `exit`
    // emitted with no listener is GONE: the run would sit at `starting` with a
    // dead child, holding the lock, `childExited` never set, and every later
    // start refused as SHUTTING_DOWN by a process that is not there.
    //
    // Nothing here needs the `spawn` event: `spawn()` assigns `child.pid`
    // synchronously on success, and a failure to spawn owns the `error` path.
    this.child = child;
    this.run.pid = child.pid ?? null;
    this.spawnPending = true;
    this.startPending = true;
    // `runId` is the owner every handler is bound to: once another run starts,
    // this child's events are about a run that is over and must touch nothing.
    this.wireChild(child, runId);
    // THIS start's own view of THIS child, which `this.childExited` stops being
    // the moment a later run resets it. A start that resumes into someone
    // else's run must not read that run's liveness as its own.
    const own: { exit: { code: number | null; signal: NodeJS.Signals | null } | null } = {
      exit: null,
    };
    child.once("exit", (code, signal) => {
      own.exit = { code, signal };
    });

    try {
      // ENOENT for a missing binary arrives as an asynchronous `error`, not as
      // a throw, so a start is not "successful" until one of these two fires.
      // That `error` also reaches the listener wired just above, which is what
      // `spawnPending` holds off: failStart is the one that unwinds a start.
      const spawnError = await new Promise<Error | null>((resolve) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve(null);
        };
        const onError = (err: Error) => {
          child.off("spawn", onSpawn);
          resolve(err);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      this.spawnPending = false;
      if (spawnError) return await this.failStart(spawnError, file, prev, prevAlive, metadata, runId);
      if (own.exit || !this.startStillOwns(runId, child)) {
        return await this.startupExit(runId, own.exit);
      }

      // Tracked, so `closeOut` can let it land before it stamps the record.
      this.startWrite = this.writeMetadata(file, { ...metadata, pid: child.pid ?? null });
      await this.startWrite;
      // Again after the write, because that write is where a startup crash most
      // often lands: it is the only slow thing between spawn and prompt. And
      // nothing is awaited between here and `sendPrompt`, so a prompt can never
      // be written into a child this start does not own.
      if (own.exit || !this.startStillOwns(runId, child)) {
        return await this.startupExit(runId, own.exit);
      }

      this.sendPrompt(behaviour === "chat" ? input.message! : promptFor(behaviour, slug, this.options.root));
      return { ok: true, run: this.summary() };
    } finally {
      // Whatever happened, this start is no longer in flight — `closeOut` stops
      // wording a later exit as a startup failure.
      this.startPending = false;
    }
  }

  /**
   * pi died while `start()` was still awaiting — and `closeOut`, which ran with
   * the lock STILL HELD, has already done the entire unwind: the ended record,
   * the release, the `exit` and `error` events, the `failed` status. Its error
   * says "during startup" because `startPending` was set while it ran.
   *
   * So this waits for that to finish and answers the caller, and it writes
   * NOTHING. A second unwind here would run without the lock, which means a run
   * that started in the gap would have its fresh record overwritten by this
   * run's ended one and this run's error and `failed` status dropped into its
   * transcript. The one thing a lockless path may still do is return.
   */
  private async startupExit(
    owner: string,
    exit: { code: number | null; signal: NodeJS.Signals | null } | null,
  ): Promise<StartResult> {
    // Only OUR unwind is worth waiting for. If the manager has moved on, the
    // `closeOut` it is holding belongs to another run and is none of our
    // business — least of all something to block this answer on.
    if (this.run?.runId === owner && this.closing) await this.closing.catch(() => {});
    if (!exit) return { ok: false, code: "SPAWN_FAILED", message: "the run was replaced before it could start" };
    return {
      ok: false,
      code: "SPAWN_FAILED",
      message: `${exitDetail(exit.code, exit.signal)} during startup`,
    };
  }

  /**
   * Whether the start still awaiting is the run this manager is on.
   *
   * `this.child` and `this.childExited` describe the CURRENT run: a later start
   * resets both, so a start that compares against them is asking about someone
   * else's child. Its own `child` and `runId` are the only honest comparison.
   */
  private startStillOwns(owner: string, child: ChildProcess): boolean {
    return this.run?.runId === owner && this.child === child && !this.childExited;
  }

  /**
   * Send a message into the live session. `waiting` takes a plain prompt;
   * `running` must declare `streamingBehavior` or pi rejects it outright
   * (rpc.md: "If the agent is streaming and no streamingBehavior is specified,
   * the command returns an error").
   *
   * `starting` is refused rather than guessed at: the first prompt is in flight
   * and whether pi has accepted it yet is unknowable from here, so a plain
   * prompt might be rejected as already-streaming and a steer might be rejected
   * as not-streaming. The client disables the reply box in `starting`.
   */
  reply(message: string): ActionResult {
    if (!this.run) return { ok: false, code: "NOT_FOUND", message: "run not found" };
    const status = this.run.status;
    if (status === "starting") {
      return { ok: false, code: "NOT_ACTIVE", message: "run is still starting" };
    }
    if (status !== "running" && status !== "waiting") {
      return { ok: false, code: "NOT_ACTIVE", message: `run is ${status}` };
    }
    const command =
      status === "running"
        ? { type: "prompt", message, streamingBehavior: "steer" }
        : { type: "prompt", message };
    if (!this.send(command)) {
      return { ok: false, code: "NOT_ACTIVE", message: "the run process is gone" };
    }
    this.emit({ type: "user", message });
    return { ok: true, run: this.summary() };
  }

  /** Answer one pending extension dialog. Anything else is NOT_FOUND (AC 4). */
  respondUi(answer: RunUiAnswer): ActionResult {
    if (!this.run) return { ok: false, code: "NOT_FOUND", message: "run not found" };
    if (!this.pendingUi.has(answer.id)) {
      return { ok: false, code: "NOT_FOUND", message: "no pending request with that id" };
    }
    const response: Record<string, unknown> = { type: "extension_ui_response", id: answer.id };
    if (answer.cancelled) response.cancelled = true;
    else if (typeof answer.confirmed === "boolean") response.confirmed = answer.confirmed;
    else if (typeof answer.value === "string") {
      response.value = answer.value;
      if (answer.value.length >= MIN_SECRET_LENGTH) this.runScopedSecrets.add(answer.value);
      const trimmed = answer.value.trim();
      if (trimmed !== answer.value && trimmed.length >= MIN_SECRET_LENGTH) this.runScopedSecrets.add(trimmed);
    } else response.cancelled = true;
    if (!this.send(response)) {
      return { ok: false, code: "NOT_ACTIVE", message: "the run process is gone" };
    }
    this.pendingUi.delete(answer.id);
    this.emit({ type: "ui_resolved", id: answer.id });
    return { ok: true, run: this.summary() };
  }

  abort(): ActionResult {
    if (!this.run) return { ok: false, code: "NOT_FOUND", message: "run not found" };
    if (!this.isActive()) return { ok: false, code: "NOT_ACTIVE", message: `run is ${this.run.status}` };
    this.writeStopMarker("abort");
    // Set first: the stdin `error` handler must not read the EPIPE that
    // follows our own shutdown as a failure.
    this.abortRequested = true;
    // Before the cancellations, so a half-written sentence is the last thing
    // the operator sees of the turn they stopped, not the first thing after it.
    this.flushText();
    this.cancelPendingDialogs();
    this.send({ type: "abort" });
    this.endStdin();
    this.setStatus("stopped");
    this.armKill();
    return { ok: true, run: this.summary() };
  }

  /**
   * Release a settled run. Ending stdin is enough — verified live on
   * 2026-08-27, pi exits 0 immediately — and the SIGTERM below is the fallback
   * for a build that does not.
   */
  async finish(): Promise<ActionResult> {
    if (!this.run) return { ok: false, code: "NOT_FOUND", message: "run not found" };
    if (this.run.status !== "waiting") {
      return { ok: false, code: "NOT_ACTIVE", message: `run is ${this.run.status}` };
    }
    this.writeStopMarker("finish");
    this.finishRequested = true;
    this.flushText();
    this.cancelPendingDialogs();
    this.endStdin();
    this.armKill();
    const child = this.child;
    if (child && !this.childExited) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
    if (this.closing) await this.closing;
    await this.drainMetadataWrites();
    return { ok: true, run: this.summary() };
  }

  /** Fence pending starts, then wait for the owned child before releasing state. */
  dispose(): Promise<void> {
    this.disposing = true;
    if (!this.disposal) this.disposal = this.disposeOwned();
    return this.disposal;
  }

  private async disposeOwned(): Promise<void> {
    this.writeStopMarker("dispose");
    const starts = await Promise.allSettled([...this.starts]);
    const startError = starts.find((result): result is PromiseRejectedResult => result.status === "rejected");
    this.clearTimers();
    const child = this.child;
    let forced = false;
    let runExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    if (child && !this.childExited) {
      // Register before sending the signal; retain the lock until exit/closeOut.
      let forceTimer: ReturnType<typeof setTimeout>;
      let deadline: ReturnType<typeof setTimeout>;
      const exited = new Promise<void>((resolve, reject) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => { runExit = { code, signal }; clearTimeout(forceTimer); clearTimeout(deadline); resolve(); };
        child.once("exit", onExit);
        forceTimer = setTimeout(() => {
          forced = true;
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              child.off("exit", onExit);
              reject(error);
              return;
            }
          }
          deadline = setTimeout(() => {
            child.off("exit", onExit);
            reject(new Error("owned run child did not exit after SIGKILL"));
          }, FORCE_KILL_MS);
        }, this.killGraceMs);
      });
      this.abortRequested = true;
      child.kill("SIGTERM");
      await exited;
    }
    if (this.closing) await this.closing;
    await this.drainMetadataWrites();
    await this.cleanupPrepared(true);
    await this.releaseLock();
    if (startError) throw startError.reason;
    if (this.cleanupError) throw this.cleanupError;
    if (forced) throw new Error("owned run child required SIGKILL during shutdown");
    const outcome = runExit as { code: number | null; signal: NodeJS.Signals | null } | null;
    // Pi 1.0.4 reports its completed SIGTERM cleanup as the conventional 143.
    // A just-spawned child may not have installed its signal handler yet;
    // parent-owned state is still cleaned after this requested SIGTERM exit.
    if (outcome && ((outcome.signal && outcome.signal !== "SIGTERM") ||
      (!outcome.signal && outcome.code !== 0 && outcome.code !== 143))) {
      throw new Error(`run child failed during shutdown: ${exitDetail(outcome.code, outcome.signal)}`);
    }
  }

  /**
   * What can be done from `process.on("exit")`, where nothing asynchronous
   * runs. Best effort by definition — an orphaned lock goes stale in 10s and
   * the next start reclaims it.
   */
  disposeSync(): void {
    this.clearTimers();
    if (this.child && !this.childExited) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      // Preserve the lock/recovery record while a child may still be alive.
      return;
    }
    if (!this.release) return;
    this.release = null;
    try {
      lockfile.unlockSync(paths.runManager(this.options.root));
    } catch {
      // not held, or already compromised
    }
  }

  // ── Child wiring ────────────────────────────────────────────────────────

  /**
   * Every handler below belongs to ONE run, named by `owner`.
   *
   * A child can outlive its run: it exits while `start()` is still unwinding,
   * or a later start replaces it. Its bytes, its errors and above all its exit
   * are then about a run that is over, and applying any of them to the run that
   * came after would corrupt it — `childExited` in particular describes the
   * CURRENT child, and setting it from a dead one's handler would tell the
   * liveness guard that a live pi is gone.
   */
  private wireChild(child: ChildProcess, owner: string): void {
    const splitter = createLineSplitter((line) => this.handleLine(line));
    this.splitter = splitter;
    const owns = () => this.run?.runId === owner && this.child === child;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!owns()) return;
      splitter.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!owns()) return;
      const text = this.runCredentialFileUnreadable()
        ? RUN_CREDENTIAL_UNREADABLE_MARKER
        : chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
    });

    // The one place a dead pipe is handled. Without it an EPIPE write is an
    // unhandled 'error' on the stream and takes the process down.
    child.stdin?.on("error", (err: Error) => {
      if (!owns()) return;
      this.emit({ type: "error", message: `stdin: ${err.message}` });
      if (this.isActive()) this.setStatus("failed");
    });

    child.on("error", (err: Error) => {
      if (!owns()) return;
      // A spawn failure reaches this listener AND the race in `start()`.
      // Reporting it here too would put the same error in the transcript twice,
      // and `failStart` is the only one of the two that unwinds the start.
      if (this.spawnPending) return;
      this.emit({ type: "error", message: err.message });
      if (this.isActive()) this.setStatus("failed");
    });

    child.on("exit", (code, signal) => {
      if (!owns()) return;
      this.childExited = true;
      this.clearTimers();
      // Kept rather than voided: a start still awaiting has to let this finish
      // before it answers its caller. See `startupExit`.
      this.closing = this.closeOut(code, signal, owner, child.pid ?? null);
    });
  }

  /**
   * Everything that must happen after the child is gone, in the one order that
   * keeps the two on-disk facts honest:
   *
   *   1. Stamp `endedAt` on the record WHILE THE LOCK IS STILL HELD. That stamp
   *      is what lets the next loser of a lock race tell the current holder's
   *      record from a finished one — without it, the id left behind by the
   *      previous run is indistinguishable from the id of the run that is
   *      actually holding the lock, and a 409 reports the wrong run.
   *   2. Release the lock BEFORE publishing the terminal status, so that "this
   *      run is over" and "another run may start" are one fact rather than two.
   *      A client that re-enables its start button on `done` would otherwise
   *      race the release and get a 409 for a run that has already exited.
   */
  private async closeOut(
    code: number | null,
    signal: NodeJS.Signals | null,
    owner: string,
    childPid: number | null,
  ): Promise<void> {
    if (this.run?.runId !== owner) return;
    const retainedSecretSnapshots = this.snapshotPreparedSecrets();
    const runCredentialUnreadableAtExit = this.runCredentialFileUnreadable();
    try {
      // The snapshots above must exist before held text is flushed and before
      // OAuth write-back can replace the workspace's starting credential.
      this.splitter?.end();
      this.emit({ type: "exit", code, signal });
      this.flushText();
      if (childPid && (this.abortRequested || this.finishRequested)) {
        await this.terminateOwnedProcessGroup(childPid);
      }
      // A start still in flight may have its pid write in the air. Let it land
      // first or the stamp below is the one that gets overwritten — and this is
      // the last moment the lock is still held to order the two.
      if (this.startWrite) await this.startWrite.catch(() => {});
      await this.markEnded(owner);
      await this.cleanupPrepared(false);
      await this.releaseLock();
      // RE-CHECKED, because releasing the lock is exactly what lets the next run
      // start: from here on the record, the transcript and the status may be its.
      if (this.run?.runId !== owner) return;
      const clean = code === 0 && !signal;
      if (this.abortRequested) {
        this.setStatus("stopped");
      } else if (this.finishRequested && clean) {
        this.setStatus("done");
      } else {
        const tail = runCredentialUnreadableAtExit ? "" : this.stderrTail.trim();
        const detail = exitDetail(code, signal);
        // While a start is still in flight this is the ONLY report of its
        // failure: `startupExit` answers the caller with the same sentence and
        // emits nothing, because everything it could do would be lockless.
        let message: string;
        if (this.startPending) {
          message = tail ? `${detail} during startup: ${tail}` : `${detail} during startup`;
        } else {
          message = tail || detail;
        }
        this.emit({ type: "error", message });
        this.setStatus("failed");
      }
      await this.drainMetadataWrites();
    } finally {
      for (const id of retainedSecretSnapshots) this.secrets.dropSnapshot(id);
    }
    this.runScopedSecrets.clear();
    this.heldSecrets.clear();
  }

  /** Only ever touches a record this manager still owns the lock on, and wrote. */
  private async markEnded(owner: string): Promise<void> {
    if (!this.release || this.run?.runId !== owner) return;
    const file = paths.runManager(this.options.root);
    try {
      const metadata = await this.readMetadata(file);
      if (!metadata || metadata.runId !== owner) return;
      await this.writeMetadata(file, {
        ...metadata,
        pid: null,
        endedAt: new Date().toISOString(),
      });
    } catch {
      // best effort: a stale record only costs a wrong id in a 409
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // stdout is protocol-only in RPC mode; anything else is a stray banner.
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;

    // Status machine first, so a transition is logged before the transcript
    // line that caused it.
    switch (event.type) {
      case "agent_start":
      case "message_start":
      case "tool_execution_start":
        this.clearIdleTimer();
        if (this.isActive()) this.setStatus("running");
        break;
      case "agent_settled":
        // Cancels the idle guard too: a fast turn must not be followed by a
        // second, spurious `waiting` when the timer fires.
        this.clearIdleTimer();
        if (this.isActive()) this.setStatus("waiting");
        break;
      case "response":
        if (event.command === "prompt" && event.success === false) {
          this.emitChild({ type: "error", message: `pi rejected the message: ${String(event.error ?? "")}` });
        }
        // A slash command answers `response` and never starts a turn, so this
        // is the only thing that returns the panel to `waiting` afterwards.
        if (event.command === "prompt" && (this.run?.status === "starting" || this.run?.status === "waiting")) {
          this.armIdleTimer();
        }
        break;
    }

    const normalized = normalizeRpcEvent(event);
    if (!normalized) return;
    if (normalized.type === "ui_request") this.pendingUi.add(normalized.id);
    this.emitChild(normalized);
  }

  // ── stdin ───────────────────────────────────────────────────────────────

  /**
   * The ONE path to the child's stdin. Returns false rather than throwing when
   * the pipe is gone, and queues behind a `drain` so a burst of small commands
   * cannot be reordered or dropped.
   */
  private send(command: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!this.child || this.childExited || !stdin || stdin.destroyed || stdin.writableEnded) {
      return false;
    }
    const line = `${JSON.stringify(command)}\n`;
    if (this.stdinBlocked) {
      this.stdinQueue.push(line);
      return true;
    }
    if (!stdin.write(line)) {
      this.stdinBlocked = true;
      stdin.once("drain", () => this.flushStdin());
    }
    return true;
  }

  private flushStdin(): void {
    this.stdinBlocked = false;
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.stdinQueue = [];
      this.endAfterFlush = false;
      return;
    }
    while (this.stdinQueue.length > 0) {
      const line = this.stdinQueue.shift() as string;
      if (!stdin.write(line)) {
        this.stdinBlocked = true;
        stdin.once("drain", () => this.flushStdin());
        return;
      }
    }
    if (this.endAfterFlush) {
      this.endAfterFlush = false;
      this.endStdin();
    }
  }

  private sendPrompt(message: string): void {
    if (!this.send({ type: "prompt", message })) return;
    this.emit({ type: "user", message });
  }

  /**
   * Close the child's stdin — but never ahead of what is still queued for it.
   *
   * `abort()` and `finish()` cancel every pending dialog and then end the
   * pipe. If a write had gone into backpressure, those cancellations are
   * sitting in `stdinQueue`, and ending here would set `writableEnded`, which
   * is exactly what makes the next `flushStdin()` throw the queue away: pi
   * would never receive the cancellation and its extension would wait on a
   * promise nothing can settle. So a shutdown under backpressure only arms the
   * flag, and `flushStdin` ends the pipe once the queue is empty.
   *
   * The kill timers `abort()` and `finish()` arm are still the fallback, and
   * they are what bounds this: if the drain never comes, SIGTERM does.
   */
  private endStdin(): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    if (this.stdinBlocked || this.stdinQueue.length > 0) {
      this.endAfterFlush = true;
      return;
    }
    try {
      stdin.end();
    } catch {
      // a pipe that closed between the check and here
    }
  }

  /**
   * Cancel every dialog pi is blocked on, BEFORE stdin closes. A cancellation
   * written after the pipe is gone can never be delivered, and the extension's
   * awaiting promise would then hang until the process is killed.
   */
  private cancelPendingDialogs(): void {
    for (const id of [...this.pendingUi]) {
      this.send({ type: "extension_ui_response", id, cancelled: true });
      this.pendingUi.delete(id);
      this.emit({ type: "ui_resolved", id });
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  private isActive(): boolean {
    const status = this.run?.status;
    return status === "starting" || status === "running" || status === "waiting";
  }

  private setStatus(next: RunStatus): void {
    if (!this.run || this.run.status === next) return;
    this.run.status = next;
    if (next === "done" || next === "stopped" || next === "failed") {
      this.run.endedAt = this.run.endedAt ?? new Date().toISOString();
    }
    this.emit({ type: "status", status: next, run: this.summary() });
    if (next === "waiting" && this.pendingHandoff && this.run.kind === "chat") {
      void this.processPendingHandoff();
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isActive()) this.setStatus("waiting");
    }, this.idleGraceMs);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armKill(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    const pid = this.child?.pid ?? null;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!pid) return;
      this.signalOwnedProcessGroup(pid, "SIGTERM");
      this.forceTimer = setTimeout(() => {
        this.forceTimer = null;
        if (process.platform !== "win32") {
          if (isProcessGroupAlive(pid)) this.signalOwnedProcessGroup(pid, "SIGKILL");
        } else if (this.child && !this.childExited) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, FORCE_KILL_MS);
    }, this.killGraceMs);
  }

  /** SIGTERM/SIGKILL the detached run group (PJR-21: only our spawned child's pid). */
  private signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      if (this.child && !this.childExited) {
        try {
          this.child.kill(signal);
        } catch {
          // already gone
        }
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async terminateOwnedProcessGroup(pid: number): Promise<void> {
    if (process.platform === "win32") return;
    if (!isProcessGroupAlive(pid)) return;
    this.signalOwnedProcessGroup(pid, "SIGTERM");
    if (!isProcessGroupAlive(pid)) return;
    const deadline = Date.now() + this.killGraceMs;
    while (Date.now() < deadline) {
      if (!isProcessGroupAlive(pid)) return;
      await delay(100);
    }
    if (isProcessGroupAlive(pid)) this.signalOwnedProcessGroup(pid, "SIGKILL");
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.killTimer = null;
    this.forceTimer = null;
  }

  // ── Log ─────────────────────────────────────────────────────────────────

  private summary(): RunSummary {
    return { ...(this.run as RunSummary) };
  }

  /**
   * The one door into the log and the one door onto the wire — which is why
   * redaction lives here rather than in the normalizer or the routes. Nothing
   * that skips this function can reach a client, and nothing that goes through
   * it keeps a secret (redact.ts).
   *
   * A `text` delta is the one event that cannot be redacted on its own: pi may
   * split a password across two of them. Whatever tail of the block could still
   * be the start of a secret is held back here (`splitHoldback`) and released
   * by the next delta, or by `flushText` when the block ends.
   */
  private emit(event: RunEvent): void {
    if (event.type === "text") {
      const list = this.secretsForText();
      const split = splitHoldback(this.textHoldback + event.delta, list);
      this.textHoldback = split.holdback;
      // What is held back is half of a value from THIS list, so this list has
      // to outlive the credentials.json rewrite that may come before the delta
      // completing it. Once nothing is held, nothing needs remembering.
      if (split.holdback) for (const secret of list) this.heldSecrets.add(secret);
      else this.heldSecrets.clear();
      // Nothing left over the holdback is not an event: a delta that was only
      // the first half of a secret produces no transcript line of its own.
      if (split.emit) this.publish({ type: "text", delta: split.emit }, () => list);
      return;
    }
    // Held text goes out BEFORE the event that ended its block, so the
    // transcript keeps its order.
    if (ENDS_TEXT.has(event.type)) this.flushText();
    this.publish(event, () => this.redactSecrets());
  }

  private emitChild(event: RunEvent): void {
    if (event.type === "tool_end" && event.handoff && this.run?.kind === "chat" && !event.isError) {
      this.pendingHandoff = event.handoff;
    }
    this.emit(this.runCredentialFileUnreadable() ? maskUnreadableChildEvent(event) : event);
  }

  private async processPendingHandoff(): Promise<void> {
    if (this.handoffProcessing || !this.pendingHandoff || this.run?.kind !== "chat" || this.run.status !== "waiting") {
      return;
    }
    this.handoffProcessing = true;
    const handoff = this.pendingHandoff;
    this.pendingHandoff = null;
    const chatRun = this.run;
    try {
      const finishResult = await this.finish();
      if (!finishResult.ok) {
        chatRun.handoff = { error: finishResult.message };
        this.emit({ type: "status", status: chatRun.status, run: { ...chatRun } });
        return;
      }
      // Resolve the job the way POST /api/runs does; the manager expects a concrete slug.
      const slug = handoff.kind === "apply-next"
        ? await resolveApplyNextSlug(this.options.root)
        : handoff.slug && isSafeSlug(handoff.slug) ? resolveQueueJob(this.options.root, handoff.slug).slug : null;
      const startResult = slug
        ? await this.start({ kind: handoff.kind, slug })
        : { ok: false as const, code: "EMPTY_QUEUE", message: handoff.kind === "apply-next" ? "The queue is empty." : "That job is not in the queue." };
      if (startResult.ok) {
        chatRun.handoff = { runId: startResult.run.runId };
      } else {
        const message = "message" in startResult && typeof startResult.message === "string"
          ? startResult.message
          : startResult.code;
        chatRun.handoff = { error: message };
        this.emit({ type: "error", message });
      }
      this.emit({ type: "status", status: chatRun.status, run: { ...chatRun } });
    } finally {
      this.handoffProcessing = false;
    }
  }

  private runCredentialFileUnreadable(): boolean {
    return this.runAuthSecretPath !== null && this.secrets.isPathUnreadable(this.runAuthSecretPath);
  }

  /**
   * Release the held tail of a text block, redacted like any other delta. It is
   * emitted verbatim when it never completed a secret, which is the whole point
   * of holding back only what could still become one.
   */
  private flushText(): void {
    if (!this.textHoldback) return;
    const held = this.textHoldback;
    const list = this.secretsForText();
    this.textHoldback = "";
    this.heldSecrets.clear();
    this.publish({ type: "text", delta: held }, () => list);
  }

  /**
   * The secrets a text delta is measured and redacted against: the current list
   * plus every list seen since the holdback became non-empty.
   *
   * Without the union, a password rewritten out of credentials.json between the
   * delta carrying `OLDSE…` and the one carrying `…CRET-12345` would be held
   * back under the old list and released under the new one — which does not
   * name it — and the assembled `OLDSECRET-12345` would go out in plaintext.
   * A run only ever holds one block's worth, and the set is dropped as soon as
   * the holdback drains.
   */
  private redactSecrets(): readonly string[] {
    const current = normalizeSecrets([...this.readSecrets(), ...this.runScopedSecrets]);
    if (this.heldSecrets.size === 0) return current;
    return normalizeSecrets([...current, ...this.heldSecrets]);
  }

  private secretsForText(): readonly string[] {
    return this.redactSecrets();
  }

  private publish(event: RunEvent, secrets: () => readonly string[]): void {
    const seq = ++this.seqCounter;
    const entry = { ...redactEvent(event, secrets), seq } as RunLogEntry;
    if (this.run) {
      this.run.lastSeq = seq;
      if (this.run.firstSeq === 0) this.run.firstSeq = seq;
    }
    this.log.push(entry);
    if (this.log.length > LOG_CAP) {
      this.log.splice(0, this.log.length - LOG_CAP);
      if (this.run) this.run.firstSeq = this.log[0].seq;
    }
    // Filled after the cap so the embedded summary's firstSeq is the one a
    // client would actually be able to replay from.
    if (entry.type === "status" && this.run) entry.run = this.summary();
    for (const listener of this.listeners) listener(entry);
  }

  // ── run-manager.json ────────────────────────────────────────────────────

  private async readMetadata(file: string): Promise<RunMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Partial<RunMetadata>;
      return typeof record.runId === "string" ? (record as RunMetadata) : null;
    } catch {
      return null;
    }
  }

  private drainMetadataWrites(): Promise<void> {
    const pending = [...this.metadataWrites];
    if (pending.length === 0) return Promise.resolve();
    return Promise.allSettled(pending).then(() => {
      if (this.metadataWrites.size > 0) return this.drainMetadataWrites();
    });
  }

  private writeMetadata(file: string, metadata: RunMetadata): Promise<void> {
    const work = (async () => {
      const { atomicWriteFile } = await import("../../../.pi/extensions/lib/durable-store");
      await atomicWriteFile(file, `${JSON.stringify(metadata, null, 2)}\n`);
    })();
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    this.metadataWrites.add(tracked);
    void tracked.finally(() => {
      this.metadataWrites.delete(tracked);
    });
    return work;
  }

  /**
   * The id to put in a 409, and it must be the id of the run that is actually
   * holding the lock.
   *
   * Two things can be in the file when a loser reads it, and neither is the
   * answer: `{}` on a workspace whose first two runs raced, and the record of
   * an EARLIER run that has since exited. The first is why this re-reads at
   * all — the holder writes its metadata microseconds after `lock()` resolves.
   * The second is why `endedAt` is skipped: a finished record carries a real,
   * plausible runId, and reporting it would name a run that is not the reason
   * this start was refused.
   */
  private async readLockedRunId(file: string): Promise<string | null> {
    for (let attempt = 0; attempt < LOCKED_READ_ATTEMPTS; attempt += 1) {
      const metadata = await this.readMetadata(file);
      if (metadata?.runId && !metadata.endedAt) return metadata.runId;
      await delay(LOCKED_READ_INTERVAL_MS);
    }
    return null;
  }

  // ── Orphans ─────────────────────────────────────────────────────────────

  /**
   * A stale lock means the sidecar that held it died without cleaning up, and
   * its pi child may still be running against this workspace — holding the
   * browser profile that the new run needs.
   *
   * Killing a recorded pid is only safe with PROOF that it is ours, so the pid
   * is signalled only when `ps` shows a command line carrying both `--mode rpc`
   * and the recorded session name. A mismatch, a missing `ps`, or any error at
   * all leaves the process alone and says so in the transcript: never kill on
   * absent evidence.
   *
   * NEVER THROWS. A previous run's corpse must not be able to fail a start.
   *
   * @returns whether the recorded pid is still alive afterwards, which decides
   *   whether a failed start must restore the previous metadata verbatim.
   */
  private async reclaimOrphan(prev: RunMetadata | null): Promise<boolean> {
    const pid = prev?.pid ?? null;
    if (!prev || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      if (!isAlive(pid)) return false;
      const commandLine = await psCommand(pid);
      const sessionName = typeof prev.sessionName === "string" ? prev.sessionName : "";
      const ours =
        commandLine.includes("--mode rpc") && sessionName.length > 0 && commandLine.includes(sessionName);
      if (!ours) {
        this.emit({
          type: "notify",
          level: "warning",
          message: `run-manager.json named pid ${pid}, which is not a pi run — left alone`,
        });
        return isAlive(pid);
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // exited between the liveness check and here
      }
      if (!(await waitForExit(pid, this.killGraceMs))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // exited under the SIGTERM after all
        }
        await waitForExit(pid, FORCE_KILL_MS);
      }
      // SIGKILL is not a guarantee: the pid may be someone else's (EPERM, which
      // `isAlive` counts as alive) or wedged in an uninterruptible state. Say
      // which of the two happened — "stopped" over a process still holding this
      // workspace's browser profile is the one message that would send the
      // reader looking in the wrong place.
      const stillAlive = isAlive(pid);
      this.emit({
        type: "notify",
        level: "warning",
        message: stillAlive
          ? `could not stop orphaned run ${prev.runId} (pid ${pid}) — left alive`
          : `stopped orphaned run ${prev.runId} (pid ${pid})`,
      });
      return stillAlive;
    } catch (err) {
      this.emit({
        type: "notify",
        level: "warning",
        message: `run-manager.json named pid ${pid}, which is not a pi run — left alone (${
          err instanceof Error ? err.message : String(err)
        })`,
      });
      try {
        return isAlive(pid);
      } catch {
        return false;
      }
    }
  }

  // ── Failure ─────────────────────────────────────────────────────────────

  /**
   * The lock is held and there is no child. Two things must be true when this
   * returns: the lock is released (it must never outlive a process-less run),
   * and the file still points at a live orphan if there is one — that record is
   * the only handle the next start has on it.
   */
  private async failStart(
    err: unknown,
    file: string,
    prev: RunMetadata | null,
    prevAlive: boolean,
    metadata: RunMetadata,
    owner: string,
  ): Promise<StartResult> {
    const message = err instanceof Error ? err.message : String(err);
    // Everything below writes this run's record, its transcript and its status.
    // If another run has started since, none of that is ours to write any more
    // and the answer to our own caller is all that is left to give. Reachable
    // only in theory today — every caller still holds the lock — but this is
    // the guard that keeps it that way.
    if (this.run?.runId !== owner) return { ok: false, code: "SPAWN_FAILED", message };
    this.child = null;
    try {
      if (prevAlive && prev) {
        await this.writeMetadata(file, prev);
      } else {
        await this.writeMetadata(file, { ...metadata, pid: null, endedAt: new Date().toISOString() });
      }
    } catch {
      // best effort — the lock release below matters more
    }
    await this.releaseLock();
    const retainedSecretSnapshots = this.snapshotPreparedSecrets();
    try {
      await this.cleanupPrepared(false);
      this.emit({ type: "error", message });
      this.setStatus("failed");
    } finally {
      for (const id of retainedSecretSnapshots) this.secrets.dropSnapshot(id);
    }
    const parsed = parseRunPrepareError(err);
    if (parsed && isRunStartRefusalCode(parsed.code)) {
      return { ok: false, code: parsed.code, message: parsed.message };
    }
    return { ok: false, code: "SPAWN_FAILED", message };
  }

  private async releaseLock(): Promise<void> {
    const release = this.release;
    this.release = null;
    if (!release) return;
    try {
      await release();
    } catch {
      // already released, or compromised and reported as an error event
    }
  }

  /**
   * Freeze both credential generations before `beforeCleanup` can write the
   * rotated one back over the workspace's starting OAuth credential.
   */
  private snapshotPreparedSecrets(): string[] {
    const retained: string[] = [];
    const prepared = this.prepared;
    if (!prepared) return retained;
    if (this.runAuthSecretPath) {
      this.secrets.snapshotPath(this.runAuthSecretPath);
      retained.push(this.runAuthSecretPath);
    }
    const startedValues = prepared.oauthWriteBack?.flatMap(({ startedWith }) => [
      startedWith.access,
      startedWith.refresh,
    ]) ?? [];
    if (startedValues.length > 0) {
      const id = `${this.runAuthSecretPath ?? this.run?.runId ?? "prepared-run"}:started-oauth`;
      this.secrets.snapshotValues(id, startedValues);
      retained.push(id);
    }
    return retained;
  }

  private async cleanupPrepared(strict = false): Promise<void> {
    const prepared = this.prepared;
    if (prepared) {
      try {
        if (prepared.beforeCleanup) {
          try {
            await prepared.beforeCleanup();
          } catch (error) {
            this.emit({
              type: "notify",
              level: "warning",
              message: `OAuth write-back failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            this.cleanupError = error;
            if (strict) throw error;
            return;
          }
        }
        this.prepared = null;
        if (this.runAuthSecretPath) {
          this.secrets.removePath(this.runAuthSecretPath);
          this.runAuthSecretPath = null;
        }
        await prepared.cleanup();
        this.cleanupError = null;
      } catch (error) {
        this.cleanupError = error;
        if (strict) throw error;
      }
    }
  }
}

/**
 * How an exit is worded, in the transcript and in a failed start's answer.
 * One function so the sentence a caller is given and the sentence the panel
 * shows cannot drift apart.
 */
function exitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return `pi exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
}

/**
 * The first message of a run.
 *
 * `apply` sends the exact sentence `/apply-next` would have sent
 * (job-applier.ts:527), so a UI-started apply and a terminal-started one give
 * the agent identical instructions. `gather` and `status` are the extension
 * commands themselves — pi executes those immediately, without an LLM call.
 */
function promptFor(behaviour: Exclude<Behaviour, "chat">, slug: string | null, root: string): string {
  switch (behaviour) {
    case "apply":
      return `Apply to the next queued job: ${slug} (file: jobs/queue/${resolveQueueJob(root, slug!).filename}); use slug \`${slug}\` in tool calls`;
    case "gather":
      return "/gather";
    case "score":
      return "/score-discovered";
    case "status":
      return "/status";
  }
}

/** EPERM means it exists and is not ours to signal — still alive for our purposes. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function psCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
    timeout: 2000,
  });
  return stdout.trim();
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return !isAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
