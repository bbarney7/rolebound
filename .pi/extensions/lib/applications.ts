import { resolveQueueSlug } from "./queue-slug";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  atomicCreateFile,
  atomicWriteFile,
  mutateJsonFile,
  NO_CHANGE,
  readJsonFile,
  withFileLock,
  WorkspaceFileError,
} from "./durable-store";
import { moveJobFileNoClobber } from "./job-files";
import { corruptFileRecoveryMessage } from "./accounts-store";
import {
  isSafeSlug,
  parseStateText,
  resolveApplicationQueueSource,
  WORKSPACE_FILES,
  type ParsedStateJson,
} from "./workspace-files";
import { WORKSPACE, wsPath } from "./workspace";

function resolveRoot(root?: string): string {
  return root ?? WORKSPACE;
}

function stateFile(root?: string): string {
  return path.join(resolveRoot(root), WORKSPACE_FILES.state);
}

function appliedTrackerFile(root?: string): string {
  return path.join(resolveRoot(root), WORKSPACE_FILES.appliedTracker);
}

function jobPath(root: string, ...segments: string[]): string {
  return path.join(root, ...segments);
}
const SERIALIZE_STATE = (value: ParsedStateJson) => JSON.stringify(value, null, 2);

export type ApplicationRecord = Record<string, unknown>;

export function stateCorruptMessage(err: WorkspaceFileError): string {
  return corruptFileRecoveryMessage(err.file);
}

export async function readApplicationState(root?: string): Promise<ParsedStateJson> {
  const read = await readJsonFile(stateFile(root), parseStateText);
  if (read.state === "missing") {
    return { applications: [], addresses: {} };
  }
  return read.value;
}

export async function readApplicationStateStrict(): Promise<
  ParsedStateJson | { error: WorkspaceFileError }
> {
  try {
    return await readApplicationState();
  } catch (err) {
    if (err instanceof WorkspaceFileError) return { error: err };
    throw err;
  }
}

export type MutateApplicationStateParams = {
  slug: string;
  status?: string;
  reopenApproval?: { submitted_at: string | null };
  [key: string]: unknown;
};

export type MutateApplicationStateResult =
  | { ok: true; app: ApplicationRecord }
  | {
      ok: false;
      error:
        | WorkspaceFileError
        | { code: "SUBMITTED_LOCKED"; message: string }
        | { code: "OVERRIDE_REQUIRES_USER"; message: string };
    };

export async function mutateApplicationState(
  params: MutateApplicationStateParams,
  merge: (app: ApplicationRecord, existing: ApplicationRecord | undefined) => void,
): Promise<MutateApplicationStateResult> {
  try {
    const app = await mutateJsonFile(
      stateFile(),
      {
        parse: parseStateText,
        serialize: SERIALIZE_STATE,
        bootstrapBytes: JSON.stringify({ applications: [], addresses: {} }),
        mode: 0o600,
      },
      (state) => {
        const apps = state.applications as ApplicationRecord[];
        let app = apps.find((a) => a.slug === params.slug);
        const prior = app ? { ...app } : undefined;
        if (!app) {
          app = { slug: params.slug, attempts: [] };
          apps.push(app);
        }
        const reopening = prior?.status === "submitted" &&
          params.status !== undefined && params.status !== "submitted";
        if (reopening) {
          if (!params.reopenApproval) {
            throw Object.assign(new Error("submitted locked"), {
              code: "SUBMITTED_LOCKED",
              submitted_at: prior.submitted_at,
            });
          }
          if ((params.reopenApproval.submitted_at ?? null) !== (prior.submitted_at ?? null)) {
            throw Object.assign(new Error("override requires user"), {
              code: "OVERRIDE_REQUIRES_USER",
            });
          }
          if (prior.submitted_at !== undefined) {
            app.reopened_from_submitted_at = prior.submitted_at;
          }
          delete app.submitted_at;
          app.reopened_at = new Date().toISOString();
        }
        merge(app, prior);
        if (reopening) delete app.queue_file;
        if (params.status !== undefined) app.status = params.status;
        state.applications = apps;
        state.last_updated = new Date().toISOString();
        return state;
      },
    );
    const apps = app.applications as ApplicationRecord[];
    const entry = apps.find((a) => a.slug === params.slug);
    return { ok: true, app: entry ?? { slug: params.slug } };
  } catch (err: any) {
    if (err instanceof WorkspaceFileError) {
      return { ok: false, error: err };
    }
    if (err?.code === "SUBMITTED_LOCKED") {
      return {
        ok: false,
        error: {
          code: "SUBMITTED_LOCKED",
          message: `Application ${params.slug} is already submitted (${err.submitted_at ?? "unknown date"}). Reopening needs the user's confirmation (override_submitted).`,
        },
      };
    }
    if (err?.code === "OVERRIDE_REQUIRES_USER") {
      return {
        ok: false,
        error: {
          code: "OVERRIDE_REQUIRES_USER",
          message: "Reopening needs the user's confirmation (override_submitted).",
        },
      };
    }
    throw err;
  }
}

export async function setAcknowledgedAt(policy: string): Promise<MutateApplicationStateResult> {
  try {
    await mutateJsonFile(
      stateFile(),
      {
        parse: parseStateText,
        serialize: SERIALIZE_STATE,
        bootstrapBytes: JSON.stringify({ applications: [], addresses: {} }),
        mode: 0o600,
      },
      (state) => {
        state.acknowledged_at = new Date().toISOString();
        state.acknowledged_policy = policy;
        state.last_updated = new Date().toISOString();
        return state;
      },
    );
    return { ok: true, app: {} };
  } catch (err) {
    if (err instanceof WorkspaceFileError) return { ok: false, error: err };
    throw err;
  }
}

export async function mutateAddresses(
  fn: (addresses: Record<string, unknown>) => Record<string, unknown> | typeof NO_CHANGE,
): Promise<MutateApplicationStateResult> {
  try {
    await mutateJsonFile(
      stateFile(),
      {
        parse: parseStateText,
        serialize: SERIALIZE_STATE,
        bootstrapBytes: JSON.stringify({ applications: [], addresses: {} }),
        mode: 0o600,
      },
      (state) => {
        const addresses = { ...(state.addresses as Record<string, unknown>) };
        const out = fn(addresses);
        if (out === NO_CHANGE) return NO_CHANGE;
        state.addresses = out;
        state.last_updated = new Date().toISOString();
        return state;
      },
    );
    return { ok: true, app: {} };
  } catch (err) {
    if (err instanceof WorkspaceFileError) return { ok: false, error: err };
    throw err;
  }
}

export function renderTracker(state: ParsedStateJson): string {
  const apps = (state.applications as ApplicationRecord[]) || [];
  const rows: string[] = [];
  const statusCounts: Record<string, number> = {};

  for (let i = 0; i < apps.length; i++) {
    const a = apps[i];
    const status = String(a.status ?? "unknown");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const submitted = a.submitted_at
      ? new Date(String(a.submitted_at)).toISOString().split("T")[0]
      : "—";

    const loc = String(a.location_raw ?? "").replace(/\n/g, " ");

    let notes = "";
    const attempts = (a.attempts as ApplicationRecord[]) || [];
    const lastAttempt = attempts[attempts.length - 1];
    if (a.confirmation_source) {
      notes = `source=${String(a.confirmation_source)}`.replace(/\n/g, " ").slice(0, 80);
    } else if (a.block_reason) {
      notes = String(a.block_reason).replace(/\n/g, " ").slice(0, 80);
    } else if (lastAttempt?.notes) {
      notes = String(lastAttempt.notes).replace(/\n/g, " ").slice(0, 80);
    }
    if (notes.length > 78) notes += "…";

    rows.push(
      `| ${i + 1} | ${a.company ?? "?"} | ${a.title ?? "?"} | ${loc || "—"} | ${status} | ${submitted} | ${notes || "—"} |`,
    );
  }

  const statusRows = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `| ${s} | ${c} |`)
    .join("\n");

  return `# Job Application Tracker

Auto-generated from \`state.json\`. Do not edit manually — it will be overwritten.

| # | Company | Title | Location | Status | Submitted | Notes |
|---|---------|-------|----------|--------|-----------|-------|
${rows.join("\n")}

## Status counts

| Status | Count |
|--------|-------|
${statusRows}
`;
}

export async function regenerateAppliedTracker(root?: string): Promise<void> {
  const state = await readApplicationState(root);
  const md = renderTracker(state);
  const file = appliedTrackerFile(root);
  const exists = await fs.stat(file).catch(() => null);
  if (exists) {
    await atomicWriteFile(file, md);
  } else {
    await atomicCreateFile(file, md, { mode: 0o644 });
  }
}

export type CompleteApplicationResult =
  | { ok: true; queue_file: string }
  | {
      ok: false;
      code: "CORRUPT" | "NOT_SUBMITTED" | "NOT_FOUND" | "EEXIST" | "UNSAFE_SLUG" | "MOVE_FAILED";
      message: string;
    };

function resolveQueuePaths(
  root: string,
  slug: string,
  app: ApplicationRecord,
): { src: string; dst: string; alreadyAppliedOnly: boolean } {
  const dst = jobPath(root, "jobs", "applied", `${slug}.md`);
  const resolved = resolveApplicationQueueSource(root, slug, app.queue_file);
  if (resolved.kind === "already_applied") {
    return { src: resolved.appliedAbsolute, dst, alreadyAppliedOnly: true };
  }
  const src = resolved.kind === "queue" ? resolved.absolute : resolved.absolute;
  return { src, dst, alreadyAppliedOnly: false };
}

export type CompleteApplicationTestHooks = import("./job-files").MoveJobFileTestHooks & {
  afterMoveBeforeRepoint?: () => void | Promise<void>;
};

export async function completeApplication(
  slug: string,
  options: {
    root?: string;
    testHooks?: CompleteApplicationTestHooks;
    lockRetries?: number;
  } = {},
): Promise<CompleteApplicationResult> {
  const root = resolveRoot(options.root);
  const STATE_FILE = stateFile(root);
  if (!isSafeSlug(slug)) {
    return { ok: false, code: "UNSAFE_SLUG", message: `invalid slug: ${slug}` };
  }

  let queueFileDest = `jobs/applied/${slug}.md`;

  try {
    await withFileLock(
      STATE_FILE,
      async () => {
      const read = await readJsonFile(STATE_FILE, parseStateText);
      if (read.state === "missing") {
        throw new WorkspaceFileError("MISSING", STATE_FILE, "state.json is missing");
      }
      const state = read.value;
      const apps = state.applications as ApplicationRecord[];
      const app = apps.find((a) => a.slug === slug);
      if (!app || app.status !== "submitted") {
        throw Object.assign(new Error("not submitted"), { code: "NOT_SUBMITTED" });
      }

      const { src, dst, alreadyAppliedOnly } = resolveQueuePaths(root, slug, app);
      const srcExists = await fileExists(src);
      const dstExists = await fileExists(dst);

      if (alreadyAppliedOnly) {
        if (dstExists) {
          queueFileDest = `jobs/applied/${slug}.md`;
          app.queue_file = queueFileDest;
          state.applications = apps;
          state.last_updated = new Date().toISOString();
          await atomicWriteFile(STATE_FILE, SERIALIZE_STATE(state), { mode: 0o600 });
          return;
        }
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      }

      if (src === dst && srcExists) {
        queueFileDest = `jobs/applied/${slug}.md`;
        app.queue_file = queueFileDest;
        state.applications = apps;
        state.last_updated = new Date().toISOString();
        await atomicWriteFile(STATE_FILE, SERIALIZE_STATE(state), { mode: 0o600 });
        return;
      }

      if (!srcExists && dstExists) {
        queueFileDest = `jobs/applied/${slug}.md`;
        app.queue_file = queueFileDest;
        state.applications = apps;
        state.last_updated = new Date().toISOString();
        await atomicWriteFile(STATE_FILE, SERIALIZE_STATE(state), { mode: 0o600 });
        return;
      }

      if (!srcExists && !dstExists) {
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      }

      const move = await moveJobFileNoClobber(src, dst, {
        testHooks: options.testHooks
          ? {
              afterLink: options.testHooks.afterLink,
              beforeUnlink: options.testHooks.beforeUnlink,
            }
          : undefined,
      });
      if (!move.ok) {
        if (move.code === "NOT_FOUND" && dstExists) {
          queueFileDest = `jobs/applied/${slug}.md`;
          app.queue_file = queueFileDest;
          state.applications = apps;
          state.last_updated = new Date().toISOString();
          await atomicWriteFile(STATE_FILE, SERIALIZE_STATE(state), { mode: 0o600 });
          return;
        }
        throw Object.assign(new Error(move.message), { code: move.code });
      }

      if (options.testHooks?.afterMoveBeforeRepoint) {
        await options.testHooks.afterMoveBeforeRepoint();
      }

      queueFileDest = `jobs/applied/${slug}.md`;
      app.queue_file = queueFileDest;
      state.applications = apps;
      state.last_updated = new Date().toISOString();
      await atomicWriteFile(STATE_FILE, SERIALIZE_STATE(state), { mode: 0o600 });
    },
      options.lockRetries !== undefined ? { lockRetries: options.lockRetries } : {},
    );
  } catch (err: any) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      return { ok: false, code: "CORRUPT", message: stateCorruptMessage(err) };
    }
    if (err?.code === "ELOCKED") {
      throw err;
    }
    if (err?.code === "NOT_SUBMITTED") {
      return { ok: false, code: "NOT_SUBMITTED", message: `Application ${slug} must have status submitted before completion.` };
    }
    if (err?.code === "NOT_FOUND") {
      return { ok: false, code: "NOT_FOUND", message: `No queue file found for ${slug}.` };
    }
    if (err?.code === "EEXIST") {
      return { ok: false, code: "EEXIST", message: err.message ?? "destination already exists with different content" };
    }
    if (err?.code === "PARTIAL_CONFLICT" || err?.code === "BAD_URL") {
      return { ok: false, code: "MOVE_FAILED", message: String(err.message) };
    }
    throw err;
  }

  try {
    await regenerateAppliedTracker(root);
  } catch {
    // derived file — log-only per plan
  }

  await removeApplicationArtifacts(root, slug);

  return { ok: true, queue_file: queueFileDest };
}

async function removeApplicationArtifacts(root: string, slug: string): Promise<void> {
  if (!isSafeSlug(slug)) return;
  const scriptsDir = path.resolve(root, ".pi-jobs", "scripts");
  for (const name of [`${slug}-fill.js`, `${slug}-submit.js`, `${slug}-otp.js`, `${slug}.json`]) {
    const target = path.resolve(scriptsDir, name);
    if (!target.startsWith(scriptsDir + path.sep)) continue;
    await fs.unlink(target).catch(() => {});
  }
  const observedDir = path.resolve(root, ".pi-jobs", "observed");
  const observed = path.resolve(observedDir, `${slug}.json`);
  if (observed.startsWith(observedDir + path.sep)) {
    await fs.unlink(observed).catch(() => {});
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileBytes(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

async function sameFileOrBytes(a: string, b: string): Promise<boolean> {
  const [ab, bb] = await Promise.all([readFileBytes(a), readFileBytes(b)]);
  if (!ab || !bb) return false;
  if (ab.equals(bb)) return true;
  try {
    const ha = await fs.open(a, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const hb = await fs.open(b, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const [sa, sb] = await Promise.all([ha.stat({ bigint: true }), hb.stat({ bigint: true })]);
      return sa.dev === sb.dev && sa.ino === sb.ino;
    } finally {
      await ha.close();
      await hb.close();
    }
  } catch {
    return false;
  }
}

function urlFromQueueFile(content: string): string | null {
  const m = content.match(/^url:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** Apply-next guard: skip queue files already applied or matching a submitted URL. */
export async function shouldSkipQueueFileForApply(
  queueFileName: string,
  state: ParsedStateJson,
): Promise<{ skip: boolean; reason?: string }> {
  const queuePath = wsPath("jobs", "queue", queueFileName);
  const slug = resolveQueueSlug(queueFileName);
  if (!isSafeSlug(slug)) return { skip: true, reason: "unsafe queue file name" };

  const appliedPath = wsPath("jobs", "applied", `${slug}.md`);
  if (await sameFileOrBytes(queuePath, appliedPath)) {
    return { skip: true, reason: "queue file already matches applied copy" };
  }

  const content = await fs.readFile(queuePath, "utf8").catch(() => "");
  const url = urlFromQueueFile(content);
  const apps = (state.applications as ApplicationRecord[]) || [];
  if (url) {
    const submitted = apps.find((a) => a.status === "submitted" && a.url === url);
    if (submitted) {
      return { skip: true, reason: `URL already submitted as ${submitted.slug}` };
    }
  }

  const submittedApp = apps.find((a) => a.slug === slug && a.status === "submitted");
  if (submittedApp) {
    const dst = wsPath("jobs", "applied", `${slug}.md`);
    if (await fileExists(dst) && (await fileExists(queuePath))) {
      if (await sameFileOrBytes(queuePath, dst)) {
        return { skip: true, reason: "submitted application with duplicate queue copy" };
      }
    }
  }

  return { skip: false };
}
