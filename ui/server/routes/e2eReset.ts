import { Router } from "express";
import fs from "node:fs";
import path from "node:path";

const DISCOVERIES: Array<[string, number | null, string]> = [
  ["e2e-engineer", 5, "Platform Engineer"],
  ["e2e-designer", 3, "Product Designer"],
  ["e2e-analyst", null, "Business Analyst"],
];

const E2E_SLUGS = DISCOVERIES.map(([slug]) => slug);

function writeDiscovery(root: string, slug: string, score: number | null, title: string) {
  const scoreLines = score
    ? `llm_score: ${score}\nllm_reasoning: Strong fictional fit for E2E.\nllm_scored_at: 2026-01-01T00:00:00.000Z\n`
    : "";
  fs.writeFileSync(
    path.join(root, "jobs", "discovered", `${slug}.md`),
    `---\nurl: https://example.invalid/jobs/${slug}\ncompany: E2E Company\ntitle: ${title}\nlocation: Remote\nsource: greenhouse\n${scoreLines}discovered_at: 2026-01-01T00:00:00.000Z\n---\nSynthetic posting for browser tests only.\n`,
  );
}

export function resetE2eDiscoveries(root: string) {
  for (const slug of E2E_SLUGS) {
    const queueFile = path.join(root, "jobs", "queue", `${slug}.md`);
    if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    const appliedFile = path.join(root, "jobs", "applied", `${slug}.md`);
    if (fs.existsSync(appliedFile)) fs.unlinkSync(appliedFile);
    const shot = path.join(root, "screenshots", `demo-synthetic-${slug}-confirmation.svg`);
    if (fs.existsSync(shot)) fs.unlinkSync(shot);
  }
  fs.mkdirSync(path.join(root, "jobs", "discovered"), { recursive: true });
  for (const [slug, score, title] of DISCOVERIES) writeDiscovery(root, slug, score, title);
}

export function clearE2eAcknowledgement(root: string) {
  const statePath = path.join(root, "state.json");
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    acknowledged_at?: string;
    acknowledged_policy?: string;
  };
  delete state.acknowledged_at;
  delete state.acknowledged_policy;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function resetE2eWorkspace(root: string, fixturesDir: string) {
  resetE2eDiscoveries(root);
  const seedPdf = path.join(fixturesDir, "sample.pdf");
  if (fs.existsSync(seedPdf)) {
    fs.mkdirSync(path.join(root, "resumes"), { recursive: true });
    fs.copyFileSync(seedPdf, path.join(root, "resumes", "default.pdf"));
    for (const name of ["sample.pdf", "upload-resume.pdf"]) {
      const file = path.join(root, "resumes", name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  const statePath = path.join(root, "state.json");
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      applications?: Array<{ slug?: string }>;
    };
    if (Array.isArray(state.applications)) {
      state.applications = state.applications.filter((entry) => !E2E_SLUGS.includes(entry.slug ?? ""));
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
  }
}

export function e2eResetRouter(root: string): Router {
  const router = Router();
  const fixturesDir = process.env.PI_JOBS_E2E_FIXTURES ?? path.join(root, "..", "ui", "e2e", "fixtures");

  router.post("/reset-discoveries", (_req, res) => {
    if (process.env.PI_JOBS_DEMO !== "1") {
      res.status(404).json({ error: "not found" });
      return;
    }
    resetE2eDiscoveries(root);
    res.json({ ok: true });
  });

  router.post("/reset-workspace", (_req, res) => {
    if (process.env.PI_JOBS_DEMO !== "1") {
      res.status(404).json({ error: "not found" });
      return;
    }
    resetE2eWorkspace(root, fixturesDir);
    res.json({ ok: true });
  });

  router.post("/clear-acknowledgement", (_req, res) => {
    if (process.env.PI_JOBS_DEMO !== "1") {
      res.status(404).json({ error: "not found" });
      return;
    }
    clearE2eAcknowledgement(root);
    res.json({ ok: true });
  });

  return router;
}
