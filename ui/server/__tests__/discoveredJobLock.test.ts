import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCORE_TEMPLATE_VERSION, writeScoreToFrontmatter } from "../../../.pi/extensions/lib/scoring";
import { setDiscoveryDismissed } from "../readers/discoveries";
import { promoteQueueFile } from "../queueWriter";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function seedDiscovered(root: string, slug: string, raw: string) {
  const discoveredDir = path.join(root, "jobs", "discovered");
  await fs.mkdir(discoveredDir, { recursive: true });
  const file = path.join(discoveredDir, `${slug}.md`);
  await fs.writeFile(file, raw);
  return file;
}

describe("discovered job file lock", () => {
  it("coordinates score writes with dismiss and promotion without resurrecting moved files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-discovered-lock-"));
    roots.push(root);
    const slug = "acme-staff-engineer";
    const queueDir = path.join(root, "jobs", "queue");
    await fs.mkdir(queueDir, { recursive: true });
    const file = await seedDiscovered(root, slug, `---
url: https://example.invalid/jobs/1
company: Acme
title: Staff Engineer
location: Remote
---
Body
`);

    const scorePromise = writeScoreToFrontmatter(file, { score: 4, reasoning: "Fit." }, undefined);
    const dismissPromise = setDiscoveryDismissed(root, slug, true);
    const promotePromise = promoteQueueFile(root, slug);
    const [scoreResult, dismissResult, promoteResult] = await Promise.allSettled([scorePromise, dismissPromise, promotePromise]);

    const outcomes = [scoreResult, dismissResult, promoteResult].filter((item) => item.status === "fulfilled");
    expect(outcomes.length).toBeGreaterThan(0);
    const discoveredExists = await fs.stat(file).catch(() => null);
    const queueExists = await fs.stat(path.join(queueDir, `${slug}.md`)).catch(() => null);
    expect(discoveredExists && queueExists).not.toBeTruthy();
    if (discoveredExists) {
      const text = await fs.readFile(file, "utf8");
      expect(text).toMatch(/dismissed:\s*'?true'?|llm_score:/);
    }
  });

  it("serializes concurrent score writes so only one compare-and-swap succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-discovered-cas-"));
    roots.push(root);
    const slug = "acme-cas-role";
    const raw = `---
url: https://example.invalid/jobs/2
company: Acme
title: CAS Role
location: Remote
---
Body
`;
    const file = await seedDiscovered(root, slug, raw);
    const first = writeScoreToFrontmatter(file, { score: 3, reasoning: "First." }, raw);
    const second = writeScoreToFrontmatter(file, { score: 5, reasoning: "Second." }, raw);
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((item) => item.status === "fulfilled").length;
    const rejected = results.filter((item) => item.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    const saved = await fs.readFile(file, "utf8");
    expect(saved).toMatch(/llm_score: [35]/);
    expect(saved).toMatch(/llm_reasoning:/);
    expect(saved).toMatch(/llm_scored_at:/);
    expect(saved).toMatch(new RegExp(`llm_score_template: ${SCORE_TEMPLATE_VERSION}`));
  });

  it("promotes a discovered file with complete score metadata after partial llm_score is upserted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-discovered-upsert-"));
    roots.push(root);
    const slug = "acme-partial-score";
    const queueDir = path.join(root, "jobs", "queue");
    await fs.mkdir(queueDir, { recursive: true });
    const raw = `---
url: https://example.invalid/jobs/3
company: Acme
title: Partial Score
llm_score: 2
---
Body
`;
    const file = await seedDiscovered(root, slug, raw);
    await writeScoreToFrontmatter(file, { score: 4, reasoning: "Filled metadata." }, raw);
    const promoted = await promoteQueueFile(root, slug);
    expect(promoted.ok).toBe(true);
    const queue = await fs.readFile(path.join(queueDir, `${slug}.md`), "utf8");
    expect(queue).toMatch(/llm_score: 4/);
    expect(queue).toMatch(/llm_reasoning: "Filled metadata\."/);
    expect(queue).toMatch(/llm_scored_at:/);
    expect(queue).toMatch(new RegExp(`llm_score_template: ${SCORE_TEMPLATE_VERSION}`));
    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });

  it("rejects symlink discovered files before scoring", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-discovered-symlink-"));
    roots.push(root);
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "---\nurl: https://example.invalid/1\n---\n");
    const file = path.join(root, "jobs", "discovered", "evil.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.symlink(outside, file);
    await expect(writeScoreToFrontmatter(file, { score: 1, reasoning: "nope" })).rejects.toThrow(/regular file|not found/);
  });
});
