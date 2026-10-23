import { promises as fs } from "node:fs";
import path from "node:path";
import { paths } from "./workspace";
import { withLock } from "./lock";
import {
  parseSettingsText,
  SettingsShapeError,
  type CaptchaFileSettings,
} from "../../.pi/extensions/lib/captcha";

/**
 * settings.json: read and locked read-modify-write via shared `withFileLock`
 * (D4). The parse rule is the library's, so the extension and the UI can
 * never disagree about what the file means.
 */

export interface SettingsFile {
  raw: Record<string, unknown>;
  captcha: CaptchaFileSettings;
  warnings: string[];
}

/** ENOENT is a fresh clone, not an error. Corrupt files throw, like credentials. */
export async function readSettingsFile(root: string): Promise<SettingsFile> {
  let text: string;
  try {
    text = await fs.readFile(paths.settings(root), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: {}, captcha: { provider: "off", api_key: "", max_paid_tasks_per_day: 20 }, warnings: [] };
    }
    throw err;
  }
  return parseSettingsText(text);
}

export type SettingsWriteResult =
  | { ok: true }
  | { ok: false; error: { code: "PARSE" | "SHAPE"; message: string } };

async function writeAtomically(file: string, next: Record<string, unknown>): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.settings.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    // The scaffolder chmods the file 600 (scripts/init-workspace.sh); rename()
    // carries the temp file's own mode over it, so the atomic rename must not
    // widen that by creating the temp file with the process's default mode.
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Replace the `captcha` block, keeping every other top-level key. A corrupt
 * file is refused as data so the form can say why — the bytes are never
 * touched.
 *
 * proper-lockfile needs a target that already exists, so a missing file is
 * first seeded with an exclusive ("wx") write of `{}`. A lost race on the
 * seed is fine: EEXIST just means another writer — another process, or an
 * earlier concurrent call to this same function — got there first. EVERY
 * writer, including the seeder, then goes through the SAME locked
 * read-modify-write below, the accountsWriter.ts `createAccountEntry`
 * pattern applied to a second file. That is what closes the lost-write
 * hazard: without it, two first-time saves against an absent settings.json
 * could both take the "create" branch, both report `{ ok: true }`, and one
 * writer's block would silently overwrite the other's outside any lock.
 */
export async function writeCaptchaSettings(root: string, next: CaptchaFileSettings): Promise<SettingsWriteResult> {
  const file = paths.settings(root);
  try {
    // Same 600-not-644 reason as writeAtomically's temp file: a first-time
    // seed must not create the file more readable than the scaffolder does.
    await fs.writeFile(file, "{}", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return withLock(file, async () => {
    let parsed: SettingsFile;
    try {
      parsed = parseSettingsText(await fs.readFile(file, "utf-8"));
    } catch (err) {
      if (err instanceof SettingsShapeError) return { ok: false, error: { code: "SHAPE", message: err.message } };
      if (err instanceof SyntaxError) return { ok: false, error: { code: "PARSE", message: "settings.json is not valid JSON" } };
      throw err;
    }
    await writeAtomically(file, { ...parsed.raw, captcha: next });
    return { ok: true };
  });
}
