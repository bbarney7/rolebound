import { describe, expect, it } from "vitest";
import {
  BACKOFF_CAP_MS,
  BACKOFF_MS,
  READY_GRACE_MS,
  WATCHDOG_MS,
  backoffDelay,
  connectSse,
} from "../sse";
import type { ConnectionState, EventSourceLike, SseDeps, TimerHandle } from "../sse";

/**
 * Deterministic scheduler. The driver never inspects a handle, so plain
 * incrementing numbers are legal `TimerHandle`s. Real timers are never used: the
 * mode-1 test has to cross a 40s deadline, and this suite has to finish inside
 * vitest's default 5s testTimeout.
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<TimerHandle, { fn: () => void; at: number }>();

  return {
    pending: () => scheduled.size,
    /** Deadlines of every armed timer, ascending, relative to "now". */
    delays: () => [...scheduled.values()].map((t) => t.at - now).sort((a, b) => a - b),
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      const id = nextId++;
      scheduled.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (handle: TimerHandle): void => {
      scheduled.delete(handle);
    },
    /** Advance `ms`, firing due timers in deadline order, including any armed en route. */
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        let dueId: TimerHandle | null = null;
        let dueAt = Infinity;
        for (const [id, t] of scheduled) {
          if (t.at <= target && t.at < dueAt) {
            dueId = id;
            dueAt = t.at;
          }
        }
        if (dueId === null) break;
        const due = scheduled.get(dueId)!;
        scheduled.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

class FakeEventSource implements EventSourceLike {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  /** Whether all three handlers were already null when close() was called. */
  handlersNulledBeforeClose: boolean | null = null;
  readonly named = new Map<string, Array<(ev: MessageEvent) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const existing = this.named.get(type);
    if (existing) existing.push(listener);
    else this.named.set(type, [listener]);
  }

  close(): void {
    this.handlersNulledBeforeClose =
      this.onopen === null && this.onmessage === null && this.onerror === null;
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }
  emitError(): void {
    this.onerror?.(new Event("error"));
  }
  emitData(payload: string): void {
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }
  emitNamed(type: string): void {
    for (const l of this.named.get(type) ?? []) l(new MessageEvent(type, { data: "{}" }));
  }
}

/** One rig per test: fake clock, fake sockets, recorded states and changes. */
function makeRig(random: () => number = () => 0) {
  const clock = makeClock();
  const sockets: FakeEventSource[] = [];
  const states: ConnectionState[] = [];
  const changes: Array<string | null> = [];
  let readyCount = 0;
  const readyKinds: boolean[] = [];

  const deps: SseDeps = {
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sockets.push(es);
      return es;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random,
  };

  const teardown = connectSse(
    {
      url: "/api/events",
      onState: (s) => states.push(s),
      onChange: (f) => changes.push(f),
      onReady: (confirmed) => {
        readyCount += 1;
        readyKinds.push(confirmed);
      },
    },
    deps,
  );

  return {
    clock,
    sockets,
    states,
    changes,
    teardown,
    ready: () => readyCount,
    readyKinds,
    latest: () => sockets[sockets.length - 1],
  };
}

describe("connectSse — mode 1 (half-open stream, the primary failure)", () => {
  it("reconnects on the watchdog deadline with zero onerror and zero frames", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    expect(rig.states).toEqual(["connecting", "open"]);

    // The exact shape of the reported bug: Chrome held readyState === OPEN for
    // 40s with no error and no data. Nothing is emitted here on purpose.
    rig.clock.advance(WATCHDOG_MS - 1);
    expect(rig.states).toEqual(["connecting", "open"]);

    rig.clock.advance(1);
    expect(rig.states).toEqual(["connecting", "open", "reconnecting"]);
    expect(rig.sockets[0].closed).toBe(true);

    // and it actually recovers once the backoff timer fires
    rig.clock.advance(backoffDelay(0, () => 0));
    expect(rig.sockets).toHaveLength(2);
    rig.latest().emitOpen();
    expect(rig.states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("fires the watchdog from connecting when a socket never opens", () => {
    const rig = makeRig();
    rig.clock.advance(WATCHDOG_MS);
    expect(rig.states).toEqual(["connecting", "reconnecting"]);
  });

  it.each([
    ["onopen", (es: FakeEventSource) => es.emitOpen()],
    ["named connected", (es: FakeEventSource) => es.emitNamed("connected")],
    ["named watching", (es: FakeEventSource) => es.emitNamed("watching")],
    ["named ping", (es: FakeEventSource) => es.emitNamed("ping")],
    ["unnamed data", (es: FakeEventSource) => es.emitData('{"file":"state.json"}')],
  ])("an observable %s frame rearms the watchdog", (_label, emit) => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.states.length = 0;

    rig.clock.advance(WATCHDOG_MS - 1);
    emit(rig.latest());
    rig.clock.advance(WATCHDOG_MS - 1);
    expect(rig.states).toEqual([]); // still open — the frame pushed the deadline out

    rig.clock.advance(1);
    expect(rig.states).toEqual(["reconnecting"]);
  });

  /**
   * The tests above cross the deadline in one jump, which proves the deadline
   * exists but says nothing about the cadence it will actually meet in
   * production. These two model the real 25s server heartbeat against the 40s
   * client deadline.
   *
   * 25_000 is `HEARTBEAT_MS` from `server/routes/events.ts`. It is written as a
   * literal rather than imported, because a client test importing server code
   * would be the only such edge in the repo. The two cannot drift silently: the
   * server suite asserts `HEARTBEAT_MS === 25_000`, so changing it there fails
   * that test and sends the author back here.
   */
  it("survives the real 25s/40s heartbeat cadence indefinitely", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.states.length = 0;

    for (let i = 0; i < 10; i++) {
      rig.clock.advance(25_000);
      rig.latest().emitNamed("ping");
    }

    // 250s of healthy stream: no reconnect, no second socket.
    expect(rig.states).toEqual([]);
    expect(rig.sockets).toHaveLength(1);
  });

  it("tolerates a heartbeat 15s late, but treats a dropped one as a dead stream", () => {
    // LATE: the beat due at 25s arrives at 39s — 14s late, inside the 15s of
    // slack the 40s deadline buys. No reconnect.
    const late = makeRig();
    late.latest().emitOpen();
    late.states.length = 0;
    late.clock.advance(WATCHDOG_MS - 1);
    late.latest().emitNamed("ping");
    late.clock.advance(1);
    expect(late.states).toEqual([]);

    // DROPPED: beat 1 lands at 25s, beat 2 (due 50s) never arrives. The deadline
    // runs from the LAST FRAME, so it expires at 65s — 15s after the missing
    // beat was due. Reconnecting here is the intended behaviour.
    const dropped = makeRig();
    dropped.latest().emitOpen();
    dropped.states.length = 0;
    dropped.clock.advance(25_000);
    dropped.latest().emitNamed("ping");
    expect(dropped.states).toEqual([]);
    dropped.clock.advance(WATCHDOG_MS);
    expect(dropped.states).toEqual(["reconnecting"]);
  });
});

describe("connectSse — mode 2 (onerror after a 502)", () => {
  it("reconnects on onerror and recovers when the backend returns", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitError();

    expect(rig.states).toEqual(["connecting", "open", "reconnecting"]);
    expect(rig.sockets[0].closed).toBe(true);

    rig.clock.advance(backoffDelay(0, () => 0));
    expect(rig.sockets).toHaveLength(2);
    rig.latest().emitOpen();
    expect(rig.states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("stays in reconnecting across repeated failures instead of flickering", () => {
    const rig = makeRig();
    rig.latest().emitError();
    for (let i = 0; i < 4; i++) {
      rig.clock.advance(BACKOFF_CAP_MS);
      rig.latest().emitError();
    }
    expect(rig.states).toEqual(["connecting", "reconnecting"]);
    expect(rig.sockets.length).toBe(5);
  });

  /**
   * Guards the generation bump inside `teardownSource`. Handlers assigned as
   * properties are nulled before close(), but listeners added with
   * addEventListener CANNOT be nulled — the generation check is the only thing
   * that stops a frame queued on the dead socket from arming a watchdog while
   * the driver is in `reconnecting` with a backoff pending.
   *
   * This asserts on the CLOCK, not on the state list, because the bug is
   * invisible in the state list: with BACKOFF_CAP_MS (10s) below WATCHDOG_MS
   * (40s), the stray watchdog is always cleared by the next open() before it can
   * fire, so the states come out identical either way. Counting armed timers is
   * what actually distinguishes the two implementations. Raising the backoff cap
   * above the watchdog deadline would turn the same latent defect into a live
   * double reconnect — this test fails first instead.
   */
  it("a frame from a retired socket cannot arm a watchdog during backoff", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    const retired = rig.latest();
    retired.emitError();

    expect(rig.states).toEqual(["connecting", "open", "reconnecting"]);
    // Exactly one armed timer, the backoff: dropAndRetry cleared the watchdog.
    expect(rig.clock.pending()).toBe(1);
    expect(rig.clock.delays()).toEqual([backoffDelay(0, () => 0)]);

    // A named frame queued on the dead socket lands after close().
    retired.emitNamed("ping");
    retired.emitNamed("watching");

    // Still exactly one timer, still the backoff — unchanged deadline.
    expect(rig.clock.pending()).toBe(1);
    expect(rig.clock.delays()).toEqual([backoffDelay(0, () => 0)]);
    expect(rig.states).toEqual(["connecting", "open", "reconnecting"]);
  });
});

/**
 * The cold-start refresh must not be issued at `open`. The server arms its
 * chokidar watcher only after the response heads are sent and documents that
 * file events can be swallowed by the initial scan until it emits `watching`
 * (events.ts:43-44). A refresh issued before that frame can read the workspace,
 * miss a write that lands during the scan, and never be told about it — which
 * would let the UI report "current" over data that is already wrong.
 */
describe("connectSse — readiness (onReady)", () => {
  it("does not fire on open alone — the watcher is not armed yet", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("connected");
    expect(rig.ready()).toBe(0);
  });

  it("fires when the server reports its watcher is armed", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(1);
  });

  it("fires exactly once even if watching repeats", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    rig.latest().emitNamed("watching");
    rig.clock.advance(READY_GRACE_MS * 2);
    expect(rig.ready()).toBe(1);
  });

  it("falls back to the grace deadline when watching never arrives", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.clock.advance(READY_GRACE_MS - 1);
    expect(rig.ready()).toBe(0);
    rig.clock.advance(1);
    expect(rig.ready()).toBe(1);
  });

  it("fires once per connection, so every reconnect gets its own cold start", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(1);

    rig.latest().emitError();
    rig.clock.advance(backoffDelay(0, () => 0));
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(2);
  });

  it("does not fire after teardown, and leaves no ready timer behind", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.teardown();
    rig.clock.advance(READY_GRACE_MS * 2);
    expect(rig.ready()).toBe(0);
    expect(rig.clock.pending()).toBe(0);
  });

  it("does not arm the grace timer until the socket actually opens", () => {
    // Armed at construction, the grace timer would be measuring connect time as
    // well as watcher-startup time: a connect slower than READY_GRACE_MS would
    // announce readiness while the socket was still CONNECTING, and — because
    // readiness is announced at most once per connection — permanently suppress
    // the real one. The consumer would then sit in `syncing…` forever.
    const rig = makeRig();
    expect(rig.clock.pending()).toBe(1); // watchdog only
    rig.clock.advance(READY_GRACE_MS * 2);
    expect(rig.ready()).toBe(0);
  });

  it("still reports readiness when watching arrives after the grace deadline", () => {
    // The grace timer is a guess that the frame is not coming. When the guess is
    // wrong, the frame is the only thing that actually proves the server's
    // watcher is armed, so it must not be swallowed — otherwise a chokidar scan
    // slower than 5s silently recreates the stale-snapshot race D14 exists to
    // close.
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.clock.advance(READY_GRACE_MS);
    expect(rig.ready()).toBe(1); // provisional, from the grace timer

    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(2); // confirmed, from the frame

    // ...and confirmation is still only ever announced once.
    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(2);
  });

  it("does not fire the grace timer once watching has already confirmed", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    expect(rig.ready()).toBe(1);
    rig.clock.advance(READY_GRACE_MS * 2);
    expect(rig.ready()).toBe(1);
  });

  it("reports watching-backed readiness as CONFIRMED", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitNamed("watching");
    expect(rig.readyKinds).toEqual([true]);
  });

  it("reports grace-timer readiness as PROVISIONAL, then confirms on watching", () => {
    // The distinction is load-bearing, not cosmetic. A provisional readiness
    // means the refresh is worth making but its result cannot be called
    // "current": during chokidar's initial scan a write is invisible to both
    // the refresh and the stream. App.tsx holds `syncing…` until the confirmed
    // one lands.
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.clock.advance(READY_GRACE_MS);
    expect(rig.readyKinds).toEqual([false]);

    rig.latest().emitNamed("watching");
    expect(rig.readyKinds).toEqual([false, true]);
  });

  it("does not fire from a socket the driver already retired", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    const retired = rig.latest();
    retired.emitError();
    retired.emitNamed("watching");
    expect(rig.ready()).toBe(0);
  });
});

describe("connectSse — backoff schedule", () => {
  it("is 500/1000/2000/4000/5000ms at the jitter floor", () => {
    const zero = () => 0;
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffDelay(a, zero))).toEqual([
      500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it("is 1000/2000/4000/8000/10000ms at the jitter ceiling", () => {
    const one = () => 1;
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffDelay(a, one))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it("never exceeds BACKOFF_CAP_MS and never drops below half the first step", () => {
    for (let a = 0; a < 40; a++) {
      const d = backoffDelay(a, () => 0.37);
      expect(d).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      expect(d).toBeGreaterThanOrEqual(BACKOFF_MS / 2);
    }
  });

  it("arms the real schedule between attempts, and the cap bounds it", () => {
    const rig = makeRig(() => 1);
    const armed: number[] = [];
    for (let i = 0; i < 6; i++) {
      rig.latest().emitError();
      armed.push(rig.clock.delays()[0]);
      rig.clock.advance(BACKOFF_CAP_MS);
    }
    expect(armed).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("resets the attempt counter after a successful open", () => {
    const rig = makeRig(() => 1);
    rig.latest().emitError();
    rig.clock.advance(BACKOFF_CAP_MS);
    rig.latest().emitError();
    expect(rig.clock.delays()[0]).toBe(2000);

    rig.clock.advance(BACKOFF_CAP_MS);
    rig.latest().emitOpen();
    rig.latest().emitError();
    expect(rig.clock.delays()[0]).toBe(1000);
  });
});

describe("connectSse — data frames", () => {
  it("reports the changed file and reports null for a malformed payload", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    rig.latest().emitData('{"file":"state.json","ts":"2026-08-04T00:00:00.000Z"}');
    rig.latest().emitData("not json");
    expect(rig.changes).toEqual(["state.json", null]);
  });
});

describe("connectSse — teardown (AC #4)", () => {
  it("clears both timers, nulls every handler before close, and reports closed", () => {
    const rig = makeRig();
    rig.latest().emitOpen();
    // Two timers while open-but-not-yet-ready: the liveness watchdog and the
    // ready-grace fallback. The grace timer is cleared by `watching`; here it is
    // still armed, which is exactly the state teardown has to cope with.
    expect(rig.clock.pending()).toBe(2);
    rig.latest().emitNamed("watching");
    expect(rig.clock.pending()).toBe(1); // grace timer retired by readiness

    rig.teardown();

    expect(rig.clock.pending()).toBe(0);
    expect(rig.sockets[0].closed).toBe(true);
    expect(rig.sockets[0].handlersNulledBeforeClose).toBe(true);
    expect(rig.states).toEqual(["connecting", "open", "closed"]);
  });

  it("clears the backoff timer when torn down mid-reconnect", () => {
    const rig = makeRig();
    rig.latest().emitError();
    expect(rig.clock.pending()).toBe(1); // backoff armed, watchdog disarmed

    rig.teardown();
    expect(rig.clock.pending()).toBe(0);

    rig.clock.advance(60_000);
    expect(rig.sockets).toHaveLength(1); // no orphan reconnect
  });

  it("swallows a late named-event callback from a socket it already closed", () => {
    const rig = makeRig();
    const first = rig.latest();
    first.emitOpen();
    rig.teardown();

    first.emitNamed("ping");
    first.emitData('{"file":"late.json"}');

    expect(rig.clock.pending()).toBe(0);
    expect(rig.changes).toEqual([]);
    expect(rig.states).toEqual(["connecting", "open", "closed"]);
  });

  it("is idempotent — a second teardown is a no-op", () => {
    const rig = makeRig();
    rig.teardown();
    rig.teardown();
    expect(rig.states).toEqual(["connecting", "closed"]);
    expect(rig.clock.pending()).toBe(0);
  });

  it("leaves no orphan timer or socket across StrictMode connect/teardown/connect", () => {
    const clock = makeClock();
    const sockets: FakeEventSource[] = [];
    const deps: SseDeps = {
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        sockets.push(es);
        return es;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0,
    };
    const opts = { url: "/api/events", onState: () => {}, onChange: () => {} };

    const first = connectSse(opts, deps);
    first();
    const second = connectSse(opts, deps);

    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].closed).toBe(false);
    // Exactly one timer: the live socket's watchdog. Neither socket has opened,
    // so no ready-grace timer exists yet (it is armed in onopen, not at
    // construction). The torn down socket contributed nothing, which is the
    // orphan this test exists to catch.
    expect(clock.pending()).toBe(1);

    second();
    expect(clock.pending()).toBe(0);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
});

describe("connectSse — exported constants pin the stated time budget (AC #3)", () => {
  it("holds the documented values", () => {
    expect(BACKOFF_MS).toBe(1_000);
    expect(BACKOFF_CAP_MS).toBe(10_000);
    expect(WATCHDOG_MS).toBe(40_000);
    expect(READY_GRACE_MS).toBe(5_000);
  });
});
