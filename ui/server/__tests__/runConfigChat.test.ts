import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentRun } from "../runConfig";
import { setConnectionCredential } from "../providers/providerService";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const agentConn = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  label: "Agent",
  provider: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9001/v1",
};
const chatConn = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  label: "Chat",
  provider: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9002/v1",
};

async function workspace(settings: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-chat-config-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(root, ".pi", "mcp.json"));
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings));
  const connections = settings.connections as Array<{ id: string }>;
  for (const connection of connections) {
    await setConnectionCredential(root, connection.id, `${connection.id}-key`);
  }
  return root;
}

describe("prepareAgentRun chat model", () => {
  it("uses chat selection for chat runs and agent for apply", async () => {
    const root = await workspace({
      schemaVersion: 2,
      connections: [agentConn, chatConn],
      agent: { connectionId: agentConn.id, modelId: "agent-model" },
      chat: { connectionId: chatConn.id, modelId: "chat-model" },
      scoring: { connectionId: agentConn.id, modelId: "agent-model" },
      captcha: {},
    });
    const chatRun = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174099", "ui:chat", {}, "chat");
    expect(chatRun.model).toContain("chat-model");
    expect(chatRun.env?.PI_JOBS_AGENT_MODEL).toContain("chat-model");
    const applyRun = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174098", "ui:acme", {}, "apply");
    expect(applyRun.model).toContain("agent-model");
    await chatRun.cleanup();
    await applyRun.cleanup();
  });

  it("falls back to agent when chat is null", async () => {
    const root = await workspace({
      schemaVersion: 2,
      connections: [agentConn],
      agent: { connectionId: agentConn.id, modelId: "agent-model" },
      chat: null,
      scoring: { connectionId: agentConn.id, modelId: "agent-model" },
      captcha: {},
    });
    const prepared = await prepareAgentRun(root, "123e4567-e89b-12d3-a456-426614174097", "ui:chat", {}, "chat");
    expect(prepared.model).toContain("agent-model");
    await prepared.cleanup();
  });
});
