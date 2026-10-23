import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, readJsonFile, withFileLock, WorkspaceFileError } from "./durable-store";
import { parseSettingsText, resolveMaxPaidTasksPerDay } from "./captcha";
import { workspaceFilePath } from "./workspace-files";

export const CAPTCHA_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CaptchaSpendTask = { at: number; slug: string; provider: string };

export type CaptchaSpendFile = { tasks: CaptchaSpendTask[] };

function spendPath(root: string): string {
  return workspaceFilePath(root, "captchaSpend");
}

export function parseCaptchaSpendText(text: string, file: string): CaptchaSpendFile {
  if (text.trim() === "") {
    throw new WorkspaceFileError("CORRUPT", file, `${file} is empty`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkspaceFileError("CORRUPT", file, `${file} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceFileError("CORRUPT", file, `${file} must be a JSON object`);
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    throw new WorkspaceFileError("CORRUPT", file, `${file} tasks must be an array`);
  }
  for (const row of tasks) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new WorkspaceFileError("CORRUPT", file, `${file} task entries must be objects`);
    }
    const { at, slug, provider } = row as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new WorkspaceFileError("CORRUPT", file, `${file} task.at must be a number`);
    }
    if (typeof slug !== "string" || !slug.trim()) {
      throw new WorkspaceFileError("CORRUPT", file, `${file} task.slug must be a string`);
    }
    if (typeof provider !== "string" || !provider.trim()) {
      throw new WorkspaceFileError("CORRUPT", file, `${file} task.provider must be a string`);
    }
  }
  return { tasks: tasks as CaptchaSpendTask[] };
}

function pruneTasks(tasks: CaptchaSpendTask[], now: number): CaptchaSpendTask[] {
  const cutoff = now - CAPTCHA_SPEND_WINDOW_MS;
  return tasks.filter((t) => t.at > cutoff);
}

export function formatDailyCapFreesAt(oldestInWindowAt: number): string {
  return new Date(oldestInWindowAt + CAPTCHA_SPEND_WINDOW_MS).toISOString();
}

export type ReservePaidTaskParams = {
  slug: string;
  provider: string;
  settingsPath: string;
  env?: NodeJS.ProcessEnv;
};

export type ReservePaidTaskResult =
  | { ok: true }
  | { ok: false; code: "budget_exhausted"; cap: "daily" | "corrupt"; error: string; freesAt?: string };

export async function countPaidTasksInWindow(root: string, now: number): Promise<number> {
  const file = spendPath(root);
  const read = await readJsonFile(file, (text) => parseCaptchaSpendText(text, file));
  if (read.state === "missing") return 0;
  return pruneTasks(read.value.tasks, now).length;
}

/** Fail closed when the spend file exists but is corrupt. */
export async function inspectCaptchaSpendFile(root: string): Promise<void> {
  const file = spendPath(root);
  try {
    const read = await readJsonFile(file, (text) => parseCaptchaSpendText(text, file));
    if (read.state === "missing") return;
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") throw err;
    throw err;
  }
}

export async function reservePaidTask(
  root: string,
  now: number,
  params: ReservePaidTaskParams,
): Promise<ReservePaidTaskResult> {
  const file = spendPath(root);
  const env = params.env ?? process.env;
  let maxPerDay: number;
  try {
    const text = await fs.readFile(params.settingsPath, "utf-8").catch(() => "");
    const parsed = text.trim() === "" ? { captcha: { provider: "off" as const, api_key: "" } } : parseSettingsText(text);
    maxPerDay = resolveMaxPaidTasksPerDay(parsed.captcha);
  } catch {
    maxPerDay = resolveMaxPaidTasksPerDay({ provider: "off", api_key: "" });
  }

  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(file, JSON.stringify({ tasks: [] }, null, 2), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  try {
    return await withFileLock(file, async () => {
      let tasks: CaptchaSpendTask[] = [];
      try {
        const read = await readJsonFile(file, (text) => parseCaptchaSpendText(text, file));
        if (read.state === "ok") tasks = read.value.tasks;
      } catch (err) {
        if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
          return {
            ok: false,
            code: "budget_exhausted",
            cap: "corrupt",
            error: `${err.file} is corrupt; paid CAPTCHA tasks are blocked until you repair it.`,
          };
        }
        throw err;
      }

      const pruned = pruneTasks(tasks, now);
      if (pruned.length >= maxPerDay) {
        const oldest = pruned.reduce((m, t) => (t.at < m ? t.at : m), pruned[0]?.at ?? now);
        const freesAt = formatDailyCapFreesAt(oldest);
        return {
          ok: false,
          code: "budget_exhausted",
          cap: "daily",
          error: `Daily paid CAPTCHA task cap (${maxPerDay} per rolling 24 hours) is exhausted; next slot frees at ${freesAt}.`,
          freesAt,
        };
      }

      pruned.push({ at: now, slug: params.slug, provider: params.provider });
      await atomicWriteFile(file, JSON.stringify({ tasks: pruned }, null, 2), { mode: 0o600 });
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      return {
        ok: false,
        code: "budget_exhausted",
        cap: "corrupt",
        error: `${err.file} is corrupt; paid CAPTCHA tasks are blocked until you repair it.`,
      };
    }
    throw err;
  }
}
