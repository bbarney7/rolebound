/**
 * Client-owned reconnect driver for the `/api/events` SSE stream.
 *
 * Written for the failure reproduced on 2026-08-03: with the page open, killing
 * `dev:server` leaves Vite's proxy holding the browser's half of the connection
 * open. A real Chrome EventSource sat at `readyState === OPEN` for 40s after the
 * kill and fired `onerror` ZERO times, so the user agent never retried — an
 * `onerror`-driven reconnect would simply never have run. The liveness watchdog
 * below is the only mechanism that can observe that. `onerror` covers the
 * second, weaker failure: a retry issued while the backend is still down gets
 * Vite's `502 Bad Gateway` / `Content-Type: text/plain`, which trips the SSE
 * spec's fail-the-connection rule and closes the EventSource permanently.
 *
 * No React import, and no DOM global is touched at module-evaluation time, so
 * this module imports cleanly under vitest's default `environment: "node"`,
 * where `EventSource` does not exist.
 */

/** First backoff step. Doubles per attempt until `BACKOFF_CAP_MS`. */
export const BACKOFF_MS = 1_000;
/** Ceiling on the backoff step: 6 requests/minute against a long-down backend. */
export const BACKOFF_CAP_MS = 10_000;
/**
 * Liveness deadline, measured from the LAST OBSERVABLE FRAME — not from a fixed
 * schedule. Against the server's 25s heartbeat that means a heartbeat may arrive
 * up to 15s LATE (t=40 against an expected t=25) without triggering a reconnect.
 *
 * A heartbeat that is DROPPED ENTIRELY is a different case and is deliberately
 * NOT tolerated: with beats due at 25s and 50s, losing the one at 25s means the
 * deadline at t=40 expires 10s before the next beat is due, and the driver
 * reconnects. That is the intended behaviour — on a TCP stream that is genuinely
 * alive, a whole heartbeat does not go missing; something that swallowed it is
 * exactly the half-open condition this watchdog exists to catch. The cost of
 * being wrong is one workspace rescan.
 */
export const WATCHDOG_MS = 40_000;
/**
 * How long to wait for the server's `watching` frame before treating the stream
 * as ready anyway.
 *
 * The server arms its chokidar watcher AFTER the response heads are sent, and
 * says so in as many words: "before this, file events can be swallowed as part
 * of the scan" (events.ts:43-44). So a cold-start refresh issued the instant the
 * socket opens can read the workspace, miss a write that happens during the
 * scan, and never hear about it — the refresh was too early and the stream
 * swallowed it. Waiting for `watching` closes that hole.
 *
 * The grace timer exists so the wait is bounded. A server that never reports
 * `watching` (an older build, a watcher that fails to initialise) must not leave
 * the UI waiting forever for a frame that is not coming.
 */
export const READY_GRACE_MS = 5_000;

/**
 * Named server frames that prove the stream is alive. The unnamed `data:` frame
 * arrives on `onmessage` instead and is handled separately.
 *
 * `: ping\n\n` is deliberately absent: it is an SSE *comment*, and the
 * EventSource API surfaces no event of any kind for a comment frame (verified in
 * real Chrome). That is exactly why events.ts now emits a named `ping` alongside
 * it.
 */
const OBSERVABLE_EVENTS = ["connected", "watching", "ping"] as const;

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Opaque scheduler handle. The driver only ever hands it back to
 * `deps.clearTimeout` and never inspects it, so the concrete type belongs to
 * whoever supplied the scheduler: `ReturnType<typeof setTimeout>` for the
 * default deps (the idiom events.ts:48 uses), `number` for a test clock.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * The slice of the DOM `EventSource` this driver uses. Structural rather than
 * `EventSource` itself so a test can inject a fake under `environment: "node"`.
 */
export type EventSourceLike = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener: (type: string, listener: (ev: MessageEvent) => void) => void;
  close: () => void;
};

/** The injectable seam. Every default is resolved inside `connectSse`'s body. */
export type SseDeps = {
  createEventSource: (url: string) => EventSourceLike;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  random: () => number;
};

export type SseOptions = {
  url: string;
  /** Called once per distinct state; repeats are suppressed. */
  onState: (state: ConnectionState) => void;
  /** `file` is null when the frame's payload is not parseable JSON. */
  onChange: (file: string | null) => void;
  /**
   * The moment to issue a cold-start refresh — which is NOT `open`.
   *
   * `confirmed` says whether the server actually told us its watcher is armed
   * (`event: watching`) or whether READY_GRACE_MS simply expired. Both are
   * worth refreshing on; only the first is grounds for calling the result
   * current, because during chokidar's initial scan a write can be missed by
   * the refresh AND swallowed by the scan. May fire twice per connection: once
   * provisionally on grace, once confirmed if `watching` then arrives.
   */
  onReady?: (confirmed: boolean) => void;
};

/**
 * Equal jitter over an exponential schedule capped at `BACKOFF_CAP_MS`:
 * `d/2 + random() * d/2`. Exported so tests assert the real formula instead of a
 * copy: `random: () => 0` pins the schedule to 500/1000/2000/4000/5000ms and
 * `random: () => 1` to 1000/2000/4000/8000/10000ms.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const full = Math.min(BACKOFF_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return full / 2 + random() * (full / 2);
}

export function connectSse(options: SseOptions, deps: Partial<SseDeps> = {}): () => void {
  // Defaults live here, not at module scope: referencing `EventSource` at
  // module-evaluation time would throw on import under `environment: "node"`.
  // The two timer deps are renamed on destructure so the wrappers below can
  // still see the real globals.
  const {
    createEventSource = (url: string): EventSourceLike => new EventSource(url),
    setTimeout: schedule = (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms),
    clearTimeout: cancel = (handle: TimerHandle): void => clearTimeout(handle),
    random = Math.random,
  } = deps;

  let cancelled = false;
  let attempt = 0;
  let generation = 0;
  let state: ConnectionState | null = null;
  let source: EventSourceLike | null = null;
  let backoffTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;
  let readyTimer: TimerHandle | null = null;

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    options.onState(next);
  };

  const clearBackoff = () => {
    if (backoffTimer === null) return;
    cancel(backoffTimer);
    backoffTimer = null;
  };

  const clearWatchdog = () => {
    if (watchdogTimer === null) return;
    cancel(watchdogTimer);
    watchdogTimer = null;
  };

  const clearReady = () => {
    if (readyTimer === null) return;
    cancel(readyTimer);
    readyTimer = null;
  };

  /** (Re)arm the liveness deadline. Called on every observable frame. */
  const armWatchdog = () => {
    clearWatchdog();
    watchdogTimer = schedule(() => {
      watchdogTimer = null;
      if (cancelled) return;
      // MODE 1: the socket is still readyState OPEN and no `onerror` will ever
      // arrive. Nothing but this timer can see it.
      dropAndRetry();
    }, WATCHDOG_MS);
  };

  const teardownSource = () => {
    // Retire the generation HERE, not only in open(). Named listeners added with
    // addEventListener cannot be nulled, so `live()` is the only thing standing
    // between a queued frame from a socket we have finished with and
    // armWatchdog(). If the generation only advanced in open(), those listeners
    // would stay live for the whole backoff window and a late `ping` from the
    // dead socket would arm a watchdog during `reconnecting`, when the state
    // machine documents the watchdog as disarmed.
    //
    // Today that stray timer is harmless — BACKOFF_CAP_MS (10s) is strictly less
    // than WATCHDOG_MS (40s), so the next open() always clears it before it can
    // fire — but "harmless" here depends on a numeric coincidence between two
    // independent constants. Raising the backoff cap above the watchdog deadline
    // would silently turn it into a double reconnect. Retiring the generation
    // removes the dependency instead of documenting it.
    generation += 1;
    clearReady();
    const es = source;
    source = null;
    if (es === null) return;
    // Null the handlers BEFORE close(): a late callback from a socket we are
    // finished with must never schedule a timer.
    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.close();
  };

  const dropAndRetry = () => {
    teardownSource();
    clearWatchdog();
    clearBackoff();
    setState("reconnecting");
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    backoffTimer = schedule(() => {
      backoffTimer = null;
      if (cancelled) return;
      open();
    }, delay);
  };

  const open = () => {
    // Every callback below belongs to exactly one socket. A callback from a
    // superseded socket must do nothing, or a stale error schedules a second
    // backoff timer alongside the live one.
    const gen = ++generation;
    const live = () => !cancelled && gen === generation;

    // `watching` is CONFIRMED readiness; the grace timer is only a guess that the
    // frame is not coming. They are tracked separately and deliberately not
    // collapsed into one flag: if the grace timer wins the race and `watching`
    // then arrives anyway, the consumer must hear about it, because only the
    // frame proves the server's watcher is actually armed. So `watching` fires
    // onReady even after a grace announcement — at worst one extra refresh, and
    // that refresh is the only one that can be trusted.
    let announcedByGrace = false;
    let announcedByWatching = false;
    const announceReady = (via: "watching" | "grace") => {
      if (!live()) return;
      if (via === "watching") {
        if (announcedByWatching) return;
        announcedByWatching = true;
      } else {
        if (announcedByGrace || announcedByWatching) return;
        announcedByGrace = true;
      }
      clearReady();
      options.onReady?.(via === "watching");
    };

    const es = createEventSource(options.url);
    source = es;

    es.onopen = () => {
      if (!live()) return;
      attempt = 0;
      armWatchdog();
      // Arm the grace timer HERE, not at construction. Armed at construction it
      // measures connect time as well as watcher-startup time, so a connect
      // slower than READY_GRACE_MS announces readiness while the socket is still
      // CONNECTING — before there is any stream to be ready.
      clearReady();
      readyTimer = schedule(() => {
        readyTimer = null;
        announceReady("grace");
      }, READY_GRACE_MS);
      setState("open");
    };

    es.onmessage = (ev) => {
      if (!live()) return;
      armWatchdog();
      let file: string | null = null;
      try {
        file = (JSON.parse(ev.data) as { file?: string }).file ?? null;
      } catch {
        // ignore malformed event
      }
      options.onChange(file);
    };

    es.onerror = () => {
      if (!live()) return;
      // MODE 2: a retry made while the backend is down got Vite's 502
      // text/plain, so the UA has given up on this socket for good.
      dropAndRetry();
    };

    for (const name of OBSERVABLE_EVENTS) {
      es.addEventListener(name, () => {
        if (!live()) return;
        armWatchdog();
        // `watching` is the server saying its chokidar watcher is armed. Before
        // it, a write can be swallowed by the initial scan, so a refresh issued
        // any earlier can silently miss one.
        if (name === "watching") announceReady("watching");
      });
    }

    armWatchdog();
  };

  setState("connecting");
  open();

  return () => {
    if (cancelled) return;
    cancelled = true;
    clearBackoff();
    clearWatchdog();
    clearReady();
    teardownSource();
    setState("closed");
  };
}
