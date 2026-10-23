import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resolveContinueFromForkSource, saveChatSession } from "../runs/chatSession";
import { makeFixtureWorkspace, rmFixtureWorkspace, seedRunsApplyReady } from "./helpers";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakePi.mjs");
const fixtures: string[] = [];

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rmFixtureWorkspace(root);
});

describe("chat continueFrom", () => {
  it("rejects missing session and passes --fork when continuing", async () => {
    const root = await makeFixtureWorkspace();
    fixtures.push(root);
    await seedRunsApplyReady(root);
    const priorRunId = "123e4567-e89b-12d3-a456-426614174010";
    const priorDir = path.join(root, ".pi-jobs", "runs", priorRunId, "pi-agent", "sessions");
    await fs.mkdir(priorDir, { recursive: true });
    await fs.writeFile(path.join(priorDir, "chat.jsonl"), '{"type":"session"}\n');
    let forkPath: string | undefined;
    const app = createApp(root, {
      security: { enabled: false },
      runs: {
        command: process.execPath,
        args: () => [FAKE_PI],
        model: "fake/model",
        idleGraceMs: 50,
        killGraceMs: 50,
        prepare: async (runId, sessionName, kind, _runtime, continueFrom) => {
          const { prepareAgentRun } = await import("../runConfig");
          const prepared = await prepareAgentRun(root, runId, sessionName, {}, kind, continueFrom);
          const forkIndex = prepared.args.indexOf("--fork");
          if (forkIndex >= 0) forkPath = prepared.args[forkIndex + 1];
          return prepared;
        },
      },
    });
    const server = await new Promise<import("node:http").Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve(s)));
      s.once("error", reject);
    });
    const port = (server.address() as import("node:net").AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const bad = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "chat", message: "hello", continueFrom: "not-a-uuid" }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "continueFrom has no saved chat session" });

      const ok = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "chat", message: "hello", continueFrom: priorRunId }),
      });
      expect(ok.status).toBe(201);
      expect(forkPath).toBeTruthy();
      expect(forkPath).toContain("fork-source.jsonl");
      await app.runs.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps a chat session after its run directory is removed, and forks from it", async () => {
    const root = await makeFixtureWorkspace();
    fixtures.push(root);
    const runId = "123e4567-e89b-12d3-a456-426614174011";
    const runDir = path.join(root, ".pi-jobs", "runs", runId);
    await fs.mkdir(path.join(runDir, "pi-agent", "sessions"), { recursive: true });
    await fs.writeFile(path.join(runDir, "pi-agent", "sessions", "chat.jsonl"), '{"type":"session","id":"kept"}\n');
    await saveChatSession(root, runId, runDir);
    await fs.rm(runDir, { recursive: true, force: true });
    const nextRunDir = path.join(root, ".pi-jobs", "runs", "123e4567-e89b-12d3-a456-426614174012");
    await fs.mkdir(nextRunDir, { recursive: true });
    const fork = await resolveContinueFromForkSource(root, runId, nextRunDir);
    expect(await fs.readFile(fork, "utf8")).toContain('"kept"');
    expect((await fs.stat(path.join(root, ".pi-jobs", "chat-sessions", `${runId}.jsonl`))).mode & 0o777).toBe(0o600);
  });

  it("replaces a planted symlink instead of writing through it", async () => {
    const root = await makeFixtureWorkspace();
    fixtures.push(root);
    const runId = "123e4567-e89b-12d3-a456-426614174013";
    const runDir = path.join(root, ".pi-jobs", "runs", runId);
    await fs.mkdir(path.join(runDir, "pi-agent", "sessions"), { recursive: true });
    await fs.writeFile(path.join(runDir, "pi-agent", "sessions", "chat.jsonl"), "session\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "untouched");
    await fs.mkdir(path.join(root, ".pi-jobs", "chat-sessions"), { recursive: true });
    await fs.symlink(outside, path.join(root, ".pi-jobs", "chat-sessions", `${runId}.jsonl`));
    await saveChatSession(root, runId, runDir);
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
    expect((await fs.lstat(path.join(root, ".pi-jobs", "chat-sessions", `${runId}.jsonl`))).isFile()).toBe(true);
  });
});
