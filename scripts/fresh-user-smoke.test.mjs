import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HOSTILE_AUTH_FAKE_KEY,
  SCAFFOLD_BLOCKER_CODES,
  buildChildEnv,
  loadScrubEnvNames,
  parseDoctorBlockers,
  readinessBlockerCodes,
} from "./fresh-user-smoke.mjs";
import { codeRoot } from "./workspace.mjs";

test("loadScrubEnvNames includes provider catalog scrub names and CAPTCHA env vars", async () => {
  const names = await loadScrubEnvNames(codeRoot);
  assert.ok(names.includes("OPENAI_API_KEY"));
  assert.ok(names.includes("ANTHROPIC_OAUTH_TOKEN"));
  assert.ok(names.includes("CURSOR_API_KEY"));
  assert.ok(names.includes("CAPSOLVER_API_KEY"));
  assert.ok(names.includes("TWOCAPTCHA_API_KEY"));
});

test("buildChildEnv clears scrubbed keys and uses isolated HOME and PI_CODING_AGENT_DIR", async () => {
  const names = await loadScrubEnvNames(codeRoot);
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fresh-user-home-"));
  const agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fresh-user-agent-"));
  const polluted = { OPENAI_API_KEY: "leak", CAPSOLVER_API_KEY: "leak", CUSTOM: "keep" };
  const env = buildChildEnv({ workspaceRoot: codeRoot, home, piAgentDir: agentDir, scrubNames: names, parentEnv: polluted });
  assert.equal(env.HOME, home);
  assert.equal(env.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CAPSOLVER_API_KEY, undefined);
  assert.equal(env.CUSTOM, "keep");
});

test("parseDoctorBlockers captures scaffold codes from shipped doctor output shape", () => {
  const sample = `
BLOCKED AGENT_MODEL_MISSING: Choose an agent connection and model.
BLOCKED NAME_MISSING: Add your full name.
BLOCKED EMAIL_MISSING: Add a valid email address.
BLOCKED PROFILE_PLACEHOLDERS: Replace template placeholders in Identity, Work history, Education, Authorization, Q&A bank.
BLOCKED RESUME_MISSING: Upload and select a default or global PDF resume.
BLOCKED TARGETS_PLACEHOLDER: Replace the example targets with real company board slugs
BLOCKED ACKNOWLEDGEMENT_MISSING: Acknowledge automatic submission before applying.
BLOCKED capability discover
`;
  const blockers = parseDoctorBlockers(sample);
  for (const code of SCAFFOLD_BLOCKER_CODES) {
    assert.ok(blockers.has(code), `expected ${code}`);
  }
  assert.equal(blockers.get("AGENT_MODEL_MISSING"), "Choose an agent connection and model.");
});

test("readinessBlockerCodes collects step and score blockers", () => {
  const codes = readinessBlockerCodes({
    steps: [
      { blockers: [{ code: "AGENT_MODEL_MISSING" }, { code: "NAME_MISSING" }] },
      { blockers: [{ code: "RESUME_MISSING" }] },
    ],
    scoreBlockers: [{ code: "PROFILE_PLACEHOLDERS" }],
  });
  assert.deepEqual(
    [...codes].sort(),
    ["AGENT_MODEL_MISSING", "NAME_MISSING", "PROFILE_PLACEHOLDERS", "RESUME_MISSING"].sort(),
  );
});

test("hostile auth fake key is a unique probe string", () => {
  assert.match(HOSTILE_AUTH_FAKE_KEY, /fresh-user-hostile/);
  assert.ok(HOSTILE_AUTH_FAKE_KEY.length >= 24);
});
