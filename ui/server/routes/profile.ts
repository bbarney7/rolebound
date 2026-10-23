import { writeResume } from "../../../.pi/extensions/lib/resume-writer";
import { Router, type Request, type Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Busboy from "busboy";
import { paths } from "../workspace";
import { withLock } from "../lock";
import { withResumeRunGuard } from "../runConfig";
import { readProfile } from "../readers/profile";
import { readAddresses, readResumes } from "../readers/library";
import {
  addSection,
  createProfileFromTemplate,
  mutateProfile,
} from "../profileWriter";
import {
  hasTopLevelHeading,
  replaceCandidateSummaryBody,
  replaceSectionBody,
  setBulletValues,
  type ProfileWriteError,
} from "../profileText";
import {
  PROFILE_EDITABLE_SECTION_IDS,
  type ProfileBulletsUpdateBody,
  type ProfileBodyUpdateBody,
  type ProfileEditableSectionId,
  type ProfileMutationResult,
  type AddressUpdateBody,
} from "../../shared/types";
import { CANDIDATE_SUMMARY_MAX_LENGTH } from "../../shared/profilePlaceholders";

/**
 * THE PROFILE ROUTES READ `profile.md`, `templates/`, `resumes/` (names and
 * stat only) and `state.json.addresses`. `credentials.json` IS NEVER OPENED —
 * AC 7, encoded as a standing invariant in `__tests__/api.test.ts`'s sentinel
 * list rather than left as an observation here.
 *
 * Three factories in one file, matching `accountsRouter` (`routes/accounts.ts:176`).
 * They are separate mounts rather than fields of `GET /api/profile` (Q5)
 * because they are different stores with separate revision and safety rules.
 */

/** The `body` cap. `express.json()`'s own 100kb default sits above it. */
const MAX_BODY_LENGTH = 64 * 1024;

/** Matches `accounts.ts`'s MAX_TEXT_LENGTH — one line of prose in a bullet. */
const MAX_BULLET_LENGTH = 512;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export interface ResumeRouteOptions { isRunActive?: () => boolean; }

/** The three sections this ticket can write; add is offered exactly where edit is. */
const EDITABLE: readonly string[] = PROFILE_EDITABLE_SECTION_IDS;

/** The Q&A bank is a raw textarea (Decision 2), so bullets are the other two. */
const BULLET_SECTIONS: readonly string[] = ["identity", "resume", "searchPreferences"];

/**
 * The one place the writer's codes become statuses, shared by all four mutation
 * routes so they cannot drift route by route (the shape `accounts.ts:83-85`
 * uses). `SECTION_EXISTS` and `EXISTS` are two different 409s: "that section is
 * already in the file" and "profile.md is already on disk".
 */
function writeErrorStatus(code: ProfileWriteError["code"]): number {
  if (code === "NO_SECTION") return 404;
  if (code === "BAD_BODY") return 400;
  return 409;
}

function sendWriteError(res: Response, error: ProfileWriteError): void {
  const body: { error: string; field?: string } = { error: error.message };
  if (error.code === "BAD_BODY") body.field = "body";
  res.status(writeErrorStatus(error.code)).json(body);
}

/** Every mutation answers with the RE-DERIVED payload, never `{ok:true}`. */
async function mutationResult(root: string): Promise<ProfileMutationResult> {
  return { profile: await readProfile(root) };
}

function sectionParam(req: Request): string | null {
  const id = req.params.id;
  return typeof id === "string" && id !== "" ? id : null;
}

export function profileRouter(root: string): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await readProfile(root));
    } catch (err) {
      next(err);
    }
  });

  /** Create `profile.md` from the template (Q1). `wx` is the atomic primitive. */
  router.post("/", async (_req, res, next) => {
    try {
      const result = await createProfileFromTemplate(root);
      if (!result.ok) {
        sendWriteError(res, result.error);
        return;
      }
      res.status(201).json(await mutationResult(root));
    } catch (err) {
      next(err);
    }
  });

  /** Add a section that is absent, in `templates/profile.template.md` order. */
  router.post("/sections/:id", async (req, res, next) => {
    try {
      const id = sectionParam(req);
      if (id === null || !EDITABLE.includes(id)) {
        res.status(400).json({ error: "section is not editable", field: "id" });
        return;
      }
      const result = await addSection(root, id as ProfileEditableSectionId);
      if (!result.ok) {
        sendWriteError(res, result.error);
        return;
      }
      res.json(await mutationResult(root));
    } catch (err) {
      next(err);
    }
  });

  /**
   * Validation order, matching `accounts.ts`: shape → length → whitelist →
   * filesystem. The filesystem call is always last and its result is mapped
   * through `writeErrorStatus`.
   *
   * PRESENCE DETECTION COPIES `accounts.ts:342-357` EXACTLY — `hasOwnProperty`,
   * a `present` counter, and the `no fields to update` refusal. Destructuring
   * cannot tell absent from null-valued, and two of the last three commits on
   * `main` (`5eaede0`, `2abba75`) exist purely to fix that class of bug.
   */
  router.patch("/sections/:id/bullets", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<ProfileBulletsUpdateBody>;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        typeof body.bullets !== "object" ||
        body.bullets === null ||
        Array.isArray(body.bullets)
      ) {
        res.status(400).json({ error: "bullets must be an object", field: "bullets" });
        return;
      }
      if (!(body.revision === null || (typeof body.revision === "string" && body.revision.length === 64))) { res.status(428).json({ error: "profile revision is required", field: "revision" }); return; }

      const bullets = body.bullets as Record<string, unknown>;
      const has = (key: string) => Object.prototype.hasOwnProperty.call(bullets, key);
      const values: Record<string, string | null> = {};
      let present = 0;

      for (const key of Object.keys(bullets)) {
        if (!has(key)) continue;
        present++;
        const value = bullets[key];
        if (value === null) {
          values[key] = null;
          continue;
        }
        if (typeof value !== "string") {
          res.status(400).json({ error: `${key} must be a string or null`, field: "bullets" });
          return;
        }
        if (value.length > MAX_BULLET_LENGTH) {
          res.status(400).json({
            error: `${key} must be ${MAX_BULLET_LENGTH} characters or fewer`,
            field: "bullets",
          });
          return;
        }
        // A bullet is ONE LINE, and the writer splices raw text into it. A
        // newline would turn one bullet into two lines of markdown the reader
        // then cannot address, so it is refused rather than written.
        if (/[\n\r]/.test(value)) {
          res.status(400).json({
            error: `${key} must not contain a line break`,
            field: "bullets",
          });
          return;
        }
        values[key] = value;
      }

      const id = sectionParam(req);
      if (id === null || !BULLET_SECTIONS.includes(id)) {
        res.status(400).json({ error: "section is not editable", field: "id" });
        return;
      }

      if (present === 0) {
        res.status(400).json({ error: "no fields to update" });
        return;
      }

      const result = await mutateProfile(
        root,
        (md) => setBulletValues(md, id as ProfileEditableSectionId, values),
        typeof body.revision === "string" ? body.revision : undefined,
      );
      if (!result.ok) {
        sendWriteError(res, result.error);
        return;
      }
      res.json(await mutationResult(root));
    } catch (err) {
      next(err);
    }
  });

  /** The Q&A bank only: raw markdown in, raw markdown out, nothing interpreted. */
  router.put("/sections/:id/body", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<ProfileBodyUpdateBody>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "body must be a string", field: "body" });
        return;
      }
      if (typeof body.body !== "string") {
        res.status(400).json({ error: "body must be a string", field: "body" });
        return;
      }
      if (!(body.revision === null || (typeof body.revision === "string" && body.revision.length === 64))) { res.status(428).json({ error: "profile revision is required", field: "revision" }); return; }
      if (body.body.length > MAX_BODY_LENGTH) {
        res.status(400).json({
          error: `body must be ${MAX_BODY_LENGTH} characters or fewer`,
          field: "body",
        });
        return;
      }
      // The same comment-removed heading test the writer uses, run here so the
      // filesystem call stays last in the validation order.
      if (hasTopLevelHeading(body.body)) {
        res.status(400).json({
          error: "body must not contain a `#` or `##` heading — it would create a new section",
          field: "body",
        });
        return;
      }

      const id = sectionParam(req);
      if (
        id === null ||
        ![
          "qaBank",
          "resumeRegionRules",
          "cityRules",
          "cityNormalization",
          "addressPolicy",
          "workHistory",
          "education",
          "authorization",
          "candidateSummary",
        ].includes(id)
      ) {
        res.status(400).json({ error: "section is not editable", field: "id" });
        return;
      }

      const text = body.body;
      if (id === "candidateSummary" && text.length > CANDIDATE_SUMMARY_MAX_LENGTH) {
        res.status(400).json({
          error: `body must be ${CANDIDATE_SUMMARY_MAX_LENGTH} characters or fewer`,
          field: "body",
        });
        return;
      }
      const templateMd = id === "candidateSummary"
        ? await fs.readFile(paths.profileTemplate(root), "utf8").catch(() => "")
        : "";
      const result = await mutateProfile(
        root,
        (md) =>
          id === "candidateSummary"
            ? replaceCandidateSummaryBody(md, text, templateMd)
            : replaceSectionBody(md, id as ProfileEditableSectionId, text),
        typeof body.revision === "string" ? body.revision : undefined,
      );
      if (!result.ok) {
        sendWriteError(res, result.error);
        return;
      }
      res.json(await mutationResult(root));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function resumesRouter(root: string, options: ResumeRouteOptions = {}): Router {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await readResumes(root));
    } catch (err) {
      next(err);
    }
  });
  router.post("/", async (req, res, next) => {
    try {
      const contentType = req.header("content-type") ?? "";
      if (!/^multipart\/form-data\s*;/i.test(contentType)) { res.status(415).json({ error: "resume upload must use multipart/form-data", field: "file" }); return; }
      const parsed = await parseResumeUpload(req);
      if (!parsed.ok) { res.status(parsed.status).json({ error: parsed.error, field: "file" }); return; }
      const { filename, bytes, replace } = parsed;
      if (options.isRunActive?.() === true) { res.status(409).json({ error: "Cannot change a resume while a run is active", code: "RUN_BUSY" }); return; }
      const outcome = await withResumeRunGuard(root, () => writeResume(root, filename, bytes, replace, () => options.isRunActive?.() === true));
      if ("error" in outcome) { res.status(409).json({ error: outcome.error, code: outcome.code, field: "file" }); return; }
      const existed = outcome.existed;
      res.status(existed ? 200 : 201).json({ ...(await readResumes(root)), uploaded: filename, replaced: existed });
    } catch (err) { next(err); }
  });
  router.put("/selection", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { filename?: unknown; mode?: unknown; revision?: unknown; replace?: unknown };
      if (typeof body.filename !== "string" || path.basename(body.filename) !== body.filename || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/i.test(body.filename)) { res.status(400).json({ error: "choose a safe PDF filename", field: "filename" }); return; }
      if (body.mode !== "default" && body.mode !== "override") { res.status(400).json({ error: "mode must be default or override", field: "mode" }); return; }
      if (typeof body.revision !== "string" || body.revision.length !== 64) { res.status(428).json({ error: "profile revision is required", field: "revision" }); return; }
      const result = await withResumeRunGuard(root, async () => {
        if (options.isRunActive?.() === true) return { status: 409, body: { error: "Cannot change resume selection while a run is active", code: "RUN_BUSY" } };
        const dir = paths.resumesDir(root); const source = path.join(dir, body.filename as string);
        let stat; try { stat = await fs.lstat(source); } catch { return { status: 404, body: { error: "selected resume does not exist", field: "filename" } }; }
        if (stat.isSymbolicLink() || !stat.isFile()) return { status: 409, body: { error: "selected resume is unsafe", field: "filename" } };
        const head = Buffer.alloc(5); const handle = await fs.open(source, "r"); try { await handle.read(head, 0, 5, 0); } finally { await handle.close(); }
        if (!head.equals(Buffer.from("%PDF-"))) return { status: 415, body: { error: "selected resume is not a PDF", field: "filename" } };
        if (body.mode === "override") {
          const changed = await mutateProfile(root, (md) => setBulletValues(md, "resume", { "resume path": `resumes/${body.filename}` }), body.revision as string);
          if (!changed.ok) return { status: writeErrorStatus(changed.error.code), body: { error: changed.error.message } };
        } else if (body.filename !== "default.pdf") {
          const target = path.join(dir, "default.pdf");
          if (body.replace !== true) { try { await fs.lstat(target); return { status: 409, body: { error: "default.pdf exists; confirm replacement", code: "REPLACE_REQUIRED" } }; } catch {} }
          const selected = await writeResume(root, "default.pdf", await fs.readFile(source), true);
          if ("error" in selected) return { status: 409, body: { error: selected.error } };
        }
        return { status: 200, body: { profile: await readProfile(root), resumes: await readResumes(root) } };
      });
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  });
  return router;
}

type UploadParse = { ok: true; filename: string; bytes: Buffer; replace: boolean } | { ok: false; status: number; error: string };
function parseResumeUpload(req: Request): Promise<UploadParse> {
  return new Promise((resolve) => {
    let settled = false; let filename = ""; let mime = ""; let file: Buffer | null = null; let replace = false; let files = 0;
    const finish = (value: UploadParse) => { if (!settled) { settled = true; resolve(value); } };
    let bb: ReturnType<typeof Busboy>;
    try { bb = Busboy({ headers: req.headers, preservePath: true, limits: { fileSize: MAX_RESUME_BYTES, files: 1, fields: 4, parts: 5, headerPairs: 100 } }); }
    catch { finish({ ok: false, status: 400, error: "invalid multipart request" }); return; }
    bb.on("field", (name, value) => { if (name === "replace") replace = value === "true"; });
    bb.on("file", (name, stream, info) => {
      files++; const chunks: Buffer[] = [];
      if (name !== "file") { stream.resume(); return; }
      filename = info.filename; mime = info.mimeType;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => finish({ ok: false, status: 413, error: "resume exceeds 10 MiB" }));
      stream.on("end", () => { file = Buffer.concat(chunks); });
    });
    bb.on("filesLimit", () => finish({ ok: false, status: 400, error: "exactly one file is required" }));
    bb.on("fieldsLimit", () => finish({ ok: false, status: 400, error: "too many form fields" }));
    bb.on("partsLimit", () => finish({ ok: false, status: 400, error: "too many multipart parts" }));
    bb.on("error", () => finish({ ok: false, status: 400, error: "invalid multipart request" }));
    bb.on("close", () => {
      if (settled) return;
      if (files !== 1 || file === null) return finish({ ok: false, status: 400, error: "exactly one file is required" });
      if (!filename || path.basename(filename) !== filename || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/i.test(filename)) return finish({ ok: false, status: 400, error: "use a safe PDF filename" });
      if (mime !== "application/pdf") return finish({ ok: false, status: 415, error: "resume must have application/pdf content type" });
      if (file.length < 5 || !file.subarray(0, 5).equals(Buffer.from("%PDF-"))) return finish({ ok: false, status: 415, error: "resume is not a valid PDF" });
      finish({ ok: true, filename, bytes: file, replace });
    });
    req.pipe(bb);
  });
}

export function addressesRouter(root: string, options: ResumeRouteOptions = {}): Router {
  const router = Router();
  /**
   * ALWAYS 200, INCLUDING WHEN `state.json` IS CORRUPT. `readState` uses the
   * strict workspace parser, and with no trailing error
   * handler in `app.ts` an escaping throw becomes an HTML 500 — which would
   * fail the sentinel loop in `__tests__/api.test.ts` that asserts 200 for
   * every listed route. `readAddresses` turns both failure modes into
   * `stateJsonReadable: false`. Errors as data, exactly as the writer does.
   */
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await readAddresses(root));
    } catch (err) {
      next(err);
    }
  });
  router.put("/:key", async (req, res, next) => {
    try {
      if (options.isRunActive?.() === true) { res.status(409).json({ error: "Cannot change saved addresses while a run is active", code: "RUN_BUSY" }); return; }
      const key = req.params.key;
      if (typeof key !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key)) { res.status(400).json({ error: "invalid address key", field: "key" }); return; }
      const body = (req.body ?? {}) as Partial<AddressUpdateBody>;
      if (!(body.revision === null || (typeof body.revision === "string" && body.revision.length === 64))) { res.status(428).json({ error: "address revision is required", field: "revision" }); return; }
      for (const field of ["street", "city", "state", "zip"] as const) {
        if (typeof body[field] !== "string" || !body[field]!.trim() || body[field]!.length > 200 || /[\r\n]/.test(body[field]!)) { res.status(400).json({ error: `${field} is required and must be one line`, field }); return; }
      }
      const file = paths.stateJson(root); await fs.mkdir(path.dirname(file), { recursive: true });
      try { const stat = await fs.lstat(file); if (stat.isSymbolicLink() || !stat.isFile()) { res.status(409).json({ error: "state.json is unsafe" }); return; } } catch (error: any) { if (error?.code !== "ENOENT") throw error; await fs.writeFile(file, "{}\n", { flag: "wx", mode: 0o600 }); }
      await withLock(file, async () => {
        if (options.isRunActive?.() === true) throw Object.assign(new Error("Cannot change saved addresses while a run is active"), { code: "RUN_BUSY" });
        const rawText = await fs.readFile(file, "utf8");
        if (body.revision !== null && createHash("sha256").update(rawText).digest("hex") !== body.revision) throw Object.assign(new Error("state.json changed since addresses were loaded"), { code: "REVISION_CONFLICT" });
        const raw = JSON.parse(rawText) as Record<string, any>;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("state.json must be an object");
        if (raw.addresses !== undefined && (!raw.addresses || typeof raw.addresses !== "object" || Array.isArray(raw.addresses))) throw new TypeError("state.json addresses must be an object");
        const addresses = raw.addresses ?? {};
        raw.addresses = { ...addresses, [key]: { street: body.street!.trim(), city: body.city!.trim(), state: body.state!.trim(), zip: body.zip!.trim() } };
        const tmp = path.join(path.dirname(file), `.state.${process.pid}.${Date.now()}.tmp`);
        try { await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await fs.rename(tmp, file); } finally { await fs.rm(tmp, { force: true }); }
      });
      res.json(await readAddresses(root));
    } catch (error: any) { if (error?.code === "RUN_BUSY") { res.status(409).json({ error: error.message, code: "RUN_BUSY" }); return; } if (error?.code === "REVISION_CONFLICT") { res.status(409).json({ error: error.message, code: "REVISION_CONFLICT" }); return; } if (error instanceof SyntaxError || error instanceof TypeError) { res.status(409).json({ error: "state.json must be repaired before saving an address" }); return; } next(error); }
  });
  return router;
}
