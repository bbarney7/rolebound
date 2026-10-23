import { withFileLock } from "./durable-store";
import { wsPath } from "./workspace";

/** Parsed ATS board entry from `targets.md`. */
export interface TargetEntry {
  source: "greenhouse" | "ashby" | "lever";
  slug: string;
}

/** Lossless parser for grouped `targets.md` board lists. */
export function parseTargets(md: string): TargetEntry[] {
  const lines = md.split("\n");
  let currentSource: TargetEntry["source"] | null = null;
  const out: TargetEntry[] = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) {
      const m = raw.match(/^#+\s*(greenhouse|ashby|lever)/i);
      if (m) currentSource = m[1].toLowerCase() as TargetEntry["source"];
      else if (raw.startsWith("#")) currentSource = null;
      continue;
    }
    if (raw.startsWith("- ")) {
      const slug = raw.slice(2).trim().split(/\s+/)[0];
      if (slug && currentSource) out.push({ source: currentSource, slug });
    }
  }
  return out;
}

export async function withTargetsLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockTarget = wsPath("targets.md.lock");
  const { promises: fs } = await import("node:fs");
  await fs.appendFile(lockTarget, "");
  return withFileLock(lockTarget, async () => fn());
}
