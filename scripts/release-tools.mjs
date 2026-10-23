import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_MANIFEST = new URL("./release-manifest.json", import.meta.url);

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*")}$`);
}

export function normalizeRelative(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`unsafe relative path: ${value}`);
  }
  return normalized;
}

export function matchesAny(relative, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(relative));
}

export async function loadManifest(file = DEFAULT_MANIFEST) {
  const raw = await fs.readFile(file, "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.include) || !Array.isArray(manifest.exclude)) {
    throw new Error("invalid release manifest");
  }
  return manifest;
}

/** Paths omitted from export source walks; MUST fail strict candidate/history audit when present. */
export function exportIgnorePatterns(manifest) {
  return manifest.exportIgnore ?? manifest.ignore ?? [];
}

const RUNTIME_DIRS = new Set(["node_modules", "dist"]);
const PRIVATE_RUNTIME_DIRS = new Set([".browser-data", ".playwright-mcp", ".pi-jobs"]);

async function walk(root, current = root, result = [], options = {}) {
  const ignore = options.ignore ?? [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || RUNTIME_DIRS.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed: ${path.relative(root, absolute)}`);
    const relative = normalizeRelative(path.relative(root, absolute));
    if (matchesAny(relative, ignore) || matchesAny(`${relative}/**`, ignore)) continue;
    if (entry.isDirectory() && PRIVATE_RUNTIME_DIRS.has(entry.name) && options.prunePrivateRuntime) continue;
    if (entry.isDirectory()) await walk(root, absolute, result, options);
    else result.push(relative);
  }
  return result;
}

export async function listFiles(root, options = {}) {
  const forExport = options.forExport === true;
  const ignore = forExport ? exportIgnorePatterns(options.manifest ?? {}) : (options.ignore ?? []);
  return (await walk(root, root, [], { ...options, ignore })).sort();
}

export function classifyFiles(files, manifest, options = {}) {
  const forExport = options.forExport === true;
  const exportIgnore = exportIgnorePatterns(manifest);
  const prohibited = [];
  const unreviewed = [];
  const included = [];
  for (const file of files) {
    if (matchesAny(file, exportIgnore)) {
      if (forExport) continue;
      prohibited.push(file);
      continue;
    }
    const explicitlyIncluded = matchesAny(file, manifest.include ?? []);
    const allowBinary = matchesAny(file, manifest.allowBinary ?? []);
    const marker = file.endsWith("/.gitkeep");
    if (allowBinary) {
      included.push(file);
      continue;
    }
    if (explicitlyIncluded && marker) included.push(file);
    else if (matchesAny(file, manifest.sensitivePathPatterns ?? [])) prohibited.push(file);
    else if (matchesAny(file, manifest.exclude ?? [])) prohibited.push(file);
    else if (explicitlyIncluded) included.push(file);
    else unreviewed.push(file);
  }
  return { included, prohibited, unreviewed };
}

const secretRules = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{20,}\b/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}/i
];

export async function scanContent(root, files) {
  const findings = [];
  for (const file of files) {
    let text;
    try { text = await fs.readFile(path.join(root, file), "utf8"); }
    catch { throw new Error(`cannot read candidate file: ${file}`); }
    // Test fixtures may name a non-secret sentinel; keep the scanner focused on
    // values that could be copied into a real release.
    text = text.replaceAll("SENTINEL_PASSWORD", "<placeholder>").replaceAll("FIXTURE_PASSWORD", "<placeholder>").replaceAll("FIXTURE-SECRET-do-not-leak", "<placeholder>");
    for (const rule of secretRules) {
      if (rule.test(text)) { findings.push(file); break; }
    }
  }
  return findings;
}

export async function hashFiles(root, files) {
  const hashes = {};
  for (const file of files) hashes[file] = createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex");
  return hashes;
}

export async function scanGitHistory(root, manifest) {
  // A candidate export intentionally has no history. Do not let Git discover
  // and scan an unrelated parent checkout.
  try { await fs.lstat(path.join(root, ".git")); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const findings = [];
  let listing;
  try { ({ stdout: listing } = await execFileAsync("git", ["-C", root, "rev-list", "--objects", "--all"], { maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { throw new Error(`cannot inspect candidate Git history: ${error instanceof Error ? error.message : String(error)}`); }
  for (const line of listing.split("\n")) {
    const match = line.match(/^([0-9a-f]{40})\s*(.*)$/);
    if (!match) continue;
    const [, oid, file] = match;
    let type;
    try { ({ stdout: type } = await execFileAsync("git", ["-C", root, "cat-file", "-t", oid])); }
    catch (error) { throw new Error(`cannot inspect Git object ${oid}: ${error instanceof Error ? error.message : String(error)}`); }
    if (type.trim() !== "blob") continue;
    const historicalClass = file ? classifyFiles([file], manifest, { forExport: false }) : { prohibited: [], unreviewed: [] };
    const sensitivePath = file && !file.endsWith("/.gitkeep") && (historicalClass.prohibited.length > 0 || historicalClass.unreviewed.length > 0);
    let content;
    try { ({ stdout: content } = await execFileAsync("git", ["-C", root, "cat-file", "-p", oid], { maxBuffer: 8 * 1024 * 1024 })); }
    catch { findings.push(file || "<history blob>"); continue; }
    content = content.replaceAll("SENTINEL_PASSWORD", "<placeholder>").replaceAll("FIXTURE_PASSWORD", "<placeholder>").replaceAll("FIXTURE-SECRET-do-not-leak", "<placeholder>");
    const hasSecret = secretRules.some((rule) => rule.test(content));
    if (sensitivePath || hasSecret) findings.push(file || "<history blob>");
  }
  return [...new Set(findings)].sort();
}

export function redactPath(value) {
  return path.basename(value);
}
