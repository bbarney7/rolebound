import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AUTO_SUBMIT_POLICY_VERSION } from "../../shared/autoSubmitPolicy";
import { ALL_SCRUB_ENV_NAMES } from "../../shared/providerCatalog";
import { createApp } from "../app";
import {
  FIXTURE_LIVE_SHAPED_PROFILE,
  makeFixtureWorkspace,
  rmFixtureWorkspace,
  seedRunsApplyReady,
} from "./helpers";
import {
  providerAlias,
  setConnectionCredential,
  setModelRuntimeFactoryForTests,
} from "../providers/providerService";
import { modifyAuthFile } from "../providers/authStoreFile";
import { prepareAgentRun } from "../runConfig";
import type { ProviderHostDeps } from "../providers/hostDeps";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakePi.mjs");
const REPO_PI_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".pi", "mcp.json");
const TIMEOUT = 15_000;

async function copyRepoMcp(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.copyFile(REPO_PI_MCP, path.join(root, ".pi", "mcp.json"));
}

const agentConnection = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  label: "Agent",
  provider: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9001/v1",
};

async function seedReadySettings(root: string) {
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      connections: [agentConnection],
      agent: { connectionId: agentConnection.id, modelId: "agent-model" },
      scoring: { connectionId: agentConnection.id, modelId: "agent-model" },
      captcha: {},
    }),
  );
  await setConnectionCredential(root, agentConnection.id, "agent-key");
  await fs.writeFile(
    path.join(root, "state.json"),
    JSON.stringify({
      applications: [],
      addresses: {},
      acknowledged_at: "2026-01-01T00:00:00.000Z",
      acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
    }),
  );
}

interface Ctx {
  root: string;
  app: ReturnType<typeof createApp>;
  server: Server;
  base: string;
}

const open: Ctx[] = [];

async function boot(
  root: string,
  runtime: { env?: NodeJS.ProcessEnv; runsEnv?: NodeJS.ProcessEnv; nodeMajor?: number } = {},
): Promise<Ctx> {
  const runEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ALL_SCRUB_ENV_NAMES) delete runEnv[name];
  const providerHost: ProviderHostDeps = {
    home: path.join(root, "injected-provider-home"),
    env: runtime.env ?? runEnv,
    platform: process.platform,
    nodeMajor: runtime.nodeMajor ?? (Number(process.versions.node.split(".")[0]) || 0),
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
  const app = createApp(root, {
    security: { enabled: false },
    providerHost,
    runs: {
      command: process.execPath,
      args: () => [FAKE_PI],
      model: "fake/model",
      env: runtime.runsEnv,
      prepare: (runId, sessionName, kind, effectiveRuntime) =>
        prepareAgentRun(root, runId, sessionName, effectiveRuntime, kind),
      idleGraceMs: 300,
      killGraceMs: 300,
      heartbeatMs: 150,
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const ctx = { root, app, server, base: `http://127.0.0.1:${port}` };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const ctx of open.splice(0)) {
    await ctx.app.runs.dispose();
    ctx.server.closeAllConnections?.();
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    await rmFixtureWorkspace(ctx.root);
  }
});

async function startRun(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function currentRun(base: string) {
  const res = await fetch(`${base}/api/runs/current`);
  return (await res.json()) as { run: unknown };
}

async function expectRefused(
  base: string,
  body: Record<string, unknown>,
  code: string,
) {
  const res = await startRun(base, body);
  const json = (await res.json()) as { code?: string; error?: string };
  expect(res.status).toBe(422);
  expect(json.code).toBe(code);
  expect((await currentRun(base)).run).toBeNull();
}

describe("POST /api/runs readiness refusals", () => {
  it("starts score with an API key present only in the injected provider runtime", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const openai = {
      id: "123e4567-e89b-12d3-a456-426614174010",
      label: "Injected OpenAI",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [openai],
        agent: { connectionId: openai.id, modelId: "gpt-4o-mini" },
        scoring: { connectionId: openai.id, modelId: "gpt-4o-mini" },
        captcha: {},
      }),
    );
    const injectedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ALL_SCRUB_ENV_NAMES) delete injectedEnv[name];
    injectedEnv.OPENAI_API_KEY = "FIXTURE-SECRET-do-not-leak";
    const { base } = await boot(root, { runsEnv: injectedEnv });

    const readiness = await fetch(`${base}/api/readiness`).then((response) => response.json()) as {
      scoreReady: boolean;
    };
    expect(readiness.scoreReady).toBe(true);
    const response = await startRun(base, { kind: "score", slugs: ["alpha-ai-director"] });
    expect(response.status).toBe(201);
  }, TIMEOUT);

  it("uses a credential present only in runs.env for readiness, the apply gate, and preparation", async () => {
    const root = await makeFixtureWorkspace();
    await seedRunsApplyReady(root);
    await copyRepoMcp(root);
    const openai = {
      id: "123e4567-e89b-12d3-a456-426614174013",
      label: "Runs env OpenAI",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [openai],
        agent: { connectionId: openai.id, modelId: "gpt-4o-mini" },
        scoring: { connectionId: openai.id, modelId: "gpt-4o-mini" },
        captcha: {},
      }),
    );
    const runsEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ALL_SCRUB_ENV_NAMES) delete runsEnv[name];
    runsEnv.OPENAI_API_KEY = "FIXTURE-SECRET-do-not-leak";
    const { base } = await boot(root, { runsEnv });

    const readiness = await fetch(`${base}/api/readiness`).then((response) => response.json()) as {
      applyReady: boolean;
    };
    expect(readiness.applyReady).toBe(true);
    const response = await startRun(base, { kind: "apply", slug: "alpha-ai-director" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      kind: "apply",
      slug: "alpha-ai-director",
      config: { credentialSource: "environment" },
    });
  }, TIMEOUT);

  it("starts apply with the injected Cursor Node major reported ready by the API", async () => {
    const root = await makeFixtureWorkspace();
    await seedRunsApplyReady(root);
    await copyRepoMcp(root);
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174011",
      label: "Cursor",
      provider: "cursor" as const,
    };
    const scorer = {
      id: "123e4567-e89b-12d3-a456-426614174012",
      label: "Scorer",
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:9002/v1",
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [cursor, scorer],
        agent: { connectionId: cursor.id, modelId: "composer-2.5" },
        scoring: { connectionId: scorer.id, modelId: "score-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, cursor.id, "FIXTURE-SECRET-do-not-leak");
    await setConnectionCredential(root, scorer.id, "FIXTURE-SECRET-do-not-leak");
    const { base } = await boot(root, { nodeMajor: 24 });

    const readiness = await fetch(`${base}/api/readiness`).then((response) => response.json()) as {
      applyReady: boolean;
      serverRuntime: { nodeMajor: number };
    };
    expect(readiness.serverRuntime.nodeMajor).toBe(24);
    expect(readiness.applyReady).toBe(true);
    const response = await startRun(base, { kind: "apply", slug: "alpha-ai-director" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ kind: "apply", slug: "alpha-ai-director" });
  }, TIMEOUT);

  it("gather refuses TARGETS_PLACEHOLDER with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(
      path.join(root, "targets.md"),
      "# Gather targets\n\n## Greenhouse\n\n- example-co\n\n## Ashby\n\n- example-co\n\n## Lever\n\n- example-co\n",
    );
    const { base } = await boot(root);
    await expectRefused(base, { kind: "gather" }, "TARGETS_PLACEHOLDER");
  }, TIMEOUT);

  it("gather refuses TARGETS_MISSING with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# targets\n\n");
    const { base } = await boot(root);
    await expectRefused(base, { kind: "gather" }, "TARGETS_MISSING");
  }, TIMEOUT);

  it("gather refuses MODEL_UNAVAILABLE with 422 for an unknown native model and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const nativeAgent = {
      id: "123e4567-e89b-12d3-a456-426614174021",
      label: "OpenAI agent",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [nativeAgent],
        agent: { connectionId: nativeAgent.id, modelId: "does-not-exist-pjr23" },
        scoring: null,
        captcha: {},
      }),
    );
    await setConnectionCredential(root, nativeAgent.id, "FIXTURE-SECRET-do-not-leak");
    const { base } = await boot(root);
    await expectRefused(base, { kind: "gather" }, "MODEL_UNAVAILABLE");
  }, TIMEOUT);

  it("score refuses MODEL_UNAVAILABLE with 422 for an unknown native model and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        applications: [],
        addresses: {},
        acknowledged_at: "2026-01-01T00:00:00.000Z",
        acknowledged_policy: AUTO_SUBMIT_POLICY_VERSION,
      }),
    );
    const nativeAgent = {
      id: "123e4567-e89b-12d3-a456-426614174022",
      label: "OpenAI agent",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [nativeAgent],
        agent: { connectionId: nativeAgent.id, modelId: "does-not-exist-pjr23" },
        scoring: { connectionId: nativeAgent.id, modelId: "does-not-exist-pjr23" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, nativeAgent.id, "FIXTURE-SECRET-do-not-leak");
    const { base } = await boot(root);
    await expectRefused(base, { kind: "score", slugs: ["pj-unknown-model"] }, "MODEL_UNAVAILABLE");
  }, TIMEOUT);

  it("gather refuses CREDENTIAL_MISSING with 422 when native OpenAI agent has no key", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const nativeAgent = {
      id: "123e4567-e89b-12d3-a456-426614174020",
      label: "OpenAI agent",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [nativeAgent],
        agent: { connectionId: nativeAgent.id, modelId: "gpt-4o-mini" },
        scoring: null,
        captcha: {},
      }),
    );
    const runEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ALL_SCRUB_ENV_NAMES) delete runEnv[name];
    const app = createApp(root, {
      security: { enabled: false },
      runs: {
        command: process.execPath,
        args: () => [FAKE_PI],
        model: "fake/model",
        env: runEnv,
        prepare: (runId, sessionName, kind) => prepareAgentRun(root, runId, sessionName, runEnv, kind),
        idleGraceMs: 300,
        killGraceMs: 300,
        heartbeatMs: 150,
      },
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    open.push({ root, app, server, base });
    await expectRefused(base, { kind: "gather" }, "CREDENTIAL_MISSING");
  }, TIMEOUT);

  it("score refuses PROFILE_PLACEHOLDERS with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    await seedReadySettings(root);
    const { base } = await boot(root);
    await expectRefused(base, { kind: "score" }, "PROFILE_PLACEHOLDERS");
  }, TIMEOUT);

  it("score refuses PROFILE_MISSING with 422 when profile.md is absent", async () => {
    const root = await makeFixtureWorkspace();
    await fs.rm(path.join(root, "profile.md"));
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    await seedReadySettings(root);
    const { base } = await boot(root);
    await expectRefused(base, { kind: "score" }, "PROFILE_MISSING");
  }, TIMEOUT);

  it("score refuses CREDENTIAL_MISSING with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const scorer = {
      id: "123e4567-e89b-12d3-a456-426614174014",
      label: "Paid scorer",
      provider: "openai" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agentConnection, scorer],
        agent: { connectionId: agentConnection.id, modelId: "agent-model" },
        scoring: { connectionId: scorer.id, modelId: "gpt-4o-mini" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, agentConnection.id, "agent-key");
    const { base } = await boot(root);
    await expectRefused(base, { kind: "score" }, "CREDENTIAL_MISSING");
  }, TIMEOUT);

  it("score refuses AGENT_MODEL_MISSING with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agentConnection],
        scoring: { connectionId: agentConnection.id, modelId: "agent-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, agentConnection.id, "agent-key");
    const { base } = await boot(root);
    await expectRefused(base, { kind: "score" }, "AGENT_MODEL_MISSING");
  }, TIMEOUT);

  it("apply refuses PROFILE_PLACEHOLDERS with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(
      path.join(root, "profile.md"),
      FIXTURE_LIVE_SHAPED_PROFILE.replace(
        "### Staff Engineer · Acme · 2022-01 – Present\n\nLed the platform team.",
        "### <Job title> · <Company> · <YYYY-MM> – Present\n\n<One-paragraph summary of the role.>",
      ),
    );
    await seedReadySettings(root);
    const { base } = await boot(root);
    await expectRefused(base, { kind: "apply", slug: "alpha-ai-director" }, "PROFILE_PLACEHOLDERS");
  }, TIMEOUT);

  it("apply-next refuses PROFILE_PLACEHOLDERS with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(
      path.join(root, "profile.md"),
      FIXTURE_LIVE_SHAPED_PROFILE.replace(
        "### Staff Engineer · Acme · 2022-01 – Present\n\nLed the platform team.",
        "### <Job title> · <Company> · <YYYY-MM> – Present\n\n<One-paragraph summary of the role.>",
      ),
    );
    await seedReadySettings(root);
    const { base } = await boot(root);
    await expectRefused(base, { kind: "apply-next" }, "PROFILE_PLACEHOLDERS");
  }, TIMEOUT);

  it("apply refuses RESUME_MISSING with 422 and spawns no run", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE);
    await seedReadySettings(root);
    await fs.rm(path.join(root, "resumes", "default.pdf"));
    const { base } = await boot(root);
    await expectRefused(base, { kind: "apply", slug: "alpha-ai-director" }, "RESUME_MISSING");
  }, TIMEOUT);

  it("score refuses SCORING_MODEL_MISSING with 422 when Cursor agent has no scorer", async () => {
    if (Number(process.versions.node.split(".")[0]) < 24) return;
    const root = await makeFixtureWorkspace();
    const { base } = await boot(root);
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174030",
      label: "Cursor",
      provider: "cursor" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [cursor],
        agent: { connectionId: cursor.id, modelId: "composer-2.5" },
        scoring: null,
        captcha: {},
      }),
    );
    await setConnectionCredential(root, cursor.id, "cursor-key");
    await expectRefused(base, { kind: "score" }, "SCORING_MODEL_MISSING");
  }, TIMEOUT);

  it("score refuses CREDENTIAL_EXPIRED with 422 when Cursor key is expired", async () => {
    if (Number(process.versions.node.split(".")[0]) < 24) return;
    const root = await makeFixtureWorkspace();
    const { base } = await boot(root);
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174032",
      label: "Cursor",
      provider: "cursor" as const,
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const scorer = {
      id: "123e4567-e89b-12d3-a456-426614174033",
      label: "Scorer",
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:9002/v1",
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [cursor, scorer],
        agent: { connectionId: cursor.id, modelId: "composer-2.5" },
        scoring: { connectionId: scorer.id, modelId: "score-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, cursor.id, "cursor-key");
    await setConnectionCredential(root, scorer.id, "score-key");
    await expectRefused(base, { kind: "score" }, "CREDENTIAL_EXPIRED");
  }, TIMEOUT);

  it("score refuses CURSOR_NODE_VERSION with 422 when Node is below 24", async () => {
    if (Number(process.versions.node.split(".")[0]) >= 24) return;
    const root = await makeFixtureWorkspace();
    const { base } = await boot(root);
    const cursor = {
      id: "123e4567-e89b-12d3-a456-426614174034",
      label: "Cursor",
      provider: "cursor" as const,
    };
    const scorer = {
      id: "123e4567-e89b-12d3-a456-426614174035",
      label: "Scorer",
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:9002/v1",
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [cursor, scorer],
        agent: { connectionId: cursor.id, modelId: "composer-2.5" },
        scoring: { connectionId: scorer.id, modelId: "score-model" },
        captcha: {},
      }),
    );
    await setConnectionCredential(root, cursor.id, "cursor-key");
    await setConnectionCredential(root, scorer.id, "score-key");
    await expectRefused(base, { kind: "score" }, "CURSOR_NODE_VERSION");
  }, TIMEOUT);

});

describe("applyReadinessBlocker for the pi /apply-next command", () => {
  it("skips the connection step when includeConnection is false", async () => {
    const { applyReadinessBlocker } = await import("../runReadiness");
    const { seedRunsApplyReady } = await import("./helpers");
    const root = await makeFixtureWorkspace();
    try {
      await seedRunsApplyReady(root);
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({ schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: {} }),
      );
      expect((await applyReadinessBlocker(root))?.code).toBe("AGENT_MODEL_MISSING");
      expect(await applyReadinessBlocker(root, { includeConnection: false })).toBeNull();
      await fs.rm(path.join(root, "resumes", "default.pdf"));
      expect((await applyReadinessBlocker(root, { includeConnection: false }))?.code).toBe("RESUME_MISSING");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("accepts a location-specific resume when default.pdf is missing", async () => {
    const { applyReadinessBlocker } = await import("../runReadiness");
    const { seedRunsApplyReady } = await import("./helpers");
    const root = await makeFixtureWorkspace();
    try {
      await seedRunsApplyReady(root);
      const profileWithResumeRules = `${FIXTURE_LIVE_SHAPED_PROFILE.replace(
        "## City → Address rules",
        `### Resume region rules (\`resume_key\`)

| \`resume_key\` | Match terms |
|---|---|
| \`denver\` | denver, boulder, colorado, co |
| \`chicago\` | chicago, evanston, illinois, il |

## City → Address rules`,
      )}`;
      await fs.writeFile(path.join(root, "profile.md"), profileWithResumeRules);
      await fs.rm(path.join(root, "resumes", "default.pdf"));
      await fs.writeFile(path.join(root, "resumes", "denver.pdf"), "%PDF-1.4 stub\n");
      const slug = "denver-role";
      await fs.writeFile(
        path.join(root, "jobs", "queue", `${slug}.md`),
        `---\nurl: https://example.test/denver\ncompany: Acme\ntitle: Engineer\nlocation: Denver, CO\n---\n`,
      );
      const { resumeReadyForQueueSlug } = await import("../runReadiness");
      const { readResumes } = await import("../readers/library");
      const { readProfile } = await import("../readers/profile");
      expect((await readProfile(root)).resume?.regionRules?.some((r) => r.key === "denver")).toBe(true);
      expect((await readResumes(root)).files.find((f) => f.name === "denver.pdf")?.reachability).toBe("region");
      expect(await resumeReadyForQueueSlug(root, slug)).toBe(true);
      expect(await applyReadinessBlocker(root, { includeConnection: false, slug })).toBeNull();
      // The dashboard run-start check gets the slug too, so it does not refuse before applyGate runs.
      const { readinessBlockerForRunKind } = await import("../runReadiness");
      expect(await readinessBlockerForRunKind(root, "apply", slug)).toBeNull();
      await fs.writeFile(
        path.join(root, "jobs", "queue", `${slug}.md`),
        `---\nurl: https://example.test/chi\ncompany: Acme\ntitle: Engineer\nlocation: Chicago, IL\n---\n`,
      );
      expect((await applyReadinessBlocker(root, { includeConnection: false, slug }))?.code).toBe("RESUME_MISSING");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });

  it("gather refuses CONFIG_INVALID with 422 for dual same-provider oauth selections", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const agent = { id: "123e4567-e89b-12d3-a456-426614174097", label: "A", provider: "anthropic" as const };
    const scorer = { id: "123e4567-e89b-12d3-a456-426614174098", label: "B", provider: "anthropic" as const };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [agent, scorer],
        agent: { connectionId: agent.id, modelId: "claude-sonnet-4-5" },
        scoring: { connectionId: scorer.id, modelId: "claude-sonnet-4-5" },
        captcha: {},
      }),
    );
    const oauth = (tag: string) => ({
      type: "oauth" as const,
      access: `FIXTURE-SECRET-do-not-leak-${tag}-a`,
      refresh: `FIXTURE-SECRET-do-not-leak-${tag}-r`,
      expires: Date.now() + 60_000,
    });
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(agent.id)]: oauth("agent"),
      [providerAlias(scorer.id)]: oauth("scorer"),
    }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
    }));
    const { base } = await boot(root);
    try {
      await expectRefused(base, { kind: "gather" }, "CONFIG_INVALID");
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);

  it("gather refuses CREDENTIAL_EXPIRED with 422 when oauth refresh fails during prepare", async () => {
    const root = await makeFixtureWorkspace();
    await fs.writeFile(path.join(root, "targets.md"), "# greenhouse\n- acme\n");
    const conn = {
      id: "123e4567-e89b-12d3-a456-426614174099",
      label: "Claude",
      provider: "anthropic" as const,
    };
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [conn],
        agent: { connectionId: conn.id, modelId: "claude-sonnet-4-5" },
        scoring: null,
        captcha: {},
      }),
    );
    await modifyAuthFile(root, (auth) => ({
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
    const { base } = await boot(root);
    try {
      await expectRefused(base, { kind: "gather" }, "CREDENTIAL_EXPIRED");
    } finally {
      setModelRuntimeFactoryForTests(undefined);
    }
  }, TIMEOUT);
});
