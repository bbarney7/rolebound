#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { classifyFiles, hashFiles, listFiles, loadManifest, scanContent } from "./release-tools.mjs";

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const outputArg = arg("--output");
if (!outputArg) { console.error("usage: release-export.mjs --output <empty-directory>"); process.exit(2); }
try {
  const source = path.resolve(arg("--source") ?? process.cwd());
  const output = path.resolve(outputArg);
  const manifest = await loadManifest(arg("--manifest") ? path.resolve(arg("--manifest")) : path.join(source, "scripts/release-manifest.json"));
  const sourceReal = await fs.realpath(source);
  await fs.mkdir(output, { recursive: true });
  const outputReal = await fs.realpath(output);
  if (outputReal === sourceReal || outputReal.startsWith(`${sourceReal}${path.sep}`) || sourceReal.startsWith(`${outputReal}${path.sep}`)) throw new Error("source and output must not overlap");
  if ((await fs.readdir(output)).length) throw new Error("output directory must be empty");
  const files = await listFiles(source, { prunePrivateRuntime: true, manifest, forExport: true });
  const classes = classifyFiles(files, manifest, { forExport: true });
  // Private runtime files are expected in a live workspace and are omitted;
  // anything outside the reviewed boundary is a hard failure.
  if (classes.unreviewed.length) throw new Error("source contains unreviewed files");
  const findings = await scanContent(source, classes.included);
  if (findings.length) throw new Error("source contains secret-pattern findings");
  const { included } = classes;
  if (!included.length) throw new Error("manifest selected no files");
  for (const file of included) {
    const destination = path.join(output, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, file), destination);
  }
  const hashes = await hashFiles(output, included);
  await fs.writeFile(path.join(output, "release-index.json"), JSON.stringify({ schemaVersion: 1, source: "reviewed export", files: hashes }, null, 2) + "\n");
  console.log(`exported ${included.length} reviewed files to ${output}`);
} catch (error) {
  console.error(`release export error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(2);
}
