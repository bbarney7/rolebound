import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

test("removed provider-login identifiers do not return outside historical documentation", () => {
  const removed = [
    ["cursor", "login"].join("-"),
    ["cursor", "import"].join("-"),
    ["Cursor", "Connection", "Auth"].join(""),
  ].join("\\|");
  const result = spawnSync(
    "git",
    ["grep", "-n", removed, "--", ".", ":!Codex-info", ":!docs"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    1,
    `obsolete identifiers remain:\n${result.stdout}${result.stderr}`,
  );
});
