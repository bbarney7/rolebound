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
import { fileIdentity, moveJobFileNoClobber, sameFileIdentity, type FileIdentity } from "./job-files";
import { withDiscoveredJobFileLock } from "./job-file-lock";
import { corruptFileRecoveryMessage } from "./accounts-store";
import { isSafeSlug, parseGatherStateText, WORKSPACE_FILES, type ParsedGatherState } from "./workspace-files";
import { wsPath } from "./workspace";

const GATHER_FILE = wsPath(WORKSPACE_FILES.gatherState);
const SERIALIZE = (v: ParsedGatherState) => JSON.stringify(v, null, 2);

export type SeenEntry = Record<string, unknown> & {
  decision?: string;
  first_seen?: string;
  company?: string;
  title?: string;
  source?: string;
  reject_reason?: string;
  reject_pending?: { identity: FileIdentity; at: string };
};

export async function readGatherStateStrict(): Promise<ParsedGatherState | { error: Error }> {
  try {
    const read = await readJsonFile(GATHER_FILE, parseGatherStateText);
    if (read.state === "missing") {
      return { seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false };
    }
    return read.value;
  } catch (err) {
    return { error: err as Error };
  }
}

export async function mutateGatherState(
  fn: (state: ParsedGatherState) => ParsedGatherState | typeof NO_CHANGE,
  options: { bootstrap?: boolean; bootstrapBytes?: string } = {},
): Promise<ParsedGatherState | { error: Error }> {
  const bootstrap = options.bootstrap !== false;
  const bootstrapBytes =
    options.bootstrapBytes ??
    (await fs.readFile(wsPath("templates", WORKSPACE_FILES.gatherState), "utf8").catch(() =>
      JSON.stringify({ seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false }),
    ));
  try {
    return await mutateJsonFile(
      GATHER_FILE,
      {
        parse: parseGatherStateText,
        serialize: SERIALIZE,
        bootstrapBytes,
        mode: 0o600,
        bootstrap,
      },
      (state) => {
        const next: ParsedGatherState = {
          ...state,
          seen_urls: { ...(state.seen_urls as Record<string, SeenEntry>) },
          per_company: { ...(state.per_company as Record<string, unknown>) },
        };
        const out = fn(next);
        if (out === NO_CHANGE) return NO_CHANGE;
        return out;
      },
    );
  } catch (err) {
    return { error: err as Error };
  }
}

export function upsertSeenUrlCore(
  seen: Record<string, SeenEntry>,
  url: string,
  patch: Partial<SeenEntry> & { decision: string },
): void {
  const existing = seen[url];
  seen[url] = {
    first_seen: new Date().toISOString(),
    source: patch.source ?? "pi-jobs-ui",
    company: patch.company ?? "",
    title: patch.title ?? "",
    ...(existing ?? {}),
    ...patch,
  };
}

export function mergeGatherResults(
  current: ParsedGatherState,
  snapshot: Record<string, SeenEntry>,
  proposed: ParsedGatherState,
  gatheredCompanies: string[],
): ParsedGatherState {
  const seen = { ...(current.seen_urls as Record<string, SeenEntry>) };
  const proposedSeen = proposed.seen_urls as Record<string, SeenEntry>;
  for (const [url, entry] of Object.entries(proposedSeen)) {
    const snap = snapshot[url];
    const cur = seen[url];
    const snapJson = snap === undefined ? undefined : JSON.stringify(snap);
    const curJson = cur === undefined ? undefined : JSON.stringify(cur);
    if (snapJson === curJson) {
      seen[url] = { ...entry };
    } else if (cur) {
      seen[url] = { ...cur };
    }
  }
  const perCompany = { ...(current.per_company as Record<string, unknown>) };
  for (const company of gatheredCompanies) {
    if (proposed.per_company[company] !== undefined) {
      perCompany[company] = proposed.per_company[company];
    }
  }
  return {
    ...current,
    seen_urls: seen,
    per_company: perCompany,
    last_full_gather: proposed.last_full_gather ?? current.last_full_gather,
    auto_promote: proposed.auto_promote ?? current.auto_promote,
  };
}

/** End-of-gather merge (same sequence as job-gatherer) for tests and reconciliation fixtures. */
export async function persistGatherMerge(
  snapshot: Record<string, SeenEntry>,
  proposed: ParsedGatherState,
  gatheredCompanies: string[],
  testHooks?: { beforeMerge?: () => void | Promise<void> },
): Promise<ParsedGatherState | { error: Error }> {
  if (testHooks?.beforeMerge) {
    await testHooks.beforeMerge();
  }
  return mutateGatherState((current) => mergeGatherResults(current, snapshot, proposed, gatheredCompanies));
}

export function extractJobUrl(raw: string): string | null {
  const m = raw.match(/^url:\s*(\S+)/m);
  return m ? m[1] : null;
}

export async function writeDiscoveredJob(relativePath: string, body: string): Promise<"created" | "exists"> {
  const file = wsPath(relativePath);
  try {
    await atomicCreateFile(file, body, { mode: 0o644 });
    return "created";
  } catch (err: any) {
    if (err?.code === "EEXIST") return "exists";
    throw err;
  }
}

export async function promoteDiscovered(
  slug: string,
  testHooks?: import("./job-files").MoveJobFileTestHooks,
): Promise<{ ok: boolean; error?: string; code?: string }> {
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe slug: ${slug}`, code: "UNSAFE" };
  const src = wsPath("jobs", "discovered", `${slug}.md`);
  const dst = wsPath("jobs", "queue", `${slug}.md`);
  let url: string | null = null;
  const locked = await withDiscoveredJobFileLock(src, async () => {
    const move = await moveJobFileNoClobber(src, dst, { testHooks });
    if (!move.ok) {
      if (move.code === "NOT_FOUND") return { ok: false, error: move.message, code: move.code };
      if (move.code === "EEXIST") return { ok: false, error: move.message, code: move.code };
      return { ok: false, error: move.message, code: move.code };
    }
    url = extractJobUrl(move.raw);
    return { ok: true as const };
  }).catch((err: { code?: string }) => {
    if (err?.code === "ELOCKED") {
      return { ok: false, error: "discovered job file is locked; retry", code: "BUSY" };
    }
    return { ok: false, error: "discovered file not found", code: "NOT_FOUND" };
  });

  if (!locked.ok) return locked;
  if (!url) {
    return { ok: true };
  }
  const meta = await mutateGatherState((state) => {
    const seen = state.seen_urls as Record<string, SeenEntry>;
    upsertSeenUrlCore(seen, url!, { decision: "promoted" });
    state.seen_urls = seen;
    return state;
  });
  if ("error" in meta) {
    return { ok: false, error: corruptFileRecoveryMessage(meta.error as any) };
  }
  return { ok: true };
}

export async function rejectDiscovered(
  slug: string,
  reason: string,
  testHooks?: import("./job-files").MoveJobFileTestHooks & {
    afterRejectPending?: () => void | Promise<void>;
  },
): Promise<{ ok: boolean; error?: string; code?: string }> {
  if (!isSafeSlug(slug)) return { ok: false, error: `unsafe slug: ${slug}`, code: "UNSAFE" };
  const src = wsPath("jobs", "discovered", `${slug}.md`);
  if (!(await fs.stat(src).catch(() => null))) {
    return { ok: true, error: "no seen_urls entry recorded" };
  }

  let url: string | null = null;
  let identity: FileIdentity | null = null;
  let priorEntry: SeenEntry | undefined;

  try {
    await withDiscoveredJobFileLock(src, async () => {
      const handle = await fs.open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const st = await handle.stat({ bigint: true });
        identity = fileIdentity(st);
        const raw = await handle.readFile("utf8");
        url = extractJobUrl(raw);
      } finally {
        await handle.close();
      }
    });
  } catch (err: any) {
    if (err?.code === "ELOCKED") {
      return { ok: false, error: "discovered job file is locked; retry", code: "BUSY" };
    }
    return { ok: true, error: "no seen_urls entry recorded" };
  }

  if (!url) {
    await fs.unlink(src).catch(() => {});
    return { ok: true, error: "no seen_urls entry recorded" };
  }

  const upsert = await mutateGatherState((state) => {
    const seen = state.seen_urls as Record<string, SeenEntry>;
    priorEntry = seen[url!] ? { ...seen[url!] } : undefined;
    upsertSeenUrlCore(seen, url!, {
      decision: "rejected",
      reject_reason: reason,
      reject_pending: { identity: identity!, at: new Date().toISOString() },
    });
    state.seen_urls = seen;
    return state;
  });
  if ("error" in upsert) {
    const err = upsert.error;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (testHooks?.afterRejectPending) await testHooks.afterRejectPending();

  let unlinkOk = false;
  await withDiscoveredJobFileLock(src, async () => {
    const handle = await fs.open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = await handle.stat({ bigint: true });
      const nowId = fileIdentity(st);
      if (!sameFileIdentity(nowId, identity!)) {
        unlinkOk = false;
        return;
      }
    } finally {
      await handle.close();
    }
    if (testHooks?.beforeUnlink) await testHooks.beforeUnlink();
    await fs.unlink(src);
    unlinkOk = true;
  }).catch(() => {
    unlinkOk = false;
  });

  if (!unlinkOk) {
    await mutateGatherState((state) => {
      const seen = state.seen_urls as Record<string, SeenEntry>;
      if (priorEntry) seen[url!] = priorEntry;
      else delete seen[url!];
      state.seen_urls = seen;
      return state;
    });
    return { ok: false, error: "discovered file changed during reject", code: "CONFLICT" };
  }

  await mutateGatherState((state) => {
    const seen = state.seen_urls as Record<string, SeenEntry>;
    const entry = seen[url!];
    if (entry) {
      delete entry.reject_pending;
      seen[url!] = entry;
    }
    state.seen_urls = seen;
    return state;
  });

  return { ok: true };
}

export async function markSeenUrlPromoted(
  root: string,
  url: string,
  meta: { company: string | null; title: string | null; source: string | null },
): Promise<{ ok: boolean; warning: string | null }> {
  const file = path.join(root, WORKSPACE_FILES.gatherState);
  try {
    await withFileLock(file, async () => {
      const read = await readJsonFile(file, parseGatherStateText);
      if (read.state === "missing") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      const state = read.value;
      const parsedSeen = (state.seen_urls ?? {}) as Record<string, SeenEntry>;
      const seen: Record<string, SeenEntry> = Object.create(null);
      for (const [key, entry] of Object.entries(parsedSeen)) {
        seen[key] = entry;
      }
      const existing = seen[url];
      upsertSeenUrlCore(seen, url, {
        decision: "promoted",
        ...(existing
          ? {}
          : {
              company: meta.company ?? "",
              title: meta.title ?? "",
              source: meta.source ?? "pi-jobs-ui",
            }),
      });
      state.seen_urls = seen;
      await atomicWriteFile(file, SERIALIZE(state), { mode: 0o600 });
    });
    return { ok: true, warning: null };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        warning:
          "gather_state.json was not found, so the gatherer dedup hint was not recorded. The queue file was written.",
      };
    }
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      return {
        ok: false,
        warning: `${err.message}, so the gatherer dedup hint was not recorded and the file was left byte-for-byte untouched. The queue file was written.`,
      };
    }
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        warning:
          "gather_state.json is not valid JSON, so the gatherer dedup hint was not recorded and the file was left byte-for-byte untouched. The queue file was written.",
      };
    }
    return {
      ok: false,
      warning: `gather_state.json could not be updated (${String(err)}), so the gatherer dedup hint was not recorded. The queue file was written.`,
    };
  }
}
