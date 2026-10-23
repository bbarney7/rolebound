import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

test("ci.yml parses as YAML and wires fresh-user smoke on export and macOS verify", () => {
  const doc = yaml.load(fs.readFileSync(workflowPath, "utf8"));
  assert.equal(doc.name, "CI");
  const release = doc.jobs["release-export"];
  assert.ok(release);
  const releaseRun = release.steps.map((step) => step.run).filter(Boolean).join("\n");
  assert.match(releaseRun, /rolebound pilot ü/);
  assert.match(releaseRun, /fresh-user-smoke/);

  const verify = doc.jobs.verify;
  const macStep = verify.steps.find(
    (step) => step.name === "Fresh-user smoke on exported Unicode path (macOS)",
  );
  assert.ok(macStep, "expected macOS fresh-user smoke step");
  assert.equal(macStep.if, "runner.os == 'macOS'");
  assert.match(macStep.run, /rolebound pilot ü/);
  assert.match(macStep.run, /fresh-user-smoke/);
});

// Walks the files rather than using `git grep`: CI also runs this inside the exported
// tree, which has no .git directory.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "Codex-info", "docs", "dist", "artifacts",
  ".pi-jobs", ".browser-data", "uploads", "resumes", "screenshots",
]);

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

test("removed provider-login identifiers do not return outside historical documentation", () => {
  const removed = new RegExp([
    ["cursor", "login"].join("-"),
    ["cursor", "import"].join("-"),
    ["Cursor", "Connection", "Auth"].join(""),
  ].join("|"));
  const hits = [];
  for (const file of sourceFiles(repoRoot)) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\u0000")) continue;
    text.split("\n").forEach((line, index) => {
      if (removed.test(line)) hits.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `obsolete identifiers remain:\n${hits.join("\n")}`);
});
