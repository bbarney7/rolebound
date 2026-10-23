import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { completeApplication, readApplicationState, regenerateAppliedTracker, renderTracker } from "./applications";
import {
  atomicWriteFile,
  readJsonFile,
  withFileLock,
  WorkspaceFileError,
} from "./durable-store";
import { extractJobUrl, upsertSeenUrlCore, type SeenEntry } from "./gather-store";
import { fileIdentity, sameFileIdentity, type FileIdentity } from "./job-files";
import {
  parseGatherStateText,
  parseStateText,
  resolveApplicationQueueSource,
  WORKSPACE_FILES,
  isSafeSlug,
  type ParsedGatherState,
} from "./workspace-files";
import { withDiscoveredJobFileLock } from "./job-file-lock";
import { readObservation } from "./submission-policy";

export type ReconcileRow =
  | "R1"
  | "R2"
  | "R3"
  | "R4"
  | "R4b"
  | "R5"
  | "R6"
  | "R7"
  | "R8"
  | "R9"
  | "R10"
  | "R11"
  | "R12"
  | "R13";

export type ReconcileFinding = {
  row: ReconcileRow;
  message: string;
  applied?: boolean;
  skipped?: boolean;
};

export type ReconcileOptions = {
  apply: boolean;
  rows?: ReconcileRow[];
  lockRetries?: number;
};

const ALL_ROWS: ReconcileRow[] = [
  "R1",
  "R2",
  "R3",
  "R4",
  "R4b",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
  "R13",
];
const RUN_START_ROWS: ReconcileRow[] = ["R1", "R13", "R5", "R6", "R7", "R12"];
const TEMP_MAX_AGE_MS = 10 * 60 * 1000;
const SERIALIZE_GATHER = (v: ParsedGatherState) => JSON.stringify(v, null, 2);

async function filesSame(a: string, b: string): Promise<boolean> {
  try {
    const [ab, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ab.equals(bb);
  } catch {
    return false;
  }
}

async function sameInodeOrBytes(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.lstat(a, { bigint: true }), fs.lstat(b, { bigint: true })]);
    if (sameFileIdentity(fileIdentity(sa), fileIdentity(sb))) return true;
  } catch {
    return false;
  }
  return filesSame(a, b);
}

function lockOpts(lockRetries?: number) {
  return lockRetries !== undefined ? { lockRetries } : {};
}

async function withLockOrSkip<T>(
  file: string,
  lockRetries: number | undefined,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; skipped: true }> {
  try {
    const value = await withFileLock(file, async () => fn(), lockOpts(lockRetries));
    return { ok: true, value };
  } catch (err: any) {
    if (err?.code === "ELOCKED") return { ok: false, skipped: true };
    throw err;
  }
}

async function readGather(root: string): Promise<ParsedGatherState | null> {
  const gatherPath = path.join(root, WORKSPACE_FILES.gatherState);
  const read = await readJsonFile(gatherPath, parseGatherStateText);
  if (read.state === "missing") return { seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false };
  return read.value;
}

async function writeGatherAt(root: string, state: ParsedGatherState): Promise<void> {
  const gatherPath = path.join(root, WORKSPACE_FILES.gatherState);
  await atomicWriteFile(gatherPath, SERIALIZE_GATHER(state), { mode: 0o600 });
}

async function listDiscoveredByUrl(root: string): Promise<Map<string, { path: string; identity: FileIdentity; raw: string }>> {
  const dir = path.join(root, "jobs", "discovered");
  const out = new Map<string, { path: string; identity: FileIdentity; raw: string }>();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const filePath = path.join(dir, name);
    try {
      const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const st = await handle.stat({ bigint: true });
        const raw = await handle.readFile("utf8");
        const url = extractJobUrl(raw);
        if (url) out.set(url, { path: filePath, identity: fileIdentity(st), raw });
      } finally {
        await handle.close();
      }
    } catch {
      // skip
    }
  }
  return out;
}

async function scanTempFiles(root: string): Promise<string[]> {
  const stale: string[] = [];
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;

  async function considerFile(full: string, base: string): Promise<void> {
    const st = await fs.stat(full).catch(() => null);
    if (!st || st.mtimeMs >= cutoff) return;
    const isTemp =
      /^\..*\.tmp$/.test(base) ||
      base.endsWith(".score-tmp") ||
      /\.tmp-\d+-[0-9a-f]+$/i.test(base) ||
      /\.restore-\d+$/.test(base);
    if (isTemp) stale.push(full);
  }

  async function walkDir(dir: string, recursive: boolean): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!recursive) continue;
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        await walkDir(full, true);
        continue;
      }
      await considerFile(full, ent.name);
    }
  }

  await walkDir(root, false);
  for (const jobDir of ["discovered", "queue", "applied"]) {
    await walkDir(path.join(root, "jobs", jobDir), false);
  }
  await walkDir(path.join(root, "ui"), true);
  const piJobs = path.join(root, ".pi-jobs");
  const piEntries = await fs.readdir(piJobs, { withFileTypes: true }).catch(() => []);
  for (const ent of piEntries) {
    if (!ent.isDirectory() || ent.name === "backups" || ent.name === "runs") continue;
    await walkDir(path.join(piJobs, ent.name), true);
  }
  for (const ent of piEntries) {
    if (!ent.isFile()) continue;
    await considerFile(path.join(piJobs, ent.name), ent.name);
  }

  return stale;
}

export async function reconcileWorkspace(root: string, options: ReconcileOptions): Promise<ReconcileFinding[]> {
  const rows = new Set(options.rows ?? ALL_ROWS);
  const findings: ReconcileFinding[] = [];
  const lockRetries = options.lockRetries;

  const statePath = path.join(root, WORKSPACE_FILES.state);
  const gatherPath = path.join(root, WORKSPACE_FILES.gatherState);

  let stateCorrupt = false;
  let gatherCorrupt = false;
  try {
    await readJsonFile(statePath, parseStateText);
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      stateCorrupt = true;
      findings.push({ row: "R11", message: `${path.basename(err.file)} is corrupt; repair aborted` });
    } else {
      throw err;
    }
  }
  try {
    await readJsonFile(gatherPath, parseGatherStateText);
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      gatherCorrupt = true;
      findings.push({ row: "R11", message: `${path.basename(err.file)} is corrupt; repair aborted` });
    } else {
      throw err;
    }
  }
  if ((stateCorrupt || gatherCorrupt) && options.apply && rows.has("R11")) {
    return findings;
  }

  const gatherOk = !gatherCorrupt;
  const stateOk = !stateCorrupt;

  if (gatherOk && (rows.has("R1") || rows.has("R2"))) {
    const discoveredDir = path.join(root, "jobs", "discovered");
    const queueDir = path.join(root, "jobs", "queue");
    const discovered = await fs.readdir(discoveredDir).catch(() => [] as string[]);
    for (const name of discovered.filter((f) => f.endsWith(".md"))) {
      const dPath = path.join(discoveredDir, name);
      const qPath = path.join(queueDir, name);
      const observedSame = (await fs.stat(qPath).catch(() => null)) && (await filesSame(dPath, qPath));
      if (!observedSame) {
        if (rows.has("R2") && (await fs.stat(qPath).catch(() => null))) {
          findings.push({ row: "R2", message: `conflict discovered+queue ${name}` });
        }
        continue;
      }
      if (!rows.has("R1")) continue;
      let locked: Awaited<ReturnType<typeof withLockOrSkip<{ skipped: true } | { report: string } | { applied: string }>>>;
      try {
        locked = await withDiscoveredJobFileLock(dPath, async () => {
          return await withLockOrSkip(gatherPath, lockRetries, async () => {
            const stillSame = await filesSame(dPath, qPath);
            if (!stillSame) return { skipped: true as const };
            if (!options.apply) return { report: `duplicate discovered+queue ${name}` };
            await fs.unlink(dPath);
            const raw = await fs.readFile(qPath, "utf8");
            const url = extractJobUrl(raw);
            if (url) {
              const gather = (await readGather(root))!;
              const seen = gather.seen_urls as Record<string, SeenEntry>;
              upsertSeenUrlCore(seen, url, { decision: "promoted" });
              gather.seen_urls = seen;
              await writeGatherAt(root, gather);
            }
            return { applied: `removed discovered copy ${name}` };
          });
        });
      } catch (err: any) {
        if (err?.code === "ELOCKED") {
          findings.push({ row: "R1", message: `lock busy for ${name}`, skipped: true });
          continue;
        }
        throw err;
      }
      if (!locked.ok) {
        findings.push({ row: "R1", message: `lock busy for ${name}`, skipped: true });
      } else if ("skipped" in locked.value && locked.value.skipped) {
        findings.push({ row: "R1", message: `state changed for ${name}`, skipped: true });
      } else if ("report" in locked.value) {
        findings.push({ row: "R1", message: locked.value.report ?? "" });
      } else if ("applied" in locked.value) {
        findings.push({ row: "R1", message: locked.value.applied ?? "", applied: true });
      }
    }
  }

  if (gatherOk && rows.has("R3")) {
    const queueDir = path.join(root, "jobs", "queue");
    const queueFiles = await fs.readdir(queueDir).catch(() => [] as string[]);
    for (const name of queueFiles.filter((f) => f.endsWith(".md"))) {
      const qPath = path.join(queueDir, name);
      let url: string | null = null;
      try {
        const raw = await fs.readFile(qPath, "utf8");
        url = extractJobUrl(raw);
      } catch {
        continue;
      }
      if (!url) continue;
      const gatherBefore = await readGather(root);
      const entry = (gatherBefore?.seen_urls as Record<string, SeenEntry>)?.[url];
      if (entry?.decision === "promoted") continue;

      const locked = await withLockOrSkip(gatherPath, lockRetries, async () => {
        const gather = (await readGather(root))!;
        const seen = gather.seen_urls as Record<string, SeenEntry>;
        const cur = seen[url!];
        if (cur?.decision === "promoted") return { skipped: true as const };
        if (!options.apply) return { report: `queue file ${name} not marked promoted` };
        upsertSeenUrlCore(seen, url!, { decision: "promoted" });
        gather.seen_urls = seen;
        await writeGatherAt(root, gather);
        return { applied: `marked promoted for ${url}` };
      });
      if (!locked.ok) findings.push({ row: "R3", message: `lock busy for ${name}`, skipped: true });
      else if ("skipped" in locked.value && locked.value.skipped) {
        findings.push({ row: "R3", message: `state changed for ${url}`, skipped: true });
      } else if ("report" in locked.value) findings.push({ row: "R3", message: locked.value.report ?? "" });
      else if ("applied" in locked.value) findings.push({ row: "R3", message: locked.value.applied ?? "", applied: true });
    }
  }

  const discoveredByUrl = await listDiscoveredByUrl(root);

  if (gatherOk && (rows.has("R4") || rows.has("R4b"))) {
    const gatherSnap = await readGather(root);
    const seen = (gatherSnap?.seen_urls ?? {}) as Record<string, SeenEntry>;
    for (const [url, entry] of Object.entries(seen)) {
      if (!entry.reject_pending) {
        if (rows.has("R4") && entry.decision === "rejected" && discoveredByUrl.has(url)) {
          findings.push({ row: "R4", message: `rejected rediscovery left alone for ${url}` });
        }
        continue;
      }
      const disc = discoveredByUrl.get(url);
      if (rows.has("R4b") && !disc) {
        const locked = await withLockOrSkip(gatherPath, lockRetries, async () => {
          const gather = (await readGather(root))!;
          const s = gather.seen_urls as Record<string, SeenEntry>;
          const e = s[url];
          if (!e?.reject_pending) return { skipped: true as const };
          if (discoveredByUrl.has(url)) return { skipped: true as const };
          if (!options.apply) return { report: `clear reject_pending for ${url}` };
          delete e.reject_pending;
          s[url] = e;
          gather.seen_urls = s;
          await writeGatherAt(root, gather);
          return { applied: `cleared reject_pending for ${url}` };
        });
        if (!locked.ok) findings.push({ row: "R4b", message: `lock busy for ${url}`, skipped: true });
        else if ("skipped" in locked.value && locked.value.skipped) {
          findings.push({ row: "R4b", message: `state changed for ${url}`, skipped: true });
        } else if ("report" in locked.value) findings.push({ row: "R4b", message: locked.value.report ?? "" });
        else if ("applied" in locked.value) findings.push({ row: "R4b", message: locked.value.applied ?? "", applied: true });
        continue;
      }
      if (!rows.has("R4") || !disc) continue;
      const pendingId = entry.reject_pending.identity;
      const sameId = sameFileIdentity(pendingId, disc.identity);
      if (!sameId) {
        findings.push({ row: "R4", message: `reject_pending identity mismatch for ${url}` });
        continue;
      }
      const locked = await withLockOrSkip(gatherPath, lockRetries, async () => {
        const freshDisc = await listDiscoveredByUrl(root);
        const fd = freshDisc.get(url);
        if (!fd || !sameFileIdentity(pendingId, fd.identity)) return { skipped: true as const };
        if (!options.apply) return { report: `finish reject for ${url}` };
        await fs.unlink(fd.path);
        const gather = (await readGather(root))!;
        const s = gather.seen_urls as Record<string, SeenEntry>;
        const e = s[url];
        if (e) delete e.reject_pending;
        gather.seen_urls = s;
        await writeGatherAt(root, gather);
        return { applied: `finished reject for ${url}` };
      });
      if (!locked.ok) findings.push({ row: "R4", message: `lock busy for ${url}`, skipped: true });
      else if ("skipped" in locked.value && locked.value.skipped) {
        findings.push({ row: "R4", message: `state changed for ${url}`, skipped: true });
      } else if ("report" in locked.value) findings.push({ row: "R4", message: locked.value.report ?? "" });
      else if ("applied" in locked.value) findings.push({ row: "R4", message: locked.value.applied ?? "", applied: true });
    }
  }

  if (stateOk && rows.has("R13")) {
    const observedDir = path.join(root, ".pi-jobs", "observed");
    const entries = await fs.readdir(observedDir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      const slug = ent.name.slice(0, -".json".length);
      if (!isSafeSlug(slug)) {
        findings.push({ row: "R13", message: `ignored unsafe observation filename ${ent.name}` });
        continue;
      }
      const obs = await readObservation(root, slug);
      if (obs.status !== "ok" || obs.value.state !== "submitted") continue;

      const locked = await withLockOrSkip(statePath, lockRetries, async () => {
        const fresh = await readJsonFile(statePath, parseStateText);
        if (fresh.state !== "ok") return { corrupt: true as const };
        const apps = fresh.value.applications as Array<Record<string, unknown>>;
        const app = apps.find((a) => a.slug === slug);
        if (!app) return { skip: true as const };
        if (String(app.status) === "submitted") return { already: true as const };
        const reopenedAt = typeof app.reopened_at === "string" ? Date.parse(app.reopened_at) : NaN;
        const obsAt = Date.parse(obs.value.at);
        if (!Number.isNaN(reopenedAt) && !Number.isNaN(obsAt) && obsAt <= reopenedAt) {
          return { stale: true as const };
        }
        if (!options.apply) {
          return { report: `record observed submission for ${slug}` };
        }
        app.status = "submitted";
        app.confirmation_source =
          obs.value.source === "greenhouse_otp_script" ? "greenhouse_otp_script" : "greenhouse_submit_script";
        app.confirmation_evidence = `observed ${obs.value.state} from ${obs.value.source} at ${obs.value.at} (run ${obs.value.runId})`;
        app.screenshot_error = "recorded by reconciler";
        app.submitted_at = obs.value.at;
        fresh.value.applications = apps;
        fresh.value.last_updated = new Date().toISOString();
        await atomicWriteFile(statePath, JSON.stringify(fresh.value, null, 2), { mode: 0o600 });
        return { applied: `recorded submission for ${slug}` };
      });
      if (!locked.ok) {
        findings.push({ row: "R13", message: `lock busy for ${slug}`, skipped: true });
        continue;
      }
      const v = locked.value;
      if ("corrupt" in v && v.corrupt) {
        stateCorrupt = true;
        findings.push({ row: "R13", message: "state corrupt during R13", skipped: true });
        break;
      }
      if ("already" in v && v.already) {
        findings.push({ row: "R13", message: `state already submitted for ${slug}` });
      } else if ("stale" in v && v.stale) {
        findings.push({ row: "R13", message: `ignored observation older than reopened_at for ${slug}` });
      } else if ("skip" in v && v.skip) {
        findings.push({ row: "R13", message: `no state entry for observed ${slug}` });
      } else if ("report" in v) {
        findings.push({ row: "R13", message: v.report ?? "" });
      } else if ("applied" in v) {
        findings.push({ row: "R13", message: v.applied ?? "", applied: true });
      }
    }
  }

  if (stateOk && (rows.has("R5") || rows.has("R6") || rows.has("R7"))) {
    const stateRead = await readJsonFile(statePath, parseStateText);
    if (stateRead.state === "ok") {
      for (const app of stateRead.value.applications as Array<Record<string, unknown>>) {
        const slug = String(app.slug ?? "");
        if (!slug) continue;
        const status = String(app.status ?? "");
        const submitted = status === "submitted";
        const resolved = resolveApplicationQueueSource(root, slug, app.queue_file);
        const appliedPath = path.join(root, "jobs", "applied", `${slug}.md`);
        const queuePath =
          resolved.kind === "queue" || resolved.kind === "fallback_queue" ? resolved.absolute : null;

        if (resolved.kind === "fallback_queue" && resolved.ignoredRecord) {
          findings.push({
            row: "R5",
            message: `ignored invalid queue_file for ${slug}: ${resolved.ignoredRecord}`,
          });
        }

        if (resolved.kind === "already_applied" && submitted) {
          const appliedExists = await fs.stat(appliedPath).then(() => true).catch(() => false);
          if (appliedExists) {
            findings.push({
              row: "R7",
              message: `queue_file already points at applied for ${slug}`,
            });
          } else {
            findings.push({
              row: "R7",
              message: `queue_file points at applied but file missing for ${slug}`,
            });
          }
          continue;
        }

        if (rows.has("R5") && submitted && queuePath) {
          const appliedExists = await fs.stat(appliedPath).then(() => true).catch(() => false);
          const queueExists = await fs.stat(queuePath).then(() => true).catch(() => false);
          if (queueExists && !appliedExists) {
            if (!options.apply) {
              findings.push({ row: "R5", message: `complete interrupted application ${slug}` });
            } else {
              try {
                const done = await completeApplication(slug, { root, lockRetries });
                if (done.ok) findings.push({ row: "R5", message: `completed ${slug}`, applied: true });
                else findings.push({ row: "R5", message: done.message });
              } catch (err: any) {
                if (err?.code === "ELOCKED") findings.push({ row: "R5", message: `lock busy for ${slug}`, skipped: true });
                else throw err;
              }
            }
          }
        }

        if (rows.has("R6") && submitted && queuePath) {
          const appliedExists = await fs.stat(appliedPath).then(() => true).catch(() => false);
          const queueExists = await fs.stat(queuePath).then(() => true).catch(() => false);
          if (appliedExists && queueExists && queuePath !== appliedPath) {
            const same = await sameInodeOrBytes(queuePath, appliedPath);
            if (!same) {
              findings.push({ row: "R6", message: `conflict queue/applied bytes for ${slug}` });
            } else if (!options.apply) {
              findings.push({ row: "R6", message: `duplicate queue copy for submitted ${slug}` });
            } else {
              try {
                const locked = await withLockOrSkip(statePath, lockRetries, async () => {
                  const fresh = await readJsonFile(statePath, parseStateText);
                  if (fresh.state !== "ok") return { skipped: true as const };
                  const freshApp = (fresh.value.applications as Array<Record<string, unknown>>).find(
                    (a) => a.slug === slug,
                  );
                  if (!freshApp || String(freshApp.status) !== "submitted") return { skipped: true as const };
                  const freshResolved = resolveApplicationQueueSource(root, slug, freshApp.queue_file);
                  const freshQueue =
                    freshResolved.kind === "queue" || freshResolved.kind === "fallback_queue"
                      ? freshResolved.absolute
                      : null;
                  if (!freshQueue || freshQueue === appliedPath) return { skipped: true as const };
                  const stillSame = await sameInodeOrBytes(freshQueue, appliedPath);
                  if (!stillSame) return { skipped: true as const };
                  await fs.unlink(freshQueue);
                  return { unlinked: true as const };
                });
                if (!locked.ok) {
                  findings.push({ row: "R6", message: `lock busy for ${slug}`, skipped: true });
                  continue;
                }
                if ("skipped" in locked.value && locked.value.skipped) {
                  findings.push({ row: "R6", message: `state changed for ${slug}`, skipped: true });
                  continue;
                }
                const done = await completeApplication(slug, { root, lockRetries });
                if (done.ok) findings.push({ row: "R6", message: `removed queue copy for ${slug}`, applied: true });
                else findings.push({ row: "R6", message: done.message });
              } catch (err: any) {
                if (err?.code === "ELOCKED") findings.push({ row: "R6", message: `lock busy for ${slug}`, skipped: true });
                else throw err;
              }
            }
          }
        }

        if (rows.has("R7") && submitted && queuePath) {
          const appliedExists = await fs.stat(appliedPath).then(() => true).catch(() => false);
          const queueExists = await fs.stat(queuePath).then(() => true).catch(() => false);
          if (!queueExists && appliedExists) {
            if (!options.apply) {
              findings.push({ row: "R7", message: `repoint queue_file for ${slug}` });
            } else {
              try {
                const done = await completeApplication(slug, { root, lockRetries });
                if (done.ok) findings.push({ row: "R7", message: `repointed ${slug}`, applied: true });
                else findings.push({ row: "R7", message: done.message });
              } catch (err: any) {
                if (err?.code === "ELOCKED") findings.push({ row: "R7", message: `lock busy for ${slug}`, skipped: true });
                else throw err;
              }
            }
          }
        }
      }
    }
  }

  if (stateOk && rows.has("R8")) {
    const appliedDir = path.join(root, "jobs", "applied");
    const appliedFiles = await fs.readdir(appliedDir).catch(() => [] as string[]);
    const stateRead = await readJsonFile(statePath, parseStateText);
    if (stateRead.state === "ok") {
      const apps = stateRead.value.applications as Array<Record<string, unknown>>;
      for (const name of appliedFiles.filter((f) => f.endsWith(".md"))) {
        const slug = name.replace(/\.md$/, "");
        const app = apps.find((a) => a.slug === slug);
        if (!app || String(app.status) !== "submitted") {
          findings.push({ row: "R8", message: `applied/${name} without submitted state` });
        }
      }
    }
  }

  if (stateOk && rows.has("R9")) {
    const trackerPath = path.join(root, WORKSPACE_FILES.appliedTracker);
    const stateRead = await readJsonFile(statePath, parseStateText);
    if (stateRead.state === "ok") {
      const expected = renderTracker(stateRead.value);
      let needs = false;
      try {
        const st = await fs.stat(trackerPath);
        const stateSt = await fs.stat(statePath);
        const current = await fs.readFile(trackerPath, "utf8");
        if (stateSt.mtimeMs > st.mtimeMs || current !== expected) needs = true;
      } catch {
        needs = true;
      }
      if (needs) {
        if (options.apply) {
          await regenerateAppliedTracker(root);
          findings.push({ row: "R9", message: "regenerated APPLIED.md", applied: true });
        } else findings.push({ row: "R9", message: "APPLIED.md stale" });
      }
    }
  }

  if (gatherOk && rows.has("R10")) {
    for (const [url, disc] of discoveredByUrl) {
      const gather = await readGather(root);
      const seen = (gather?.seen_urls ?? {}) as Record<string, SeenEntry>;
      if (seen[url]) continue;
      const locked = await withLockOrSkip(gatherPath, lockRetries, async () => {
        const g = (await readGather(root))!;
        const s = g.seen_urls as Record<string, SeenEntry>;
        if (s[url]) return { skipped: true as const };
        if (!options.apply) return { report: `missing seen_urls for ${url}` };
        upsertSeenUrlCore(s, url, { decision: "discovered", first_seen: new Date().toISOString() });
        g.seen_urls = s;
        await writeGatherAt(root, g);
        return { applied: `recorded discovered for ${url}` };
      });
      if (!locked.ok) findings.push({ row: "R10", message: `lock busy for ${url}`, skipped: true });
      else if ("skipped" in locked.value && locked.value.skipped) {
        findings.push({ row: "R10", message: `state changed for ${url}`, skipped: true });
      } else if ("report" in locked.value) findings.push({ row: "R10", message: locked.value.report ?? "" });
      else if ("applied" in locked.value) findings.push({ row: "R10", message: locked.value.applied ?? "", applied: true });
    }
  }

  if (rows.has("R12")) {
    const stale = await scanTempFiles(root);
    // Nothing found is not a finding: every run start would otherwise warn "0 stale temp files".
    if (stale.length > 0 && options.apply) {
      for (const file of stale) {
        await fs.rm(file, { force: true }).catch(() => {});
      }
      findings.push({ row: "R12", message: `removed ${stale.length} stale temp files`, applied: true });
    } else if (stale.length > 0) {
      findings.push({ row: "R12", message: `found ${stale.length} stale temp files` });
    }
  }

  return findings;
}

export function reconcileRowsForRunStart(): ReconcileRow[] {
  return RUN_START_ROWS;
}

export async function reconcileAtRunStart(root: string): Promise<ReconcileFinding[]> {
  return reconcileWorkspace(root, { apply: true, rows: reconcileRowsForRunStart(), lockRetries: 0 });
}
