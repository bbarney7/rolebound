import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { paths } from "./workspace";
import {
  isValidTargetSlug,
  normalizeTargetSlug,
  type TargetEntry,
  type TargetSource,
  TARGET_SOURCES,
} from "../shared/discovery";
import { parseTargetsMarkdown, renderTargetsMarkdown } from "./readers/targets";

export class TargetsRevisionConflictError extends Error {
  code = "REVISION_CONFLICT" as const;
}

export class TargetsValidationError extends Error {
  code = "CONFIG_INVALID" as const;
}

function validateEntries(entries: TargetEntry[]): TargetEntry[] {
  const out: TargetEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new TargetsValidationError("invalid target entry");
    if (!TARGET_SOURCES.includes(entry.source)) throw new TargetsValidationError(`unsupported target source: ${String(entry.source)}`);
    const slug = normalizeTargetSlug(String(entry.slug ?? ""));
    if (!isValidTargetSlug(slug)) throw new TargetsValidationError(`invalid ATS slug: ${slug || "<empty>"}`);
    const key = `${entry.source}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: entry.source as TargetSource, slug });
  }
  return out;
}

function tempPath(dir: string): string {
  return path.join(dir, `.targets.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
}

function targetsLockPath(file: string): string {
  return `${file}.lock`;
}

function revisionFor(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type TargetsWriteState =
  | { exists: true; text: string; revision: string }
  | { exists: false; text: string };

async function templateBaseline(root: string): Promise<string> {
  return fs.readFile(path.join(root, "templates", "targets.template.md"), "utf8").catch(() => "# Gather targets\n");
}

/** Mirrors `readTargets` existence/revision semantics without creating the file. */
async function readTargetsWriteState(root: string, file: string): Promise<TargetsWriteState> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new TargetsValidationError("targets.md must not be a symlink");
    if (!stat.isFile()) throw new TargetsValidationError("targets.md must be a regular file");
    const text = await fs.readFile(file, "utf8");
    return { exists: true, text, revision: revisionFor(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false, text: await templateBaseline(root) };
    }
    throw error;
  }
}

function assertExpectedRevision(state: TargetsWriteState, expectedRevision: string | null): void {
  if (state.exists) {
    if (expectedRevision !== state.revision) {
      throw new TargetsRevisionConflictError("targets changed; reload and retry");
    }
    return;
  }
  if (expectedRevision !== null) {
    throw new TargetsRevisionConflictError("targets changed; reload and retry");
  }
}

export async function writeTargets(root: string, entries: TargetEntry[], expectedRevision: string | null): Promise<{ revision: string; text: string; entries: TargetEntry[] }> {
  const normalized = validateEntries(entries);
  const file = paths.targets(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lockPath = targetsLockPath(file);
  await fs.appendFile(lockPath, "");
  return withLock(lockPath, async () => {
    const state = await readTargetsWriteState(root, file);
    assertExpectedRevision(state, expectedRevision);
    const nextText = renderTargetsMarkdown(state.text, normalized);
    const dir = path.dirname(file);
    if (!state.exists) {
      try {
        await fs.writeFile(file, nextText, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new TargetsRevisionConflictError("targets changed; reload and retry");
        }
        throw error;
      }
    } else {
      const tmp = tempPath(dir);
      try {
        await fs.writeFile(tmp, nextText, { mode: 0o600 });
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
    }
    return {
      text: nextText,
      entries: parseTargetsMarkdown(nextText),
      revision: revisionFor(nextText),
    };
  });
}
