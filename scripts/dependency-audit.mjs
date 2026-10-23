import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function auditFindings(report, exceptions, today = new Date().toISOString().slice(0, 10)) {
  if (report.error || !report.vulnerabilities || !report.metadata) throw new Error("dependency audit did not return a complete report");
  const rejected = new Set();
  const accepted = new Set();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    for (const advisory of entry.via) {
      if (typeof advisory === "string") {
        if (!report.vulnerabilities[advisory]) rejected.add(`${name}: unresolved dependency ${advisory}`);
        continue; // every leaf is also audited as its own vulnerability entry
      }
      const exception = exceptions.find(value => value.advisory === advisory.url && value.package === name);
      if (exception && exception.expires >= today && entry.severity === "moderate" && advisory.severity === "moderate") accepted.add(advisory.url);
      else rejected.add(`${name}: ${advisory.url}`);
    }
  }
  return { rejected: [...rejected], accepted: [...accepted] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    let raw;
    try { raw = execFileSync("npm", ["audit", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 10_000_000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      if (error.status !== 1 || !error.stdout) throw new Error("npm audit failed to obtain advisory data");
      raw = error.stdout;
    }
    const exceptions = JSON.parse(fs.readFileSync(new URL("../docs/dependency-audit-exceptions.json", import.meta.url), "utf8"));
    const result = auditFindings(JSON.parse(raw), exceptions);
    if (result.rejected.length) {
      console.error("dependency audit rejected:", result.rejected.join("; "));
      process.exitCode = 1;
    } else {
      console.log(`dependency audit passed: ${result.accepted.length} documented moderate CLI-only advisory exception(s); no other findings`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
