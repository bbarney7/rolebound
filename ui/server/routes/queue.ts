import { resolveQueueSlug } from "../../../.pi/extensions/lib/queue-slug";
import { Router } from "express";
import type { RunManager } from "../runs/runManager";
import { isSafeSlug } from "../workspace";
import { listJobFiles, listQueue, toQueueItem } from "../readers/jobFiles";
import { markSeenUrlPromoted } from "../readers/gatherState";
import {
  checkFrontmatterValue,
  createQueueFile,
  promoteQueueFile,
  removeQueueFile,
} from "../queueWriter";
import type {
  DiscoveredItem,
  QueueCreateBody,
  QueueMutationResult,
  QueuePromoteBody,
} from "../../shared/types";

const BAD_SLUG = { error: "invalid slug" };
const NOT_IN_QUEUE = { error: "queue item not found" };
const NOT_DISCOVERED = { error: "discovered file not found" };
/**
 * D34's identity-change outcome. Distinct from NOT_IN_QUEUE because the file IS
 * there — it is just not the file the user asked to delete — and distinct from
 * a 500 because nothing failed unexpectedly.
 */
const QUEUE_ITEM_CHANGED = { error: "queue item changed on disk before it could be removed" };
/** The URL is rendered as an <a href> in the queue list (D37). */
const BAD_URL = { error: "url must be an http(s) URL" };

/**
 * The one place the http(s)-only policy is decided, so POST and promote cannot
 * drift apart. Promote needs it as much as POST does: a discovered file's `url:`
 * is scraped from a third-party job board, and the queue list renders it as an
 * anchor. React only sanitizes `javascript:` — `data:` and every other scheme
 * pass straight through — so the server must not persist one into the queue.
 */
function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** The four keys CLAUDE.md:21-35 marks required. Order fixes the 400 message. */
const REQUIRED_FIELDS = ["url", "company", "title", "location"] as const;

/** Optional body keys that land in frontmatter or an `ATS:` line, so they get
 * the same control-character check as the required four. `body` is excluded
 * on purpose — it goes AFTER the closing `---`, where a newline is text. */
const OPTIONAL_TEXT_FIELDS = ["source", "resumeKey", "addressCityKey", "slug", "ats"] as const;

const DISCOVERED_DEFAULT_LIMIT = 50;
const DISCOVERED_MAX_LIMIT = 200;

/**
 * Presence + shape check for the four required keys, returning a narrowed
 * object so nothing downstream needs a non-null assertion. TypeScript does not
 * narrow an outer binding through a for-of over a tuple, which is why this
 * returns the values rather than just a boolean.
 */
function requireFields(
  body: Partial<QueueCreateBody>,
):
  | { ok: true; url: string; company: string; title: string; location: string }
  | { ok: false; message: string } {
  const collected: Record<string, string> = {};
  for (const field of REQUIRED_FIELDS) {
    const value = body[field];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, message: `${field} is required` };
    }
    collected[field] = value.trim();
  }
  return {
    ok: true,
    url: collected.url,
    company: collected.company,
    title: collected.title,
    location: collected.location,
  };
}

/** Trimmed value for an optional string field; undefined when absent or blank. */
function optionalField(
  body: Partial<QueueCreateBody>,
  key: (typeof OPTIONAL_TEXT_FIELDS)[number],
): string | undefined {
  const value = body[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function queueRouter(root: string, manager?: RunManager): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await listQueue(root));
    } catch (err) {
      next(err);
    }
  });

  /**
   * The promote picker's source. Registered BEFORE any parameterised route so
   * a future `GET /:slug` cannot shadow it — there is no `GET /:slug` today,
   * and this ordering is what keeps that true by accident-proofing.
   *
   * Filtered, sorted, and capped server-side because jobs/discovered/ holds
   * ~929 files totalling ~969 KB of body text. The response cap does NOT cap
   * the read — listJobFiles still opens every file — which is a cost that
   * already exists on /api/overview and is recorded as a known follow-up
   * rather than fixed here. The client fetches this ON DEMAND only, never from
   * refresh(), because refresh runs on every SSE event.
   */
  router.get("/discovered", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
      const limit =
        Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, DISCOVERED_MAX_LIMIT)
          : DISCOVERED_DEFAULT_LIMIT;

      const files = await listJobFiles(root, "discovered");
      const matched = q
        ? files.filter((f) =>
            `${f.company ?? ""} ${f.title ?? ""} ${f.location ?? ""}`.toLowerCase().includes(q),
          )
        : files;

      // -1 rather than -Infinity: (-Infinity) - (-Infinity) is NaN, and a
      // comparator that returns NaN has implementation-defined behaviour.
      // llmScore is a small positive integer in this corpus, so -1 sorts
      // unscored rows last with no arithmetic hazard.
      const score = (v: number | null) => v ?? -1;
      const sorted = [...matched].sort(
        (a, b) =>
          score(b.llmScore) - score(a.llmScore) ||
          (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
      );

      const items: DiscoveredItem[] = sorted.slice(0, limit).map((f) => ({
        slug: f.slug,
        url: f.url,
        company: f.company,
        title: f.title,
        location: f.location,
        source: f.source,
        match: f.match,
        llmScore: f.llmScore,
        discoveredAt: f.discoveredAt,
      }));
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      // Express 5 leaves req.body undefined for an empty body.
      const body = (req.body ?? {}) as Partial<QueueCreateBody>;

      // Required-field check FIRST and before ANY filesystem call. A queue
      // file missing url/company/title/location halts the applier outright
      // (CLAUDE.md:35, "If any required field is missing, stop and ask"), so
      // writing one is a product bug rather than a style issue.
      const required = requireFields(body);
      if (!required.ok) {
        res.status(400).json({ error: required.message });
        return;
      }

      // Frontmatter injection is the real hazard: an embedded "\n---\n" would
      // terminate the block and silently reinterpret the rest of the document.
      // Reject rather than escape — a quoted value would round-trip into the
      // displayed string as a literal "…" because the tolerant parser does not
      // strip quotes (jobFiles.ts:67).
      for (const field of REQUIRED_FIELDS) {
        const problem = checkFrontmatterValue(field, body[field]);
        if (problem) {
          res.status(400).json({ error: problem.message });
          return;
        }
      }
      for (const field of OPTIONAL_TEXT_FIELDS) {
        const supplied = body[field];
        if (supplied === undefined) continue;
        // A present-but-blank optional field must be treated as ABSENT here,
        // exactly as `optionalField` treats it below. Without this,
        // `{ source: "" }` — which is what an untouched optional <input>
        // submits — reaches `checkFrontmatterValue`, whose probe serializes
        // `k: ` and gets `null` back from matter(), not a string. The probe
        // therefore reports "would be reinterpreted" and the route 400s on a
        // field the user never filled in. Measured:
        // matter("---\nk: \n---\n").data.k is null for "", " ", "   ", "\t".
        if (typeof supplied === "string" && supplied.trim() === "") continue;
        const problem = checkFrontmatterValue(field, supplied);
        if (problem) {
          res.status(400).json({ error: problem.message });
          return;
        }
      }
      if (body.body !== undefined && typeof body.body !== "string") {
        res.status(400).json({ error: "body must be a string" });
        return;
      }

      // D37 — validate the URL, still before any filesystem call. Two
      // independent reasons:
      //
      //  1. The field is rendered as an <a href> in the queue list, so a
      //     `javascript:` value has no business being accepted.
      //  2. D24 keys the seen_urls upsert by this exact string and R7 calls
      //     that upsert "not optional". The concrete failure it closes:
      //     a job submitted with the url `__proto__` would, on a plain
      //     object, assign through Object.prototype's __proto__ setter,
      //     create NO own property, and report a successful upsert that
      //     durably recorded nothing.
      //
      // AFTER the control-character checks, deliberately: the WHATWG URL
      // parser strips tabs and newlines from its input rather than rejecting
      // them, so running this first would let a newline-bearing url through
      // with the wrong error message.
      if (!isHttpUrl(required.url)) {
        res.status(400).json(BAD_URL);
        return;
      }

      const create: QueueCreateBody = {
        url: required.url,
        company: required.company,
        title: required.title,
        location: required.location,
        source: optionalField(body, "source"),
        resumeKey: optionalField(body, "resumeKey"),
        addressCityKey: optionalField(body, "addressCityKey"),
        slug: optionalField(body, "slug"),
        ats: optionalField(body, "ats"),
        body: typeof body.body === "string" ? body.body : undefined,
      };

      const created = await createQueueFile(root, create);
      if (!created.ok) {
        if (created.error.code === "EEXIST") {
          // No auto-suffix: a silent <slug>-2.md would put two files in the
          // queue for one posting and /apply-next would apply to both.
          res.status(409).json({ error: created.error.message });
          return;
        }
        res.status(400).json({ error: created.error.message });
        return;
      }

      // The FILE now exists — the user's intent has succeeded. The seen_urls
      // upsert is a dedup hint and must never turn a successful create into a
      // 500 that invites a retry which then 409s on this very file.
      const marked = await markSeenUrlPromoted(root, create.url, {
        company: create.company,
        title: create.title,
        source: create.source ?? null,
      });

      // Re-list rather than echoing the request back: the client cannot
      // recompute `position` without forking the sort listQueue centralizes.
      const queue = await listQueue(root);
      const result: QueueMutationResult = {
        queue,
        item: queue.find((q) => q.slug === created.slug) ?? null,
        warning: marked.warning,
      };
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/promote", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<QueuePromoteBody>;
      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      // The slug arrives in a REQUEST BODY, not a path param, so the same rule
      // parseRecordedJobFile applies to state.json's queue_file applies here:
      // a value read out of a request is never interpolated into a filesystem
      // path without the guard, because paths.jobFile does no sanitization of
      // its own (workspace.ts:16-17).
      if (!isSafeSlug(slug)) {
        res.status(400).json(BAD_SLUG);
        return;
      }

      // The http(s) URL check lives INSIDE promoteQueueFile, deliberately.
      // Validating here would mean reading the file twice — once to check, once
      // to move — and a replacement landing between those two reads would pass
      // the check and be promoted anyway. The writer validates the record it
      // actually acts on, so there is no window to lose.
      const promoted = await promoteQueueFile(root, slug);
      if (!promoted.ok) {
        // PARTIAL_CONFLICT joins EEXIST on 409 (D34). It is a conflict, not a
        // not-found and not a 500: the queue file DOES now exist, the
        // discovered file also still exists, and the writer deliberately
        // deleted neither. The message names both, so the user can resolve it
        // by hand rather than retrying into a 409.
        if (promoted.error.code === "EEXIST" || promoted.error.code === "PARTIAL_CONFLICT") {
          res.status(409).json({ error: promoted.error.message });
          return;
        }
        // The discovered file exists but carries a url we refuse to persist —
        // a bad request about the file's contents, not a missing file.
        if (promoted.error.code === "BAD_URL") {
          res.status(400).json({ error: promoted.error.message });
          return;
        }
        res.status(404).json(NOT_DISCOVERED);
        return;
      }

      // Matched by URL, not by a re-derived slug: the gatherer's own promote
      // re-slugifies the display name and misses 7-in-77 of the time.
      let warning: string | null;
      if (promoted.record.url) {
        const marked = await markSeenUrlPromoted(root, promoted.record.url, {
          company: promoted.record.company,
          title: promoted.record.title,
          source: promoted.record.source,
        });
        warning = marked.warning;
      } else {
        warning =
          "the discovered file has no url: frontmatter key, so no gather_state.json dedup hint was recorded. The file was promoted.";
      }

      const queue = await listQueue(root);
      const result: QueueMutationResult = {
        queue,
        item: queue.find((q) => q.slug === slug) ?? null,
        warning,
      };
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:slug", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json(BAD_SLUG);
        return;
      }

      // List BEFORE the unlink. This read supplies exactly two things: the
      // 404 check, and the `position` the removed row held — position is an
      // index into a listing and cannot be recovered from a lone record.
      // It does NOT supply the returned item; see below.
      const before = await listQueue(root);
      const previous = before.find((q) => q.slug === slug) ?? null;
      if (!previous) {
        res.status(404).json(NOT_IN_QUEUE);
        return;
      }

      let runStopped = false;
      if (manager) {
        const current = manager.current();
        if (
          current &&
          (current.status === "starting" || current.status === "running" || current.status === "waiting") &&
          (current.kind === "apply" || current.kind === "apply-next") &&
          current.slug === resolveQueueSlug(slug)
        ) {
          const stopped = manager.abort();
          if (stopped.ok) runStopped = true;
        }
      }

      // removeQueueFile does lstat → read → lstat → compare → unlink (D34),
      // so the writer is safe independently of this route. NOT_FOUND means
      // the file vanished mid-request — the applier moves queue→applied —
      // which is a 404. CHANGED means the file at that path is no longer the
      // one we read, so nothing was unlinked and the honest answer is 409.
      const removed = await removeQueueFile(root, slug);
      if (!removed.ok) {
        if (removed.code === "CHANGED") {
          res.status(409).json(QUEUE_ITEM_CHANGED);
          return;
        }
        res.status(404).json(NOT_IN_QUEUE);
        return;
      }

      // The returned item is projected from the record removeQueueFile read
      // IMMEDIATELY BEFORE the unlink — not from the `before` listing above.
      //
      // (D34. `before` is a separate, earlier read of the whole directory, so
      // returning a row from it describes the queue as it was some
      // milliseconds earlier, not what this path held when it was destroyed.
      // Only `position` comes from that listing, because it is an index into
      // it.)
      //
      // The claim this supports is D34's narrowed one, and it is not
      // stronger: the item is what the path held immediately before we
      // unlinked it, and any replacement we could detect turned the request
      // into the 409 above instead of a deletion.
      const item = toQueueItem(removed.record, previous.position);

      // DELETE deliberately does not touch gather_state.json: no value in the
      // gatherer's union means "removed from the queue", and "rejected"
      // permanently suppresses re-discovery, which is not what this means.
      const queue = await listQueue(root);
      const result: QueueMutationResult = { queue, item, warning: null, ...(runStopped ? { runStopped: true } : {}) };
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
