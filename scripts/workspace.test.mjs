import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import {
  codeRoot,
  createBackup,
  DEFAULT_BACKUP_PATHS,
  initWorkspace,
  listBackups,
  migrateWorkspace,
  recoverMigration,
  resolveDefaultBackupPaths,
  resolveWorkspaceRoot,
  restoreBackup,
  runWorkspaceBackup,
  sha256File,
  WORKSPACE_VERSION,
} from "./workspace.mjs";

const TSX_CLI = path.join(codeRoot, "node_modules", "tsx", "dist", "cli.mjs");
const CROSS_CHILD = path.join(codeRoot, "ui", "server", "__tests__", "crossProcessChild.mts");

function demoFixture() {
  const root = fixture();
  fs.cpSync(path.join(codeRoot, ".pi", "extensions"), path.join(root, ".pi", "extensions"), { recursive: true });
  const link = path.join(root, "node_modules");
  try {
    fs.symlinkSync(path.join(codeRoot, "node_modules"), link);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return root;
}

async function waitForPause(root, token) {
  const marker = path.join(root, ".cross-test", "pause", token);
  for (;;) {
    try {
      fs.accessSync(marker);
      return;
    } catch {
      await new Promise((r) => setImmediate(r));
    }
  }
}

function spawnCredentialPauseChild(root, host, pauseToken) {
  const dir = path.join(root, ".cross-test");
  fs.mkdirSync(dir, { recursive: true });
  const specPath = path.join(dir, `spec-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify({ op: "credentials_write_pause", root, host, pauseToken }), "utf8");
  const child = spawn(process.execPath, [TSX_CLI, CROSS_CHILD, root, specPath], { cwd: root, stdio: "ignore" });
  return { child, wait: () => new Promise((resolve) => child.once("close", resolve)) };
}

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-workspace-test-")); fs.cpSync(path.resolve("templates"), path.join(root, "templates"), { recursive: true }); fs.mkdirSync(path.join(root, ".pi", "extensions"), { recursive: true }); return root; }
test("initialization is idempotent and marks version 2", () => { const root = fixture(); try { initWorkspace(root); const before = sha256File(path.join(root, "profile.md")); initWorkspace(root); assert.equal(sha256File(path.join(root, "profile.md")), before); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".pi-jobs", "workspace-version.json"), "utf8")), { version: 2, lastMigration: "workspace-init" }); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("future versions and symlinks are rejected", () => { const root = fixture(); try { fs.mkdirSync(path.join(root, ".pi-jobs"), { recursive: true }); fs.writeFileSync(path.join(root, ".pi-jobs", "workspace-version.json"), JSON.stringify({ version: WORKSPACE_VERSION + 1 })); assert.throws(() => initWorkspace(root), /newer/); fs.rmSync(path.join(root, ".pi-jobs"), { recursive: true, force: true }); fs.symlinkSync("/missing-target", path.join(root, ".pi-jobs")); assert.throws(() => initWorkspace(root), /symlink/); fs.unlinkSync(path.join(root, ".pi-jobs")); fs.symlinkSync("/tmp", path.join(root, "jobs")); assert.throws(() => initWorkspace(root), /symlink/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("version markers and dangling scaffold links are rejected", () => { const root = fixture(); try { fs.mkdirSync(path.join(root, ".pi-jobs")); fs.symlinkSync("/tmp/outside-marker", path.join(root, ".pi-jobs", "workspace-version.json")); assert.throws(() => initWorkspace(root), /symlink workspace version marker/); fs.unlinkSync(path.join(root, ".pi-jobs", "workspace-version.json")); fs.symlinkSync("/tmp/outside-profile", path.join(root, "profile.md")); assert.throws(() => initWorkspace(root), /symlink workspace file/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("backup restore verifies hashes, containment, and active run refusal", () => { const root = fixture(); try { initWorkspace(root); const profile = path.join(root, "profile.md"); const original = fs.readFileSync(profile, "utf8"); const id = createBackup(root, ["profile.md"]); fs.writeFileSync(profile, "changed"); restoreBackup(root, id); assert.equal(fs.readFileSync(profile, "utf8"), original); fs.mkdirSync(path.join(root, "ui")); fs.writeFileSync(path.join(root, "ui", "run-manager.json"), JSON.stringify({ runId: "x", pid: process.pid, sessionName: "test", startedAt: new Date().toISOString() })); assert.throws(() => restoreBackup(root, id), /active/); fs.rmSync(path.join(root, "ui"), { recursive: true, force: true }); const manifest = path.join(root, ".pi-jobs", "backups", id, "manifest.json"); const data = JSON.parse(fs.readFileSync(manifest, "utf8")); data.files[0].path = "../escape"; fs.writeFileSync(manifest, JSON.stringify(data)); assert.throws(() => restoreBackup(root, id), /invalid backup path/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("migration journals and rolls back a failed callback", () => { const root = fixture(); try { initWorkspace(root); const profile = path.join(root, "profile.md"); const original = fs.readFileSync(profile, "utf8"); assert.throws(() => migrateWorkspace(root, ["profile.md"], () => { fs.writeFileSync(profile, "partial"); throw new Error("boom"); }, "settings-v2"), /boom/); assert.equal(fs.readFileSync(profile, "utf8"), original); assert.equal(fs.existsSync(path.join(root, ".pi-jobs", "migration-journal.json")), false); migrateWorkspace(root, ["profile.md"], () => fs.writeFileSync(profile, "migrated"), "settings-v2"); assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".pi-jobs", "workspace-version.json"), "utf8")).lastMigration, "settings-v2"); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("a recent lock blocks restore even without metadata", () => { const root = fixture(); try { initWorkspace(root); const id = createBackup(root, ["profile.md"]); fs.mkdirSync(path.join(root, "ui"), { recursive: true }); fs.mkdirSync(path.join(root, "ui", "run-manager.json.lock")); assert.throws(() => restoreBackup(root, id), /active/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("failed migration removes files that did not exist in the backup", () => { const root = fixture(); try { initWorkspace(root); const created = path.join(root, "new-state.json"); assert.equal(fs.existsSync(created), false); assert.throws(() => migrateWorkspace(root, ["new-state.json"], () => { fs.writeFileSync(created, "partial"); throw new Error("boom"); }, "new-state"), /boom/); assert.equal(fs.existsSync(created), false); assert.equal(fs.existsSync(path.join(root, ".pi-jobs", "migration-journal.json")), false); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("startup recovery restores the marker recorded before an interrupted migration", () => { const root = fixture(); try { initWorkspace(root); const marker = path.join(root, ".pi-jobs", "workspace-version.json"); const prior = fs.readFileSync(marker); const id = createBackup(root, ["profile.md"], "interrupted"); fs.writeFileSync(path.join(root, "profile.md"), "partial"); fs.writeFileSync(marker, JSON.stringify({ version: 2, lastMigration: "partial" })); fs.writeFileSync(path.join(root, ".pi-jobs", "migration-journal.json"), JSON.stringify({ state: "started", backupId: id, priorMarker: prior.toString("base64") })); initWorkspace(root); assert.deepEqual(fs.readFileSync(marker), prior); assert.doesNotMatch(fs.readFileSync(path.join(root, "profile.md"), "utf8"), /partial/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test("launcher rejects missing and out-of-range ports before startup", () => { for (const args of [["start", "--port"], ["start", "--port", "0"], ["start", "--port", "65536"]]) { const result = spawnSync(process.execPath, [path.join(codeRoot, "scripts", "pi-jobs.mjs"), ...args], { cwd: codeRoot, encoding: "utf8" }); assert.equal(result.status, 2); assert.match(result.stderr, /--port must be an integer from 1 to 65535/); } });
test("demo rejects --root and PI_JOBS_ROOT overrides", () => {
  const withRoot = spawnSync(process.execPath, [path.join(codeRoot, "scripts", "pi-jobs.mjs"), "demo", "--root", codeRoot], { cwd: codeRoot, encoding: "utf8" });
  assert.equal(withRoot.status, 2);
  assert.match(withRoot.stderr, /ignores --root/);
  const withEnv = spawnSync(process.execPath, [path.join(codeRoot, "scripts", "pi-jobs.mjs"), "demo"], { cwd: codeRoot, encoding: "utf8", env: { ...process.env, PI_JOBS_ROOT: codeRoot } });
  assert.equal(withEnv.status, 2);
});
test("resolveWorkspaceRoot refuses a root outside this clone", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-outside-"));
  const prev = process.env.PI_JOBS_ROOT;
  try {
    process.env.PI_JOBS_ROOT = outside;
    assert.throws(() => resolveWorkspaceRoot([]), /--root must resolve to this clone/);
  } finally {
    if (prev === undefined) delete process.env.PI_JOBS_ROOT;
    else process.env.PI_JOBS_ROOT = prev;
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
test("initWorkspace refuses an incomplete root and accepts demo-style roots", () => {
  const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-workspace-test-"));
  fs.cpSync(path.resolve("templates"), path.join(incomplete, "templates"), { recursive: true });
  try {
    assert.throws(() => initWorkspace(incomplete), /not a complete clone/);
  } finally {
    fs.rmSync(incomplete, { recursive: true, force: true });
  }
  const demo = demoFixture();
  try {
    initWorkspace(demo);
    assert.ok(fs.existsSync(path.join(demo, "profile.md")));
  } finally {
    fs.rmSync(demo, { recursive: true, force: true });
  }
});
test("interrupted migrateWorkspace recovers via recoverMigration", () => {
  const root = fixture();
  try {
    initWorkspace(root);
    const marker = path.join(root, ".pi-jobs", "workspace-version.json");
    const prior = fs.readFileSync(marker);
    const id = createBackup(root, ["profile.md"], "interrupted-recover");
    fs.writeFileSync(path.join(root, "profile.md"), "partial");
    fs.writeFileSync(marker, JSON.stringify({ version: 2, lastMigration: "partial" }));
    fs.writeFileSync(path.join(root, ".pi-jobs", "migration-journal.json"), JSON.stringify({ state: "started", backupId: id, priorMarker: prior.toString("base64") }));
    assert.equal(recoverMigration(root), true);
    assert.deepEqual(fs.readFileSync(marker), prior);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "profile.md"), "utf8"), /partial/);
    assert.equal(fs.existsSync(path.join(root, ".pi-jobs", "migration-journal.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("restoreBackup leaves a persisted pre-restore backup", () => {
  const root = fixture();
  try {
    initWorkspace(root);
    const profile = path.join(root, "profile.md");
    const original = fs.readFileSync(profile, "utf8");
    const id = createBackup(root, ["profile.md"]);
    fs.writeFileSync(profile, "changed");
    const { preRestoreId } = restoreBackup(root, id);
    assert.match(preRestoreId, /-pre-restore$/);
    assert.ok(fs.existsSync(path.join(root, ".pi-jobs", "backups", preRestoreId, "manifest.json")));
    assert.equal(fs.readFileSync(profile, "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("restoreBackup refuses backup paths with no lock mapping", () => {
  const root = fixture();
  try {
    initWorkspace(root);
    const id = createBackup(root, ["profile.md"]);
    const manifestFile = path.join(root, ".pi-jobs", "backups", id, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.files.push({ path: "APPLIED.md", existed: false });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => restoreBackup(root, id), /no lock mapping/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("runWorkspaceBackup round-trips default paths and restore --list reports them", () => {
  const root = fixture();
  try {
    initWorkspace(root);
    fs.writeFileSync(
      path.join(root, "jobs", "queue", "acme-role.md"),
      "---\nurl: https://example.com/j\ncompany: Acme\ntitle: Role\n---\n",
      "utf8",
    );
    const profile = path.join(root, "profile.md");
    const originalProfile = fs.readFileSync(profile, "utf8");
    const paths = resolveDefaultBackupPaths(root);
    assert.ok(paths.includes("jobs/queue/acme-role.md"));
    const { id, fileCount } = runWorkspaceBackup(root);
    assert.ok(fileCount >= DEFAULT_BACKUP_PATHS.length);
    fs.writeFileSync(profile, "mutated profile");
    const listed = listBackups(root).find((entry) => entry.id === id);
    assert.ok(listed);
    assert.equal(listed.fileCount, fileCount);
    restoreBackup(root, id);
    assert.equal(fs.readFileSync(profile, "utf8"), originalProfile);
    const line = listBackups(root)
      .map((entry) => `${entry.id}\t${entry.date}\t${entry.fileCount}`)
      .find((row) => row.startsWith(`${id}\t`));
    assert.ok(line);
    assert.match(line, new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t`));
    assert.match(line, /\t\d+$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runWorkspaceBackup refuses during an active run", () => {
  const root = fixture();
  try {
    initWorkspace(root);
    fs.mkdirSync(path.join(root, "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "ui", "run-manager.json"),
      JSON.stringify({ runId: "x", pid: process.pid, sessionName: "test", startedAt: new Date().toISOString() }),
    );
    assert.throws(() => runWorkspaceBackup(root), /active/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup waits for a dashboard credentials lock and snapshots pre-restore state", async () => {
  const root = demoFixture();
  try {
    initWorkspace(root);
    const creds = path.join(root, "credentials.json");
    const originalText = fs.readFileSync(creds, "utf8");
    const backupId = createBackup(root, ["credentials.json"]);
    fs.writeFileSync(creds, JSON.stringify({ seed: { host: "seed.example.com", username: "s", ats: "other" } }, null, 2), "utf8");
    const dashHost = "dash-write.example.com";
    const { child, wait } = spawnCredentialPauseChild(root, dashHost, "cred-pause-ws");
    await waitForPause(root, "cred-pause-ws");
    const restorePromise = restoreBackup(root, backupId);
    child.kill("SIGKILL");
    await wait();
    const { preRestoreId } = await restorePromise;
    assert.equal(fs.readFileSync(creds, "utf8"), originalText);
    const preManifest = JSON.parse(fs.readFileSync(path.join(root, ".pi-jobs", "backups", preRestoreId, "manifest.json"), "utf8"));
    const credsEntry = preManifest.files.find((f) => f.path === "credentials.json");
    const preBytes = fs.readFileSync(path.join(root, ".pi-jobs", "backups", preRestoreId, credsEntry.backup), "utf8");
    assert.match(preBytes, /seed\.example\.com/);
    assert.doesNotMatch(preBytes, new RegExp(dashHost));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
