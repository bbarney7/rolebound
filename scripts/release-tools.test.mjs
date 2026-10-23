import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifyFiles, exportIgnorePatterns, listFiles, loadManifest, scanContent, scanGitHistory } from "./release-tools.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-release-test-"));
try {
  await fs.mkdir(path.join(temp, "templates"));
  await fs.writeFile(path.join(temp, "templates/profile.template.md"), "Name: <FILL IN>\nEmail: you@example.com\n");
  const keyLabel = "api_" + "key";
  await fs.writeFile(path.join(temp, "templates/bad.txt"), `${keyLabel} = 'synthetic-secret-that-must-not-be-printed-1234567890'`);
  const manifest = await loadManifest();
  assert.deepEqual(exportIgnorePatterns(manifest), [
    "ui/e2e/artifacts/**",
    "ui/e2e/.runtime.json",
    "ui/test-results/**",
    "test-results/**",
    "ui/public/brand/board-preview.png",
  ]);
  const required = ["scripts/process-lifecycle.mjs", "scripts/process-lifecycle.test.mjs", "scripts/smoke-support.mjs", "scripts/dependency-audit.mjs", "scripts/dependency-audit.test.mjs", "ui/server/shutdown.ts", "Codex-info/plans/PJR-21/plan.md"];
  assert.deepEqual(classifyFiles(required, manifest).included, required);
  const classes = classifyFiles(["templates/profile.template.md", "templates/bad.txt", "profile.md"], manifest);
  assert.deepEqual(classes.prohibited, ["profile.md"]);
  assert.deepEqual(classes.unreviewed, []);
  const findings = await scanContent(temp, ["templates/profile.template.md", "templates/bad.txt"]);
  assert.deepEqual(findings, ["templates/bad.txt"]);
  const history = path.join(temp, "history");
  await fs.mkdir(history);
  execFileSync("git", ["init", "-q", history]);
  await fs.writeFile(path.join(history, "README.md"), "safe");
  execFileSync("git", ["-C", history, "add", "README.md"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "safe"]);
  await fs.writeFile(path.join(history, "profile.md"), "fictional profile with no credentials");
  await fs.mkdir(path.join(history, "docs"));
  await fs.writeFile(path.join(history, "docs", "secret-example.md"), `${"to" + "ken"} = 'synthetic-history-secret-12345678901234567890'`);
  execFileSync("git", ["-C", history, "add", "profile.md", "docs/secret-example.md"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "bad"]);
  execFileSync("git", ["-C", history, "rm", "-q", "profile.md", "docs/secret-example.md"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "remove"]);
  const historyFindings = await scanGitHistory(history, manifest);
  assert.deepEqual(historyFindings, ["docs/secret-example.md", "profile.md"]);

  await fs.writeFile(path.join(history, "scratch-unreviewed.txt"), "temporary");
  execFileSync("git", ["-C", history, "add", "scratch-unreviewed.txt"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "scratch"]);
  const unreviewedHistory = await scanGitHistory(history, manifest);
  assert.ok(unreviewedHistory.includes("scratch-unreviewed.txt"));

  await fs.mkdir(path.join(history, "ui/e2e/artifacts"), { recursive: true });
  await fs.writeFile(path.join(history, "ui/e2e/artifacts", "old-trace.zip"), "zip");
  execFileSync("git", ["-C", history, "add", "ui/e2e/artifacts/old-trace.zip"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "artifact"]);
  execFileSync("git", ["-C", history, "rm", "-q", "ui/e2e/artifacts/old-trace.zip"]);
  execFileSync("git", ["-C", history, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "drop-artifact"]);
  const artifactHistory = await scanGitHistory(history, manifest);
  assert.ok(artifactHistory.includes("ui/e2e/artifacts/old-trace.zip"));

  const candidate = path.join(temp, "candidate");
  await fs.mkdir(path.join(candidate, ".pi-jobs", "browser-private"), { recursive: true });
  await fs.writeFile(path.join(candidate, ".pi-jobs", "browser-private", "session.json"), "{}");
  const candidateFiles = await listFiles(candidate, { manifest });
  assert.deepEqual(classifyFiles(candidateFiles, manifest).prohibited, [".pi-jobs/browser-private/session.json"]);
  assert.deepEqual(await listFiles(candidate, { prunePrivateRuntime: true, forExport: true, manifest }), []);

  assert.deepEqual(await scanGitHistory(candidate, manifest), []);
  await fs.mkdir(path.join(candidate, ".git"));
  await assert.rejects(scanGitHistory(candidate, manifest), /cannot inspect candidate Git history/);

  const allowClasses = classifyFiles(["ui/e2e/fixtures/sample.pdf", "resumes/secret.pdf"], manifest);
  assert.deepEqual(allowClasses.included, ["ui/e2e/fixtures/sample.pdf"]);
  assert.deepEqual(allowClasses.prohibited, ["resumes/secret.pdf"]);

  await fs.mkdir(path.join(candidate, "ui/e2e/artifacts/nested"), { recursive: true });
  await fs.writeFile(path.join(candidate, "ui/e2e/artifacts/nested/trace.zip"), "zip");
  await fs.writeFile(path.join(candidate, "ui/e2e/.runtime.json"), "{}");
  const secretLabel = "api_" + "key";
  await fs.writeFile(
    path.join(candidate, "ui/e2e/artifacts", "synthetic-secret.txt"),
    `${secretLabel} = 'synthetic-ignored-path-secret-12345678901234567890'`,
  );
  await fs.mkdir(path.join(candidate, "ui/test-results"), { recursive: true });
  await fs.writeFile(path.join(candidate, "ui/test-results", ".last-run.json"), "{}");
  await fs.mkdir(path.join(candidate, "test-results"), { recursive: true });
  await fs.writeFile(path.join(candidate, "test-results", ".last-run.json"), "{}");

  const auditFiles = await listFiles(candidate, { manifest });
  assert.ok(auditFiles.includes("ui/e2e/artifacts/nested/trace.zip"));
  assert.ok(auditFiles.includes("ui/e2e/.runtime.json"));
  assert.ok(auditFiles.includes("ui/e2e/artifacts/synthetic-secret.txt"));
  assert.ok(auditFiles.includes("ui/test-results/.last-run.json"));
  assert.ok(auditFiles.includes("test-results/.last-run.json"));
  const auditClasses = classifyFiles(auditFiles, manifest);
  assert.ok(auditClasses.prohibited.includes("ui/e2e/artifacts/nested/trace.zip"));
  assert.ok(auditClasses.prohibited.includes("ui/e2e/.runtime.json"));
  assert.ok(auditClasses.prohibited.includes("ui/e2e/artifacts/synthetic-secret.txt"));
  assert.ok(auditClasses.prohibited.includes("ui/test-results/.last-run.json"));
  assert.ok(auditClasses.prohibited.includes("test-results/.last-run.json"));

  const exportFiles = await listFiles(candidate, { manifest, forExport: true });
  assert.ok(!exportFiles.some((file) => file.startsWith("ui/e2e/artifacts/")));
  assert.ok(!exportFiles.includes("ui/e2e/.runtime.json"));
  assert.ok(!exportFiles.some((file) => file.startsWith("ui/test-results/")));
  assert.ok(!exportFiles.some((file) => file.startsWith("test-results/")));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
