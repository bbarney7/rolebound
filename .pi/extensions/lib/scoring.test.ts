import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildScoringPrompt, parseScoringJson, resolveScoringModel, writeScoreToFrontmatter } from "./scoring";

const files: string[] = [];
afterEach(async () => Promise.all(files.splice(0).map((file) => fs.rm(file, { force: true }))));

describe("scoring helpers", () => {
  it("includes scoring instructions only when provided", () => {
    const job = {
      title: "Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build things",
      url: "https://example.invalid/jobs/1",
    };
    const without = buildScoringPrompt("summary", job);
    expect(without).not.toContain("Scoring instructions from the candidate");
    const withRules = buildScoringPrompt("summary", job, "Score under 200k as 1");
    expect(withRules).toContain("Scoring instructions from the candidate (follow these):");
    expect(withRules).toContain("Score under 200k as 1");
  });

  it("requires configured scorer readiness and never falls back to agent model env", () => {
    expect(resolveScoringModel({ PI_JOBS_SCORING_MODEL: "alias/model", PI_JOBS_AGENT_MODEL: "agent/fallback" })).toEqual({
      ok: false,
      error: "Scoring connection credential is not configured",
    });
    expect(resolveScoringModel({ PI_JOBS_SCORING_MODEL: "alias/model", PI_JOBS_SCORING_READY: "1" })).toEqual({
      ok: true,
      modelName: "alias/model",
    });
  });

  it("parses valid scoring JSON and rejects malformed payloads", () => {
    expect(parseScoringJson('{"score":4,"reason":"Strong fit."}').ok).toBe(true);
    expect(parseScoringJson('{"score":6,"reason":"nope"}').ok).toBe(false);
    expect(parseScoringJson("not json").ok).toBe(false);
  });

  it("inserts score fields before the closing frontmatter delimiter", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "score-write-")), "job.md");
    files.push(file);
    const raw = `---
url: https://example.invalid/jobs/1
company: Example
title: Staff Engineer
location: Remote
---
Body after frontmatter.
`;
    await fs.writeFile(file, raw);
    await writeScoreToFrontmatter(file, { score: 3, reasoning: "Decent fit." }, raw);
    const updated = await fs.readFile(file, "utf8");
    expect(updated).toMatch(/^llm_score: 3\n/m);
    expect(updated).toMatch(/^llm_reasoning: "Decent fit\."\n/m);
    expect(updated).toMatch(/^llm_scored_at: /m);
    expect(updated.indexOf("llm_score: 3")).toBeLessThan(updated.lastIndexOf("---"));
    expect(updated).toContain("Body after frontmatter.");
  });

  it("upserts missing score metadata when llm_score already exists", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "score-upsert-")), "job.md");
    files.push(file);
    const raw = `---
url: https://example.invalid/jobs/1
llm_score: 2
---
Body
`;
    await fs.writeFile(file, raw);
    await writeScoreToFrontmatter(file, { score: 5, reasoning: "Updated." }, raw);
    const updated = await fs.readFile(file, "utf8");
    expect(updated).toMatch(/llm_score: 5/);
    expect(updated).toMatch(/llm_reasoning: "Updated\."/);
    expect(updated).toMatch(/llm_scored_at:/);
    expect(updated).toMatch(/llm_score_template: job-fit-v1/);
  });
});
