import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace, seedRunsApplyReady, SENTINEL_PASSWORD } from "./helpers";
import { createApp } from "../app";
import { readApplicationSettings } from "../applicationConfigStore";
import { prepareAgentRun } from "../runConfig";
import { modifyAuthFile } from "../providers/authStoreFile";
import { providerAlias, readAuth, removeConnection, setModelRuntimeFactoryForTests, updateConnection, updateSelections } from "../providers/providerService";
import type { RunCurrentPayload, RunLogEntry, RunStatus, RunSummary } from "../../shared/types";
import type { RunManagerOptions } from "../runs/runManager";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakePi.mjs");
const TIMEOUT = 15_000;

/** run-manager metadata is written via atomic rename; stall that step like the old writeFile spy. */
function spyStallRunManagerPidRename(delayMs: number, onlyFirstRunId?: { value: string | null }) {
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (src, dst, ...rest) => {
    const dstStr = String(dst);
    if (dstStr.endsWith(`${path.sep}run-manager.json`)) {
      const content = await fs.readFile(String(src), "utf8");
      const runId = (JSON.parse(content) as { runId?: string }).runId ?? null;
      if (onlyFirstRunId && onlyFirstRunId.value === null) onlyFirstRunId.value = runId;
      const matchesRun =
        onlyFirstRunId === undefined || runId === onlyFirstRunId.value;
      if (matchesRun && /"pid":\s*\d+/.test(content)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return rename(src, dst, ...rest);
  });
}

interface Ctx {
  root: string;
  app: ReturnType<typeof createApp>;
  server: Server;
  base: string;
}

const open: Ctx[] = [];
const fixtureRoots = new Set<string>();
const strays: ChildProcess[] = [];
const grandchildPids: number[] = [];

function trackGrandchildPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) grandchildPids.push(pid);
}

function killGrandchildPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * One app per test. Booting is a mkdtemp plus a handful of small writes, and
 * per-test isolation is what lets the lock, orphan and spawn-failure cases run
 * in any order without leaking a held lock into the next test.
 */
async function boot(
  overrides: Partial<RunManagerOptions> & { heartbeatMs?: number } = {},
  existingRoot?: string,
): Promise<Ctx> {
  const root = existingRoot ?? (await makeFixtureWorkspace());
  fixtureRoots.add(root);
  await seedRunsApplyReady(root);
  const app = createApp(root, { security: { enabled: false },
    runs: {
      command: process.execPath,
      args: () => [FAKE_PI],
      model: "fake/model",
      idleGraceMs: 300,
      killGraceMs: 300,
      heartbeatMs: 150,
      ...overrides,
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve(s));
    s.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const ctx: Ctx = { root, app, server, base: `http://127.0.0.1:${port}` };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pid of grandchildPids.splice(0)) killGrandchildPid(pid);
  for (const child of strays.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  const roots = new Set<string>();
  for (const ctx of open.splice(0)) {
    await ctx.app.runs.dispose();
    // Undici pools keep-alive sockets, and an unread error body leaves one
    // open — server.close() would then wait for a connection nothing is
    // going to use again.
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    roots.add(ctx.root);
  }
  for (const root of fixtureRoots) roots.add(root);
  fixtureRoots.clear();
  for (const root of roots) await rmFixtureWorkspace(root);
});

// ── HTTP helpers ────────────────────────────────────────────────────────────

function post(base: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function startRun(base: string, body: unknown): Promise<{ res: Response; json: any }> {
  const res = await post(base, "/api/runs", body);
  return { res, json: await res.json() };
}

async function current(base: string): Promise<RunCurrentPayload> {
  const res = await fetch(`${base}/api/runs/current`);
  return (await res.json()) as RunCurrentPayload;
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a run condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitForStatus(base: string, status: RunStatus): Promise<RunCurrentPayload> {
  return waitFor(async () => {
    const payload = await current(base);
    return payload.run?.status === status ? payload : null;
  });
}

function waitForEvent(
  base: string,
  predicate: (entry: RunLogEntry) => boolean,
): Promise<RunLogEntry> {
  return waitFor(async () => {
    const payload = await current(base);
    return payload.events.find(predicate) ?? null;
  });
}

const isNotify = (needle: string) => (entry: RunLogEntry) =>
  entry.type === "notify" && entry.message.includes(needle);

async function readMetadata(root: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, "ui", "run-manager.json"), "utf-8"));
}

/**
 * A stand-in for a pi left running by a sidecar that was killed. `--` is what
 * stops node from parsing the markers as its own options; `ps -o command=`
 * then shows them, which is the evidence the reclaim requires.
 */
function spawnDummy(markers: string[]): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", ...markers], {
    stdio: "ignore",
  });
  strays.push(child);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Background-drain an SSE response, shaped like the helper in api.test.ts. */
function readStream(res: Response) {
  let buffer = "";
  const waiters: Array<() => void> = [];
  const notifyWaiters = () => {
    for (const w of waiters.splice(0)) w();
  };
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        notifyWaiters();
      }
    } catch {
      // aborted
    }
  })();

  const waitForText = async (needle: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${needle}`);
      await Promise.race([
        new Promise<void>((r) => waiters.push(r)),
        new Promise<void>((r) => setTimeout(r, remaining)),
      ]);
    }
  };

  const runFrames = (): RunLogEntry[] =>
    buffer
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: run\n"))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as RunLogEntry);

  return { waitForText, runFrames, text: () => buffer };
}

/** Take a settled run all the way down so the lock is free for the next start. */
async function finishRun(base: string, run: RunSummary): Promise<void> {
  await waitForStatus(base, "waiting");
  const res = await post(base, `/api/runs/${run.runId}/finish`);
  expect(res.status).toBe(200);
  await waitForStatus(base, "done");
}

// ── Starting ────────────────────────────────────────────────────────────────

describe("POST /api/runs", () => {


  it("removing a numbered queue file stops its canonical apply run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "jobs/queue/01-foo.md"), "url: https://example.invalid/foo\n");
    const { base } = await boot({}, root);
    const { json } = await startRun(base, { kind: "apply-next" });
    expect(json.slug).toBe("foo");
    const response = await fetch(`${base}/api/queue/01-foo`, { method: "DELETE" });
    expect(await response.json()).toMatchObject({ runStopped: true });
    expect((await current(base)).run?.status).toBe("stopped");
  }, TIMEOUT);
  it("apply-next resolves a numbered queue file to the shared application slug", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "jobs/queue/01-foo.md"), "url: https://example.invalid/foo\n");
    const { base } = await boot({}, root);
    const { res, json } = await startRun(base, { kind: "apply-next" });
    expect(res.status).toBe(201);
    expect(json.slug).toBe("foo");
    expect(json.sessionName).toBe("ui:foo");
    const event = await waitForEvent(base, (e) => e.type === "user");
    expect(event).toMatchObject({ message: "Apply to the next queued job: foo (file: jobs/queue/01-foo.md); use slug `foo` in tool calls" });
  }, TIMEOUT);
  it(
    "apply-next resolves the first queued slug server-side and names the session after it",
    async () => {
      const { base } = await boot();
      const { res, json } = await startRun(base, { kind: "apply-next" });
      expect(res.status).toBe(201);
      // Consumption order is filenames including .md, so alpha- beats zeta-.
      expect(json.slug).toBe("alpha-ai-director");
      expect(json.sessionName).toBe("ui:alpha-ai-director");
      expect(json.kind).toBe("apply-next");
      expect(json.model).toBe("fake/model");
      const settled = await waitForStatus(base, "waiting");
      expect(settled.run?.runId).toBe(json.runId);
    },
    TIMEOUT,
  );

  it(
    "apply-next refuses an empty queue before spawning anything",
    async () => {
      const { base, root } = await boot();
      const queueDir = path.join(root, "jobs", "queue");
      const parked = path.join(root, "parked");
      await fs.mkdir(parked, { recursive: true });
      for (const file of await fs.readdir(queueDir)) {
        await fs.rename(path.join(queueDir, file), path.join(parked, file));
      }

      const { res, json } = await startRun(base, { kind: "apply-next" });
      expect(res.status).toBe(409);
      expect(json.error).toBe("the queue is empty — nothing to apply to");
      expect((await current(base)).run).toBeNull();

      for (const file of await fs.readdir(parked)) {
        await fs.rename(path.join(parked, file), path.join(queueDir, file));
      }
      expect((await startRun(base, { kind: "apply-next" })).res.status).toBe(201);
    },
    TIMEOUT,
  );

  it(
    "apply sends the exact sentence /apply-next would have sent",
    async () => {
      const { base } = await boot();
      const { res, json } = await startRun(base, { kind: "apply", slug: "zeta-platform-em" });
      expect(res.status).toBe(201);
      expect(json.sessionName).toBe("ui:zeta-platform-em");
      const entry = await waitForEvent(base, (e) => e.type === "user");
      expect(entry).toMatchObject({
        type: "user",
        message: "Apply to the next queued job: zeta-platform-em (file: jobs/queue/zeta-platform-em.md); use slug `zeta-platform-em` in tool calls",
      });
    },
    TIMEOUT,
  );

  it(
    "rejects a bad kind, a missing slug, an unsafe slug and a slug that is not queued",
    async () => {
      const { base } = await boot();
      expect((await startRun(base, { kind: "nonsense" })).res.status).toBe(400);
      expect((await startRun(base, {})).res.status).toBe(400);
      expect((await startRun(base, { kind: "apply" })).res.status).toBe(400);
      expect((await startRun(base, { kind: "apply", slug: "../escape" })).res.status).toBe(400);

      const unknown = await startRun(base, { kind: "apply", slug: "not-queued-at-all" });
      expect(unknown.res.status).toBe(404);
      expect((await current(base)).run).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "answers a second start with 409 and the active run's id, leaving its metadata intact",
    async () => {
      const { base, root } = await boot();
      const first = await startRun(base, { kind: "apply-next" });
      expect(first.res.status).toBe(201);

      const second = await startRun(base, { kind: "gather" });
      expect(second.res.status).toBe(409);
      expect(second.json.runId).toBe(first.json.runId);
      expect(second.json.error).toContain("already active");

      // The lock guards nothing about the file's contents — this is the
      // assertion that the loser did not clobber the winner's record.
      const metadata = await readMetadata(root);
      expect(metadata.runId).toBe(first.json.runId);
      expect(metadata.pid).toBe(first.json.pid);
    },
    TIMEOUT,
  );

  it(
    "answers a second start with 409 even after the lock has been lost",
    async () => {
      // What `onCompromised` leaves behind: a pi child still alive and a lock
      // a competing `lock()` would now be granted. Removing the lock directory
      // is that state exactly — and the in-memory run has to be the authority,
      // or this start resets the transcript and races the live child.
      const { base, root } = await boot();
      const first = await startRun(base, { kind: "apply-next" });
      expect(first.res.status).toBe(201);
      const before = await waitForStatus(base, "waiting");

      await fs.rm(path.join(root, "ui", "run-manager.json.lock"), { recursive: true, force: true });

      const second = await startRun(base, { kind: "gather" });
      expect(second.res.status).toBe(409);
      expect(second.json.runId).toBe(first.json.runId);
      expect(second.json.error).toContain("already active");

      const after = await current(base);
      expect(after.run?.runId).toBe(first.json.runId);
      expect(after.run?.status).toBe("waiting");
      // The transcript is the live run's, not a fresh one: same first entry,
      // and nothing dropped.
      expect(after.events[0].seq).toBe(before.events[0].seq);
      expect(after.events.length).toBeGreaterThanOrEqual(before.events.length);

      // …and the run still comes down cleanly, with releaseLock swallowing the
      // release of a lock directory that is no longer there.
      await finishRun(base, first.json as RunSummary);
      const third = await startRun(base, { kind: "gather" });
      expect(third.res.status).toBe(201);
      expect(third.json.runId).not.toBe(first.json.runId);
    },
    TIMEOUT,
  );

  it(
    "refuses a start while the aborted run's pi is still on its way out",
    async () => {
      // `abort()` answers `stopped` at once (D2) while pi is still exiting, and
      // an exiting pi still holds `.browser-data`. The status says the run is
      // over; the child says it is not, and the child is what a second pi would
      // collide with. `linger` is a pi that ignores the abort and the closing
      // of its stdin, so only the kill timer ends it.
      const { base, root } = await boot({ killGraceMs: 400 });
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "linger" });
      // The second turn's tool end: by the time any of its bytes reach here the
      // child has run the whole turn, stdin included.
      const settled = await waitFor(async () => {
        const payload = await current(base);
        return payload.events.filter((e) => e.type === "tool_end").length >= 2 ? payload : null;
      });
      const pid = settled.run?.pid as number;
      expect(alive(pid)).toBe(true);

      // The compromised lock again: nothing on disk refuses the start below.
      await fs.rm(path.join(root, "ui", "run-manager.json.lock"), { recursive: true, force: true });

      const aborted = await post(base, `/api/runs/${json.runId}/abort`);
      expect(aborted.status).toBe(200);
      expect((await aborted.json()).status).toBe("stopped");

      const second = await startRun(base, { kind: "gather" });
      expect(second.res.status).toBe(409);
      expect(second.json.error).toContain("shutting down");
      expect(second.json.runId).toBe(json.runId);
      // The refusal is about a process that is alive at the moment it is made.
      expect(alive(pid)).toBe(true);

      // The kill timer takes it down, and only then does a start succeed.
      await waitForEvent(base, (e) => e.type === "exit");
      const third = await startRun(base, { kind: "gather" });
      expect(third.res.status).toBe(201);
      expect(third.json.runId).not.toBe(json.runId);
    },
    TIMEOUT,
  );

  it(
    "does not lose the exit of a pi that dies while start() is still awaiting",
    async () => {
      // The window the exit handler now covers. It cannot be hit by timing
      // alone: a node child takes ~25ms to boot and die, while the pid write it
      // races takes under a millisecond. So the stall is made explicit — this
      // slows exactly that write, which is the event-loop stall the finding
      // describes, in the one place it bites. Without the fix the `exit` lands
      // with no listener, start() answers 201 for a dead child, and the run
      // sits at `starting` forever holding the lock.
      const spy = spyStallRunManagerPidRename(300);

      let dying = true;
      const { base, root } = await boot({
        args: () => (dying ? [FAKE_PI, "--die-on-start"] : [FAKE_PI]),
      });
      try {
        const { res, json } = await startRun(base, { kind: "gather" });
        expect(res.status).toBe(500);
        expect(json.error).toContain("exited with code 3");
        expect(json.error).toContain("during startup");
      } finally {
        spy.mockRestore();
      }

      // The run explains itself rather than vanishing.
      const payload = await current(base);
      expect(payload.run?.status).toBe("failed");
      expect(payload.run?.endedAt).not.toBeNull();
      expect(payload.events.some((e) => e.type === "exit" && e.code === 3)).toBe(true);

      // The ENDED record is the last one written: a live-looking pid here is
      // what the next start would try to reclaim.
      const metadata = await readMetadata(root);
      expect(metadata.pid).toBeNull();
      expect(metadata.endedAt).toBeTruthy();

      // Nothing latched: the lock is free and the liveness guard sees no child.
      dying = false;
      const again = await startRun(base, { kind: "gather" });
      expect(again.res.status).toBe(201);
      await waitForStatus(base, "waiting");
    },
    TIMEOUT,
  );

  it(
    "does not let a start that lost its pi trample the run that follows it",
    async () => {
      // Run A dies during startup. `closeOut` unwinds it WITH THE LOCK HELD and
      // then releases — so everything A's start does after that point is
      // lockless, and run B may legally begin the instant the lock is free. A
      // second unwind by A would overwrite B's fresh record with A's ended one
      // and drop A's error and `failed` status into B's transcript.
      //
      // The gap is opened by stalling A's pid write — round 6's technique,
      // narrowed to A's own record so B runs at full speed inside it.
      const firstRunId = { value: null as string | null };
      const spy = spyStallRunManagerPidRename(400, firstRunId);

      let dying = true;
      const { base, root } = await boot({
        args: () => (dying ? [FAKE_PI, "--die-on-start"] : [FAKE_PI]),
      });
      try {
        const a = startRun(base, { kind: "gather" });
        // `failed` is published after the lock is released, which is exactly
        // when B is allowed to start — so this is the top of the gap.
        const failedA = await waitFor(async () => {
          const payload = await current(base);
          return payload.run?.status === "failed" ? payload.run : null;
        }, 5000);

        dying = false;
        const b = await startRun(base, { kind: "apply-next" });
        expect(b.res.status).toBe(201);
        expect(b.json.runId).not.toBe(failedA.runId);

        // A still gets its own answer…
        const { res, json } = await a;
        expect(res.status).toBe(500);
        expect(json.error).toContain("during startup");

        // …and B is untouched by it: its record, and only its own events.
        await waitForStatus(base, "waiting");
        const payload = await current(base);
        expect(payload.run?.runId).toBe(b.json.runId);
        expect(payload.events.some((e) => e.type === "error")).toBe(false);
        expect(payload.events.some((e) => e.type === "status" && e.status === "failed")).toBe(false);

        const metadata = await readMetadata(root);
        expect(metadata.runId).toBe(b.json.runId);
        expect(metadata.pid).toBe(b.json.pid);
        expect(metadata.endedAt).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    },
    TIMEOUT,
  );

  it(
    "settles a run whose pi dies just after startup at failed, not starting",
    async () => {
      let dying = true;
      const { base, root } = await boot({
        args: () => (dying ? [FAKE_PI, "--die-on-start"] : [FAKE_PI]),
      });
      // No stall here, so the child outlives start() and the 201 is honest.
      // What matters is that the run does not sit at `starting` with a dead pi.
      const { res } = await startRun(base, { kind: "gather" });
      expect([201, 500]).toContain(res.status);

      const failed = await waitFor(async () => {
        const payload = await current(base);
        return payload.run?.status === "failed" ? payload : null;
      }, 2000);
      expect(failed.events.some((e) => e.type === "exit" && e.code === 3)).toBe(true);
      expect(failed.run?.endedAt).not.toBeNull();

      dying = false;
      await waitFor(async () => ((await readMetadata(root)).endedAt ? true : null));
      expect((await startRun(base, { kind: "gather" })).res.status).toBe(201);
    },
    TIMEOUT,
  );

  it(
    "never answers a concurrent loser with a null id, over repeated rounds",
    async () => {
      const { base } = await boot();
      for (let round = 0; round < 5; round += 1) {
        const [a, b] = await Promise.all([
          startRun(base, { kind: "apply-next" }),
          startRun(base, { kind: "apply-next" }),
        ]);
        const created = [a, b].filter((r) => r.res.status === 201);
        const locked = [a, b].filter((r) => r.res.status === 409);
        expect(created).toHaveLength(1);
        expect(locked).toHaveLength(1);
        // The window this exists to close: the winner publishes its id as the
        // very next statement after lock(), so the loser can never read {}.
        expect(locked[0].json.runId).toBe(created[0].json.runId);
        await finishRun(base, created[0].json as RunSummary);
      }
    },
    30_000,
  );

  it(
    "writes the run's metadata to ui/run-manager.json",
    async () => {
      const { base, root } = await boot();
      const { json } = await startRun(base, { kind: "gather" });
      const metadata = await waitFor(async () => {
        const value = await readMetadata(root);
        return value.pid ? value : null;
      });
      expect(Object.keys(metadata).sort()).toEqual(
        ["kind", "model", "pid", "runId", "sessionName", "slug", "startedAt"].sort(),
      );
      expect(metadata).toMatchObject({
        runId: json.runId,
        sessionName: "ui:gather",
        kind: "gather",
        slug: null,
        model: "fake/model",
      });
      expect(typeof metadata.pid).toBe("number");
    },
    TIMEOUT,
  );

  it(
    "leaves run-manager.json intact when an atomic metadata write fails",
    async () => {
      const ctx = await boot();
      const file = path.join(ctx.root, "ui", "run-manager.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "{}", "utf8");
      const before = await fs.readFile(file, "utf8");
      const durable = await import("../../../.pi/extensions/lib/durable-store");
      const original = durable.atomicWriteFile;
      vi.spyOn(durable, "atomicWriteFile").mockImplementationOnce(async (target, bytes, opts) => {
        if (String(target).endsWith("run-manager.json")) {
          throw new Error("injected metadata write failure");
        }
        return original(target, bytes, opts);
      });
      const writeMetadata = (ctx.app.runs as unknown as {
        writeMetadata(file: string, metadata: unknown): Promise<void>;
      }).writeMetadata.bind(ctx.app.runs);
      await expect(
        writeMetadata(file, {
          runId: "test-run",
          pid: null,
          sessionName: "ui:status",
          kind: "status",
          slug: null,
          model: "fake/model",
          startedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow("injected metadata write failure");
      vi.restoreAllMocks();
      expect(await fs.readFile(file, "utf8")).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "still starts when reconcile throws unexpectedly",
    async () => {
      const ctx = await boot();
      const reconcileMod = await import("../../../.pi/extensions/lib/reconcile");
      vi.spyOn(reconcileMod, "reconcileWorkspace").mockRejectedValueOnce(new Error("reconcile boom"));
      const { res } = await startRun(ctx.base, { kind: "status" });
      expect(res.status).toBe(201);
      await waitForStatus(ctx.base, "waiting");
      const payload = await current(ctx.base);
      expect(payload.events.some((e) => e.type === "notify" && String(e.message).includes("reconcile failed"))).toBe(
        true,
      );
      vi.restoreAllMocks();
    },
    TIMEOUT,
  );

  it(
    "still starts when reconcile reports corrupt state.json (R11)",
    async () => {
      const ctx = await boot();
      await fs.writeFile(path.join(ctx.root, "state.json"), "", "utf8");
      const { res } = await startRun(ctx.base, { kind: "status" });
      expect(res.status).toBe(201);
      await waitForStatus(ctx.base, "waiting");
      const payload = await current(ctx.base);
      expect(
        payload.events.some(
          (e) => e.type === "notify" && String(e.message).includes("reconcile R11"),
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );
});

// ── Transcript ──────────────────────────────────────────────────────────────

describe("GET /api/runs/current", () => {
  it(
    "returns an empty payload before anything has run",
    async () => {
      const { base } = await boot();
      expect(await current(base)).toEqual({ run: null, events: [] });
    },
    TIMEOUT,
  );

  it(
    "carries the normalized transcript: user, text, one-line tool call, notify, status line",
    async () => {
      const { base } = await boot();
      await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      const { events } = await current(base);

      const kinds = new Set(events.map((e) => e.type));
      expect(kinds.has("user")).toBe(true);
      expect(kinds.has("text")).toBe(true);
      expect(kinds.has("text_end")).toBe(true);
      expect(kinds.has("notify")).toBe(true);

      const tool = events.find((e) => e.type === "tool_start");
      expect(tool).toMatchObject({
        name: "browser_navigate",
        summary: "https://example.test/apply",
      });
      expect(events.some((e) => e.type === "tool_end" && e.result === "navigated")).toBe(true);

      const statusLine = events.find((e) => e.type === "status_line");
      expect(statusLine).toMatchObject({ key: "mcp", text: "mcp 0/3 servers" });
      expect(JSON.stringify(statusLine)).not.toContain("\u001b");

      // Seq is monotonic and the summary's bounds describe the log.
      const seqs = events.map((e) => e.seq);
      expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
      const payload = await current(base);
      expect(payload.run?.firstSeq).toBe(seqs[0]);
      expect(payload.run?.lastSeq).toBe(seqs[seqs.length - 1]);
    },
    TIMEOUT,
  );
});

describe("GET /api/runs/events", () => {
  it(
    "replays only what follows `since`, then streams live entries",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      const snapshot = await current(base);
      const since = snapshot.events[2].seq;

      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=${since}`, {
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const stream = readStream(res);
      await stream.waitForText("event: connected", 5000);
      await stream.waitForText(`"seq":${snapshot.run!.lastSeq}`, 5000);

      const replayed = stream.runFrames();
      expect(replayed.every((entry) => entry.seq > since)).toBe(true);
      expect(replayed[0].seq).toBe(since + 1);

      await post(base, `/api/runs/${json.runId}/reply`, { message: "/noop" });
      await stream.waitForText("prompt:/noop", 5000);
      controller.abort();
    },
    TIMEOUT,
  );
});

// ── Replying ────────────────────────────────────────────────────────────────

describe("POST /api/runs/:id/reply", () => {
  it(
    "sends a plain prompt while waiting and a steering prompt while running",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      // waiting → plain prompt
      const plain = await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      expect(plain.status).toBe(200);
      await waitForEvent(base, isNotify("prompt:please confirm|steer=false"));

      // The confirm dialog holds the turn open, so the run is genuinely running.
      const request = await waitForEvent(base, (e) => e.type === "ui_request");
      expect(request).toMatchObject({ method: "confirm", title: "Proceed?" });
      expect((await current(base)).run?.status).toBe("running");

      const steered = await post(base, `/api/runs/${json.runId}/reply`, { message: "keep going" });
      expect(steered.status).toBe(200);
      await waitForEvent(base, isNotify("prompt:keep going|steer=true"));
    },
    TIMEOUT,
  );

  it(
    "refuses a reply while the run is still starting, and the run still settles",
    async () => {
      // idleGraceMs above the fake's 400ms pause, or the guard would flip the
      // run to `waiting` before the reply lands.
      const { base, root } = await boot({ idleGraceMs: 2000 });
      await fs.writeFile(
        path.join(root, "jobs", "queue", "slow-motion-role.md"),
        "---\nurl: https://slow.test/1\ncompany: Slow\ntitle: Motion\nlocation: Remote\n---\n",
      );
      const { json } = await startRun(base, { kind: "apply", slug: "slow-motion-role" });
      expect((await current(base)).run?.status).toBe("starting");

      const early = await post(base, `/api/runs/${json.runId}/reply`, { message: "too soon" });
      expect(early.status).toBe(409);
      expect((await early.json()).error).toBe("run is still starting");

      await waitForStatus(base, "waiting");
    },
    TIMEOUT,
  );

  it(
    "rejects an empty message and an unknown run id",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      expect((await post(base, `/api/runs/${json.runId}/reply`, { message: "   " })).status).toBe(400);
      expect((await post(base, `/api/runs/${json.runId}/reply`, {})).status).toBe(400);
      expect((await post(base, "/api/runs/not-a-run/reply", { message: "hi" })).status).toBe(404);
      expect((await post(base, "/api/runs/not-a-run/abort")).status).toBe(404);
      expect((await post(base, "/api/runs/not-a-run/finish")).status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "carries the ACKNOWLEDGE gate end to end inside one session",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: "ack-gate please" });
      await waitForEvent(
        base,
        (e) => e.type === "text" && e.delta.includes("ACKNOWLEDGE"),
      );
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: "ACKNOWLEDGE" });
      await waitForEvent(base, isNotify("gate:acknowledged"));
      const after = await waitForStatus(base, "waiting");
      // Same run, same session: the gate is answered in the session that raised
      // it, which is the whole point of AC 3 and AC 6.
      expect(after.run?.runId).toBe(json.runId);
      expect(after.run?.sessionName).toBe("ui:alpha-ai-director");
    },
    TIMEOUT,
  );
});

// ── Idle guard ──────────────────────────────────────────────────────────────

describe("idle guard", () => {
  it(
    "returns a slash-command run to waiting even though no turn ever starts",
    async () => {
      const { base } = await boot();
      const { res } = await startRun(base, { kind: "status" });
      expect(res.status).toBe(201);
      const settled = await waitForStatus(base, "waiting");
      // Nothing ran: no assistant text, no tool call.
      expect(settled.events.some((e) => e.type === "text")).toBe(false);
      expect(settled.events.some((e) => e.type === "tool_start")).toBe(false);
      expect(settled.events.some((e) => e.type === "user" && e.message === "/status")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "re-arms after a reply that starts no turn",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      const before = (await current(base)).events.filter((e) => e.type === "text").length;

      await post(base, `/api/runs/${json.runId}/reply`, { message: "/noop" });
      await waitForEvent(base, isNotify("prompt:/noop"));
      await new Promise((resolve) => setTimeout(resolve, 600));

      const after = await current(base);
      expect(after.run?.status).toBe("waiting");
      expect(after.events.filter((e) => e.type === "text").length).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "does not emit a second waiting after a turn settles before the timer fires",
    async () => {
      const { base } = await boot({ idleGraceMs: 2000 });
      await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      // Past the point the idle timer would have expired had it not been
      // cancelled by agent_settled.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const { events, run } = await current(base);
      expect(run?.status).toBe("waiting");
      expect(events.filter((e) => e.type === "status" && e.status === "waiting")).toHaveLength(1);
    },
    TIMEOUT,
  );
});

// ── Dialogs ─────────────────────────────────────────────────────────────────

describe("POST /api/runs/:id/ui-response", () => {
  it(
    "answers a confirm dialog and lets the turn finish",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request");
      const id = (request as { id: string }).id;

      const res = await post(base, `/api/runs/${json.runId}/ui-response`, { id, confirmed: true });
      expect(res.status).toBe(200);
      await waitForEvent(base, (e) => e.type === "ui_resolved" && e.id === id);
      await waitForEvent(base, isNotify("dialog:confirmed=true"));
      await waitForStatus(base, "waiting");

      // The same id cannot be answered twice.
      expect((await post(base, `/api/runs/${json.runId}/ui-response`, { id, confirmed: true })).status).toBe(404);
      expect((await post(base, `/api/runs/${json.runId}/ui-response`, {})).status).toBe(400);
    },
    TIMEOUT,
  );

  it(
    "refuses a malformed answer instead of reading it as a cancellation",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request");
      const id = (request as { id: string }).id;

      const refused = async (body: unknown, error: string) => {
        const res = await post(base, `/api/runs/${json.runId}/ui-response`, body);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(error);
      };
      await refused({ id, confirmed: "true" }, "confirmed must be a boolean");
      await refused({ id, value: 123 }, "value must be a string");
      await refused({ id, cancelled: false }, "cancelled must be true when present");
      await refused(
        { id, value: "typed", confirmed: true },
        "exactly one of value, confirmed or cancelled is required",
      );
      await refused({ id }, "exactly one of value, confirmed or cancelled is required");

      // The dialog is still pending — none of the above answered it.
      expect((await post(base, `/api/runs/${json.runId}/ui-response`, { id, confirmed: true })).status).toBe(200);
      await waitForEvent(base, isNotify("dialog:confirmed=true"));
    },
    TIMEOUT,
  );

  it(
    "cancels a pending dialog before stdin closes when a run is aborted",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request");
      const id = (request as { id: string }).id;

      expect((await post(base, `/api/runs/${json.runId}/abort`)).status).toBe(200);
      // The fake only echoes this if the cancellation actually reached it,
      // which it cannot do once stdin has ended.
      await waitForEvent(base, isNotify("dialog:cancelled"));
      await waitForEvent(base, (e) => e.type === "ui_resolved" && e.id === id);
      await waitForEvent(base, (e) => e.type === "exit");
      expect((await current(base)).run?.status).toBe("stopped");
    },
    TIMEOUT,
  );

  it(
    "still delivers the cancellation when stdin is backpressured at abort time",
    async () => {
      // killGraceMs has to outlast the fake's pause: the cancellation must
      // arrive because the queue drained, not because a SIGTERM ended the run.
      const { base, app } = await boot({ killGraceMs: 5000 });
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      await waitForEvent(base, (e) => e.type === "ui_request");

      // Watch the stream rather than polling /current: the padding below is
      // echoed into the transcript, and every poll would carry it again.
      const snapshot = await current(base);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=${snapshot.run!.lastSeq}`, {
        signal: controller.signal,
      });
      const stream = readStream(res);
      await stream.waitForText("event: connected", 5000);

      // Through the manager, not the route: 128KB is far past express.json's
      // body limit, and the queue this exercises is the manager's own state.
      expect(app.runs.reply("slowreader").ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(app.runs.reply("x".repeat(128 * 1024)).ok).toBe(true);

      expect((await post(base, `/api/runs/${json.runId}/abort`)).status).toBe(200);
      // The fake can only echo this if the cancellation crossed the pipe. An
      // end() issued while the queue still held it would have discarded it,
      // and pi's extension would then wait on a promise nothing settles.
      await stream.waitForText("dialog:cancelled", 8000);
      await stream.waitForText('"type":"exit"', 8000);
      controller.abort();
      expect((await current(base)).run?.status).toBe("stopped");
    },
    TIMEOUT,
  );
});

// ── Ending a run ────────────────────────────────────────────────────────────

describe("ending a run", () => {
  it(
    "abort stops the run and the child exits",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      expect((await post(base, `/api/runs/${json.runId}/abort`)).status).toBe(200);
      expect((await current(base)).run?.status).toBe("stopped");
      await waitForEvent(base, (e) => e.type === "exit");
      // The exit must not turn a deliberate stop into a failure.
      expect((await current(base)).run?.status).toBe("stopped");
      expect((await current(base)).run?.endedAt).not.toBeNull();
    },
    TIMEOUT,
  );

  it(
    "finish releases the lock so the next run can start",
    async () => {
      const { base } = await boot();
      const first = await startRun(base, { kind: "apply-next" });
      await finishRun(base, first.json as RunSummary);

      const second = await startRun(base, { kind: "gather" });
      expect(second.res.status).toBe(201);
      expect(second.json.runId).not.toBe(first.json.runId);
      // A new run resets the transcript.
      expect((await current(base)).events.some((e) => e.type === "user" && e.message === "/gather")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "finish with no grandchild reaches done and releases the lock well under killGraceMs",
    async () => {
      const { base } = await boot({ killGraceMs: 5000 });
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      const started = Date.now();
      const res = await post(base, `/api/runs/${json.runId}/finish`);
      expect(res.status).toBe(200);
      await waitForStatus(base, "done");
      expect(Date.now() - started).toBeLessThan(1500);
      const second = await startRun(base, { kind: "gather" });
      expect(second.res.status).toBe(201);
    },
    TIMEOUT,
  );

  it(
    "refuses reply, finish and abort on a finished run",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await finishRun(base, json as RunSummary);
      expect((await post(base, `/api/runs/${json.runId}/reply`, { message: "hi" })).status).toBe(409);
      expect((await post(base, `/api/runs/${json.runId}/finish`)).status).toBe(409);
      expect((await post(base, `/api/runs/${json.runId}/abort`)).status).toBe(409);
    },
    TIMEOUT,
  );

  it(
    "refuses finish while the run is not waiting",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      await waitForEvent(base, (e) => e.type === "ui_request");
      const res = await post(base, `/api/runs/${json.runId}/finish`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("run is running");
    },
    TIMEOUT,
  );

  it(
    "reports a crashed child as failed with its exit code",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "crash now" });

      const exit = await waitForEvent(base, (e) => e.type === "exit");
      expect(exit).toMatchObject({ type: "exit", code: 2, signal: null });
      const after = await waitForStatus(base, "failed");
      expect(after.events.some((e) => e.type === "error")).toBe(true);
    },
    TIMEOUT,
  );
});

// ── Orphans and spawn failure ───────────────────────────────────────────────

describe("orphan reclaim", () => {
  it(
    "kills a recorded pid that ps proves is one of ours",
    async () => {
      const ctx = await boot();
      const dummy = spawnDummy(["--mode", "rpc", "-n", "ui:orphan"]);
      await fs.mkdir(path.join(ctx.root, "ui"), { recursive: true });
      await fs.writeFile(
        path.join(ctx.root, "ui", "run-manager.json"),
        JSON.stringify({
          runId: "orphan-run",
          pid: dummy.pid,
          sessionName: "ui:orphan",
          kind: "apply",
          slug: "orphan",
          model: "fake/model",
          startedAt: new Date().toISOString(),
        }),
      );

      const { res } = await startRun(ctx.base, { kind: "apply-next" });
      expect(res.status).toBe(201);
      await waitForEvent(ctx.base, isNotify("stopped orphaned run orphan-run"));
      await waitFor(async () => (alive(dummy.pid as number) ? null : true), 8000);
      expect(alive(dummy.pid as number)).toBe(false);
    },
    20_000,
  );

  it(
    "leaves a recorded pid alone when ps does not prove it is ours",
    async () => {
      const ctx = await boot();
      const dummy = spawnDummy(["harmless-neighbour"]);
      await fs.mkdir(path.join(ctx.root, "ui"), { recursive: true });
      await fs.writeFile(
        path.join(ctx.root, "ui", "run-manager.json"),
        JSON.stringify({
          runId: "orphan-run",
          pid: dummy.pid,
          sessionName: "ui:orphan",
          kind: "apply",
          slug: "orphan",
          model: "fake/model",
          startedAt: new Date().toISOString(),
        }),
      );

      const { res } = await startRun(ctx.base, { kind: "apply-next" });
      expect(res.status).toBe(201);
      await waitForEvent(ctx.base, isNotify("which is not a pi run — left alone"));
      expect(alive(dummy.pid as number)).toBe(true);
      dummy.kill("SIGKILL");
    },
    20_000,
  );
});

describe("spawn failure", () => {
  it(
    "keeps a live orphan's record verbatim and releases the lock",
    async () => {
      const ctx = await boot({ command: "/nonexistent/pi-binary-for-tests" });
      const dummy = spawnDummy(["harmless-neighbour"]);
      const previous = {
        runId: "orphan-run",
        pid: dummy.pid,
        sessionName: "ui:orphan",
        kind: "apply",
        slug: "orphan",
        model: "fake/model",
        startedAt: "2026-08-27T00:00:00.000Z",
      };
      await fs.mkdir(path.join(ctx.root, "ui"), { recursive: true });
      await fs.writeFile(path.join(ctx.root, "ui", "run-manager.json"), JSON.stringify(previous));

      const { res, json } = await startRun(ctx.base, { kind: "apply-next" });
      expect(res.status).toBe(500);
      expect(json.error).toContain("ENOENT");
      // The record is the only handle the next start has on a process that is
      // still running, so a failed start must not erase it.
      expect(await readMetadata(ctx.root)).toEqual(previous);
      expect((await current(ctx.base)).run?.status).toBe("failed");

      // The lock was released: a second sidecar on the same root can start.
      const second = await boot({}, ctx.root);
      expect((await startRun(second.base, { kind: "apply-next" })).res.status).toBe(201);
      dummy.kill("SIGKILL");
    },
    20_000,
  );

  it(
    "records pid null and an endedAt when there is no orphan to preserve",
    async () => {
      const ctx = await boot({ command: "/nonexistent/pi-binary-for-tests" });
      const { res } = await startRun(ctx.base, { kind: "apply-next" });
      expect(res.status).toBe(500);

      const metadata = await readMetadata(ctx.root);
      expect(metadata.pid).toBeNull();
      expect(typeof metadata.endedAt).toBe("string");

      const second = await boot({}, ctx.root);
      expect((await startRun(second.base, { kind: "apply-next" })).res.status).toBe(201);
    },
    20_000,
  );
});

// ── Secrets ─────────────────────────────────────────────────────────────────

/**
 * `"password": "<anything but [redacted]>"`, in both the shape a real args
 * object serializes to and the escaped shape a JSON blob inside a tool result
 * takes once the whole entry is stringified.
 */
const EXPOSED_PASSWORD_KEY = /\\?"password\\?"\s*:\s*\\?"(?!\[redacted\])/;

/** The thirds fakePi.mjs's `leakDeltas` streams the sentinel in. */
const SENTINEL_FRAGMENTS = (() => {
  const third = Math.ceil(SENTINEL_PASSWORD.length / 3);
  return [
    SENTINEL_PASSWORD.slice(0, third),
    SENTINEL_PASSWORD.slice(third, third * 2),
    SENTINEL_PASSWORD.slice(third * 2),
  ];
})();

/** Every assistant delta, in order: what the client's fold assembles. */
function prose(events: RunLogEntry[]): string {
  return events.map((e) => (e.type === "text" ? e.delta : "")).join("");
}

describe("secret redaction", () => {
  it(
    "keeps a credentials.json password out of /current and out of the stream",
    async () => {
      // No `secrets` override: the manager reads the fixture's own
      // credentials.json, which is what production does.
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: `leak ${SENTINEL_PASSWORD}` });
      await waitForEvent(
        base,
        (e) => e.type === "tool_end" && e.result.includes("Created account entry"),
      );
      await waitForStatus(base, "waiting");
      // The stderr tail only reaches a client as the error of a failed exit.
      await post(base, `/api/runs/${json.runId}/reply`, { message: "crash now" });
      await waitForStatus(base, "failed");

      const snapshot = await (await fetch(`${base}/api/runs/current`)).text();
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText('"type":"exit"', 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(SENTINEL_PASSWORD);
        expect(text).not.toMatch(EXPOSED_PASSWORD_KEY);
        expect(text).not.toMatch(/Password: (?!\[redacted\])/);
        // …while everything around the value is still readable.
        expect(text).toContain("Created account entry for Acme");
        expect(text).toContain("Username/Email: applicant+acme@example.com");
        expect(text).toContain("Account created; the password is [redacted].");
        expect(text).toContain("[fake] wrote credentials: [redacted]");
      }
    },
    TIMEOUT,
  );

  it(
    "keeps redacting after the UI rewrites the password through PATCH /api/accounts/:host",
    async () => {
      // AC 9. The value is unique to this test so a secrets cache another test
      // left warm cannot produce a false pass, and it is interpolated nowhere
      // but the request body and the fake agent's own prompt.
      const host = "acme.wd5.myworkdayjobs.com";
      const rotated = "ROTATED-BY-UI-3d51ae";
      const { base } = await boot();

      // The edit lands BEFORE the run starts, so the run's redactor is built
      // from the post-edit file. No production change is needed for this:
      // runs/secrets.ts stamps its cache with the file's inode, and the
      // accounts writer's tmp+rename installs a NEW inode, so the stamp cannot
      // match and the secret set is re-read.
      const patched = await fetch(`${base}/api/accounts/${encodeURIComponent(host)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: rotated }),
      });
      expect(patched.status).toBe(200);

      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: `leak ${rotated}` });
      await waitForEvent(
        base,
        (e) => e.type === "tool_end" && e.result.includes("Created account entry"),
      );
      await waitForStatus(base, "waiting");
      // The stderr tail only reaches a client as the error of a failed exit,
      // and it carries the third positive below.
      await post(base, `/api/runs/${json.runId}/reply`, { message: "crash now" });
      await waitForStatus(base, "failed");

      const snapshot = await (await fetch(`${base}/api/runs/current`)).text();
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText('"type":"exit"', 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(rotated);
        expect(text).not.toMatch(EXPOSED_PASSWORD_KEY);
        expect(text).not.toMatch(/Password: (?!\[redacted\])/);
        // The positives are the half that proves redaction did not simply eat
        // the transcript — a redactor that swallowed everything would pass the
        // three negatives above on its own.
        expect(text).toContain("Created account entry for Acme");
        expect(text).toContain("Account created; the password is [redacted].");
        expect(text).toContain("[fake] wrote credentials: [redacted]");
      }
    },
    TIMEOUT,
  );

  it(
    "keeps a secret pi split across three text deltas out of both surfaces",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: `leak ${SENTINEL_PASSWORD}` });
      await waitForEvent(base, (e) => e.type === "text" && e.delta.includes("and continue."));
      await waitForStatus(base, "waiting");

      const payload = await current(base);
      const snapshot = JSON.stringify(payload);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText("and continue.", 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(SENTINEL_PASSWORD);
        // Not one of the halves either: two plaintext fragments in two events
        // are the same leak, spelled differently.
        for (const fragment of SENTINEL_FRAGMENTS) expect(text).not.toContain(fragment);
      }

      // …and the prose the client folds out of those deltas still reads.
      expect(prose(payload.events)).toContain(
        "Account created; the password is [redacted]. Retype it as [redacted] and continue.",
      );
    },
    TIMEOUT,
  );

  it(
    "keeps redacting a secret the secrets list drops mid-sentence",
    async () => {
      // What a credentials.json rewrite does to a block in flight:
      // `create_account` replaces the entry it is working on, so the list that
      // arrives with the delta COMPLETING a split password no longer names it.
      // The swap is made from a subscriber, which publish() calls inline, so it
      // lands between the two deltas with no timing to get wrong.
      const before = "OLDRUN-SECRET-4b71";
      const after = "NEWRUN-SECRET-9c02";
      const half = Math.ceil(before.length / 2);
      let list: readonly string[] = [before];

      const { base, app } = await boot({ secrets: () => list });
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      const unsubscribe = app.runs.subscribe(0, (entry) => {
        if (entry.type === "text" && entry.delta.includes("the password is")) list = [after];
      });
      await post(base, `/api/runs/${json.runId}/reply`, { message: `rotate ${before}` });
      await waitForEvent(base, (e) => e.type === "text" && e.delta.includes("and log in."));
      await waitForStatus(base, "waiting");
      unsubscribe();

      const payload = await current(base);
      const snapshot = JSON.stringify(payload);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText("and log in.", 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(before);
        // Nor either half of it: the first was held back under the old list and
        // released under the new one.
        expect(text).not.toContain(before.slice(0, half));
        expect(text).not.toContain(before.slice(half));
      }
      expect(prose(payload.events)).toContain("the password is [redacted] and log in.");
    },
    TIMEOUT,
  );

  it(
    "redacts a manual verification OTP from ui-response across tool args, results, and split text",
    async () => {
      const otp = "87654321";
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: "verify-otp" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request" && e.method === "input");
      const id = (request as { id: string }).id;
      await post(base, `/api/runs/${json.runId}/ui-response`, { id, value: otp });
      await waitForEvent(base, (e) => e.type === "tool_end" && e.result.includes("Verification code"));
      await waitForStatus(base, "waiting");

      const payload = await current(base);
      const snapshot = JSON.stringify(payload);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText("and done.", 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(otp);
        expect(text).toContain("[redacted]");
      }
      const toolEnd = payload.events.find(
        (e): e is Extract<RunLogEntry, { type: "tool_end" }> =>
          e.type === "tool_end" && e.result.includes("Verification code"),
      );
      expect(toolEnd?.result).toContain("[redacted]");
      const toolStart = payload.events.find(
        (e) => e.type === "tool_start" && (e as { name?: string }).name === "browser_fill_form",
      );
      expect(toolStart).toBeDefined();
      expect(JSON.stringify((toolStart as { args?: unknown }).args)).toContain("[redacted]");
      expect(prose(payload.events)).toContain("Code received: [redacted] and done.");
    },
    TIMEOUT,
  );

  it(
    "redacts a trimmed manual verification OTP when ui-response includes trailing whitespace",
    async () => {
      const otp = "87654321";
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: "verify-otp" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request" && e.method === "input");
      const id = (request as { id: string }).id;
      await post(base, `/api/runs/${json.runId}/ui-response`, { id, value: `${otp}\n` });
      await waitForEvent(base, (e) => e.type === "tool_end" && e.result.includes("Verification code"));
      await waitForStatus(base, "waiting");

      const payload = await current(base);
      const snapshot = JSON.stringify(payload);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText("and done.", 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(otp);
        expect(text).toContain("[redacted]");
      }
      const toolStart = payload.events.find(
        (e) => e.type === "tool_start" && (e as { name?: string }).name === "browser_fill_form",
      );
      expect(JSON.stringify((toolStart as { args?: unknown }).args)).toContain("[redacted]");
    },
    TIMEOUT,
  );

  it(
    "redacts a manual verification OTP echoed to stderr after ui-response on failed exit",
    async () => {
      const otp = "11223344";
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: "verify-otp-leak" });
      const request = await waitForEvent(base, (e) => e.type === "ui_request" && e.method === "input");
      const id = (request as { id: string }).id;
      await post(base, `/api/runs/${json.runId}/ui-response`, { id, value: otp });
      await waitForStatus(base, "failed");

      const snapshot = await (await fetch(`${base}/api/runs/current`)).text();
      const controller = new AbortController();
      const res = await fetch(`${base}/api/runs/events?since=0`, { signal: controller.signal });
      const stream = readStream(res);
      await stream.waitForText('"type":"exit"', 5000);
      const streamed = stream.text();
      controller.abort();

      for (const text of [snapshot, streamed]) {
        expect(text).not.toContain(otp);
        expect(text).toContain("[redacted]");
      }
    },
    TIMEOUT,
  );

  it(
    "scrubs a value handed to it through the secrets seam",
    async () => {
      const sentinel = "INJECTED-RUN-SECRET-9f2c";
      const { base } = await boot({ secrets: () => [sentinel] });
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");

      await post(base, `/api/runs/${json.runId}/reply`, { message: `leak ${sentinel}` });
      const end = await waitForEvent(
        base,
        (e) => e.type === "tool_end" && e.result.includes("Created account entry"),
      );
      expect(end).toMatchObject({ isError: false });

      const text = await (await fetch(`${base}/api/runs/current`)).text();
      expect(text).not.toContain(sentinel);
      expect(text).not.toMatch(EXPOSED_PASSWORD_KEY);
      expect(text).toContain("Created account entry for Acme");
    },
    TIMEOUT,
  );
});

describe("apply-run policy gate (PJR-15 T4)", () => {
  it("refuses apply without versioned acknowledgement", async () => {
    const root = await makeFixtureWorkspace();
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    delete state.acknowledged_policy;
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
    const { base } = await boot({}, root);
    const { res, json } = await startRun(base, { kind: "apply", slug: "alpha-ai-director" });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "ACK_REQUIRED" });
    expect(String(json.error)).toMatch(/Setup/i);
  });

  it("refuses apply when the slug is already submitted", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(
      path.join(root, "jobs", "queue", "acme-engineering-manager.md"),
      `---
url: https://boards.greenhouse.io/acme/jobs/123
company: Acme
title: Engineering Manager
location: Seattle, WA
---
`,
    );
    const { base } = await boot({}, root);
    const { res, json } = await startRun(base, { kind: "apply", slug: "acme-engineering-manager" });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "ALREADY_SUBMITTED" });
  });

  it("refuses apply with ALREADY_SUBMITTED after run-start reconcile records an observation (R13)", async () => {
    const root = await makeFixtureWorkspace();
    const slug = "obs-reconcile-role";
    const { base } = await boot({}, root);
    await fs.mkdir(path.join(root, ".pi-jobs", "observed"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".pi-jobs", "observed", `${slug}.json`),
      JSON.stringify({
        slug,
        state: "submitted",
        source: "greenhouse_submit_script",
        at: "2026-06-01T12:00:00.000Z",
        runId: "run-1",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        acknowledged_at: "2026-07-01T00:00:00.000Z",
        acknowledged_policy: "auto-submit-v1",
        applications: [{ slug, status: "in_progress", queue_file: `jobs/queue/${slug}.md` }],
        addresses: {},
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "jobs", "queue", `${slug}.md`),
      `---
url: https://example.test/${slug}
company: Co
title: Role
location: Remote
---
`,
    );
    const { res, json } = await startRun(base, { kind: "apply", slug });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(json.code).not.toBe("SUBMIT_OBSERVED_UNRECORDED");
  });

  it("refuses apply under the ten-minute rate limit", async () => {
    const root = await makeFixtureWorkspace();
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    state.applications[0].submitted_at = new Date().toISOString();
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
    const { base } = await boot({}, root);
    const { res, json } = await startRun(base, { kind: "apply", slug: "alpha-ai-director" });
    expect(res.status).toBe(409);
    expect(json.code).toBe("RATE_LIMITED");
    expect(json.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns 404 for apply when the slug exists only under discovered/", async () => {
    // boundary: B6 — dismissed discovery is not applied to.
    const root = await makeFixtureWorkspace();
    const slug = "only-discovered";
    await fs.writeFile(
      path.join(root, "jobs", "discovered", `${slug}.md`),
      "---\nurl: https://example.invalid/only\ncompany: Co\ntitle: Role\nlocation: Remote\n---\n",
    );
    const { base } = await boot({}, root);
    const { res } = await startRun(base, { kind: "apply", slug });
    expect(res.status).toBe(404);
  });

  it("writes the stop marker before the abort frame is handled", async () => {
    const root = await makeFixtureWorkspace();
    const orderLog = path.join(root, "abort-order.log");
    const { base } = await boot({ env: { ...process.env, PI_JOBS_ABORT_ORDER_LOG: orderLog } }, root);
    const { json } = await startRun(base, { kind: "apply-next" });
    await waitForStatus(base, "waiting");
    await post(base, `/api/runs/${json.runId}/abort`);
    await waitFor(async () => {
      const log = await fs.readFile(orderLog, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return "";
      });
      return log.includes("abort:marker") ? true : null;
    });
    expect(await fs.readFile(orderLog, "utf8")).toContain("abort:marker");
  });

  it("DELETE on the active apply slug stops the run and removes the queue file", async () => {
    const { base } = await boot();
    const { json } = await startRun(base, { kind: "apply-next" });
    await waitForStatus(base, "waiting");
    const slug = json.slug as string;
    const res = await fetch(`${base}/api/queue/${encodeURIComponent(slug)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runStopped).toBe(true);
    expect(body.queue.some((q: { slug: string }) => q.slug === slug)).toBe(false);
    const payload = await current(base);
    expect(payload.run?.status).toBe("stopped");
  });

  it.skipIf(process.platform === "win32")(
    "grandchild sleeper stays alive without abort and is cleaned up",
    async () => {
      const root = await makeFixtureWorkspace();
      const pidFile = path.join(root, "grandchild.pid");
      const { base } = await boot({ args: () => [FAKE_PI, "--spawn-grandchild", pidFile], killGraceMs: 300 }, root);
      const { json } = await startRun(base, { kind: "status" });
      await waitForEvent(base, isNotify("fake pi loaded"));
      const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
      trackGrandchildPid(grandchildPid);
      expect(alive(grandchildPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(alive(grandchildPid)).toBe(true);
      await post(base, `/api/runs/${json.runId}/abort`);
      await waitFor(async () => (alive(grandchildPid) ? null : true));
    },
    TIMEOUT,
  );


  it.skipIf(process.platform === "win32")("abort still kills when stop.json is a directory", async () => {
    const root = await makeFixtureWorkspace();
    const pidFile = path.join(root, "grandchild.pid");
    const { base } = await boot({ args: () => [FAKE_PI, "--spawn-grandchild", pidFile], killGraceMs: 300 }, root);
    const { json } = await startRun(base, { kind: "status" });
    await waitForEvent(base, isNotify("fake pi loaded"));
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    trackGrandchildPid(pid);
    const runDir = path.join(root, ".pi-jobs/runs", json.runId);
    await fs.mkdir(path.join(runDir, "stop.json"));
    const response = await post(base, `/api/runs/${json.runId}/abort`);
    expect(response.status).toBe(200);
    await waitFor(async () => (alive(pid) ? null : true), 8000);
    await expect(fs.stat(runDir)).rejects.toThrow();
    expect((await current(base)).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "warning", message: expect.stringContaining("stop marker") }),
    ]));
  }, TIMEOUT);
  it.skipIf(process.platform === "win32")(
    "abort kills a fakePi grandchild after the grace period",
    async () => {
      const root = await makeFixtureWorkspace();
      const pidFile = path.join(root, "grandchild.pid");
      const { base } = await boot({ args: () => [FAKE_PI, "--spawn-grandchild", pidFile], killGraceMs: 300 }, root);
      const { json } = await startRun(base, { kind: "status" });
      await waitForEvent(base, isNotify("fake pi loaded"));
      const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
      trackGrandchildPid(grandchildPid);
      await post(base, `/api/runs/${json.runId}/abort`);
      await waitFor(async () => (alive(grandchildPid) ? null : true), 8000);
    },
    TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "abort kills a fakePi grandchild when pi exits immediately on abort",
    async () => {
      const root = await makeFixtureWorkspace();
      const pidFile = path.join(root, "grandchild.pid");
      const { base } = await boot(
        { args: () => [FAKE_PI, "--spawn-grandchild", pidFile, "--abort-exit"], killGraceMs: 300 },
        root,
      );
      const { json } = await startRun(base, { kind: "status" });
      await waitForEvent(base, isNotify("fake pi loaded"));
      const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
      trackGrandchildPid(grandchildPid);
      await post(base, `/api/runs/${json.runId}/abort`);
      await waitFor(async () => (alive(grandchildPid) ? null : true), 8000);
    },
    TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "finish kills a fakePi grandchild after the grace period",
    async () => {
      const root = await makeFixtureWorkspace();
      const pidFile = path.join(root, "grandchild.pid");
      const { base } = await boot({ args: () => [FAKE_PI, "--spawn-grandchild", pidFile], killGraceMs: 300 }, root);
      const { json } = await startRun(base, { kind: "status" });
      await waitForEvent(base, isNotify("fake pi loaded"));
      const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
      trackGrandchildPid(grandchildPid);
      await finishRun(base, json as RunSummary);
      await waitFor(async () => (alive(grandchildPid) ? null : true), 8000);
    },
    TIMEOUT,
  );

  it("finish writes the stop marker before signalling", async () => {
    const root = await makeFixtureWorkspace();
    const { base } = await boot({}, root);
    const { json } = await startRun(base, { kind: "status" });
    await waitForStatus(base, "waiting");
    const marker = path.join(root, ".pi-jobs", "runs", json.runId, "stop.json");
    await finishRun(base, json as RunSummary);
    const body = JSON.parse(await fs.readFile(marker, "utf8"));
    expect(body).toMatchObject({ runId: json.runId, reason: "finish" });
  });

  it("dispose writes the stop marker before signalling", async () => {
    const root = await makeFixtureWorkspace();
    const ctx = await boot({}, root);
    const { json } = await startRun(ctx.base, { kind: "status" });
    await waitForStatus(ctx.base, "waiting");
    const marker = path.join(root, ".pi-jobs", "runs", json.runId, "stop.json");
    open.splice(open.indexOf(ctx), 1);
    await ctx.app.runs.dispose();
    const body = JSON.parse(await fs.readFile(marker, "utf8"));
    expect(body).toMatchObject({ runId: json.runId, reason: "dispose" });
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    await rmFixtureWorkspace(root);
  });

  it(
    "stop during a pending confirm dialog cancels it, writes the marker, and resume is gated after queue removal",
    async () => {
      const root = await makeFixtureWorkspace();
      const { base } = await boot({}, root);
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "please confirm" });
      const dialog = await waitForEvent(base, (e) => e.type === "ui_request" && e.method === "confirm");
      const dialogId = dialog.type === "ui_request" ? dialog.id : "";
      await post(base, `/api/runs/${json.runId}/abort`);
      await waitForEvent(base, (e) => e.type === "ui_resolved" && e.id === dialogId);
      const marker = path.join(root, ".pi-jobs", "runs", json.runId, "stop.json");
      expect(await fs.readFile(marker, "utf8")).toContain(json.runId);
      await fetch(`${base}/api/queue/${encodeURIComponent(json.slug)}`, { method: "DELETE" });
      const retry = await startRun(base, { kind: "apply", slug: json.slug });
      expect(retry.res.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "passes run env vars to the child on apply",
    async () => {
      const { base } = await boot();
      const { json } = await startRun(base, { kind: "apply-next" });
      await waitForStatus(base, "waiting");
      await post(base, `/api/runs/${json.runId}/reply`, { message: "env-dump" });
      const note = await waitForEvent(
        base,
        (e) => e.type === "notify" && e.message.startsWith(`env:${json.runId}|`),
      );
      expect(note.type).toBe("notify");
      if (note.type !== "notify") throw new Error("expected notify event");
      expect(note.message).toContain(`env:${json.runId}|`);
      expect(note.message).toContain("apply-next");
      expect(note.message).toContain("alpha-ai-director");
    },
    TIMEOUT,
  );
});

describe("shutdown ownership", () => {
  it.skipIf(process.platform === "win32")("reports group-kill errors without releasing a live child's lock", async () => {
    const ctx = await boot({ args: () => [FAKE_PI, "--ignore-term"], killGraceMs: 25 });
    let pid!: number;
    const kill = process.kill.bind(process);
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await startRun(ctx.base, { kind: "status" });
      await waitForEvent(ctx.base, isNotify("fake pi loaded"));
      pid = (await readMetadata(ctx.root)).pid;
      spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid) throw Object.assign(new Error("test group permission denied"), { code: "EPERM" });
        return kill(target, signal);
      });
      await expect(ctx.app.runs.dispose()).rejects.toThrow("test group permission denied");
      expect((await fs.stat(path.join(ctx.root, "ui/run-manager.json.lock"))).isDirectory()).toBe(true);
    } finally {
      spy?.mockRestore();
      if (pid && alive(pid)) kill(-pid, "SIGKILL");
      await waitFor(async () => (await readMetadata(ctx.root)).endedAt ? true : null);
      open.splice(open.indexOf(ctx), 1);
      ctx.server.closeAllConnections();
      await new Promise<void>(resolve => ctx.server.close(() => resolve()));
      await rmFixtureWorkspace(ctx.root);
    }
  });

  it.skipIf(process.platform === "win32")("isolates run signals and awaits asynchronous runtime cleanup", async () => {
    const ctx = await boot({ args: () => [FAKE_PI, "--term-delay", path.join(ctx.root, "cleanup-marker.txt")] });
    await startRun(ctx.base, { kind: "status" });
    await waitForEvent(ctx.base, isNotify("fake pi loaded"));
    const pid = (await readMetadata(ctx.root)).pid;
    const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    const parentGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
    expect(group).toBe(pid);
    expect(group).not.toBe(parentGroup);
    await ctx.app.runs.dispose();
    expect(await fs.readFile(path.join(ctx.root, "cleanup-marker.txt"), "utf8")).toBe("cleaned");
  });

  it("does not restore old metadata after its lock has been compromised", async () => {
    let complete!: (value: any) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const ctx = await boot({ prepare: async () => { entered(); return new Promise(resolve => { complete = resolve; }); } });
    const starting = ctx.app.runs.start({ kind: "status" });
    await preparing;
    // Model onCompromised's exact state; a subsequent holder owns its record.
    const originalRelease = (ctx.app.runs as any).release as () => Promise<void>;
    await originalRelease();
    (ctx.app.runs as any).release = null;
    const successor = { runId: "successor", pid: 123, sessionName: "ui:successor", startedAt: new Date().toISOString() };
    await fs.writeFile(path.join(ctx.root, "ui/run-manager.json"), JSON.stringify(successor));
    const stopping = ctx.app.runs.dispose();
    complete({ command: process.execPath, args: [FAKE_PI], model: "fake/model", snapshot: {}, cleanup: async () => {} });
    await stopping;
    expect(await starting).toMatchObject({ ok: false, code: "SHUTTING_DOWN" });
    expect(await readMetadata(ctx.root)).toEqual(successor);
  });

  for (const code of [7, 143]) {
    it(`reports real cleanup failure but accepts pinned Pi's completed SIGTERM status (${code})`, async () => {
      const ctx = await boot({ args: () => [FAKE_PI, `--term-exit-${code}`] });
      try {
        await startRun(ctx.base, { kind: "status" });
        await waitForEvent(ctx.base, isNotify("fake pi loaded"));
        const stopping = ctx.app.runs.dispose();
        if (code === 7) await expect(stopping).rejects.toThrow("code 7");
        else await stopping;
      } finally {
        open.splice(open.indexOf(ctx), 1);
        ctx.server.closeAllConnections();
        await new Promise<void>(resolve => ctx.server.close(() => resolve()));
        await rmFixtureWorkspace(ctx.root);
      }
    });
  }

  it("reports private prepared-state cleanup failure after an active child exits", async () => {
    const cleanup = vi.fn(async () => { throw new Error("private snapshot removal denied"); });
    const ctx = await boot({ prepare: async () => ({ command: process.execPath, args: [FAKE_PI], model: "fake/model", snapshot: {} as any, cleanup }) });
    try {
      await startRun(ctx.base, { kind: "status" });
      await waitForEvent(ctx.base, isNotify("fake pi loaded"));
      await expect(ctx.app.runs.dispose()).rejects.toThrow("private snapshot removal denied");
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      open.splice(open.indexOf(ctx), 1);
      ctx.server.closeAllConnections();
      await new Promise<void>(resolve => ctx.server.close(() => resolve()));
      await rmFixtureWorkspace(ctx.root);
    }
  });

  it("preserves a live previous orphan when disposal cancels preparation", async () => {
    const orphan = spawnDummy(["--mode", "rpc", "-n", "ui:orphan"]);
    let complete!: (value: any) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const ctx = await boot({ prepare: async () => { entered(); return new Promise(resolve => { complete = resolve; }); } });
    const previous = { runId: "previous-owned-run", pid: orphan.pid, sessionName: "ui:orphan", kind: "apply", slug: "orphan", model: "fake/model", startedAt: new Date().toISOString() };
    await fs.mkdir(path.join(ctx.root, "ui"), { recursive: true });
    await fs.writeFile(path.join(ctx.root, "ui/run-manager.json"), JSON.stringify(previous));
    const starting = ctx.app.runs.start({ kind: "status" });
    await preparing;
    const stopping = ctx.app.runs.dispose();
    complete({ command: process.execPath, args: [FAKE_PI], model: "fake/model", snapshot: {}, cleanup: async () => {} });
    await stopping;
    expect(await starting).toMatchObject({ ok: false, code: "SHUTTING_DOWN" });
    expect(await readMetadata(ctx.root)).toEqual(previous);
    expect(() => process.kill(orphan.pid!, 0)).not.toThrow();
  });

  it("does not spawn after disposal races pending lock acquisition", async () => {
    const ctx = await boot();
    let unblock!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const original = lockfile.lock;
    const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (...args: Parameters<typeof lockfile.lock>) => {
      entered();
      await gate;
      return original(...args);
    });
    try {
      const starting = ctx.app.runs.start({ kind: "status" });
      await reached;
      const stopping = ctx.app.runs.dispose();
      unblock();
      await stopping;
      expect(await starting).toMatchObject({ ok: false, code: "SHUTTING_DOWN" });
      expect(ctx.app.runs.current()).toBeNull();
      await expect(fs.stat(path.join(ctx.root, "ui/run-manager.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { unblock(); spy.mockRestore(); }
  });

  it("reports forced run termination, after reaping and releasing its lock", async () => {
    const ctx = await boot({ args: () => [FAKE_PI, "--ignore-term"], killGraceMs: 25 });
    await startRun(ctx.base, { kind: "status" });
    await waitForEvent(ctx.base, isNotify("fake pi loaded"));
    const pid = (await readMetadata(ctx.root)).pid;
    await expect(ctx.app.runs.dispose()).rejects.toThrow("required SIGKILL");
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(fs.stat(path.join(ctx.root, "ui/run-manager.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    // Teardown must not rethrow an already verified failure.
    open.splice(open.indexOf(ctx), 1);
    ctx.server.closeAllConnections();
    await new Promise<void>(resolve => ctx.server.close(() => resolve()));
    await rmFixtureWorkspace(ctx.root);
  });

  it("fences a pending prepare and cleans it before releasing the run lock", async () => {
    let complete!: (value: any) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = vi.fn(async () => {
      expect((await fs.stat(path.join(ctx.root, "ui/run-manager.json.lock"))).isDirectory()).toBe(true);
    });
    const ctx = await boot({ prepare: async () => { entered(); return new Promise(resolve => { complete = resolve; }); } });
    const starting = startRun(ctx.base, { kind: "status" });
    await preparing;
    const stopping = ctx.app.runs.dispose();
    const second = await ctx.app.runs.start({ kind: "status" });
    expect(second).toMatchObject({ ok: false, code: "SHUTTING_DOWN" });
    complete({ command: process.execPath, args: [FAKE_PI], model: "fake/model", snapshot: {}, cleanup });
    await stopping;
    expect((await starting).json.error).toMatch(/shutting down/);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await readMetadata(ctx.root)).pid).toBeNull();
    await expect(fs.stat(path.join(ctx.root, "ui/run-manager.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("awaits an active child and releases state only after it exits", async () => {
    const ctx = await boot();
    await startRun(ctx.base, { kind: "status" });
    await waitForEvent(ctx.base, isNotify("fake pi loaded"));
    const pid = (await readMetadata(ctx.root)).pid;
    const first = ctx.app.runs.dispose();
    expect(ctx.app.runs.dispose()).toBe(first);
    await first;
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readMetadata(ctx.root)).endedAt).toBeTruthy();
  });

  it("invokes prepare beforeCleanup during abort before the run directory is removed", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174091",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const staleOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-stored-refresh",
      expires: Date.now() + 60_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: staleOAuth.access } }),
    }));
    let preparedRun: Awaited<ReturnType<typeof prepareAgentRun>> | null = null;
    let runId = "";
    const ctx = await boot(
      {
        prepare: async (id, sessionName, kind) => {
          runId = id;
          preparedRun = await prepareAgentRun(root, id, sessionName, {}, kind);
          return { ...preparedRun, command: process.execPath, args: [FAKE_PI] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: staleOAuth }));
    try {
      const { json } = await startRun(ctx.base, { kind: "status" });
      await waitForEvent(ctx.base, isNotify("fake pi loaded"));
      const agentDir = String(preparedRun!.env?.PI_CODING_AGENT_DIR);
      const rotated = {
        type: "oauth" as const,
        access: "FIXTURE-SECRET-do-not-leak-rotated-access",
        refresh: staleOAuth.refresh,
        expires: Date.now() + 3_600_000,
      };
      await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: rotated }, null, 2));
      expect((await post(ctx.base, `/api/runs/${json.runId}/abort`)).status).toBe(200);
      await waitForEvent(ctx.base, (e) => e.type === "exit");
      const stored = await waitFor(async () => {
        const entry = (await readAuth(root))[providerAlias(conn.id)];
        if (entry?.type === "oauth" && entry.access === rotated.access) return entry;
        return null;
      });
      expect(stored.expires).toBe(rotated.expires);
      const runDir = path.join(root, ".pi-jobs", "runs", runId);
      await waitFor(async () => {
        try {
          await fs.access(runDir);
          return null;
        } catch {
          return true;
        }
      });
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("writes back rotated OAuth credentials after a clean child exit", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174092",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const staleOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-clean-stored",
      refresh: "FIXTURE-SECRET-do-not-leak-clean-refresh",
      expires: Date.now() + 60_000,
    };
    const rotated = {
      ...staleOAuth,
      access: "FIXTURE-SECRET-do-not-leak-clean-rotated",
      expires: Date.now() + 3_600_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: staleOAuth.access } }),
    }));
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(
        path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
        JSON.stringify({ anthropic: ${JSON.stringify(rotated)} })
      );
      setTimeout(() => process.exit(0), 50);
    `;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          const prepared = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...prepared, command: process.execPath, args: ["-e", childScript] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: staleOAuth }));
    try {
      await startRun(ctx.base, { kind: "status" });
      await waitForEvent(ctx.base, (event) => event.type === "exit" && event.code === 0);
      const stored = await waitFor(async () => {
        const entry = (await readAuth(root))[providerAlias(conn.id)];
        return entry?.type === "oauth" && entry.access === rotated.access ? entry : null;
      });
      expect(stored).toEqual(rotated);
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("redacts original and rotated OAuth tokens from a failed exit after accepted write-back", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174097",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const original = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-accepted-original-access",
      refresh: "FIXTURE-SECRET-do-not-leak-accepted-original-refresh",
      expires: Date.now() + 60_000,
    };
    const rotated = {
      ...original,
      access: "FIXTURE-SECRET-do-not-leak-accepted-rotated-access",
      refresh: "FIXTURE-SECRET-do-not-leak-accepted-rotated-refresh",
      expires: Date.now() + 3_600_000,
    };
    const secrets = [original.access, original.refresh, rotated.access, rotated.refresh];
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: original.access } }),
    }));
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(
        path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
        JSON.stringify({ anthropic: ${JSON.stringify(rotated)} })
      );
      setTimeout(() => {
        console.error(${JSON.stringify(secrets.join(" "))});
        process.exit(1);
      }, 100);
    `;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          const prepared = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...prepared, command: process.execPath, args: ["-e", childScript] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: original }));
    let publishedError: RunLogEntry | undefined;
    const unsubscribe = ctx.app.runs.subscribe(0, (entry) => {
      if (entry.type === "error") publishedError = entry;
    });
    try {
      await startRun(ctx.base, { kind: "status" });
      const payload = await waitForStatus(ctx.base, "failed");
      expect(publishedError?.type).toBe("error");
      expect(JSON.stringify(publishedError)).toContain("[redacted]");
      expect(JSON.stringify(payload.events)).toContain("[redacted]");
      for (const secret of secrets) {
        expect(JSON.stringify(publishedError)).not.toContain(secret);
        expect(JSON.stringify(payload.events)).not.toContain(secret);
      }
      expect((await readAuth(root))[providerAlias(conn.id)]).toEqual(rotated);
    } finally {
      unsubscribe();
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("redacts rotated OAuth tokens from malformed run auth and retains the snapshot for recovery", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174089",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const original = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-malformed-original-access",
      refresh: "FIXTURE-SECRET-do-not-leak-malformed-original-refresh",
      expires: Date.now() + 60_000,
    };
    const rotated = {
      ...original,
      access: "FIXTURE-SECRET-do-not-leak-malformed-rotated-access",
      refresh: "FIXTURE-SECRET-do-not-leak-malformed-rotated-refresh",
      expires: Date.now() + 3_600_000,
    };
    const malformed = `{"anthropic":{"type":"oauth","access":"${rotated.access}","refresh":"${rotated.refresh}","expires":`;
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: original.access } }),
    }));
    let preparedRun: Awaited<ReturnType<typeof prepareAgentRun>> | null = null;
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), ${JSON.stringify(malformed)});
      setTimeout(() => {
        console.error(${JSON.stringify(`${rotated.access} ${rotated.refresh}`)});
        process.exit(1);
      }, 100);
    `;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          preparedRun = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...preparedRun, command: process.execPath, args: ["-e", childScript] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: original }));
    let publishedError: RunLogEntry | undefined;
    const unsubscribe = ctx.app.runs.subscribe(0, (entry) => {
      if (entry.type === "error") publishedError = entry;
    });
    let runAuthPath = "";
    try {
      await startRun(ctx.base, { kind: "status" });
      const payload = await waitForStatus(ctx.base, "failed");
      runAuthPath = path.join(String(preparedRun!.env?.PI_CODING_AGENT_DIR), "auth.json");
      const persisted = ctx.app.runs.events();
      const replayed: RunLogEntry[] = [];
      const stopReplay = ctx.app.runs.subscribe(0, (entry) => replayed.push(entry));
      stopReplay();

      expect(publishedError?.type).toBe("error");
      if (publishedError?.type === "error") {
        expect(publishedError.message).toBe("pi exited with code 1");
      }
      for (const events of [publishedError, payload.events, persisted, replayed]) {
        const text = JSON.stringify(events);
        expect(text).not.toContain(rotated.access);
        expect(text).not.toContain(rotated.refresh);
      }
      expect(await fs.readFile(runAuthPath, "utf8")).toBe(malformed);
      await fs.access(path.dirname(runAuthPath));
    } finally {
      unsubscribe();
      setModelRuntimeFactoryForTests(undefined);
      // Simulate operator recovery so the shared fixture teardown can exercise
      // the normal retained-snapshot retry instead of failing on purpose.
      if (runAuthPath) {
        await fs.writeFile(runAuthPath, JSON.stringify({ anthropic: rotated })).catch(() => {});
      }
    }
  }, TIMEOUT);

  it.each([
    {
      provider: "openai-codex" as const,
      modelId: "gpt-5.5",
      truncatedField: "access" as const,
      id: "123e4567-e89b-12d3-a456-426614174070",
      access: "eyJhbGciOiJSUzI1NiJ9.FIXTURE-SECRET-do-not-leak-codex-access",
      refresh: "rt_codex_FIXTURE-SECRET-do-not-leak-refresh",
    },
    {
      provider: "openai-codex" as const,
      modelId: "gpt-5.5",
      truncatedField: "refresh" as const,
      id: "123e4567-e89b-12d3-a456-426614174071",
      access: "eyJhbGciOiJSUzI1NiJ9.FIXTURE-SECRET-do-not-leak-codex-access",
      refresh: "rt_codex_FIXTURE-SECRET-do-not-leak-refresh",
    },
    {
      provider: "github-copilot" as const,
      modelId: "claude-sonnet-4.6",
      truncatedField: "access" as const,
      id: "123e4567-e89b-12d3-a456-426614174072",
      access: "ghu_FIXTURE-SECRET-do-not-leak-copilot-access",
      refresh: "ghr_FIXTURE-SECRET-do-not-leak-copilot-refresh",
    },
    {
      provider: "github-copilot" as const,
      modelId: "claude-sonnet-4.6",
      truncatedField: "refresh" as const,
      id: "123e4567-e89b-12d3-a456-426614174073",
      access: "ghu_FIXTURE-SECRET-do-not-leak-copilot-access",
      refresh: "ghr_FIXTURE-SECRET-do-not-leak-copilot-refresh",
    },
  ])(
    "fails closed for $provider tokens when run auth is truncated inside $truncatedField",
    async ({ provider, modelId, truncatedField, id, access, refresh }) => {
      const root = await makeFixtureWorkspace();
      const connection = { id, label: provider, provider };
      const original = {
        type: "oauth" as const,
        access: `FIXTURE-SECRET-do-not-leak-${provider}-original-access`,
        refresh: `FIXTURE-SECRET-do-not-leak-${provider}-original-refresh`,
        expires: Date.now() + 60_000,
        ...(provider === "github-copilot" ? { availableModelIds: [modelId] } : {}),
      };
      const rotated = {
        ...original,
        access,
        refresh,
        expires: Date.now() + 3_600_000,
      };
      const cut = (value: string) => value.slice(0, Math.max(1, value.length - 12));
      const malformed = truncatedField === "access"
        ? `{"${provider}":{"type":"oauth","access":"${cut(access)}`
        : `{"${provider}":{"type":"oauth","access":"${access}","refresh":"${cut(refresh)}`;
      setModelRuntimeFactoryForTests(async () => ({
        getAuth: async () => ({ auth: { apiKey: original.access } }),
      }));
      let runAuthPath = "";
      const childScript = `
        const fs = require("node:fs");
        const path = require("node:path");
        fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), ${JSON.stringify(malformed)});
        console.log(JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          notifyType: "info",
          message: ${JSON.stringify(`${access} ${refresh}`)}
        }));
        console.error(${JSON.stringify(`${access} ${refresh}`)});
        setTimeout(() => process.exit(1), 500);
      `;
      const ctx = await boot(
        {
          prepare: async (runId, sessionName, kind) => {
            const prepared = await prepareAgentRun(root, runId, sessionName, {}, kind);
            runAuthPath = path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json");
            return { ...prepared, command: process.execPath, args: ["-e", childScript] };
          },
        },
        root,
      );
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [connection],
          agent: { connectionId: connection.id, modelId },
          scoring: null,
          captcha: {},
        }),
      );
      await modifyAuthFile(root, (auth) => ({
        ...auth,
        [providerAlias(connection.id)]: original,
      }));
      const published: RunLogEntry[] = [];
      const unsubscribe = ctx.app.runs.subscribe(0, (entry) => published.push(entry));
      try {
        await startRun(ctx.base, { kind: "status" });
        const payload = await waitForStatus(ctx.base, "failed");
        const persisted = ctx.app.runs.events();
        const replayed: RunLogEntry[] = [];
        const stopReplay = ctx.app.runs.subscribe(0, (entry) => replayed.push(entry));
        stopReplay();

        for (const events of [published, payload.events, persisted, replayed]) {
          const text = JSON.stringify(events);
          expect(text).toContain("[redacted: run credential file unreadable]");
          expect(text).not.toContain(access);
          expect(text).not.toContain(refresh);
        }
        const terminalError = [...persisted].reverse().find((entry) => entry.type === "error");
        expect(terminalError).toMatchObject({
          type: "error",
          message: "pi exited with code 1",
        });
        expect(await fs.readFile(runAuthPath, "utf8")).toBe(malformed);
      } finally {
        unsubscribe();
        setModelRuntimeFactoryForTests(undefined);
        if (runAuthPath) {
          await fs.writeFile(runAuthPath, JSON.stringify({ [provider]: rotated })).catch(() => {});
        }
      }
    },
    TIMEOUT,
  );

  it("skips OAuth write-back after the running connection is removed and does not retain cleanup", async () => {
    const root = await makeFixtureWorkspace();
    const oauthConnection = {
      id: "123e4567-e89b-12d3-a456-426614174094",
      label: "Claude OAuth",
      provider: "anthropic" as const,
    };
    const replacementConnection = {
      id: "123e4567-e89b-12d3-a456-426614174095",
      label: "Claude API key",
      provider: "anthropic" as const,
    };
    const storedOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-removed-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-removed-stored-refresh",
      expires: Date.now() + 60_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: storedOAuth.access } }),
    }));
    let preparedRun: Awaited<ReturnType<typeof prepareAgentRun>> | null = null;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          preparedRun = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...preparedRun, command: process.execPath, args: [FAKE_PI] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [oauthConnection, replacementConnection],
        agent: { connectionId: oauthConnection.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(oauthConnection.id)]: storedOAuth,
      [providerAlias(replacementConnection.id)]: {
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-replacement-api-key",
      },
    }));

    try {
      const first = await startRun(ctx.base, { kind: "status" });
      expect(first.res.status).toBe(201);
      await waitForStatus(ctx.base, "waiting");
      const runDir = path.dirname(String(preparedRun!.env?.PI_CODING_AGENT_DIR));
      const waitingBeforeRotation = (await current(ctx.base)).events.filter(
        (event) => event.type === "status" && event.status === "waiting",
      ).length;
      const rotate = await post(ctx.base, `/api/runs/${first.json.runId}/reply`, {
        message: "bump-oauth-expires",
      });
      expect(rotate.status).toBe(200);
      await waitFor(async () => {
        const waitingAfterRotation = (await current(ctx.base)).events.filter(
          (event) => event.type === "status" && event.status === "waiting",
        ).length;
        return waitingAfterRotation > waitingBeforeRotation ? true : null;
      });
      const runAuth = JSON.parse(
        await fs.readFile(path.join(String(preparedRun!.env?.PI_CODING_AGENT_DIR), "auth.json"), "utf8"),
      ) as { anthropic?: { access?: string } };
      expect(runAuth.anthropic?.access).toBe("FIXTURE-SECRET-do-not-leak-rotated-access");

      const beforeSelection = await readApplicationSettings(root);
      await updateSelections(root, {
        agent: { connectionId: replacementConnection.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
      }, beforeSelection.revision);
      const beforeRemoval = await readApplicationSettings(root);
      await removeConnection(root, oauthConnection.id, beforeRemoval.revision);
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toBeUndefined();

      await finishRun(ctx.base, first.json as RunSummary);
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toBeUndefined();
      await expect(fs.access(runDir)).rejects.toThrow();

      const next = await startRun(ctx.base, { kind: "status" });
      expect(next.res.status).toBe(201);
      expect(String(next.json.error ?? "")).not.toContain("Previous OAuth write-back is still pending");
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toBeUndefined();
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("skips OAuth write-back after the running connection switched to an API key during the run", async () => {
    const root = await makeFixtureWorkspace();
    const oauthConnection = {
      id: "123e4567-e89b-12d3-a456-426614174096",
      label: "Claude OAuth",
      provider: "anthropic" as const,
    };
    const replacementConnection = {
      id: "123e4567-e89b-12d3-a456-426614174097",
      label: "Claude API key",
      provider: "anthropic" as const,
    };
    const storedOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-removed-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-removed-stored-refresh",
      expires: Date.now() + 60_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: storedOAuth.access } }),
    }));
    let preparedRun: Awaited<ReturnType<typeof prepareAgentRun>> | null = null;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          preparedRun = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...preparedRun, command: process.execPath, args: [FAKE_PI] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [oauthConnection, replacementConnection],
        agent: { connectionId: oauthConnection.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(oauthConnection.id)]: storedOAuth,
      [providerAlias(replacementConnection.id)]: {
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-replacement-api-key",
      },
    }));

    try {
      const first = await startRun(ctx.base, { kind: "status" });
      expect(first.res.status).toBe(201);
      await waitForStatus(ctx.base, "waiting");
      const runDir = path.dirname(String(preparedRun!.env?.PI_CODING_AGENT_DIR));
      const waitingBeforeRotation = (await current(ctx.base)).events.filter(
        (event) => event.type === "status" && event.status === "waiting",
      ).length;
      const rotate = await post(ctx.base, `/api/runs/${first.json.runId}/reply`, {
        message: "bump-oauth-expires",
      });
      expect(rotate.status).toBe(200);
      await waitFor(async () => {
        const waitingAfterRotation = (await current(ctx.base)).events.filter(
          (event) => event.type === "status" && event.status === "waiting",
        ).length;
        return waitingAfterRotation > waitingBeforeRotation ? true : null;
      });
      const runAuth = JSON.parse(
        await fs.readFile(path.join(String(preparedRun!.env?.PI_CODING_AGENT_DIR), "auth.json"), "utf8"),
      ) as { anthropic?: { access?: string } };
      expect(runAuth.anthropic?.access).toBe("FIXTURE-SECRET-do-not-leak-rotated-access");

      // The user replaces the running connection's OAuth credential with a
      // pasted API key through the existing PUT path while the child runs.
      const beforeReplace = await readApplicationSettings(root);
      await updateConnection(
        root,
        oauthConnection.id,
        { apiKey: "FIXTURE-SECRET-do-not-leak-user-pasted-key" },
        beforeReplace.revision,
      );
      const replacedKey = { type: "api_key", key: "FIXTURE-SECRET-do-not-leak-user-pasted-key" };
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toEqual(replacedKey);

      await finishRun(ctx.base, first.json as RunSummary);
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toEqual(replacedKey);
      await expect(fs.access(runDir)).rejects.toThrow();

      const next = await startRun(ctx.base, { kind: "status" });
      expect(next.res.status).toBe(201);
      expect(String(next.json.error ?? "")).not.toContain("Previous OAuth write-back is still pending");
      expect((await readAuth(root))[providerAlias(oauthConnection.id)]).toEqual(replacedKey);
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);
  it("redacts original and rotated OAuth tokens from a failed exit after declined write-back", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174093",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const staleOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-declined-stored",
      refresh: "FIXTURE-SECRET-do-not-leak-declined-refresh",
      expires: Date.now() + 60_000,
    };
    const rotated = {
      ...staleOAuth,
      access: "FIXTURE-SECRET-do-not-leak-declined-rotated",
      refresh: "FIXTURE-SECRET-do-not-leak-declined-rotated-refresh",
      expires: Date.now() + 120_000,
    };
    const newer = {
      ...staleOAuth,
      access: "FIXTURE-SECRET-do-not-leak-concurrent-newer",
      expires: Date.now() + 3_600_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: staleOAuth.access } }),
    }));
    const childScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(
        path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"),
        JSON.stringify({ anthropic: ${JSON.stringify(rotated)} })
      );
      setTimeout(() => {
        console.error(${JSON.stringify([
          staleOAuth.access,
          staleOAuth.refresh,
          rotated.access,
          rotated.refresh,
        ].join(" "))});
        process.exit(1);
      }, 500);
    `;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          const prepared = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...prepared, command: process.execPath, args: ["-e", childScript] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: staleOAuth }));
    let publishedError: RunLogEntry | undefined;
    const unsubscribe = ctx.app.runs.subscribe(0, (entry) => {
      if (entry.type === "error") publishedError = entry;
    });
    try {
      await startRun(ctx.base, { kind: "status" });
      await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: newer }));
      const payload = await waitForStatus(ctx.base, "failed");
      const secrets = [staleOAuth.access, staleOAuth.refresh, rotated.access, rotated.refresh];
      expect(publishedError?.type).toBe("error");
      expect(JSON.stringify(publishedError)).toContain("[redacted]");
      expect(JSON.stringify(payload.events)).toContain("[redacted]");
      for (const secret of secrets) {
        expect(JSON.stringify(publishedError)).not.toContain(secret);
        expect(JSON.stringify(payload.events)).not.toContain(secret);
      }
      expect((await readAuth(root))[providerAlias(conn.id)]).toEqual(newer);
    } finally {
      unsubscribe();
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("invokes prepare beforeCleanup during dispose before the run directory is removed", async () => {
    const root = await makeFixtureWorkspace();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174090",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const staleOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-stored-refresh",
      expires: Date.now() + 60_000,
    };
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: staleOAuth.access } }),
    }));
    let preparedRun: Awaited<ReturnType<typeof prepareAgentRun>> | null = null;
    const ctx = await boot(
      {
        prepare: async (runId, sessionName, kind) => {
          preparedRun = await prepareAgentRun(root, runId, sessionName, {}, kind);
          return { ...preparedRun, command: process.execPath, args: [FAKE_PI] };
        },
      },
      root,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(conn.id)]: staleOAuth }));
    try {
      await startRun(ctx.base, { kind: "status" });
      await waitForEvent(ctx.base, isNotify("fake pi loaded"));
      const agentDir = String(preparedRun!.env?.PI_CODING_AGENT_DIR);
      const rotated = {
        type: "oauth" as const,
        access: "FIXTURE-SECRET-do-not-leak-rotated-access",
        refresh: staleOAuth.refresh,
        expires: Date.now() + 3_600_000,
      };
      await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: rotated }, null, 2));
      await ctx.app.runs.dispose();
      const stored = (await readAuth(root))[providerAlias(conn.id)];
      expect(stored?.type).toBe("oauth");
      if (stored?.type === "oauth") {
        expect(stored.access).toBe(rotated.access);
        expect(stored.expires).toBe(rotated.expires);
      }
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("runs beforeCleanup before removing the run directory", async () => {
    let beforeRan = false;
    const root = await makeFixtureWorkspace();
    const ctx = await boot({
      prepare: async (runId) => ({
        command: process.execPath,
        args: [FAKE_PI],
        model: "fake/model",
        snapshot: { connectionId: "x", provider: "openai", modelId: "m", credentialSource: "none", capturedAt: "", settingsRevision: "" },
        beforeCleanup: async () => {
          beforeRan = true;
          await fs.access(path.join(root, ".pi-jobs", "runs", runId));
        },
        cleanup: async () => {
          expect(beforeRan).toBe(true);
          await fs.rm(path.join(root, ".pi-jobs", "runs", runId), { recursive: true, force: true });
        },
      }),
    }, root);
    await startRun(ctx.base, { kind: "status" });
    await waitForEvent(ctx.base, isNotify("fake pi loaded"));
    await ctx.app.runs.dispose();
    expect(beforeRan).toBe(true);
  }, TIMEOUT);

  it("preserves the run snapshot when OAuth write-back fails and retries cleanup on dispose", async () => {
    let runDir = "";
    let writeBackAttempts = 0;
    let cleanupCalls = 0;
    const root = await makeFixtureWorkspace();
    const ctx = await boot(
      {
        prepare: async (runId) => {
          runDir = path.join(root, ".pi-jobs", "runs", runId);
          await fs.mkdir(runDir, { recursive: true });
          await fs.writeFile(path.join(runDir, "auth.json"), "FIXTURE-SECRET-do-not-leak");
          return {
            command: process.execPath,
            args: ["-e", "setTimeout(() => process.exit(0), 25)"],
            model: "fake/model",
            snapshot: {
              connectionId: "x",
              provider: "anthropic",
              modelId: "m",
              credentialSource: "none" as const,
              capturedAt: "",
              settingsRevision: "",
            },
            beforeCleanup: async () => {
              writeBackAttempts += 1;
              if (writeBackAttempts === 1) throw new Error("provider store busy");
            },
            cleanup: async () => {
              cleanupCalls += 1;
              await fs.rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
            },
          };
        },
      },
      root,
    );
    await startRun(ctx.base, { kind: "status" });
    await waitForEvent(ctx.base, (event) => event.type === "exit" && event.code === 0);
    await waitFor(async () => ((await current(ctx.base)).run?.status === "failed" ? true : null));
    const retainedRunDir = runDir;
    await fs.access(path.join(retainedRunDir, "auth.json"));
    expect(cleanupCalls).toBe(0);

    const retry = await startRun(ctx.base, { kind: "status" });
    expect(retry.res.status).toBe(201);
    expect(writeBackAttempts).toBe(2);
    expect(cleanupCalls).toBe(1);
    await expect(fs.access(retainedRunDir)).rejects.toThrow();
    await waitForEvent(ctx.base, (event) => event.type === "exit" && event.code === 0);
    await waitFor(async () => ((await current(ctx.base)).run?.status === "failed" ? true : null));
    await ctx.app.runs.dispose();
  }, TIMEOUT);
});


describe("chat lifecycle", () => {
  it("requires a first message", async () => {
    const { base } = await boot();
    for (const message of [undefined, "", " ", 1]) {
      const { res } = await startRun(base, { kind: "chat", message });
      expect(res.status).toBe(400);
    }
  });
  it("starts with the user message, replays three turns, and ends on abort", async () => {
    const { base } = await boot();
    const { res, json: run } = await startRun(base, { kind: "chat", message: "hello" });
    expect(res.status).toBe(201);
    expect(run.kind).toBe("chat");
    await waitForStatus(base, "waiting");
    for (const message of ["second turn", "third turn"]) {
      expect((await post(base, `/api/runs/${run.runId}/reply`, { message })).status).toBe(200);
      await waitForEvent(base, isNotify(`prompt:${message}|steer=false`));
      await waitForStatus(base, "waiting");
    }
    const snapshot = await current(base);
    expect(snapshot.events.filter(e => e.type === "user").map(e => e.message)).toEqual(["hello", "second turn", "third turn"]);
    expect(snapshot.run?.endedAt).toBeNull();
    const controller = new AbortController();
    const stream = readStream(await fetch(`${base}/api/runs/events`, { signal: controller.signal }));
    await stream.waitForText('"message":"third turn"', 5000);
    controller.abort();
    expect((await post(base, `/api/runs/${run.runId}/abort`)).status).toBe(200);
    await waitForStatus(base, "stopped");
    await waitForEvent(base, e => e.type === "exit");
  });
});
