import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FILES,
  workspaceFileLockSpec,
  workspaceFileLockTarget,
  workspaceFilePath,
} from "../../../.pi/extensions/lib/workspace-files";
import { withFileLock } from "../../../.pi/extensions/lib/durable-store";
import { withTargetsLock } from "../../../.pi/extensions/lib/targets";
import { paths } from "../workspace";
import { defaultWorkspaceRoot } from "../workspace";
import { prepareAgentRun } from "../runConfig";
import { runStopMarkerPath } from "../../../.pi/extensions/lib/submission-policy";
import { resolveWorkspaceRoot } from "../../../scripts/workspace.mjs";
import { matchesAny } from "../../../scripts/release-tools.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("workspace contract", () => {
  const envRestore: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(envRestore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.keys(envRestore).forEach((k) => delete envRestore[k]);
  });

  function saveEnv(key: string) {
    envRestore[key] = process.env[key];
  }

  it("(a) server paths match WORKSPACE_FILES resolved against root", () => {
    const root = "/tmp/workspace";
    expect(paths.credentials(root)).toBe(workspaceFilePath(root, "credentials"));
    expect(paths.stateJson(root)).toBe(workspaceFilePath(root, "state"));
    expect(paths.gatherState(root)).toBe(workspaceFilePath(root, "gatherState"));
    expect(paths.settings(root)).toBe(workspaceFilePath(root, "settings"));
    expect(paths.profile(root)).toBe(workspaceFilePath(root, "profile"));
    expect(paths.instructions(root)).toBe(workspaceFilePath(root, "instructions"));
    expect(paths.targets(root)).toBe(workspaceFilePath(root, "targets"));
  });

  it("(b) agent-shared WORKSPACE_FILES map to exported D4 lock helpers", () => {
    const root = path.join(REPO, "fixture-root");
    const helpers = { withFileLock, withTargetsLock };
    for (const key of Object.keys(WORKSPACE_FILES) as (keyof typeof WORKSPACE_FILES)[]) {
      const spec = workspaceFileLockSpec(key);
      if (spec.helper === "none") {
        expect(workspaceFileLockTarget(root, key)).toBeNull();
        continue;
      }
      expect(spec.helper in helpers).toBe(true);
      const target = workspaceFileLockTarget(root, key);
      expect(target).toBe(path.join(root, spec.lockRelativePath));
      if (spec.helper === "withFileLock") expect(spec.kind).toBe("file");
      if (spec.helper === "withTargetsLock") expect(spec.kind).toBe("sidecar");
    }
  });

  it("(c) resolveWorkspaceRoot matches defaultWorkspaceRoot when PI_JOBS_ROOT is set like start", () => {
    saveEnv("PI_JOBS_ROOT");
    const resolved = resolveWorkspaceRoot([]);
    process.env.PI_JOBS_ROOT = resolved;
    expect(defaultWorkspaceRoot()).toBe(resolved);
  });

  it("(d) browser profile user-data-dir is ./.browser-data and agent spawn cwd is workspace root", async () => {
    const mcp = JSON.parse(await fs.readFile(path.join(REPO, ".mcp.json"), "utf8"));
    const args = mcp.mcpServers["job-playwright"].args as string[];
    expect(args.some((a) => a === "--user-data-dir")).toBe(true);
    const idx = args.indexOf("--user-data-dir");
    expect(args[idx + 1]).toBe("./.browser-data");

    const runManagerSrc = await fs.readFile(path.join(REPO, "ui/server/runs/runManager.ts"), "utf8");
    expect(runManagerSrc).toMatch(/cwd:\s*this\.options\.root/);
  });

  it("(e) prepareAgentRun sets PI_CODING_AGENT_DIR under .pi-jobs/runs/<id>/pi-agent", async () => {
    const workspace = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "pi-contract-"));
    try {
      const runId = "123e4567-e89b-12d3-a456-426614174099";
      const conn = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        label: "Agent",
        provider: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:9001/v1",
      };
      await fs.writeFile(
        path.join(workspace, "settings.json"),
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
        "utf8",
      );
      await fs.mkdir(path.join(workspace, ".pi"), { recursive: true });
      await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(workspace, ".pi", "mcp.json"));
      await fs.mkdir(path.join(workspace, ".pi-jobs", "runs"), { recursive: true, mode: 0o700 });
      const prepared = await prepareAgentRun(workspace, runId, "ui:gather", {}, "gather");
      expect(prepared.env?.PI_CODING_AGENT_DIR).toBe(
        path.join(workspace, ".pi-jobs", "runs", runId, "pi-agent"),
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("(f) release manifest excludes secrets, workspace state, and personal job data", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(REPO, "scripts/release-manifest.json"), "utf8"));
    const exclude = manifest.exclude as string[];
    for (const sample of [
      "credentials.json",
      "settings.json",
      "state.json",
      "gather_state.json",
      "APPLIED.md",
      ".pi-jobs/backups/x/manifest.json",
      ".browser-data/Default/Cookies",
      "jobs/queue/foo.md",
      "default.pdf",
    ]) {
      expect(matchesAny(sample, exclude)).toBe(true);
    }
    const sensitive = manifest.sensitivePathPatterns as string[];
    expect(matchesAny("APPLIED.md", sensitive)).toBe(true);
    expect(matchesAny(".pi-jobs/runs/x/pi-agent/auth.json", sensitive)).toBe(true);
    expect(matchesAny("resumes/default.pdf", sensitive)).toBe(true);
  });

  it("(h) run stop marker lives at .pi-jobs/runs/<runId>/stop.json", () => {
    const root = "/tmp/workspace";
    const runId = "123e4567-e89b-12d3-a456-426614174099";
    expect(runStopMarkerPath(root, runId)).toBe(
      path.join(root, ".pi-jobs", "runs", runId, "stop.json"),
    );
  });

  it("(g) .gitignore covers APPLIED.md and .* .tmp crash files", async () => {
    const gitignore = await fs.readFile(path.join(REPO, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\/?APPLIED\.md/m);
    expect(gitignore).toMatch(/\.\*\.tmp/);
  });
});
