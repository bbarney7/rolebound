import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { RunManager } from "../runs/runManager";
import { makeFixtureWorkspace, rmFixtureWorkspace, seedRunsApplyReady } from "./helpers";

const FAKE_PI = fileURLToPath(new URL("./fakePi.mjs", import.meta.url));
const fixtures: string[] = [];
const managers: RunManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of fixtures.splice(0)) await rmFixtureWorkspace(root);
});

async function waitFor(check: () => boolean, label = "condition") {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chat apply handoff", () => {
  it("finishes chat and starts apply-next after start_application handoff", async () => {
    const root = await makeFixtureWorkspace();
    fixtures.push(root);
    await seedRunsApplyReady(root);
    await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
    await fs.writeFile(
      path.join(root, "jobs", "queue", "acme-engineer.md"),
      "url: https://example.com/jobs/1\ncompany: Acme\ntitle: Engineer\nlocation: Remote\n",
    );
    const manager = new RunManager({
      root,
      command: process.execPath,
      args: () => [FAKE_PI],
      model: "fake/model",
      secrets: () => [],
      env: { ...process.env },
      idleGraceMs: 50,
      killGraceMs: 50,
      prepare: async () => ({
        command: process.execPath,
        args: [FAKE_PI],
        model: "fake/model",
        snapshot: {
          connectionId: "123e4567-e89b-12d3-a456-426614174000",
          provider: "openai-compatible",
          modelId: "agent-model",
          credentialSource: "app-store",
          capturedAt: new Date().toISOString(),
          settingsRevision: "x",
        },
        cleanup: async () => {},
      }),
    });
    managers.push(manager);
    const allEvents: import("../../shared/types").RunLogEntry[] = [];
    manager.subscribe(0, (entry) => allEvents.push(entry));
    const started = await manager.start({ kind: "chat", message: "handoff-apply" });
    expect(started.ok).toBe(true);
    await waitFor(() => manager.current()?.kind === "apply-next", "apply-next run");
    await waitFor(
      () => allEvents.some((e) => e.type === "tool_end" && e.handoff?.kind === "apply-next"),
      "handoff tool_end",
    );
    expect(allEvents.some((e) => e.type === "status" && e.run.kind === "chat" && e.status === "done")).toBe(true);
  });
});
