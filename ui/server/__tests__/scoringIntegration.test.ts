import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
import { completeScoringRequest, scoreDiscoveredJobFile } from "../../../.pi/extensions/lib/scoring";
import { prepareAgentRun } from "../runConfig";
import { setConnectionCredential } from "../providers/providerService";

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sseCompletion(content: string) {
  const chunk = JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  const done = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

async function fakeProvider(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
  return new Promise<{ baseUrl: string; getCalls: () => number }>((resolve, reject) => {
    let calls = 0;
    const server = http.createServer((req, res) => { calls++; void handler(req, res); });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const port = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, getCalls: () => calls });
    });
  });
}

async function workspaceWithScorer(baseUrl: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-score-int-"));
  roots.push(root);
  const connection = { id: "123e4567-e89b-12d3-a456-426614174010", label: "Scorer", provider: "openai-compatible" as const, baseUrl };
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    connections: [connection],
    agent: { connectionId: connection.id, modelId: "score-model" },
    scoring: { connectionId: connection.id, modelId: "score-model" },
    captcha: {},
  }));
  await setConnectionCredential(root, connection.id, "score-fixture-key");
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(root, ".pi", "mcp.json"));
  const prepared = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174099", "ui:score", {}, "score");
  return { root, prepared, connection };
}

describe("configured scoring integration", () => {
  it("persists parsed provider response through scoreDiscoveredJobFile orchestration", async () => {
    const response = { score: 5, reason: "Unique orchestration fit." };
    const provider = await fakeProvider((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseCompletion(JSON.stringify(response)));
    });
    const { root, prepared } = await workspaceWithScorer(provider.baseUrl);
    await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
    const jobPath = path.join(root, "jobs", "discovered", "acme-staff-engineer.md");
    const raw = `---
url: https://example.invalid/jobs/1
company: Acme
title: Staff Engineer
location: Remote
---
Description body.
`;
    await fs.writeFile(jobPath, raw);
    const result = await scoreDiscoveredJobFile(jobPath, "score this job", { env: prepared.env ?? {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ score: 5, reasoning: "Unique orchestration fit.", templateVersion: "job-fit-v1" });
    }
    const saved = await fs.readFile(jobPath, "utf8");
    expect(saved).toMatch(/llm_score: 5/);
    expect(saved).toMatch(/llm_reasoning: "Unique orchestration fit\."/);
    expect(saved).toMatch(/llm_scored_at: \d{4}-\d{2}-\d{2}T/);
    expect(saved).toMatch(/llm_score_template: job-fit-v1/);
    await prepared.cleanup();
  });

  it("retries 429 upstream failures once and rejects 401 without retry", async () => {
    let calls = 0;
    const provider = await fakeProvider((_req, res) => {
      calls++;
      if (calls === 1) { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "rate limit" })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseCompletion('{"score":3,"reason":"Retry succeeded."}'));
    });
    const { prepared } = await workspaceWithScorer(provider.baseUrl);
    const retry = await completeScoringRequest("score", undefined, prepared.env ?? {});
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.attempts).toBe(2);
    expect(provider.getCalls()).toBe(2);
    await prepared.cleanup();

    let authCalls = 0;
    const authProvider = await fakeProvider((_req, res) => { authCalls++; res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); });
    const { prepared: authPrepared } = await workspaceWithScorer(authProvider.baseUrl);
    const auth = await completeScoringRequest("score", undefined, authPrepared.env ?? {});
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.error).toContain("credential");
    expect(authCalls).toBe(1);
    if (!auth.ok) expect(auth.attempts).toBe(1);
    await authPrepared.cleanup();
  });

  it("aborts an in-flight scoring request after the provider receives it", async () => {
    let release!: () => void;
    let received = false;
    const provider = await fakeProvider((_req, res) => new Promise<void>((resolve) => {
      received = true;
      release = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseCompletion('{"score":2,"reason":"late"}'));
        resolve();
      };
    }));
    const { root, prepared } = await workspaceWithScorer(provider.baseUrl);
    await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
    const jobPath = path.join(root, "jobs", "discovered", "acme-staff-engineer.md");
    const raw = `---
url: https://example.invalid/jobs/1
company: Acme
title: Staff Engineer
location: Remote
---
Description body.
`;
    await fs.writeFile(jobPath, raw);
    const controller = new AbortController();
    const pending = completeScoringRequest("score", controller.signal, prepared.env ?? {});
    const deadline = Date.now() + 5_000;
    while (!received && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toBe(true);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error).toMatch(/cancel/i);
    if (!cancelled.ok) expect(cancelled.attempts).toBe(1);
    expect(provider.getCalls()).toBe(1);
    expect(await fs.readFile(jobPath, "utf8")).toBe(raw);
    release();
    await prepared.cleanup();
  });
});
