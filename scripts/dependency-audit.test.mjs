import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import { auditFindings } from "./dependency-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = "https://github.com/advisories/GHSA-hp3w-g68c-fv3c";
const exception = { advisory: url, package: "sprintf-js", expires: "2026-11-06" };
const report = (severity = "moderate", advisory = url) => ({ metadata: {}, vulnerabilities: { "sprintf-js": { severity, via: [{ severity, url: advisory }] } } });

test("accepts only the exact active moderate advisory; rejects new, severe and expired findings", () => {
  assert.deepEqual(auditFindings(report(), [exception], "2026-10-06").rejected, []);
  assert.equal(auditFindings(report("high"), [exception], "2026-10-06").rejected.length, 1);
  assert.equal(auditFindings(report("moderate", "https://github.com/advisories/new"), [exception], "2026-10-06").rejected.length, 1);
  assert.equal(auditFindings(report(), [exception], "2026-11-07").rejected.length, 1);
  assert.throws(() => auditFindings({ error: {} }, []), /complete report/);
});

test("@cursor/sdk root pin matches pi-cursor-sdk dependency", () => {
  const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const cursorSdkPkg = JSON.parse(readFileSync(path.join(root, "node_modules/pi-cursor-sdk/package.json"), "utf8"));
  assert.equal(rootPkg.dependencies["@cursor/sdk"], cursorSdkPkg.dependencies["@cursor/sdk"]);
});

test("the supported YAML parsing path does not load the vulnerable CLI dependency", () => {
  const require = createRequire(import.meta.url);
  const matter = require("gray-matter");
  assert.equal(matter("---\ntitle: Fixture\nscore: 5\n---\nbody").data.score, 5);
  const modules = Object.keys(require.cache);
  assert.ok(!modules.some(value => /node_modules\/(argparse|sprintf-js)\//.test(value)));
});
