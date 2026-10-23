import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const RESTORE_LOCK_BUDGET_MS = 12_000;

export const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKSPACE_VERSION = 2;
const markerPath = root => path.join(root, ".pi-jobs", "workspace-version.json");
const journalPath = root => path.join(root, ".pi-jobs", "migration-journal.json");
const relSafe = value => {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.includes("\0")) throw new Error("invalid backup path");
  return value;
};
export function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function atomicWrite(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temp, "wx", mode); try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(temp, mode); fs.renameSync(temp, file);
}
function assertNoSymlink(root, relative) { const target = path.resolve(root, relative); if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("path escapes workspace"); let cursor = path.resolve(root); for (const part of path.relative(cursor, target).split(path.sep)) { cursor = path.join(cursor, part); try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`refusing symlink path: ${relative}`); } catch (error) { if (error?.code !== "ENOENT") throw error; } } return target; }
function lstatIfPresent(file) { try { return fs.lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
export function activeRun(root) { const lock = `${path.join(root, "ui", "run-manager.json")}.lock`; try { if (Date.now() - fs.statSync(lock).mtimeMs < 10_000) return true; } catch {} try { const value = JSON.parse(fs.readFileSync(path.join(root, "ui", "run-manager.json"), "utf8")); if (value?.endedAt) return false; if (Number.isInteger(value?.pid) && value.pid > 0) { try { process.kill(value.pid, 0); return true; } catch { return false; } } } catch {} return false; }
export const DEFAULT_BACKUP_PATHS = [
  "profile.md",
  "targets.md",
  "settings.json",
  "state.json",
  "gather_state.json",
  "credentials.json",
];

function collectJobMarkdownPaths(root) {
  const out = [];
  for (const sub of ["queue", "discovered", "applied"]) {
    const dir = path.join(root, "jobs", sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".md")) out.push(`jobs/${sub}/${name}`);
    }
  }
  return out;
}

/** Lock-mapped workspace paths in restore lock order (jobs first, then JSON/profile files). */
export function resolveDefaultBackupPaths(root) {
  return [...DEFAULT_BACKUP_PATHS, ...collectJobMarkdownPaths(root)].sort(
    (a, b) => restoreLockRank(a) - restoreLockRank(b),
  );
}

function backupIdToIsoDate(id) {
  const normalized = id.replace(/-pre-restore$/, "").replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1-$2-$3T$4:$5:$6.$7Z",
  );
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : id;
}

export function listBackups(root) {
  assertNoSymlink(root, ".pi-jobs");
  const backupsDir = path.join(root, ".pi-jobs", "backups");
  if (!fs.existsSync(backupsDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(backupsDir)) {
    const dir = path.join(backupsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifestFile = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestFile)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    } catch {
      continue;
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const fileCount = files.filter(entry => entry.existed !== false).length;
    entries.push({ id: name, date: backupIdToIsoDate(name), fileCount });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export function runWorkspaceBackup(root) {
  if (activeRun(root)) throw new Error("cannot backup while a run is active");
  const relatives = resolveDefaultBackupPaths(root);
  const locks = acquireRestoreLocks(root, relatives);
  try {
    const id = createBackup(root, relatives);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".pi-jobs", "backups", id, "manifest.json"), "utf8"),
    );
    const fileCount = (manifest.files ?? []).filter(entry => entry.existed !== false).length;
    return { id, fileCount };
  } finally {
    for (const lock of locks) lock.release();
  }
}

export function createBackup(root, relativePaths, id = new Date().toISOString().replace(/[:.]/g, "-")) {
  const safeId = relSafe(id); if (safeId.includes("/") || safeId.includes("\\")) throw new Error("invalid backup path"); assertNoSymlink(root, ".pi-jobs"); assertNoSymlink(root, ".pi-jobs/backups"); const dir = path.join(root, ".pi-jobs", "backups", safeId); assertNoSymlink(root, path.join(".pi-jobs", "backups", safeId)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const files = [];
  for (const relative of relativePaths) { const safe = relSafe(relative); const source = assertNoSymlink(root, safe); if (!fs.existsSync(source)) { files.push({ path: safe, existed: false }); continue; } const backup = `${files.length}-${path.basename(safe)}`; fs.copyFileSync(source, path.join(dir, backup), fs.constants.COPYFILE_EXCL); fs.chmodSync(path.join(dir, backup), 0o600); files.push({ path: safe, existed: true, backup, sha256: sha256File(source) }); }
  atomicWrite(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, files }, null, 2) + "\n"); return id;
}
function restoreLockTarget(root, relative) {
  const safe = relSafe(relative);
  const target = assertNoSymlink(root, safe);
  if (/^jobs\/.*\.md$/.test(safe)) return `${target}.lock`;
  if (safe === "targets.md") return assertNoSymlink(root, "targets.md.lock");
  if (["credentials.json", "state.json", "gather_state.json", "settings.json", "profile.md"].includes(safe)) return target;
  if (!safe.includes("/") && safe.endsWith(".json")) return target;
  throw new Error(`no lock mapping for backup path: ${relative}`);
}

function restoreLockRank(relative) {
  if (/^jobs\/.*\.md$/.test(relative)) return 0;
  if (relative === "gather_state.json") return 1;
  if (relative === "state.json") return 2;
  if (relative === "settings.json") return 3;
  if (relative === "profile.md") return 4;
  if (relative === "targets.md") return 5;
  if (relative === "credentials.json") return 6;
  if (!relative.includes("/") && relative.endsWith(".json")) return 2;
  return 99;
}

function lockTargetSync(lockTarget) {
  const dir = fs.realpathSync(path.dirname(lockTarget));
  const lockfilePath = path.join(dir, `${path.basename(lockTarget)}.lock`);
  let compromised = false;
  const release = lockfile.lockSync(lockTarget, {
    retries: 0,
    realpath: false,
    lockfilePath,
    onCompromised: () => {
      compromised = true;
    },
  });
  return { release, compromised: () => compromised };
}

function acquireRestoreLocks(root, relatives) {
  const started = Date.now();
  const sorted = [...relatives].sort((a, b) => restoreLockRank(a) - restoreLockRank(b));
  while (Date.now() - started < RESTORE_LOCK_BUDGET_MS) {
    const held = [];
    try {
      for (const relative of sorted) {
        const target = restoreLockTarget(root, relative);
        try {
          held.push({ relative, ...lockTargetSync(target) });
        } catch (error) {
          if (error?.code !== "ELOCKED") throw error;
          for (const h of held) h.release();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          held.length = 0;
          break;
        }
      }
      if (held.length === sorted.length) return held;
    } catch (error) {
      for (const h of held) h.release();
      throw error;
    }
  }
  throw new Error("could not acquire workspace locks for restore within 12s");
}

function atomicRestoreFile(target, source) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.restore-${process.pid}`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
}

export function restoreBackup(root, id, { refuseIfActive = true } = {}) {
  if (refuseIfActive && activeRun(root)) throw new Error("cannot restore while a run is active");
  const safeId = relSafe(id);
  if (safeId.includes("/") || safeId.includes("\\")) throw new Error("invalid backup path");
  const dir = assertNoSymlink(root, path.join(".pi-jobs", "backups", safeId));
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile) || fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error(`backup not found: ${id}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!Array.isArray(manifest.files)) throw new Error("invalid backup manifest");
  const prepared = manifest.files.map(entry => {
    const target = assertNoSymlink(root, relSafe(entry.path));
    if (entry.existed === false) return { source: null, target, existed: false, relative: relSafe(entry.path) };
    const source = assertNoSymlink(dir, relSafe(entry.backup));
    if (!fs.existsSync(source) || sha256File(source) !== entry.sha256) throw new Error(`backup integrity check failed: ${entry.path}`);
    return { source, target, existed: true, relative: relSafe(entry.path) };
  });
  const relatives = prepared.map(p => p.relative);
  const locks = acquireRestoreLocks(root, relatives);
  const preRestoreId = createBackup(root, relatives, `${new Date().toISOString().replace(/[:.]/g, "-")}-pre-restore`);
  const snapshot = prepared.map(({ target }) => ({
    target,
    existed: fs.existsSync(target),
    bytes: fs.existsSync(target) ? fs.readFileSync(target) : null,
    mode: fs.existsSync(target) ? fs.statSync(target).mode : 0o600,
  }));
  try {
    for (const { source, target, existed } of prepared) {
      for (const lock of locks) {
        if (lock.compromised()) throw new Error("restore lock compromised");
      }
      if (!existed) {
        fs.rmSync(target, { force: true });
        continue;
      }
      atomicRestoreFile(target, source);
    }
  } catch (error) {
    for (const old of snapshot) {
      if (old.existed) {
        const temp = `${old.target}.restore-${process.pid}`;
        fs.writeFileSync(temp, old.bytes, { mode: old.mode & 0o777 });
        fs.renameSync(temp, old.target);
        try {
          fs.chmodSync(old.target, old.mode);
        } catch {}
      } else fs.rmSync(old.target, { force: true });
    }
    throw error;
  } finally {
    for (const lock of locks) lock.release();
  }
  return { preRestoreId };
}
export function recoverMigration(root) {
  const file = journalPath(root); if (!fs.existsSync(file)) return false; const journal = JSON.parse(fs.readFileSync(file, "utf8")); if (journal.state !== "started" || !journal.backupId) return false; restoreBackup(root, journal.backupId, { refuseIfActive: false });
  const marker = markerPath(root);
  if (typeof journal.priorMarker === "string") atomicWrite(marker, Buffer.from(journal.priorMarker, "base64"));
  else fs.rmSync(marker, { force: true });
  fs.rmSync(file, { force: true }); return true;
}
/** Run a multi-file migration with a recoverable backup/journal. The marker is
 * advanced only after the callback completes successfully. */
export function migrateWorkspace(root, relativePaths, migration, name = "migration") {
  const backupId = createBackup(root, relativePaths, `${name}-${Date.now()}`);
  const marker = markerPath(root); const priorMarker = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
  atomicWrite(journalPath(root), JSON.stringify({ version: 1, state: "started", backupId, paths: relativePaths, priorMarker: priorMarker?.toString("base64") ?? null }, null, 2) + "\n");
  try { migration(); atomicWrite(markerPath(root), JSON.stringify({ version: WORKSPACE_VERSION, lastMigration: name }) + "\n"); fs.rmSync(journalPath(root), { force: true }); }
  catch (error) { try { recoverMigration(root); } catch {} if (priorMarker) atomicWrite(marker, priorMarker); else fs.rmSync(marker, { force: true }); throw error; }
}
export function resolveWorkspaceRoot(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  const requested = i >= 0 ? argv[i + 1] : process.env.PI_JOBS_ROOT;
  const root = path.resolve(requested?.trim() || codeRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`workspace root is not a directory: ${root}`);
  if (fs.realpathSync(root) !== fs.realpathSync(codeRoot)) throw new Error(`--root must resolve to this clone: ${codeRoot}`);
  return root;
}

const files = [
  ["templates/profile.template.md", "profile.md"], ["templates/targets.template.md", "targets.md"],
  ["templates/state.json", "state.json"], ["templates/gather_state.json", "gather_state.json"],
  ["templates/credentials.json", "credentials.json"], ["templates/settings.json", "settings.json"],
];
export function initWorkspace(root) {
  const canonical = fs.realpathSync(root); if (canonical !== fs.realpathSync(codeRoot) && !fs.existsSync(path.join(root, ".pi", "extensions"))) throw new Error("workspace root is not a complete clone");
  assertNoSymlink(root, ".pi-jobs"); assertNoSymlink(root, "jobs");
  fs.mkdirSync(path.join(root, ".pi-jobs"), { recursive: true, mode: 0o700 }); recoverMigration(root);
  fs.chmodSync(path.join(root, ".pi-jobs"), 0o700);
  const marker = markerPath(root); const markerStat = lstatIfPresent(marker); if (markerStat?.isSymbolicLink()) throw new Error("refusing symlink workspace version marker"); if (markerStat) { const value = JSON.parse(fs.readFileSync(marker, "utf8")); if (value.version > WORKSPACE_VERSION) throw new Error(`workspace version ${value.version} is newer than supported version ${WORKSPACE_VERSION}`); } else atomicWrite(marker, JSON.stringify({ version: WORKSPACE_VERSION, lastMigration: "workspace-init" }) + "\n");
  for (const [src, dst] of files) {
    const target = path.join(root, dst);
    const targetStat = lstatIfPresent(target); if (targetStat?.isSymbolicLink()) throw new Error(`refusing symlink workspace file: ${dst}`);
    if (!targetStat) fs.copyFileSync(path.join(root, src), target, fs.constants.COPYFILE_EXCL);
  }
  for (const d of ["jobs/queue", "jobs/applied", "jobs/discovered", "resumes", "screenshots"]) { const p = path.join(root, d); if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error(`refusing symlink workspace directory: ${d}`); fs.mkdirSync(p, { recursive: true }); }
  assertNoSymlink(root, ".pi-jobs/pi-agent"); fs.mkdirSync(path.join(root, ".pi-jobs", "pi-agent"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, ".pi-jobs", "pi-agent"), 0o700);
  for (const f of ["credentials.json", "settings.json"]) { try { fs.chmodSync(path.join(root, f), 0o600); } catch {} }
}
