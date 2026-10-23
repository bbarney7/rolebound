import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { paths } from "./workspace";
import { withLock } from "./lock";
import { insertSection, type TextEditResult } from "./profileText";
import type { ProfileSectionId } from "../shared/types";

/**
 * The locked, atomic read-modify-write for `profile.md`, modelled on
 * `accountsWriter.ts` throughout — same lock, same tmp+rename, same
 * errors-as-data posture.
 *
 * EVERY EXPECTED FAILURE IS RETURNED AS DATA WITH THE BYTES UNTOUCHED, never
 * thrown: `app.ts` has no trailing error handler (`:53-63` answers
 * `entity.parse.failed` alone), so a throw becomes Express's HTML 500, which a
 * save form can only render as a bare status line.
 */

/**
 * Atomic replace, copied from `writeCredentials` (`accountsWriter.ts:163-175`)
 * with only the name and the payload changed.
 *
 * THE TEMP NAME MUST BE BOTH DOT-PREFIXED AND `.tmp`-SUFFIXED so `WATCH_IGNORED`
 * double-ignores it — `events.ts:15` (`/(^|[/\\])\..+/`) and `events.ts:20`
 * (`/\.tmp$/`) — leaving `fs.rename` as the only event the watcher sees. PID +
 * time + random so two processes cannot collide on the name.
 *
 * The text is written VERBATIM: no JSON.stringify analogue, no trailing-newline
 * normalization, no re-encoding. That is the whole point of this ticket's
 * writer — the file is prose the agent reads, and a byte it did not ask to
 * change must not change.
 *
 * The catch is what stops a failed write or rename from leaving a
 * `.profile.*.tmp` orphan behind; `{ force: true }` makes the cleanup a silent
 * no-op when the temp file was never created, so it cannot mask the real
 * failure, which is rethrown unchanged.
 */
export function profileTempPath(dir: string): string {
  return path.join(
    dir,
    `.profile.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
}

async function writeProfile(file: string, text: string): Promise<void> {
  const tmp = profileTempPath(path.dirname(file));
  try {
    // Keep the immediately previous valid profile recoverable before replacing it.
    await fs.copyFile(file, `${file}.bak`);
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Check the file's absence BEFORE locking, copying `credentialsFileMissing`
 * (`accountsWriter.ts:320-338`) INCLUDING ITS NON-SEEDING RULE.
 *
 * `withLock` requires the target to exist (`lock.ts:6`) and `proper-lockfile`
 * canonicalizes with `realpath`, so locking a missing path rejects ENOENT out
 * of the middleware as an HTML 500 on a save button. Creating the file so the
 * lock can be taken would turn "there is no profile" into "there is now an
 * empty profile" — a silent data event the user never asked for. The check is
 * advisory: if the file disappears between it and the lock, `withLock` still
 * rejects and the route still 500s, which is the correct answer for a file
 * deleted mid-request.
 */
export async function profileFileMissing(root: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(paths.profile(root));
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("profile.md must be a regular file inside the workspace"), { code: "UNSAFE_PROFILE" });
    return false;
  } catch (err: any) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }
}

const NO_PROFILE: TextEditResult = {
  ok: false,
  error: { code: "NO_PROFILE", message: "profile.md does not exist" },
};

type Mutation = (md: string) => TextEditResult | Promise<TextEditResult>;

/**
 * The shared RMW, structurally identical to `mutateCredentials`
 * (`accountsWriter.ts:194-237`): refuse a missing file first, then lock, then
 * READ INSIDE THE LOCK, mutate, and write atomically.
 */
export async function mutateProfile(root: string, mutate: Mutation, expectedRevision?: string): Promise<TextEditResult> {
  if (await profileFileMissing(root)) return NO_PROFILE;
  const file = paths.profile(root);
  return withLock(file, async () => {
    const md = await fs.readFile(file, "utf-8");
    if (expectedRevision !== undefined && createHash("sha256").update(md).digest("hex") !== expectedRevision) {
      return { ok: false, error: { code: "CONFLICT", message: "profile.md changed since this form was loaded" } };
    }
    const outcome = await mutate(md);
    if (!outcome.ok) return outcome;
    await writeProfile(file, outcome.text);
    return outcome;
  });
}

async function readTemplate(root: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(paths.profileTemplate(root));
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("profile template must be a regular file inside the workspace"), { code: "UNSAFE_TEMPLATE" });
    return await fs.readFile(paths.profileTemplate(root), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

const NO_TEMPLATE: TextEditResult = {
  ok: false,
  error: { code: "NO_TEMPLATE", message: "templates/profile.template.md is missing" },
};

/**
 * The missing-file path, and the one place `withLock` cannot be used because
 * the file it would lock does not exist.
 *
 * `wx` IS ITSELF THE ATOMIC EXCLUSIVE-CREATE PRIMITIVE — the kernel guarantees
 * exactly one winner — so it needs no lock, and `EEXIST` maps to `EXISTS`
 * rather than to a race. The template bytes are written verbatim, trailing
 * newline included.
 */
export async function createProfileFromTemplate(root: string): Promise<TextEditResult> {
  const template = await readTemplate(root);
  if (template === null) return NO_TEMPLATE;
  const { atomicCreateFile } = await import("../../.pi/extensions/lib/durable-store");
  try {
    await atomicCreateFile(paths.profile(root), template, { mode: 0o644 });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return { ok: false, error: { code: "EXISTS", message: "profile.md already exists" } };
    }
    throw err;
  }
  return { ok: true, text: template };
}

/** Append a missing section, in template order. The template is read INSIDE the lock. */
export async function addSection(root: string, id: ProfileSectionId): Promise<TextEditResult> {
  return mutateProfile(root, async (md) => {
    const template = await readTemplate(root);
    if (template === null) return NO_TEMPLATE;
    return insertSection(md, id, template);
  });
}
