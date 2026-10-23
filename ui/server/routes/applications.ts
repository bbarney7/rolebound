import { Router, type Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getApplication, listApplications } from "../union";
import { readJobFile } from "../readers/jobFiles";
import { isSafeSlug, paths, type JobDir } from "../workspace";
import { parseRecordedJobFile } from "../../../.pi/extensions/lib/workspace-files";

export { parseRecordedJobFile };
import { readAccounts } from "../readers/credentials";
import { readUiState, updateUiState } from "../uiState";
import {
  PIPELINE_STATUSES,
  type Application,
  type ApplicationDetailPayload,
  type ATSAccount,
  type PipelineUpdateBody,
  type UiApplicationState,
} from "../../shared/types";

const BAD_SLUG = { error: "invalid slug" };
const NOT_FOUND = { error: "application not found" };
const SCREENSHOT_NOT_FOUND = { error: "screenshot not found" };
const ALLOWED_SCREENSHOT_EXT = new Set([".png", ".jpg", ".jpeg", ".svg"]);

function screenshotSecurityHeaders(res: Response, ext: string) {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  if (ext === ".svg") res.type("image/svg+xml");
}

async function isSafeEvidenceFile(fileReal: string): Promise<boolean> {
  const ext = path.extname(fileReal).toLowerCase();
  if (!ALLOWED_SCREENSHOT_EXT.has(ext)) return false;
  if (ext !== ".svg") return true;
  let content: string;
  try {
    content = await fs.readFile(fileReal, "utf8");
  } catch {
    return false;
  }
  if (/[<][\s]*script\b/i.test(content)) return false;
  if (/\bon\w+\s*=/i.test(content)) return false;
  if (/javascript:/i.test(content)) return false;
  if (/<foreignObject\b/i.test(content)) return false;
  return true;
}

export async function resolveScreenshotPath(root: string, recorded: string | null | undefined): Promise<string | null> {
  if (!recorded) return null;
  const normalized = recorded.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!normalized.startsWith("screenshots/")) return null;
  const filename = path.basename(normalized);
  if (!filename || filename === "." || filename === ".." || filename.includes("/")) return null;
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_SCREENSHOT_EXT.has(ext)) return null;
  const target = path.join(paths.screenshotsDir(root), filename);
  try {
    const rootReal = await fs.realpath(root);
    const dirReal = await fs.realpath(paths.screenshotsDir(root));
    const fileReal = await fs.realpath(target);
    if (!fileReal.startsWith(dirReal) || !dirReal.startsWith(rootReal)) return null;
    const info = await fs.lstat(fileReal);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if (!(await isSafeEvidenceFile(fileReal))) return null;
    return fileReal;
  } catch {
    return null;
  }
}

// isSafeSlug now lives in workspace.ts, next to the `paths` helpers whose
// interpolation it guards, so the queue router can share the one copy rather
// than growing a second that drifts. Behaviour is unchanged; the traversal
// tests at applications.test.ts:261-280 pin it.

/** D1: exact hostname match first, case-insensitive company fallback, at most one. */
export function findAccount(app: Application, accounts: ATSAccount[]): ATSAccount | null {
  let host: string | null = null;
  if (app.url) {
    try {
      host = new URL(app.url).hostname;
    } catch {
      host = null;
    }
  }
  if (host) {
    const byHost = accounts.find((a) => a.host === host);
    if (byHost) return byHost;
  }
  const company = app.company?.trim().toLowerCase();
  if (!company) return null;
  return accounts.find((a) => a.company?.trim().toLowerCase() === company) ?? null;
}

/**
 * Shared by GET /:slug and PATCH /:slug/pipeline so the two shapes cannot drift.
 *
 * Both job dirs are probed because the applier only moves a posting into
 * jobs/applied/ once it submits: a row still in_progress/blocked/aborted keeps
 * its posting in jobs/queue/ (state.json carries the path as `queue_file`).
 * Reading only `applied` reported "no job description was saved" for those rows
 * while the file sat one directory away — which is exactly the kind of
 * dishonest empty state the detail view exists to avoid. `applied` wins when
 * both exist, since that is the posting actually submitted against.
 */
async function buildDetail(root: string, app: Application): Promise<ApplicationDetailPayload> {
  // The recorded path wins over the slug-derived one because the applier does
  // not always name the queue file after the slug (`jobs/queue/0-<slug>.md`).
  // Both are probed so a stale or unparseable queue_file still degrades to the
  // conventional location rather than to nothing.
  const recorded = app.queueFile ? parseRecordedJobFile(app.queueFile) : null;
  const [appliedFile, recordedFile, derivedQueueFile, accounts, uiState] = await Promise.all([
    readJobFile(root, "applied", app.slug),
    recorded ? readJobFile(root, recorded.dir, recorded.slug) : Promise.resolve(null),
    readJobFile(root, "queue", app.slug),
    readAccounts(root),
    readUiState(root),
  ]);
  // bodySource must name the dir the body actually came from, not the lookup
  // slot that found it: `queue_file` may point into jobs/applied/ (the applier
  // repoints it on submit), and calling that "queue" would tell the user a
  // submitted application was never sent.
  let file = appliedFile;
  let bodySource: JobDir | null = appliedFile ? "applied" : null;
  if (!file && recordedFile && recorded) {
    file = recordedFile;
    bodySource = recorded.dir;
  }
  if (!file && derivedQueueFile) {
    file = derivedQueueFile;
    bodySource = "queue";
  }
  return {
    application: app,
    pipelineUpdatedAt: uiState.applications[app.slug]?.pipelineUpdatedAt ?? null,
    body: file?.body ?? null,
    bodySource,
    ats: file?.ats ?? null,
    reqId: file?.reqId ?? null,
    atsAccount: findAccount(app, accounts),
  };
}

export function applicationsRouter(root: string): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await listApplications(root));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:slug/screenshot", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json(BAD_SLUG);
        return;
      }
      const app = await getApplication(root, slug);
      if (!app?.screenshot) {
        res.status(404).json(SCREENSHOT_NOT_FOUND);
        return;
      }
      const file = await resolveScreenshotPath(root, app.screenshot);
      if (!file) {
        res.status(404).json(SCREENSHOT_NOT_FOUND);
        return;
      }
      screenshotSecurityHeaders(res, path.extname(file).toLowerCase());
      res.sendFile(file);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:slug", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json(BAD_SLUG);
        return;
      }
      const app = await getApplication(root, slug);
      if (!app) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      res.json(await buildDetail(root, app));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:slug/pipeline", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json(BAD_SLUG);
        return;
      }
      const body = (req.body ?? {}) as PipelineUpdateBody;
      const { pipelineStatus, userNotes } = body;
      // D14 — this is a PARTIAL update. An absent field is left untouched;
      // a field present with an explicit null is deleted. Destructuring
      // collapses both to a nullish value, so presence is read off the
      // parsed body directly. Without this, the status editor (which sends
      // only pipelineStatus) would wipe userNotes on every save.
      const hasStatus = Object.prototype.hasOwnProperty.call(body, "pipelineStatus");
      const hasNotes = Object.prototype.hasOwnProperty.call(body, "userNotes");
      if (
        pipelineStatus != null &&
        !(PIPELINE_STATUSES as readonly string[]).includes(pipelineStatus)
      ) {
        res.status(400).json({ error: "invalid pipelineStatus" });
        return;
      }
      if (userNotes != null && typeof userNotes !== "string") {
        res.status(400).json({ error: "invalid userNotes" });
        return;
      }
      if (!(await getApplication(root, slug))) {
        res.status(404).json(NOT_FOUND);
        return;
      }

      // Snapshot for the rollback below. It must be a SHALLOW COPY: when the
      // entry already exists, `entry` below is the very same object, so a
      // bare reference would be mutated along with it and roll nothing back.
      let previousEntry: UiApplicationState | undefined;

      // The mutator MUST stay synchronous. updateUiState types it
      // `(state: UiState) => void` and invokes it without await (uiState.ts:32),
      // so TypeScript's void-return bivariance would silently accept an `async`
      // mutator whose body then runs AFTER the fs.rename at uiState.ts:40 —
      // a write that disappears with no error anywhere.
      await updateUiState(root, (state) => {
        const existing = state.applications[slug];
        previousEntry = existing ? { ...existing } : undefined;
        const entry = existing ?? {};
        if (hasStatus) {
          if (pipelineStatus == null) {
            delete entry.pipelineStatus;
            delete entry.pipelineUpdatedAt;
          } else {
            entry.pipelineStatus = pipelineStatus;
            entry.pipelineUpdatedAt = new Date().toISOString();
          }
        }
        if (hasNotes) {
          if (userNotes == null) delete entry.userNotes;
          else entry.userNotes = userNotes;
        }
        if (Object.keys(entry).length === 0) delete state.applications[slug];
        else state.applications[slug] = entry;
      });

      // Re-derive from scratch: clearing the status reverts the row to its
      // DERIVED value ("submitted" for submitted apps, union.ts:57), which the
      // client cannot compute without forking the derivation D10 exists to
      // prevent.
      const updated = await getApplication(root, slug);
      if (!updated) {
        // The row vanished between the pre-write check and here — the applier
        // rewrote state.json or moved jobs/applied/<slug>.md mid-request.
        //
        // Restore the PRE-REQUEST entry rather than deleting it: a failed write
        // must leave the world exactly as it found it. "Vanished" is not an
        // authoritative signal that the application is gone forever — it is
        // also what a mid-rewrite state.json looks like for a few
        // milliseconds — so deleting here would destroy a status the user may
        // have set weeks ago because one PATCH lost a race with a file write.
        // The cost of restoring is at worst a few orphan bytes in
        // ui-state.json, invisible to the UI because the row is not in the
        // union. The cost of deleting is real, unrecoverable user data.
        await updateUiState(root, (state) => {
          if (previousEntry === undefined) delete state.applications[slug];
          else state.applications[slug] = previousEntry;
        });
        res.status(404).json(NOT_FOUND);
        return;
      }
      res.json(await buildDetail(root, updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
