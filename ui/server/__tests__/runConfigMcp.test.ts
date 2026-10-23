import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { piArgs, prepareAgentRun, readRunConfig } from "../runConfig";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function workspaceWithMcp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-mcp-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(root, ".pi", "mcp.json"));
  const conn = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    label: "Agent",
    provider: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:9001/v1",
  };
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "agent-model" },
        captcha: {},
      },
      null,
      2,
    ),
  );
  return root;
}

describe("browser MCP run provisioning", () => {
  it("piArgs includes -a for supervised apply runs", () => {
    const cfg = readRunConfig({});
    const args = piArgs(cfg, "ui:acme-engineer");
    expect(args).toContain("-a");
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
  });

  it("prepareAgentRun copies project .pi/mcp.json into PI_CODING_AGENT_DIR", async () => {
    const workspace = await workspaceWithMcp();
    const runId = "123e4567-e89b-12d3-a456-426614174099";
    const prepared = await prepareAgentRun(workspace, runId, "ui:acme-engineer", {}, "apply");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const projectMcp = await fs.readFile(path.join(workspace, ".pi", "mcp.json"), "utf8");
    const agentMcp = await fs.readFile(path.join(agentDir, "mcp.json"), "utf8");
    expect(agentMcp).toBe(projectMcp);
    expect(prepared.args).toContain("-a");
    await prepared.cleanup();
  });
  it.each(["gather", "score", "status", "apply", "apply-next"] as const)("handles missing MCP config for %s", async (kind) => {
    const workspace = await workspaceWithMcp();
    await fs.unlink(path.join(workspace, ".pi/mcp.json"));
    const pending = prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174099", "ui:acme-engineer", {}, kind);
    if (kind === "apply" || kind === "apply-next") {
      await expect(pending).rejects.toThrow("Browser tools are not configured: .pi/mcp.json is missing");
    } else {
      const prepared = await pending;
      await expect(fs.stat(path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "mcp.json"))).rejects.toThrow();
      await prepared.cleanup();
    }
  });

});
