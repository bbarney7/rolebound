#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { classifyFiles, listFiles, loadManifest, scanContent, scanGitHistory, redactPath } from "./release-tools.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const candidate = arg("--candidate");
if (!candidate) { console.error("usage: release-audit.mjs --candidate <directory>"); process.exit(2); }
try {
  const root = path.resolve(candidate);
  const manifest = await loadManifest(arg("--manifest") ? path.resolve(arg("--manifest")) : undefined);
  const files = await listFiles(root, { manifest });
  const classes = classifyFiles(files, manifest, { forExport: false });
  const findings = await scanContent(root, classes.included);
  const historyFindings = await scanGitHistory(root, manifest);
  if (classes.prohibited.length || classes.unreviewed.length || findings.length || historyFindings.length) {
    console.error(`release audit failed: prohibited=${classes.prohibited.length} unreviewed=${classes.unreviewed.length} secret-patterns=${findings.length} history-findings=${historyFindings.length}`);
    for (const file of [...classes.prohibited, ...classes.unreviewed]) console.error(`rejected: ${redactPath(file)}`);
    for (const file of findings) console.error(`secret-pattern: ${redactPath(file)}`);
    for (const file of historyFindings) console.error(`history-finding: ${redactPath(file)}`);
    process.exit(1);
  }
  console.log(`release audit clean: ${classes.included.length} reviewed files`);
} catch (error) {
  console.error(`release audit error: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(2);
}
