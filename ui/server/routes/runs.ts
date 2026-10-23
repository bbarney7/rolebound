import { Router, type Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeSlug, paths } from "../workspace";
import { resolveQueueJob } from "../../../.pi/extensions/lib/queue-slug";
import { listQueue } from "../readers/jobFiles";
import { RUN_KINDS } from "../../shared/types";
import type {
  RunCurrentPayload,
  RunKind,
  RunReplyBody,
  RunStartBody,
  RunUiResponseBody,
} from "../../shared/types";
import type { ActionResult, RunManager } from "../runs/runManager";
import { isRunStartRefusalCode } from "../runReadiness";
import { findChatSession, isRunId } from "../runs/chatSession";
import { resolveApplyNextSlug } from "../runs/applyStart";

const BAD_KIND = { error: "invalid run kind" };
const BAD_SLUG = { error: "invalid slug" };
const MISSING_SLUG = { error: "slug is required for an apply run" };
const NOT_IN_QUEUE = { error: "queue item not found" };
/** Not a flow: the UI disables Apply next on an empty queue. This is the guard. */
const EMPTY_QUEUE = { error: "the queue is empty — nothing to apply to" };
const RUN_NOT_FOUND = { error: "run not found" };
const BAD_MESSAGE = { error: "message must be a non-empty string" };
const BAD_UI_ID = { error: "id must be a non-empty string" };
const BAD_UI_CANCELLED = { error: "cancelled must be true when present" };
const BAD_UI_CONFIRMED = { error: "confirmed must be a boolean" };
const BAD_UI_VALUE = { error: "value must be a string" };
const BAD_UI_ANSWER = { error: "exactly one of value, confirmed or cancelled is required" };
/** AC 5's sentence. The id travels beside it so the client can say which run. */
const LOCKED = "a run is already active in this workspace";
/**
 * The other 409: the previous run has ended and its pi has not finished
 * exiting. Worded as a retry because that is what it is — runs.ts:14 surfaces
 * this string verbatim as the whole explanation for a refused click, and "a run
 * is already active" would contradict the `stopped` the panel is showing.
 */
const SHUTTING_DOWN = "the previous run is still shutting down — try again in a moment";

/** Same 25s as the watcher stream, same reason for the override seam. */
export const RUN_HEARTBEAT_MS = 25_000;

export interface RunsOptions {
  heartbeatMs?: number;
  demo?: boolean;
}

export function runsRouter(root: string, manager: RunManager, opts: RunsOptions = {}): Router {
  const heartbeatMs = opts.heartbeatMs ?? RUN_HEARTBEAT_MS;
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      // Express 5 leaves req.body undefined for an empty body.
      const body = (req.body ?? {}) as Partial<RunStartBody>;
      const kind = body.kind;
      if (typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind)) {
        res.status(400).json(BAD_KIND);
        return;
      }

      if (kind === "chat" && (typeof body.message !== "string" || !body.message.trim())) {
        res.status(400).json(BAD_MESSAGE);
        return;
      }
      let slug: string | null = null;
      let slugs: string[] | undefined;
      let continueFrom: string | undefined;
      if (kind === "apply") {
        if (typeof body.slug !== "string" || body.slug.length === 0) {
          res.status(400).json(MISSING_SLUG);
          return;
        }
        // Before any fs call that interpolates it (workspace.ts:34-45).
        if (!isSafeSlug(body.slug)) {
          res.status(400).json(BAD_SLUG);
          return;
        }
        try {
          await fs.stat(paths.jobFile(root, "queue", body.slug));
        } catch {
          res.status(404).json(NOT_IN_QUEUE);
          return;
        }
        slug = resolveQueueJob(root, body.slug).slug;
      } else if (kind === "apply-next") {
        slug = await resolveApplyNextSlug(root);
        if (!slug) {
          res.status(409).json(EMPTY_QUEUE);
          return;
        }
      } else if (kind === "score" && body.slugs !== undefined) {
        if (!Array.isArray(body.slugs) || body.slugs.length < 1 || body.slugs.length > 50 || body.slugs.some(value => typeof value !== "string" || !isSafeSlug(value))) { res.status(400).json({ error: "slugs must contain 1 to 50 safe job slugs" }); return; }
        slugs = [...new Set(body.slugs)];
      }

      if (kind === "chat" && body.continueFrom !== undefined) {
        if (typeof body.continueFrom !== "string" || !isRunId(body.continueFrom)) {
          res.status(400).json({ error: "continueFrom has no saved chat session" });
          return;
        }
        if (!(await findChatSession(root, body.continueFrom))) {
          res.status(400).json({ error: "continueFrom has no saved chat session" });
          return;
        }
        continueFrom = body.continueFrom;
      }

      const result = await manager.start({
        kind: kind as RunKind,
        slug,
        slugs,
        ...(kind === "chat" ? { message: body.message, ...(continueFrom ? { continueFrom } : {}) } : {}),
      });
      if (result.ok) {
        res.status(201).json(result.run);
        return;
      }
      if (!result.ok) {
        if ((result.code === "LOCKED" || result.code === "SHUTTING_DOWN") && "runId" in result) {
          const error = result.code === "LOCKED" ? LOCKED : SHUTTING_DOWN;
          res.status(409).json({ error, runId: result.runId });
          return;
        }
        if ("message" in result && isRunStartRefusalCode(result.code)) {
          res.status(422).json({ error: result.message, code: result.code });
          return;
        }
        if (
          result.code === "ACK_REQUIRED" ||
          result.code === "ALREADY_SUBMITTED" ||
          result.code === "SUBMIT_OBSERVED_UNRECORDED" ||
          result.code === "RATE_LIMITED" ||
          result.code === "STATE_INVALID"
        ) {
          res.status(409).json({
            error: result.message,
            code: result.code,
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          });
          return;
        }
        if (result.code === "SPAWN_FAILED") {
          res.status(500).json({ error: result.message });
          return;
        }
        res.status(500).json({ error: "message" in result ? result.message : "run start failed" });
        return;
      }
    } catch (err) {
      next(err);
    }
  });

  router.get("/current", (_req, res) => {
    const payload: RunCurrentPayload = { run: manager.current(), events: manager.events() };
    res.json(payload);
  });

  /**
   * The run stream. Its own route with its own vocabulary (D4) — `/api/events`
   * is a frozen contract and stays byte-identical.
   *
   * Headers and the two heartbeat frames match events.ts exactly: the comment
   * frame is what keeps proxies from buffering, and the named `ping` is the
   * only one the EventSource API can observe.
   */
  router.get("/events", (req, res) => {
    const parsed = Number.parseInt(String(req.query.since ?? "0"), 10);
    const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: connected\ndata: {}\n\n`);

    const unsubscribe = manager.subscribe(since, (entry) => {
      res.write(`event: run\ndata: ${JSON.stringify(entry)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
      res.write(`event: ping\ndata: {}\n\n`);
    }, heartbeatMs);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post("/:id/reply", (req, res) => {
    if (!isCurrentRun(manager, req.params.id, res)) return;
    const body = (req.body ?? {}) as Partial<RunReplyBody>;
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      res.status(400).json(BAD_MESSAGE);
      return;
    }
    answer(res, manager.reply(body.message));
  });

  router.post("/:id/ui-response", (req, res) => {
    if (!isCurrentRun(manager, req.params.id, res)) return;
    const body = (req.body ?? {}) as Partial<RunUiResponseBody>;
    if (typeof body.id !== "string" || body.id.length === 0) {
      res.status(400).json(BAD_UI_ID);
      return;
    }
    /**
     * KEY PRESENCE IS THE DISCRIMINATOR (shared/types.ts:446-450), which makes
     * every malformed shape indistinguishable from "no answer given" — and the
     * manager reads no answer as a cancellation. `confirmed: "true"` from a
     * client that stringified its state would therefore dismiss the very
     * dialog the operator was answering, and report 200 for it. Each of these
     * says which part of the body is wrong, because the client that sent it is
     * the only thing that can fix it.
     */
    if (body.cancelled !== undefined && body.cancelled !== true) {
      res.status(400).json(BAD_UI_CANCELLED);
      return;
    }
    if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") {
      res.status(400).json(BAD_UI_CONFIRMED);
      return;
    }
    if (body.value !== undefined && typeof body.value !== "string") {
      res.status(400).json(BAD_UI_VALUE);
      return;
    }
    const given = [body.value, body.confirmed, body.cancelled].filter((v) => v !== undefined);
    if (given.length !== 1) {
      res.status(400).json(BAD_UI_ANSWER);
      return;
    }
    answer(
      res,
      manager.respondUi({
        id: body.id,
        value: body.value,
        confirmed: body.confirmed,
        cancelled: body.cancelled,
      }),
    );
  });

  router.post("/:id/abort", (req, res) => {
    if (!isCurrentRun(manager, req.params.id, res)) return;
    answer(res, manager.abort());
  });

  router.post("/:id/finish", async (req, res) => {
    if (!isCurrentRun(manager, req.params.id, res)) return;
    answer(res, await manager.finish());
  });

  return router;
}

/**
 * The manager holds exactly one run, so "does this id name the current run" is
 * the whole of routing by id. A stale id from a browser tab left open across a
 * restart is a 404, not a 409 — nothing about it is active.
 */
function isCurrentRun(manager: RunManager, id: string, res: Response): boolean {
  const run = manager.current();
  if (run && run.runId === id) return true;
  res.status(404).json(RUN_NOT_FOUND);
  return false;
}

function answer(res: Response, result: ActionResult): void {
  if (result.ok) {
    res.json(result.run);
    return;
  }
  res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ error: result.message });
}
