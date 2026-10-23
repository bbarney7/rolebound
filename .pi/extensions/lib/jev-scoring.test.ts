import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildJevQuestions,
  buildJevState,
  formatJevReasoning,
  JEV_FIT_CRITERIA,
  jevScoreFromFitIndex,
  parseJevDecisionsResponse,
} from "./jev-scoring";
import { completeJevScoringRequest, scoreDiscoveredJobFile } from "./scoring";
import { prepareAgentRun } from "../../../ui/server/runConfig";
import { setConnectionCredential } from "../../../ui/server/providers/providerService";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const roots: string[] = [];
const servers: Array<{ server: http.Server; close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((entry) => entry.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function jevAnswers(fitIndex: number) {
  const probabilities = [0.05, 0.05, 0.05, 0.05, 0.05];
  probabilities[fitIndex] = 0.71;
  return {
    // Real jev-1.13 shape: probabilities keyed by index, score is the expected index.
    fit: { score: Math.max(0, fitIndex - 0.01), probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])) },
    level: 0.82,
    skills: 0.77,
    location: 0.31,
  };
}

async function startDecisionsServer(
  pathSuffix: string,
  steps: Array<Record<string, unknown>>,
) {
  const mod = await import(path.join(REPO, "scripts/fixtures/fake-decisions-server.mjs")) as {
    createFakeDecisionsServer: (opts: { decisionsPath: string; steps: unknown[] }) => http.Server & { releaseHold?: () => void };
    listen: (server: http.Server) => Promise<http.Server>;
    close: (server: http.Server) => Promise<void>;
  };
  const server = mod.createFakeDecisionsServer({ decisionsPath: pathSuffix, steps });
  await mod.listen(server);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}${pathSuffix}`;
  servers.push({ server, close: () => mod.close(server) });
  return {
    baseUrl,
    releaseHold: () => server.releaseHold?.(),
    whenHoldBegins: () =>
      (server as http.Server & { whenHoldBegins: () => Promise<void> }).whenHoldBegins(),
    getRequests: async () => {
      const res = await fetch(`http://127.0.0.1:${port}/__test__/requests`);
      return (await res.json()) as Array<{ path: string; headers: Record<string, string>; body: string }>;
    },
  };
}

async function workspaceWithJevScorer(opts: {
  provider: "openrouter" | "typesafe";
  modelId: string;
  decisionsBaseUrl: string;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-score-"));
  roots.push(root);
  const agent = { id: "123e4567-e89b-12d3-a456-426614174000", label: "Agent", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9001/v1" };
  const scorer = { id: "123e4567-e89b-12d3-a456-426614174001", label: "Jev", provider: opts.provider };
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    connections: [agent, scorer],
    agent: { connectionId: agent.id, modelId: "agent-model" },
    scoring: { connectionId: scorer.id, modelId: opts.modelId },
    captcha: {},
  }));
  await setConnectionCredential(root, agent.id, "agent-key");
  await setConnectionCredential(root, scorer.id, "jev-key");
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(root, ".pi", "mcp.json"));
  const prepared = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174099", "ui:score", {
    PI_JOBS_JEV_DECISIONS_BASE_URL: opts.decisionsBaseUrl,
  }, "score");
  const models = JSON.parse(await fs.readFile(path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "models.json"), "utf8"));
  expect(JSON.stringify(models)).not.toContain(opts.modelId);
  return { root, prepared };
}

describe("Jev decisions scoring", () => {
  it("builds question shape, state, mapping, and reasoning", () => {
    const questions = buildJevQuestions();
    expect(questions.fit.type).toBe("score");
    expect(questions.fit.criteria).toEqual([...JEV_FIT_CRITERIA]);
    expect(questions.level.type).toBe("noul");
    const state = buildJevState("candidate", { title: "T", company: "C", location: "Remote", description: "x".repeat(100_000) });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(60_000);
    for (let i = 0; i < 5; i++) {
      const parsed = parseJevDecisionsResponse(JSON.stringify({ answers: jevAnswers(i) }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(jevScoreFromFitIndex(parsed.answers.fit.score)).toBe(i + 1);
    }
    const parsed = parseJevDecisionsResponse(JSON.stringify({ answers: jevAnswers(3) }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(formatJevReasoning(parsed.answers)).toMatch(/^Jev: good fit/);
      expect(formatJevReasoning(parsed.answers).length).toBeLessThanOrEqual(1000);
    }
  });

  it("posts OpenRouter decisions with auth and records usage cost", async () => {
    const server = await startDecisionsServer("/api/alpha/decisions", [{ answers: jevAnswers(3), usage: { cost: 0.002 } }]);
    const { root, prepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl: server.baseUrl,
    });
    const jobPath = path.join(root, "jobs", "discovered", "job.md");
    await fs.mkdir(path.dirname(jobPath), { recursive: true });
    await fs.writeFile(jobPath, `---\ntitle: Engineer\ncompany: Acme\nlocation: Remote\n---\nBody\n`);
    const result = await scoreDiscoveredJobFile(jobPath, "", {
      env: prepared.env ?? {},
      jev: { summary: "Staff engineer", job: { title: "Engineer", company: "Acme", location: "Remote", description: "Build things" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.score).toBe(4);
      expect(result.result.usageCost).toBe(0.002);
      expect(result.result.templateVersion).toBe("job-fit-jev-v1");
    }
    const saved = await fs.readFile(jobPath, "utf8");
    expect(saved).toMatch(/llm_score_template: job-fit-jev-v1/);
    const requests = await server.getRequests();
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(requests[0].headers.authorization).toBe("Bearer jev-key");
    expect(body.state.candidate).toBe("Staff engineer");
    expect(body.questions.fit.criteria).toEqual([...JEV_FIT_CRITERIA]);
    await prepared.cleanup();
  });

  it("uses the TypeSafe endpoint path", async () => {
    const server = await startDecisionsServer("/v1/systemone", [{ answers: jevAnswers(2) }]);
    const { root, prepared } = await workspaceWithJevScorer({
      provider: "typesafe",
      modelId: "jev-latest",
      decisionsBaseUrl: server.baseUrl,
    });
    const jobPath = path.join(root, "jobs", "discovered", "job.md");
    await fs.mkdir(path.dirname(jobPath), { recursive: true });
    await fs.writeFile(jobPath, `---\ntitle: T\n---\n`);
    const result = await scoreDiscoveredJobFile(jobPath, "", {
      env: prepared.env ?? {},
      jev: { summary: "c", job: { title: "T", company: "C", location: "R", description: "d" } },
    });
    expect(result.ok).toBe(true);
    const requests = await server.getRequests();
    expect(requests[0].path).toBe("/v1/systemone");
    expect(JSON.parse(requests[0].body).model).toBe("jev-latest");
    await prepared.cleanup();
  });

  it("handles 401, 429 retry, malformed response, and abort", async () => {
    const authServer = await startDecisionsServer("/api/alpha/decisions", [{ httpStatus: 401 }]);
    const { prepared: authPrepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl: authServer.baseUrl,
    });
    const auth = await completeJevScoringRequest("c", { title: "T", company: "C", location: "R", description: "d" }, undefined, authPrepared.env ?? {});
    expect(auth.ok).toBe(false);
    expect((await authServer.getRequests()).length).toBe(1);
    await authPrepared.cleanup();

    const retryServer = await startDecisionsServer("/api/alpha/decisions", [
      { httpStatus: 429 },
      { answers: jevAnswers(1) },
    ]);
    const { prepared: retryPrepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl: retryServer.baseUrl,
    });
    const retry = await completeJevScoringRequest("c", { title: "T", company: "C", location: "R", description: "d" }, undefined, retryPrepared.env ?? {});
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.attempts).toBe(2);
    await retryPrepared.cleanup();

    const badServer = await startDecisionsServer("/api/alpha/decisions", [{ rawBody: "not-json" }]);
    const { prepared: badPrepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl: badServer.baseUrl,
    });
    const bad = await completeJevScoringRequest("c", { title: "T", company: "C", location: "R", description: "d" }, undefined, badPrepared.env ?? {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/invalid scoring response/i);
    expect((await badServer.getRequests()).length).toBe(1);
    await badPrepared.cleanup();

    const holdServer = await startDecisionsServer("/api/alpha/decisions", [{ holdUntilReleased: true, answers: jevAnswers(0) }]);
    const { prepared: holdPrepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl: holdServer.baseUrl,
    });
    const controller = new AbortController();
    const pending = completeJevScoringRequest("c", { title: "T", company: "C", location: "R", description: "d" }, controller.signal, holdPrepared.env ?? {});
    await holdServer.whenHoldBegins();
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error).toMatch(/cancel/i);
    if (!cancelled.ok) expect(cancelled.attempts).toBe(1);
    expect((await holdServer.getRequests()).length).toBe(1);
    holdServer.releaseHold();
    await holdPrepared.cleanup();
  });
});

describe("Jev fetch redirect policy", () => {
  it("rejects HTTP redirects without contacting the redirect target", async () => {
    let redirectTargetHits = 0;
    const target = http.createServer((_req, res) => {
      redirectTargetHits += 1;
      res.writeHead(200);
      res.end("nope");
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(0, "127.0.0.1", () => resolve());
    });
    const targetPort = (target.address() as { port: number }).port;

    const redirector = http.createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/stolen` });
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      redirector.once("error", reject);
      redirector.listen(0, "127.0.0.1", () => resolve());
    });
    const originPort = (redirector.address() as { port: number }).port;
    const decisionsBaseUrl = `http://127.0.0.1:${originPort}/decisions`;

    const { prepared } = await workspaceWithJevScorer({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
      decisionsBaseUrl,
    });
    const result = await completeJevScoringRequest(
      "candidate",
      { title: "T", company: "C", location: "Remote", description: "body" },
      undefined,
      prepared.env ?? {},
    );
    expect(result.ok).toBe(false);
    expect(redirectTargetHits).toBe(0);
    await prepared.cleanup();
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }, 15_000);
});

describe("PI_JOBS_JEV_DECISIONS_BASE_URL", () => {
  it("accepts loopback and refuses anything else without falling back", async () => {
    const { jevDecisionsUrl } = await import("./jev-scoring");
    expect(() => jevDecisionsUrl("jev-openrouter", { PI_JOBS_JEV_DECISIONS_BASE_URL: "" })).toThrow(/PI_JOBS_JEV_DECISIONS_BASE_URL/);
    expect(jevDecisionsUrl("jev-openrouter", {})).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(jevDecisionsUrl("jev-openrouter", { PI_JOBS_JEV_DECISIONS_BASE_URL: "http://127.0.0.1:4011/decisions/" })).toBe(
      "http://127.0.0.1:4011/decisions",
    );
    for (const bad of ["", "   "]) {
      expect(() => jevDecisionsUrl("jev-openrouter", { PI_JOBS_JEV_DECISIONS_BASE_URL: bad })).toThrow(/PI_JOBS_JEV_DECISIONS_BASE_URL/);
    }
    for (const bad of [
      "https://evil.example/decisions",
      "http://10.0.0.1:1/x",
      "http://127.0.0.1.evil.com:1/x",
      "http://user@127.0.0.1:1/x",
      "http://127.0.0.1:1/x?q=1",
      "file:///tmp/x",
      "not a url",
    ]) {
      expect(() => jevDecisionsUrl("jev-openrouter", { PI_JOBS_JEV_DECISIONS_BASE_URL: bad })).toThrow(/PI_JOBS_JEV_DECISIONS_BASE_URL/);
    }
  });

  it("does not call production when prepare forwards an empty override", async () => {
    let productionHits = 0;
    const production = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/alpha/decisions")) {
        productionHits += 1;
      }
      res.writeHead(500);
      res.end("should not run");
    });
    await new Promise<void>((resolve, reject) => {
      production.once("error", reject);
      production.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (production.address() as { port: number }).port;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-empty-override-"));
    roots.push(root);
    const agent = { id: "123e4567-e89b-12d3-a456-426614174000", label: "Agent", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9001/v1" };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174001", label: "Jev", provider: "openrouter" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [agent, scorer],
      agent: { connectionId: agent.id, modelId: "agent-model" },
      scoring: { connectionId: scorer.id, modelId: "typesafe/jev-1.13" },
      captcha: {},
    }));
    await setConnectionCredential(root, agent.id, "agent-key");
    await setConnectionCredential(root, scorer.id, "jev-key");
    await fs.mkdir(path.join(root, ".pi"), { recursive: true });
    await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(root, ".pi", "mcp.json"));
    const prepared = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174098", "ui:score", {
      PI_JOBS_JEV_DECISIONS_BASE_URL: "",
      OPENROUTER_BASE_URL: `http://127.0.0.1:${port}`,
    }, "score");
    await expect(completeJevScoringRequest(
      "candidate",
      { title: "T", company: "C", location: "Remote", description: "body" },
      undefined,
      prepared.env ?? {},
    )).rejects.toThrow(/PI_JOBS_JEV_DECISIONS_BASE_URL/);
    expect(productionHits).toBe(0);
    await prepared.cleanup();
    await new Promise<void>((resolve) => production.close(() => resolve()));
  });
});

describe("parseJevDecisionsResponse wire formats", () => {
  it("parses the OpenRouter decisions wire shape", () => {
    const body = JSON.stringify({
      answers: {
        fit: { score: 3.95, confidence: 0.96, probabilities: { "0": 0.01, "1": 0, "2": 0.01, "3": 0.01, "4": 0.97 } },
        level: { probability: 0.8 },
        skills: 0.6,
        location: { probability: 0.2 },
      },
      usage: { cost: 0.00002 },
    });
    const parsed = parseJevDecisionsResponse(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answers.fit.score).toBe(4);
    expect(parsed.usageCost).toBe(0.00002);
  });

  it("parses the TypeSafe System One wire shape", () => {
    const body = JSON.stringify({
      answers: {
        fit: { type: "score", score: 3.2, confidence: 0.91 },
        level: { type: "noul", noul: 0.82, confidence: 0.88 },
        skills: { type: "noul", noul: 0.77, confidence: 0.85 },
        location: { type: "noul", noul: 0.31, confidence: 0.7 },
      },
    });
    const parsed = parseJevDecisionsResponse(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answers.fit.score).toBe(3);
    expect(parsed.answers.level).toBe(0.82);
    expect(parsed.answers.skills).toBe(0.77);
    expect(parsed.answers.location).toBe(0.31);
  });
});

describe("parseJevDecisionsResponse on the real jev-1.13 score shape", () => {
  it("takes the most probable option from index-keyed probabilities, ignoring the continuous score", async () => {
    const { parseJevDecisionsResponse } = await import("./jev-scoring");
    // Shape captured from the owner's jev-bench star round (OpenRouter /api/alpha/decisions).
    const body = JSON.stringify({
      answers: {
        fit: { score: 3.95, confidence: 0.96, probabilities: { "0": 0.01, "1": 0, "2": 0.01, "3": 0.01, "4": 0.97 } },
        level: { probability: 0.8 },
        skills: 0.6,
        location: { probability: 0.2 },
      },
      usage: { cost: 0.00002 },
    });
    const parsed = parseJevDecisionsResponse(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answers.fit.score).toBe(4);
    expect(parsed.usageCost).toBe(0.00002);
    expect(parseJevDecisionsResponse(JSON.stringify({ answers: { fit: { score: 2, probabilities: { "7": 1 } }, level: 1, skills: 1, location: 1 } })).ok).toBe(false);
  });
});
