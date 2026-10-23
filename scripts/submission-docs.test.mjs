import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(codeRoot, rel), "utf8");
}

function listBoundaryComments(dir) {
  const found = new Set();
  const walk = (rel) => {
    const abs = path.join(codeRoot, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(rel, ent.name);
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".mts"))) {
        const text = fs.readFileSync(path.join(codeRoot, child), "utf8");
        for (const m of text.matchAll(/\/\/\s*boundary:\s*(B\d+)/g)) found.add(m[1]);
      }
    }
  };
  walk(dir);
  return found;
}

function codeEnforcedBoundaryIds(securityMd) {
  const ids = [];
  for (const line of securityMd.split("\n")) {
    if (!/^\|\s*B\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 3) continue;
    const id = cells[0];
    const enforcement = cells[2];
    if (/\*\*Code/.test(enforcement)) ids.push(id);
  }
  return ids;
}

test("ats-adapters guidance does not reference CLAUDE.md stop-and-ask", () => {
  const src = read(".pi/extensions/ats-adapters.ts");
  assert.equal(src.includes("per CLAUDE.md"), false);
});

test("SECURITY.md and README omit explicit submit confirmation claim", () => {
  const security = read("SECURITY.md");
  const readme = read("README.md");
  assert.equal(security.toLowerCase().includes("explicit submit confirmation"), false);
  assert.equal(readme.toLowerCase().includes("explicit submit confirmation"), false);
});

test("every code-enforced boundary id in SECURITY.md has a boundary comment in lib or server tests", () => {
  const security = read("SECURITY.md");
  const required = codeEnforcedBoundaryIds(security);
  const comments = new Set([
    ...listBoundaryComments(".pi/extensions/lib"),
    ...listBoundaryComments("ui/server/__tests__"),
  ]);
  const missing = required.filter((id) => !comments.has(id));
  assert.deepEqual(
    missing,
    [],
    `Missing // boundary: comments for: ${missing.join(", ")} (have: ${[...comments].sort().join(", ")})`,
  );
});

function collectReadinessBlockerCodes() {
  const readiness = read("ui/server/readiness.ts");
  const profilePlaceholders = read("ui/shared/profilePlaceholders.ts");
  const codes = new Set();
  for (const m of readiness.matchAll(/blocker\(\s*"([^"]+)"/g)) codes.add(m[1]);
  for (const m of readiness.matchAll(/blocker\(\s*([A-Z][A-Z0-9_]+)/g)) {
    const name = m[1];
    const constMatch = profilePlaceholders.match(
      new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
    );
    if (constMatch) codes.add(constMatch[1]);
  }
  for (const m of profilePlaceholders.matchAll(/export const ([A-Z_]+_CODE)\s*=\s*"([^"]+)"/g)) {
    codes.add(m[2]);
  }
  const cursorAuth = read("ui/server/providers/cursorReadiness.ts");
  for (const m of cursorAuth.matchAll(/code:\s*"([A-Z_]+)"/g)) {
    const code = m[1];
    if (code === "CURSOR_LOGIN_EXPIRING") continue;
    codes.add(code);
  }
  return codes;
}

function collectDoctorInfrastructureTokens() {
  const doctor = read("scripts/doctor-readiness.mts");
  const tokens = new Set();
  for (const m of doctor.matchAll(/console\.log\(`BLOCKED ([^:]+):/g)) tokens.add(m[1].trim());
  for (const m of doctor.matchAll(/console\.log\("BLOCKED ([^:]+):/g)) tokens.add(m[1].trim());
  for (const m of doctor.matchAll(/return "BLOCKED ([^:]+):/g)) tokens.add(m[1].trim());
  return tokens;
}

function npmRunScriptsFromWalkthrough(markdown) {
  const scripts = new Set();
  for (const m of markdown.matchAll(/npm run ([a-zA-Z0-9:-]+)/g)) scripts.add(m[1].replace(/:$/, ""));
  return scripts;
}

function tableCodesBetween(markdown, startMarker, endMarker) {
  const part = markdown.split(startMarker)[1]?.split(endMarker)[0] ?? "";
  const codes = new Set();
  for (const m of part.matchAll(/\| `([A-Z][A-Z0-9_]+)` \|/g)) codes.add(m[1]);
  return codes;
}

function doctorCodesFromWalkthrough(markdown) {
  return new Set([
    ...tableCodesBetween(markdown, "## 7.", "## 8."),
    ...tableCodesBetween(markdown, "### Test connection and provider error codes", "## 5."),
  ]);
}

function collectProviderErrorCodes() {
  const providers = read("ui/shared/providers.ts");
  const match = providers.match(/ProviderErrorCode\s*=\s*([^;]+);/);
  assert.ok(match, "ProviderErrorCode type not found");
  return new Set(match[1].match(/"([A-Z_]+)"/g).map((s) => s.slice(1, -1)));
}

test("support-walkthrough npm run scripts exist in package.json", () => {
  const walkthrough = read("docs/support-walkthrough.md");
  const pkg = JSON.parse(read("package.json"));
  const scripts = npmRunScriptsFromWalkthrough(walkthrough);
  assert.ok(scripts.size > 0, "expected npm run commands in support-walkthrough.md");
  const missing = [...scripts].filter((name) => !(name in pkg.scripts));
  assert.deepEqual(missing, [], `unknown npm scripts: ${missing.join(", ")}`);
});

test("support-walkthrough doctor readiness codes exist in readiness or doctor", () => {
  const walkthrough = read("docs/support-walkthrough.md");
  const readinessCodes = collectReadinessBlockerCodes();
  const doctorInfra = collectDoctorInfrastructureTokens();
  const providerCodes = collectProviderErrorCodes();
  const warningCodes = new Set(["MODEL_UNVERIFIED", "CURSOR_LOGIN_EXPIRING"]);
  const named = doctorCodesFromWalkthrough(walkthrough);
  const missing = [...named].filter(
    (code) =>
      !readinessCodes.has(code) &&
      !doctorInfra.has(code) &&
      !providerCodes.has(code) &&
      !warningCodes.has(code) &&
      code !== "CAPABILITY",
  );
  assert.deepEqual(
    missing,
    [],
    `unknown doctor/readiness codes in walkthrough: ${missing.join(", ")} (readiness: ${[...readinessCodes].sort().join(", ")})`,
  );
});

test("support-walkthrough documents every readiness blocker code doctor can emit", () => {
  const walkthrough = read("docs/support-walkthrough.md");
  const readinessCodes = collectReadinessBlockerCodes();
  const documented = doctorCodesFromWalkthrough(walkthrough);
  const missing = [...readinessCodes].filter((code) => !documented.has(code));
  assert.deepEqual(
    missing,
    [],
    `walkthrough missing readiness blocker codes: ${missing.join(", ")}`,
  );
});
