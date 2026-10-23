import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
import { readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import { prepareAgentRun, providerConfig } from "../runConfig";
import {
  persistConnectionHealth,
  providerAlias,
  readAuth,
  setConnectionCredential,
  setModelRuntimeFactoryForTests,
  updateConnection,
} from "../providers/providerService";
import { modifyAuthFile } from "../providers/authStoreFile";
import { ALL_SCRUB_ENV_NAMES } from "../../shared/providerCatalog";
import { completeScoringRequest } from "../../../.pi/extensions/lib/scoring";
import {
  configureLoginSessions,
  drainLoginSessions,
  getLogin,
  resetLoginSessions,
  startLogin,
} from "../providers/loginSessions";
import type { ProviderHostDeps } from "../providers/hostDeps";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setModelRuntimeFactoryForTests(undefined);
  await drainLoginSessions();
  configureLoginSessions(null);
  resetLoginSessions();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "pi-run-config-"));
  roots.push(value);
  await fs.mkdir(path.join(value, ".pi"), { recursive: true });
  await fs.copyFile(path.join(REPO, ".pi", "mcp.json"), path.join(value, ".pi", "mcp.json"));
  return value;
}
const a = { id: "123e4567-e89b-12d3-a456-426614174000", label: "Agent", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9001/v1" };
const b = { id: "123e4567-e89b-12d3-a456-426614174001", label: "Scorer", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9002/v1" };

function providerHost(workspace: string): ProviderHostDeps {
  return {
    home: path.join(workspace, "home"),
    env: {},
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
}

describe("configured run snapshots", () => {
  it("materializes isolated agent/scorer aliases and freezes credentials", async () => {
    const workspace = await root(); await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({ schemaVersion: 2, connections: [a, b], agent: { connectionId: a.id, modelId: "agent-model" }, scoring: { connectionId: b.id, modelId: "score-model" }, captcha: {} }));
    await setConnectionCredential(workspace, a.id, "agent-old"); await setConnectionCredential(workspace, b.id, "score-key");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174099", "ui:score", {}, "score");
    const authFile = path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"), before = await fs.readFile(authFile, "utf8");
    expect(before).toContain("agent-old"); expect(before).toContain("score-key"); expect(prepared.env?.PI_JOBS_SCORING_MODEL).toContain("score-model"); expect(prepared.env?.PI_JOBS_SCORING_READY).toBe("1"); expect(prepared.args).toContain("pi-jobs-123e4567-e89b-12d3-a456-426614174000/agent-model");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent"); const runtime = await ModelRuntime.create({ authPath: authFile, modelsPath: path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "models.json") });
    expect(runtime.getModel(`pi-jobs-${a.id}`, "agent-model")).toBeTruthy(); expect(runtime.getModel(`pi-jobs-${b.id}`, "score-model")).toBeTruthy();
    await setConnectionCredential(workspace, a.id, "agent-new"); expect(await fs.readFile(authFile, "utf8")).toBe(before);
    const next = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174098", "ui:gather", {}, "gather"); expect(await fs.readFile(path.join(String(next.env?.PI_CODING_AGENT_DIR), "auth.json"), "utf8")).toContain("agent-new");
    await prepared.cleanup(); await next.cleanup(); expect(await fs.stat(authFile).catch(() => null)).toBeNull();
  });
  it("blocks missing agent selection without falling back to a global model", async () => {
    const workspace = await root(), current = await readApplicationSettings(workspace); await writeApplicationSettings(workspace, { schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: {} }, current.revision);
    await expect(prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174097", "ui:gather", { PI_JOBS_MODEL: "paid/global" }, "gather")).rejects.toThrow("AGENT_MODEL_MISSING");
  });
  it("scrubs connection environment keys before installing trusted run controls", async () => {
    const workspace = await root();
    const connection = { ...a, envKeyName: "ROLEBOUND_FIXTURE_PROVIDER_KEY" };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [connection],
      agent: { connectionId: connection.id, modelId: "agent-model" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, connection.id, "agent-key");
    const runId = "123e4567-e89b-12d3-a456-426614174094";
    const prepared = await prepareAgentRun(
      workspace,
      runId,
      "ui:gather",
      {
        ROLEBOUND_FIXTURE_PROVIDER_KEY: "parent-secret",
        PI_CODING_AGENT_DIR: "/hostile/global-agent",
        PI_JOBS_RUN_ID: "hostile-run",
      },
      "gather",
    );
    expect(prepared.env?.ROLEBOUND_FIXTURE_PROVIDER_KEY).toBeUndefined();
    expect(prepared.env?.PI_CODING_AGENT_DIR).toMatch(new RegExp(`/runs/${runId}/pi-agent$`));
    expect(prepared.env?.PI_JOBS_RUN_ID).toBe(runId);
    await prepared.cleanup();
  });
  it("pins scorer identity but blocks scoring when scorer B is missing", async () => {
    const workspace = await root(), remoteScorer = { ...b, baseUrl: "https://scorer.invalid/v1" };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({ schemaVersion: 2, connections: [a, remoteScorer], agent: { connectionId: a.id, modelId: "agent" }, scoring: { connectionId: b.id, modelId: "score" }, captcha: {} }));
    await setConnectionCredential(workspace, a.id, "agent-key");
    const gather = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174096", "ui:gather", { PI_JOBS_SCORING_MODEL: "stale/alias", PI_JOBS_AGENT_MODEL: "stale/agent" }, "gather");
    expect(gather.env?.PI_JOBS_SCORING_MODEL).toBe(`pi-jobs-${b.id}/score`);
    expect(gather.env?.PI_JOBS_SCORING_READY).toBeUndefined();
    expect(gather.env?.PI_JOBS_AGENT_MODEL).toContain("agent");
    const blocked = await completeScoringRequest("score this", undefined, gather.env ?? {});
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("credential");
    await gather.cleanup();
    await expect(prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174095", "ui:score", {}, "score")).rejects.toThrow("credential");
  });
  it("preserves native provider api/baseUrl metadata and rejects unsupported reasoning", async () => {
    const openai = await providerConfig({ id: "x", label: "x", provider: "openai" }, { connectionId: "x", modelId: "gpt-4o-mini" }, false);
    const model = openai.models[0] as { api?: string; baseUrl?: string };
    expect(openai.api).toBe("openai-responses");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    const anthropic = await providerConfig({ id: "y", label: "y", provider: "anthropic" }, { connectionId: "y", modelId: "claude-haiku-4-5" }, false);
    expect(anthropic.api).toBe("anthropic-messages");
    await expect(providerConfig({ id: "z", label: "z", provider: "openai-compatible", baseUrl: "http://127.0.0.1:9003/v1", api: "openai-completions" }, { connectionId: "z", modelId: "manual-model", thinking: "high" }, false)).rejects.toThrow("manual models require capability validation");
  });

  it("ignores hostile global pi auth and models during metadata lookup", async () => {
    const hostileRoot = await root();
    const hostileAgent = path.join(hostileRoot, "hostile-agent");
    await fs.mkdir(hostileAgent, { recursive: true });
    await fs.writeFile(path.join(hostileAgent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "HOSTILE-GLOBAL-KEY" } }), { mode: 0o600 });
    await fs.writeFile(path.join(hostileAgent, "models.json"), JSON.stringify({
      providers: {
        openai: {
          baseUrl: "https://evil.invalid/v1",
          api: "openai-completions",
          models: [{ id: "gpt-4o-mini", name: "Hostile", api: "openai-completions", baseUrl: "https://evil.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }],
        },
      },
    }));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = hostileAgent;
    try {
      const config = await providerConfig({ id: "x", label: "x", provider: "openai" }, { connectionId: "x", modelId: "gpt-4o-mini" }, false);
      const model = config.models[0] as { api?: string; baseUrl?: string };
      expect(model.baseUrl).toBe("https://api.openai.com/v1");
      expect(model.api).toBe("openai-responses");
      expect(JSON.stringify(config)).not.toContain("evil.invalid");
      expect(JSON.stringify(config)).not.toContain("HOSTILE-GLOBAL-KEY");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("materializes native openrouter auth and model args when unambiguous", async () => {
    const workspace = await root();
    const openrouter = {
      id: "123e4567-e89b-12d3-a456-426614174077",
      label: "OpenRouter",
      provider: "openrouter" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [openrouter],
      agent: { connectionId: openrouter.id, modelId: "anthropic/claude-fable-5" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, openrouter.id, "or-key");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174076", "ui:gather", {}, "gather");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(auth.openrouter.key).toBe("or-key");
    expect(models.providers.openrouter).toBeUndefined();
    expect(prepared.model).toBe("openrouter/anthropic/claude-fable-5");
    expect(prepared.args).toContain("openrouter/anthropic/claude-fable-5");
    await prepared.cleanup();
  });

  it("materializes native opencode-go auth without alias providers", async () => {
    const workspace = await root();
    const opencode = {
      id: "123e4567-e89b-12d3-a456-426614174062",
      label: "OpenCode Go",
      provider: "opencode-go" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [opencode],
      agent: { connectionId: opencode.id, modelId: "kimi-k3" },
      scoring: { connectionId: opencode.id, modelId: "kimi-k3" },
      captcha: {},
    }));
    await setConnectionCredential(workspace, opencode.id, "FIXTURE-SECRET-do-not-leak");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174061", "ui:score", {}, "score");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(auth["opencode-go"].key).toBe("FIXTURE-SECRET-do-not-leak");
    expect(models.providers[`pi-jobs-${opencode.id}`]).toBeUndefined();
    expect(models.providers["opencode-go"]).toBeUndefined();
    expect(prepared.model).toBe("opencode-go/kimi-k3");
    expect(prepared.env?.PI_JOBS_SCORING_MODEL).toBe("opencode-go/kimi-k3");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    const model = runtime.getModel("opencode-go", "kimi-k3");
    expect(model?.provider).toBe("opencode-go");
    expect(model?.api).toBe("openai-completions");
    expect(auth["opencode-go"].key).toBe("FIXTURE-SECRET-do-not-leak");
    await prepared.cleanup();
  });

  it("materializes native openai auth and model refs when unambiguous", async () => {
    const workspace = await root();
    const openai = {
      id: "123e4567-e89b-12d3-a456-426614174060",
      label: "OpenAI",
      provider: "openai" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [openai],
      agent: { connectionId: openai.id, modelId: "gpt-4o-mini" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, openai.id, "FIXTURE-SECRET-do-not-leak");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174059", "ui:gather", {}, "gather");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(auth.openai.key).toBe("FIXTURE-SECRET-do-not-leak");
    expect(models.providers.openai).toBeUndefined();
    expect(prepared.model).toBe("openai/gpt-4o-mini");
    await prepared.cleanup();
  });

  it("aliases two connections of the same native provider in one run", async () => {
    const workspace = await root();
    const first = {
      id: "123e4567-e89b-12d3-a456-426614174058",
      label: "OpenAI agent",
      provider: "openai" as const,
    };
    const second = {
      id: "123e4567-e89b-12d3-a456-426614174057",
      label: "OpenAI scorer",
      provider: "openai" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [first, second],
      agent: { connectionId: first.id, modelId: "gpt-4o-mini" },
      scoring: { connectionId: second.id, modelId: "gpt-4o" },
      captcha: {},
    }));
    await setConnectionCredential(workspace, first.id, "agent-openai-key");
    await setConnectionCredential(workspace, second.id, "scorer-openai-key");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174056", "ui:score", {}, "score");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(auth.openai.key).toBe("agent-openai-key");
    expect(auth[`pi-jobs-${second.id}`].key).toBe("scorer-openai-key");
    expect(auth[`pi-jobs-${first.id}`]).toBeUndefined();
    expect(models.providers.openai).toBeUndefined();
    expect(models.providers[`pi-jobs-${first.id}`]).toBeUndefined();
    expect(models.providers[`pi-jobs-${second.id}`]).toBeTruthy();
    expect(prepared.model).toBe("openai/gpt-4o-mini");
    expect(prepared.env?.PI_JOBS_SCORING_MODEL).toBe(`pi-jobs-${second.id}/gpt-4o`);
    await prepared.cleanup();
  });

  it("keeps the agent on native opencode-go and aliases only a separate scorer connection", async () => {
    const workspace = await root();
    const agentConn = {
      id: "123e4567-e89b-12d3-a456-426614174051",
      label: "OpenCode agent",
      provider: "opencode-go" as const,
    };
    const scorerConn = {
      id: "123e4567-e89b-12d3-a456-426614174052",
      label: "OpenCode scorer",
      provider: "opencode-go" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [agentConn, scorerConn],
      agent: { connectionId: agentConn.id, modelId: "kimi-k3" },
      scoring: { connectionId: scorerConn.id, modelId: "kimi-k3" },
      captcha: {},
    }));
    await setConnectionCredential(workspace, agentConn.id, "FIXTURE-SECRET-do-not-leak-agent");
    await setConnectionCredential(workspace, scorerConn.id, "FIXTURE-SECRET-do-not-leak-scorer");
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174050", "ui:score", {}, "score");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(auth["opencode-go"].key).toBe("FIXTURE-SECRET-do-not-leak-agent");
    expect(auth[`pi-jobs-${scorerConn.id}`].key).toBe("FIXTURE-SECRET-do-not-leak-scorer");
    expect(auth[`pi-jobs-${agentConn.id}`]).toBeUndefined();
    expect(models.providers["opencode-go"]).toBeUndefined();
    expect(models.providers[`pi-jobs-${agentConn.id}`]).toBeUndefined();
    expect(models.providers[`pi-jobs-${scorerConn.id}`]).toBeTruthy();
    expect(prepared.model).toBe("opencode-go/kimi-k3");
    expect(prepared.env?.PI_JOBS_SCORING_MODEL).toBe(`pi-jobs-${scorerConn.id}/kimi-k3`);
    await prepared.cleanup();
  });

  it("rejects an unknown native agent model before writing run files", async () => {
    const workspace = await root();
    const openai = {
      id: "123e4567-e89b-12d3-a456-426614174049",
      label: "OpenAI",
      provider: "openai" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [openai],
      agent: { connectionId: openai.id, modelId: "does-not-exist-pjr23" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, openai.id, "FIXTURE-SECRET-do-not-leak");
    await expect(
      prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174048", "ui:gather", {}, "gather"),
    ).rejects.toThrow("MODEL_UNAVAILABLE");
    await expect(fs.stat(path.join(workspace, ".pi-jobs", "runs", "123e4567-e89b-12d3-a456-426614174048"))).rejects.toThrow();
  });

  it("loads pi-cursor-sdk, cursor auth, isolation env, and scrubs provider secrets", async () => {
    const workspace = await root();
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174066",
      label: "Cursor",
      provider: "cursor" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [cursor],
      agent: { connectionId: cursor.id, modelId: "composer-2.5" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, cursor.id, "cursor-fixture-key");
    const parentEnv: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "parent-openai",
      GROQ_API_KEY: "parent-groq",
      ANTHROPIC_API_KEY: "parent-anthropic",
      ANTHROPIC_AUTH_TOKEN: "parent-auth-token",
      ANTHROPIC_OAUTH_TOKEN: "parent-oauth",
      ANTHROPIC_FEDERATION_RULE_ID: "parent-fed",
      TYPESAFE_API_KEY: "parent-typesafe",
      CURSOR_BACKEND_URL: "https://evil.example",
      CURSOR_WEBSITE_URL: "https://evil.example",
    };
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174065",
      "ui:gather",
      parentEnv,
      "gather",
    );
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
    expect(settings.packages?.[0]).toMatch(/pi-cursor-sdk$/);
    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    expect(auth.cursor.key).toBe("cursor-fixture-key");
    expect(prepared.model).toBe("cursor/composer-2.5");
    expect(prepared.env?.PI_CURSOR_SDK_STATE_ROOT).toMatch(/cursor-state$/);
    expect(prepared.env?.PI_CURSOR_SETTING_SOURCES).toBe("none");
    expect(prepared.env?.PI_JOBS_SCORING_READY).toBeUndefined();
    for (const name of ALL_SCRUB_ENV_NAMES) expect(prepared.env?.[name]).toBeUndefined();
    expect(prepared.env?.CURSOR_BACKEND_URL).toBeUndefined();
    expect(prepared.env?.CURSOR_WEBSITE_URL).toBeUndefined();
    await prepared.cleanup();
  });

  it("drops inherited Cursor endpoint overrides and applies a stored non-production backend", async () => {
    const workspace = await root();
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174055",
      label: "Cursor",
      provider: "cursor" as const,
      cursorBackendUrl: "https://staging.cursor.example",
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [cursor],
      agent: { connectionId: cursor.id, modelId: "composer-2.5" },
      scoring: null,
      captcha: {},
    }));
    await setConnectionCredential(workspace, cursor.id, "cursor-key");
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174054",
      "ui:gather",
      { CURSOR_BACKEND_URL: "https://evil.example", CURSOR_WEBSITE_URL: "https://evil.example" },
      "gather",
    );
    expect(prepared.env?.CURSOR_BACKEND_URL).toBe("https://staging.cursor.example");
    expect(prepared.env?.CURSOR_WEBSITE_URL).toBeUndefined();
    await prepared.cleanup();
  });

  it("refuses a pre-existing pi-agent symlink and leaves the external sentinel untouched", async () => {
    const workspace = await root();
    const sentinel = path.join(workspace, "outside-sentinel.json");
    await fs.writeFile(sentinel, JSON.stringify({ marker: "untouched" }), { mode: 0o600 });
    const runId = "123e4567-e89b-12d3-a456-426614174088";
    const runDir = path.join(workspace, ".pi-jobs", "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.symlink(sentinel, path.join(runDir, "pi-agent"));
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [a],
      agent: { connectionId: a.id, modelId: "agent-model" },
      scoring: { connectionId: a.id, modelId: "agent-model" },
      captcha: {},
    }));
    await setConnectionCredential(workspace, a.id, "agent-key");
    await expect(prepareAgentRun(workspace, runId, "ui:gather", {}, "gather")).rejects.toThrow(/symlink|CONFIG_INVALID/i);
    expect(JSON.parse(await fs.readFile(sentinel, "utf8"))).toEqual({ marker: "untouched" });
  });

  it("writes oauth credentials under the native provider id for a single anthropic connection", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174040",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const oauth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-access",
      refresh: "FIXTURE-SECRET-do-not-leak-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: oauth }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: oauth.access } }),
    }));
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174041", "ui:gather", {}, "gather");
    const runAuth = JSON.parse(await fs.readFile(path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"), "utf8"));
    expect(runAuth.anthropic).toEqual(oauth);
    await prepared.beforeCleanup?.();
    const stored = (await readAuth(workspace))[providerAlias(conn.id)];
    expect(stored?.type).toBe("oauth");
    await prepared.cleanup();
  });

  it("defers run OAuth write-back during login, retains the snapshot, and retries after settlement", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174075",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [conn],
      agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
      scoring: null,
      captcha: {},
    }));
    const initial = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-writeback-initial",
      refresh: "FIXTURE-SECRET-do-not-leak-writeback-refresh",
      expires: Date.now() + 60_000,
    };
    const rotated = {
      ...initial,
      access: "FIXTURE-SECRET-do-not-leak-writeback-rotated",
      expires: initial.expires + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: initial }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: initial.access } }),
    }));
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174076",
      "ui:gather",
      {},
      "gather",
    );
    const runAuthPath = path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json");
    await fs.writeFile(runAuthPath, JSON.stringify({ anthropic: rotated }));

    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let rejectLogin!: (error: Error) => void;
    const loginReleased = new Promise<never>((_resolve, reject) => { rejectLogin = reject; });
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          loginStarted();
          return loginReleased;
        },
        checkAuth: async () => undefined,
      }),
    });
    const startedView = await startLogin(workspace, conn.id, providerHost(workspace), {
      expectedProvider: conn.provider,
    });
    expect(startedView.status).toBe("pending");
    await started;

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(prepared.beforeCleanup?.()).rejects.toMatchObject({
      code: "LOGIN_IN_PROGRESS",
      status: 409,
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("OAuth write-back deferred"));
    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(initial);
    await fs.access(runAuthPath);

    rejectLogin(new Error("fixture login stopped"));
    for (let i = 0; i < 80 && getLogin(workspace, conn.id).status === "pending"; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(getLogin(workspace, conn.id).status).toBe("failed");

    await prepared.beforeCleanup?.();
    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(rotated);
    await prepared.cleanup();
    warning.mockRestore();
  });

  it("write-back skips per-run oauth when expires is older than the app store", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174059",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const storedOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-stored-refresh",
      expires: Date.now() + 3_600_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: storedOAuth }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: storedOAuth.access } }),
    }));
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174060", "ui:gather", {}, "gather");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-stale-run-access",
          refresh: storedOAuth.refresh,
          expires: Date.now() + 30_000,
        },
      }),
    );
    await prepared.beforeCleanup?.();
    const after = (await readAuth(workspace))[providerAlias(conn.id)];
    expect(after?.type).toBe("oauth");
    if (after?.type === "oauth") {
      expect(after.access).toBe(storedOAuth.access);
      expect(after.expires).toBe(storedOAuth.expires);
    }
    await prepared.cleanup();
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "missing or non-string OAuth tokens",
      JSON.stringify({ anthropic: { type: "oauth", access: 7, expires: Date.now() + 120_000 } }),
    ],
    [
      "non-finite OAuth expiry",
      '{"anthropic":{"type":"oauth","access":"FIXTURE-access","refresh":"FIXTURE-refresh","expires":1e999}}',
    ],
  ])("rejects %s in the per-run auth write-back snapshot", async (_label, runAuthText) => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174058",
      label: "Claude",
      provider: "anthropic" as const,
    };
    const storedOAuth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-writeback-stored",
      refresh: "FIXTURE-SECRET-do-not-leak-writeback-refresh",
      expires: Date.now() + 60_000,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [conn],
      agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
      scoring: null,
      captcha: {},
    }));
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: storedOAuth }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: storedOAuth.access } }),
    }));
    const prepared = await prepareAgentRun(
      workspace,
      `123e4567-e89b-12d3-a456-42661417405${runAuthText.length % 10}`,
      "ui:gather",
      {},
      "gather",
    );
    const runAuthPath = path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json");
    await fs.writeFile(runAuthPath, runAuthText);

    await expect(prepared.beforeCleanup?.()).rejects.toThrow("run credential snapshot is malformed");
    expect(await fs.readFile(runAuthPath, "utf8")).toBe(runAuthText);
    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(storedOAuth);
    await prepared.cleanup();
  });

  it("write-back does not overwrite a newer oauth credential already in the app store", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174061",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const initial = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-initial",
      refresh: "FIXTURE-SECRET-do-not-leak-initial-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: initial }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: initial.access } }),
    }));
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174062",
      "ui:gather",
      {},
      "gather",
    );
    const runEntry = {
      ...initial,
      access: "FIXTURE-SECRET-do-not-leak-run",
      expires: initial.expires + 60_000,
    };
    await fs.writeFile(
      path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"),
      JSON.stringify({ anthropic: runEntry }),
    );
    const concurrent = {
      ...initial,
      access: "FIXTURE-SECRET-do-not-leak-concurrent-newer",
      expires: initial.expires + 120_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: concurrent }));

    await prepared.beforeCleanup?.();

    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(concurrent);
    await prepared.cleanup();
  });

  it("write-back skips when the connection was signed into a different OAuth account during the run", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174071",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const initial = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-initial",
      refresh: "FIXTURE-SECRET-do-not-leak-initial-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: initial }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: initial.access } }),
    }));
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174072",
      "ui:gather",
      {},
      "gather",
    );
    const runEntry = {
      ...initial,
      access: "FIXTURE-SECRET-do-not-leak-run",
      expires: initial.expires + 60_000,
    };
    await fs.writeFile(
      path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"),
      JSON.stringify({ anthropic: runEntry }),
    );
    // Account B: a different identity whose expiry is OLDER than the run's
    // rotated token, so an expiry-only comparison would wrongly overwrite it.
    const concurrent = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-account-b",
      refresh: "FIXTURE-SECRET-do-not-leak-account-b-refresh",
      expires: initial.expires + 30_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: concurrent }));

    await prepared.beforeCleanup?.();

    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(concurrent);
    await prepared.cleanup();
  });
  it("write-back leaves refreshFailedAt in place when the run credential did not change", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174073",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const initial = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-initial",
      refresh: "FIXTURE-SECRET-do-not-leak-initial-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: initial }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: initial.access } }),
    }));
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174074",
      "ui:gather",
      {},
      "gather",
    );
    const runEntry = { ...initial };
    await fs.writeFile(
      path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"),
      JSON.stringify({ anthropic: runEntry }),
    );
    // A connection test fails refresh mid-run and records the D7 marker.
    const failedAt = new Date(Date.now() - 1_000).toISOString();
    await persistConnectionHealth(workspace, conn.id, { refreshFailedAt: failedAt });

    await prepared.beforeCleanup?.();

    expect((await readAuth(workspace))[providerAlias(conn.id)]).toEqual(initial);
    const after = await readApplicationSettings(workspace);
    expect(after.data.connections.find((c) => c.id === conn.id)?.refreshFailedAt).toBe(failedAt);
    await prepared.cleanup();
  });
  it("refreshes expired oauth via the runtime before spawn and writes the refreshed token to the per-run file", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174042",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    const stale = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-stale",
      refresh: "FIXTURE-SECRET-do-not-leak-refresh",
      expires: Date.now() - 60_000,
    };
    const fresh = {
      ...stale,
      access: "FIXTURE-SECRET-do-not-leak-fresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: stale }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: fresh }));
        return { auth: { apiKey: fresh.access } };
      },
    }));
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174043", "ui:gather", {}, "gather");
    const runAuth = JSON.parse(await fs.readFile(path.join(String(prepared.env?.PI_CODING_AGENT_DIR), "auth.json"), "utf8"));
    expect(runAuth.anthropic.access).toBe(fresh.access);
    await prepared.cleanup();
  });

  it("refuses run preparation when the selected connection changes provider and key during resolution", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174091",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [conn],
      agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
      scoring: null,
      captcha: {},
    }));
    await modifyAuthFile(workspace, (auth) => ({
      ...auth,
      [providerAlias(conn.id)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-old-provider",
        refresh: "FIXTURE-SECRET-do-not-leak-old-refresh",
        expires: Date.now() + 60_000,
      },
    }));
    let resolutionStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolutionStarted = resolve; });
    let releaseResolution!: () => void;
    const released = new Promise<void>((resolve) => { releaseResolution = resolve; });
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        resolutionStarted();
        await released;
        return { auth: { apiKey: "FIXTURE-SECRET-do-not-leak-old-provider" } };
      },
    }));
    const runId = "123e4567-e89b-12d3-a456-426614174090";

    const preparation = prepareAgentRun(workspace, runId, "ui:gather", {}, "gather");
    await started;
    const current = await readApplicationSettings(workspace);
    await updateConnection(
      workspace,
      conn.id,
      { provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-new-provider" },
      current.revision,
    );
    releaseResolution();

    await expect(preparation).rejects.toThrow("CONFIG_INVALID");
    await expect(fs.stat(path.join(workspace, ".pi-jobs", "runs", runId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Copilot model removed by the pre-run credential refresh", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174064",
      label: "Copilot",
      provider: "github-copilot" as const,
    };
    const stale = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-copilot-stale",
      refresh: "FIXTURE-SECRET-do-not-leak-copilot-refresh",
      expires: Date.now() + 60_000,
      availableModelIds: ["claude-sonnet-4.6"],
    };
    const fresh = {
      ...stale,
      access: "FIXTURE-SECRET-do-not-leak-copilot-fresh",
      expires: Date.now() + 3_600_000,
      availableModelIds: ["gpt-4.1"],
    };
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      connections: [conn],
      agent: { connectionId: conn.id, modelId: "claude-sonnet-4.6" },
      scoring: null,
      captcha: {},
    }));
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: stale }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(conn.id)]: fresh }));
        return { auth: { apiKey: fresh.access } };
      },
    }));
    const runId = "123e4567-e89b-12d3-a456-426614174063";
    await expect(prepareAgentRun(workspace, runId, "ui:gather", {}, "gather")).rejects.toThrow("MODEL_UNAVAILABLE");
    await expect(fs.stat(path.join(workspace, ".pi-jobs", "runs", runId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the run with CREDENTIAL_EXPIRED when oauth refresh fails and persists refreshFailedAt", async () => {
    const workspace = await root();
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174044",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(workspace, (auth) => ({
      ...auth,
      [providerAlias(conn.id)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-access",
        refresh: "FIXTURE-SECRET-do-not-leak-refresh",
        expires: Date.now() - 60_000,
      },
    }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        throw new Error("OAuth refresh failed for anthropic: unauthorized");
      },
    }));
    await expect(
      prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174045", "ui:gather", {}, "gather"),
    ).rejects.toThrow("CREDENTIAL_EXPIRED");
    const settings = await readApplicationSettings(workspace);
    expect(settings.data.connections[0]?.refreshFailedAt).toBeTruthy();
  });

  it("refuses dual same-provider oauth agent and scorer selections with CONFIG_INVALID", async () => {
    const workspace = await root();
    const agent = { id: "123e4567-e89b-12d3-a456-426614174046", label: "A", provider: "anthropic" as const };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174047", label: "B", provider: "anthropic" as const };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent, scorer],
        agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scorer.id, modelId: "claude-sonnet-4-5" },
        captcha: {},
      }),
    );
    const oauth = (suffix: string) => ({
      type: "oauth" as const,
      access: `FIXTURE-SECRET-do-not-leak-${suffix}-a`,
      refresh: `FIXTURE-SECRET-do-not-leak-${suffix}-r`,
      expires: Date.now() + 60_000,
    });
    await modifyAuthFile(workspace, (auth) => ({
      ...auth,
      [providerAlias(agent.id)]: oauth("agent"),
      [providerAlias(scorer.id)]: oauth("scorer"),
    }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
    }));
    await expect(
      prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174048", "ui:score", {}, "score"),
    ).rejects.toThrow("CONFIG_INVALID");
  });

  it("rechecks dual same-provider OAuth after deferred scorer credential resolution", async () => {
    const workspace = await root();
    const agent = { id: "123e4567-e89b-12d3-a456-426614174067", label: "A", provider: "anthropic" as const };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174068", label: "B", provider: "anthropic" as const };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent, scorer],
        agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scorer.id, modelId: "claude-haiku-4-5" },
        captcha: {},
      }),
    );
    const oauth = (suffix: string) => ({
      type: "oauth" as const,
      access: `FIXTURE-SECRET-do-not-leak-${suffix}-access`,
      refresh: `FIXTURE-SECRET-do-not-leak-${suffix}-refresh`,
      expires: Date.now() + 60_000,
    });
    const agentOAuth = oauth("agent-race");
    const scorerOAuth = oauth("scorer-race");
    await modifyAuthFile(workspace, (auth) => ({
      ...auth,
      [providerAlias(agent.id)]: agentOAuth,
      [providerAlias(scorer.id)]: {
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-scorer-initial-key",
      },
    }));
    let switchedScorer = false;
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        if (!switchedScorer) {
          switchedScorer = true;
          await modifyAuthFile(workspace, (auth) => ({
            ...auth,
            [providerAlias(scorer.id)]: scorerOAuth,
          }));
          return { auth: { apiKey: agentOAuth.access } };
        }
        return { auth: { apiKey: scorerOAuth.access } };
      },
    }));

    const runId = "123e4567-e89b-12d3-a456-426614174069";
    await expect(prepareAgentRun(workspace, runId, "ui:score", {}, "score")).rejects.toThrow(
      "CONFIG_INVALID",
    );
    expect(switchedScorer).toBe(true);
    await expect(fs.stat(path.join(workspace, ".pi-jobs", "runs", runId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("agent oauth + scorer api_key maps oauth to native anthropic and api_key to pi-jobs alias", async () => {
    const workspace = await root();
    const agent = { id: "123e4567-e89b-12d3-a456-426614174049", label: "OAuth agent", provider: "anthropic" as const };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174050", label: "Key scorer", provider: "anthropic" as const };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent, scorer],
        agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scorer.id, modelId: "claude-haiku-4-5" },
        captcha: {},
      }),
    );
    const oauth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-oauth-access",
      refresh: "FIXTURE-SECRET-do-not-leak-oauth-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(agent.id)]: oauth }));
    await setConnectionCredential(workspace, scorer.id, "FIXTURE-SECRET-do-not-leak-scorer-key");
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: oauth.access } }),
    }));
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174051", "ui:score", {}, "score");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const runAuth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(runAuth.anthropic.type).toBe("oauth");
    expect(runAuth[`pi-jobs-${scorer.id}`].key).toBe("FIXTURE-SECRET-do-not-leak-scorer-key");
    expect(models.providers[`pi-jobs-${scorer.id}`]).toBeTruthy();
    expect(models.providers.anthropic).toBeUndefined();
    expect(prepared.env?.PI_JOBS_AGENT_MODEL).toBe("anthropic/claude-sonnet-4-5");
    expect(prepared.env?.PI_JOBS_SCORING_MODEL).toBe(`pi-jobs-${scorer.id}/claude-haiku-4-5`);
    await prepared.cleanup();
  });

  it("agent api_key + scorer oauth maps oauth to native anthropic and agent key to pi-jobs alias", async () => {
    const workspace = await root();
    const agent = { id: "123e4567-e89b-12d3-a456-426614174052", label: "Key agent", provider: "anthropic" as const };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174053", label: "OAuth scorer", provider: "anthropic" as const };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent, scorer],
        agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scorer.id, modelId: "claude-haiku-4-5" },
        captcha: {},
      }),
    );
    await setConnectionCredential(workspace, agent.id, "FIXTURE-SECRET-do-not-leak-agent-key");
    const oauth = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-scorer-oauth-access",
      refresh: "FIXTURE-SECRET-do-not-leak-scorer-oauth-refresh",
      expires: Date.now() + 60_000,
    };
    await modifyAuthFile(workspace, (auth) => ({ ...auth, [providerAlias(scorer.id)]: oauth }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: oauth.access } }),
    }));
    const prepared = await prepareAgentRun(workspace, "123e4567-e89b-12d3-a456-426614174054", "ui:score", {}, "score");
    const agentDir = String(prepared.env?.PI_CODING_AGENT_DIR);
    const runAuth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(runAuth.anthropic.type).toBe("oauth");
    expect(runAuth[`pi-jobs-${agent.id}`].key).toBe("FIXTURE-SECRET-do-not-leak-agent-key");
    expect(models.providers[`pi-jobs-${agent.id}`]).toBeTruthy();
    expect(prepared.env?.PI_JOBS_AGENT_MODEL).toBe(`pi-jobs-${agent.id}/claude-sonnet-4-5`);
    expect(prepared.env?.PI_JOBS_SCORING_MODEL).toBe("anthropic/claude-haiku-4-5");
    await prepared.cleanup();
  });

  it("sets CURSOR_DATA_DIR for cursor runs, strips inherited values, and removes the directory on cleanup", async () => {
    const workspace = await root();
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174055",
      label: "Cursor",
      provider: "cursor" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [cursor],
        agent: { connectionId: cursor.id, modelId: "composer-2.5" },
        scoring: null,
        captcha: {},
      }),
    );
    await setConnectionCredential(workspace, cursor.id, "cursor-fixture-key");
    const prepared = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174056",
      "ui:gather",
      { CURSOR_DATA_DIR: "/tmp/inherited-cursor-data" },
      "gather",
    );
    expect(prepared.env?.CURSOR_DATA_DIR).toMatch(/cursor-data$/);
    await fs.access(String(prepared.env?.CURSOR_DATA_DIR));
    await prepared.cleanup();
    await expect(fs.stat(String(prepared.env?.CURSOR_DATA_DIR))).rejects.toThrow();

    const openaiOnly = {
      id: "123e4567-e89b-12d3-a456-426614174057",
      label: "OpenAI",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(workspace, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [openaiOnly],
        agent: { connectionId: openaiOnly.id, modelId: "gpt-4o-mini" },
        scoring: null,
        captcha: {},
      }),
    );
    await setConnectionCredential(workspace, openaiOnly.id, "FIXTURE-SECRET-do-not-leak");
    const nonCursor = await prepareAgentRun(
      workspace,
      "123e4567-e89b-12d3-a456-426614174058",
      "ui:gather",
      { CURSOR_DATA_DIR: "/tmp/inherited-cursor-data" },
      "gather",
    );
    expect(nonCursor.env?.CURSOR_DATA_DIR).toBeUndefined();
    await nonCursor.cleanup();
  });
});
