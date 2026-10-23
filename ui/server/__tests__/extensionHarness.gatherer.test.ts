import http from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseTargetsMarkdown } from "../readers/targets";
import { TargetsRevisionConflictError, writeTargets } from "../targetsWriter";
import { createExtensionHarnessWorkspace, createRecordingExtensionApi } from "./extensionHarness";
import { FIXTURE_LIVE_SHAPED_PROFILE } from "./helpers";
import { prepareAgentRun } from "../runConfig";
import { setConnectionCredential } from "../providers/providerService";

function sseCompletion(content: string) {
  const chunk = JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  const done = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

async function fakeProvider(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
  return new Promise<{ baseUrl: string; getCalls: () => number; close: () => Promise<void> }>((resolve, reject) => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      void handler(req, res);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        getCalls: () => calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("extension harness — job-gatherer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("score_discovered refuses placeholder profile text without a model request", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), (await fs.readFile(path.join(ws.root, "templates", "profile.template.md"), "utf8")));
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, tools } = createRecordingExtensionApi();
    mod.default(pi);
    const score = tools.get("score_discovered");
    expect(score).toBeDefined();
    const out = await score!("t", {});
    expect(out.details?.errors?.[0]?.error).toMatch(/PROFILE_PLACEHOLDERS/);
    expect(String(out.content?.[0]?.text ?? "")).toMatch(/PROFILE_PLACEHOLDERS/);
  });

  it("add_target creates targets.md when missing", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, tools } = createRecordingExtensionApi();
    mod.default(pi);
    const addTarget = tools.get("add_target");
    expect(addTarget).toBeDefined();
    const out = await addTarget!("t", { company: "acme-co", source: "greenhouse" });
    expect(out.isError).not.toBe(true);
    const md = await fs.readFile(path.join(ws.root, "targets.md"), "utf8");
    expect(md).toContain("acme-co");
  });

  it("add_target racing writeTargets keeps both edits", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(
      path.join(ws.root, "targets.md"),
      "# Gather targets\n\n## Greenhouse\n\n- seed-co\n",
      "utf8",
    );
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, tools } = createRecordingExtensionApi();
    mod.default(pi);
    const addTarget = tools.get("add_target");
    expect(addTarget).toBeDefined();

    const targetsPath = path.join(ws.root, "targets.md");
    const race = Promise.all([
      addTarget!("t", { company: "from-agent", source: "greenhouse" }),
      (async () => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const md = await fs.readFile(targetsPath, "utf8");
          const revision = createHash("sha256").update(md).digest("hex");
          const entries = parseTargetsMarkdown(md);
          try {
            await writeTargets(
              ws.root,
              [...entries, { source: "ashby", slug: "from-dashboard" }],
              revision,
            );
            return;
          } catch (err) {
            if (!(err instanceof TargetsRevisionConflictError)) throw err;
            await new Promise((r) => setTimeout(r, 5));
          }
        }
        throw new Error("writeTargets did not succeed after retries");
      })(),
    ]);
    await race;
    const md = await fs.readFile(path.join(ws.root, "targets.md"), "utf8");
    expect(md).toMatch(/from-agent/);
    expect(md).toMatch(/from-dashboard/);
  });

  it("score-discovered scores directly when PI_JOBS_RUN_ID is set", async () => {
    let received = false;
    const provider = await fakeProvider(async (_req, res) => {
      received = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sseCompletion(JSON.stringify({ score: 4, reason: "strong platform fit" })),
      );
    });
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const agent = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      label: "Agent",
      provider: "openai-compatible" as const,
      baseUrl: provider.baseUrl,
    };
    await fs.writeFile(path.join(ws.root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
    await fs.writeFile(
      path.join(ws.root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent],
        agent: { connectionId: agent.id, modelId: "agent-model" },
        scoring: { connectionId: agent.id, modelId: "score-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(ws.root, agent.id, "score-fixture-key");
    const repoPiMcp = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".pi", "mcp.json");
    await fs.mkdir(path.join(ws.root, ".pi"), { recursive: true });
    await fs.copyFile(repoPiMcp, path.join(ws.root, ".pi", "mcp.json"));
    const prepared = await prepareAgentRun(
      ws.root,
      "123e4567-e89b-12d3-a456-426614174099",
      "dashboard:score",
      {},
      "score",
    );
    const priorEnv = { ...process.env };
    Object.assign(process.env, prepared.env);
    await fs.writeFile(
      path.join(ws.root, "jobs", "discovered", "acme-staff-engineer.md"),
      `---
url: https://example.invalid/jobs/1
company: Acme
title: Staff Engineer
location: Remote
---
Description body.
`,
    );
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, commands, sentMessages } = createRecordingExtensionApi();
    mod.default(pi);
    const scoreDiscovered = commands.get("score-discovered");
    expect(scoreDiscovered).toBeDefined();
    const notifications: string[] = [];
    const ctx = {
      cwd: ws.root,
      signal: undefined,
      abort: () => {},
      ui: { notify: (message: string) => notifications.push(message) },
    };
    await scoreDiscovered!("", ctx);
    expect(received).toBe(true);
    expect(sentMessages).toHaveLength(0);
    const jobPath = path.join(ws.root, "jobs", "discovered", "acme-staff-engineer.md");
    const scored = await fs.readFile(jobPath, "utf8");
    expect(scored).toMatch(/llm_score:\s*4/);
    expect(scored).toMatch(/llm_reasoning:\s*"strong platform fit"/);
    expect(notifications.join("\n")).toMatch(/Errors: 0/);
    Object.assign(process.env, priorEnv);
    await prepared.cleanup();
    await provider.close();
  });

  it("score-discovered sends a follow-up message in terminal sessions without scoring directly", async () => {
    let received = false;
    const provider = await fakeProvider(() => {
      received = true;
    });
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const priorRunId = process.env.PI_JOBS_RUN_ID;
    delete process.env.PI_JOBS_RUN_ID;
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, commands, sentMessages } = createRecordingExtensionApi();
    mod.default(pi);
    const scoreDiscovered = commands.get("score-discovered");
    expect(scoreDiscovered).toBeDefined();
    const ctx = { cwd: ws.root, signal: undefined, abort: () => {}, ui: { notify: () => {} } };
    await scoreDiscovered!("", ctx);
    expect(received).toBe(false);
    expect(sentMessages.join("\n")).toMatch(/score_discovered/i);
    if (priorRunId) process.env.PI_JOBS_RUN_ID = priorRunId;
    await provider.close();
  });

  it("score_discovered aborts a held scoring request without writing the job", { timeout: 20_000 }, async () => {
    let release!: () => void;
    let received = false;
    const provider = await fakeProvider(
      () =>
        new Promise<void>((resolve) => {
          received = true;
          release = () => {
            resolve();
          };
        }),
    );
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const agent = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      label: "Agent",
      provider: "openai-compatible" as const,
      baseUrl: provider.baseUrl,
    };
    await fs.writeFile(path.join(ws.root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
    await fs.writeFile(path.join(ws.root, "targets.md"), "# greenhouse\n- acme\n");
    await fs.writeFile(
      path.join(ws.root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent],
        agent: { connectionId: agent.id, modelId: "agent-model" },
        scoring: { connectionId: agent.id, modelId: "score-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(ws.root, agent.id, "score-fixture-key");
    const repoPiMcp = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".pi", "mcp.json");
    await fs.mkdir(path.join(ws.root, ".pi"), { recursive: true });
    await fs.copyFile(repoPiMcp, path.join(ws.root, ".pi", "mcp.json"));
    const prepared = await prepareAgentRun(
      ws.root,
      "123e4567-e89b-12d3-a456-426614174099",
      "terminal:score",
      {},
      "score",
    );
    const priorEnv = { ...process.env };
    Object.assign(process.env, prepared.env);
    const jobPath = path.join(ws.root, "jobs", "discovered", "acme-staff-engineer.md");
    const raw = `---
url: https://example.invalid/jobs/1
company: Acme
title: Staff Engineer
location: Remote
---
Description body.
`;
    await fs.writeFile(jobPath, raw);
    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-gatherer.ts"));
    const { pi, tools } = createRecordingExtensionApi();
    mod.default(pi);
    const scoreDiscovered = tools.get("score_discovered");
    expect(scoreDiscovered).toBeDefined();
    const controller = new AbortController();
    const pending = scoreDiscovered!("t", {}, controller.signal);
    const deadline = Date.now() + 15_000;
    while (!received && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(received).toBe(true);
    controller.abort();
    await pending;
    expect(provider.getCalls()).toBe(1);
    expect(await fs.readFile(jobPath, "utf8")).toBe(raw);
    Object.assign(process.env, priorEnv);
    await prepared.cleanup();
    await provider.close();
  });

});
