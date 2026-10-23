import { Router } from "express";
import path from "node:path";
import chokidar from "chokidar";

const DEBOUNCE_MS = 250;
/** Exported so a test can assert the shipped interval the SSE contract froze. */
export const HEARTBEAT_MS = 25_000;

/**
 * Watch the whole workspace root with exclusions. An allowlist of mixed
 * file+directory targets silently breaks directory events in chokidar v4
 * (fsevents coalesces to the common parent and drops subtree events).
 */
export const WATCH_IGNORED: (RegExp | string)[] = [
  /(^|[/\\])\..+/, // dotfiles/dirs: .git, .browser-data, .playwright-mcp, .syntaur, .pi
  /node_modules([/\\]|$)/,
  /screenshots([/\\]|$)/,
  /\.pdf$/,
  /\.lock([/\\]|$)/,
  /\.tmp$/,
];

export function watchTarget(root: string): string {
  return root;
}

export type EventsOptions = {
  /**
   * Heartbeat interval override. The shipped 25s exceeds the 15s per-test budget
   * in api.test.ts, and there is no other seam: HEARTBEAT_MS is a module
   * constant and an ESM live binding cannot be reassigned.
   */
  heartbeatMs?: number;
  /**
   * Debounce-window override, same seam and same reason. The shipped 250ms is
   * shorter than the jitter between two chokidar events for one write on macOS
   * fsevents, so a coalescing test written against the real value is a race.
   */
  debounceMs?: number;
};

export function eventsRouter(root: string, opts: EventsOptions = {}): Router {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const router = Router();

  router.get("/", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: connected\ndata: {}\n\n`);

    const watcher = chokidar.watch(watchTarget(root), {
      ignoreInitial: true,
      ignored: WATCH_IGNORED,
      depth: 3, // jobs/<dir>/<file>.md is depth 2; state.json depth 0
      // A root fsevents subscription can report `ready` and still drop the
      // first nested create on macOS. This workspace is intentionally small;
      // polling makes the readiness boundary real on macOS and Linux.
      usePolling: true,
      interval: 500,
    });
    // Tell the client when the initial scan is done — before this, file events
    // can be swallowed as part of the scan.
    watcher.on("ready", () => {
      res.write(`event: watching\ndata: {}\n\n`);
    });
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    watcher.on("all", (_event, filePath) => {
      const rel = path.relative(root, filePath);
      const existing = pending.get(rel);
      if (existing) clearTimeout(existing);
      pending.set(
        rel,
        setTimeout(() => {
          pending.delete(rel);
          res.write(`data: ${JSON.stringify({ file: rel, ts: new Date().toISOString() })}\n\n`);
        }, debounceMs),
      );
    });

    // Two frames, deliberately. The comment is the frozen wire contract (AC #5);
    // the named event is the only one the EventSource API can actually observe,
    // and the client watchdog has nothing to watch without it.
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
      res.write(`event: ping\ndata: {}\n\n`);
    }, heartbeatMs);

    req.on("close", () => {
      clearInterval(heartbeat);
      for (const t of pending.values()) clearTimeout(t);
      void watcher.close();
    });
  });

  return router;
}
