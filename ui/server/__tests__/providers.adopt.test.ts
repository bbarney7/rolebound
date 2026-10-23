import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import type { ProviderHostDeps } from "../providers/hostDeps";
import { drainLoginSessions } from "../providers/loginSessions";
import { readAuth } from "../providers/authStoreFile";
import { providerAlias } from "../providers/providerIds";
import { readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import { prepareAgentRun } from "../runConfig";
import { computeReadiness } from "../readiness";
import * as finalizeDefaults from "../providers/finalizeDefaults";
import { setConnectionCredential } from "../providers/providerService";

const FIXTURE = "FIXTURE-SECRET-do-not-leak";

function cursorSdkJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    apiKey: FIXTURE,
    backendUrl: "https://api2.cursor.sh",
    email: "dev@example.com",
    createdAtMs: Date.now(),
    apiKeyExpiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
}

function baseDeps(root: string, env: NodeJS.ProcessEnv = {}): ProviderHostDeps {
  return {
    home: path.join(root, "home"),
    env,
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
}

async function withServer(
  setup: (root: string, host: ProviderHostDeps) => Promise<void>,
  run: (ctx: { root: string; base: string; host: ProviderHostDeps }) => Promise<void>,
): Promise<void> {
  const root = await makeFixtureWorkspace();
  const host = baseDeps(root);
  await fs.mkdir(host.home, { recursive: true });
  await setup(root, host);
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      connections: [],
      agent: null,
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    }),
  );
  const app = createApp(root, { security: { enabled: false }, providerHost: host });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run({ root, base: `http://127.0.0.1:${port}`, host });
  } finally {
    await drainLoginSessions();
    await new Promise((resolve) => server.close(resolve));
    await rmFixtureWorkspace(root);
  }
}

afterEach(async () => {
  await drainLoginSessions();
});

describe("POST /api/providers/adopt", () => {
  it("cursor + typesafe → two connections and Jev scoring", async () => {
    await withServer(
      async (root, host) => {
        host.env = { ...host.env, TYPESAFE_API_KEY: FIXTURE };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        const body = (await res.json()) as {
          connections: Array<{ provider: string }>;
          scoring: { modelId: string } | null;
          error?: { message: string };
        };
        expect(res.status).toBe(200);
        expect(body.connections.filter((c) => c.provider === "cursor")).toHaveLength(1);
        expect(body.connections.filter((c) => c.provider === "typesafe")).toHaveLength(1);
        expect(body.scoring?.modelId).toBe("jev-latest");
      },
    );
  });

  it("adopts only the first TypeSafe supplemental when TypeSafe and OpenRouter are both detected", async () => {
    await withServer(
      async (_root, host) => {
        host.env = {
          ...host.env,
          TYPESAFE_API_KEY: `${FIXTURE}-typesafe`,
          OPENROUTER_API_KEY: `${FIXTURE}-openrouter`,
        };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ base }) => {
        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        const body = await response.json() as {
          connections: Array<{ provider: string }>;
          scoring: { connectionId: string; modelId: string } | null;
        };
        expect(response.status).toBe(200);
        expect(body.connections.filter((connection) => connection.provider === "typesafe")).toHaveLength(1);
        expect(body.connections.filter((connection) => connection.provider === "openrouter")).toHaveLength(0);
        expect(body.scoring?.modelId).toBe("jev-latest");
      },
    );
  });

  it("uses a TypeSafe primary without creating a detected OpenRouter supplemental", async () => {
    await withServer(
      async (_root, host) => {
        host.env = {
          ...host.env,
          TYPESAFE_API_KEY: `${FIXTURE}-typesafe-primary`,
          OPENROUTER_API_KEY: `${FIXTURE}-openrouter`,
        };
      },
      async ({ base }) => {
        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:typesafe" }),
        });
        const body = await response.json() as {
          connections: Array<{ id: string; provider: string }>;
          scoring: { connectionId: string; modelId: string } | null;
        };
        expect(response.status).toBe(200);
        const typesafe = body.connections.filter((connection) => connection.provider === "typesafe");
        expect(typesafe).toHaveLength(1);
        expect(body.connections.filter((connection) => connection.provider === "openrouter")).toHaveLength(0);
        expect(body.scoring).toEqual({ connectionId: typesafe[0]!.id, modelId: "jev-latest" });
      },
    );
  });

  it("adopts one TypeSafe supplemental when both pi and environment origins are detected", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ...host.env, TYPESAFE_API_KEY: `${FIXTURE}-env-typesafe` };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ typesafe: { type: "api_key", key: `${FIXTURE}-pi-typesafe` } }),
        );
      },
      async ({ root, base }) => {
        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        const body = await response.json() as {
          connections: Array<{ id: string; provider: string; origin?: { kind: string } }>;
        };
        expect(response.status).toBe(200);
        const supplemental = body.connections.filter((connection) => connection.provider === "typesafe");
        expect(supplemental).toHaveLength(1);
        expect(supplemental[0]?.origin?.kind).toBe("pi-auth");
        const auth = await readAuth(root);
        expect(Object.keys(auth).filter((alias) => alias.endsWith(supplemental[0]!.id))).toHaveLength(1);
      },
    );
  });

  it("keeps scoring on an existing usable TypeSafe connection instead of adopting detected OpenRouter", async () => {
    const typesafeId = "123e4567-e89b-12d3-a456-426614174090";
    await withServer(
      async (_root, host) => {
        host.env = { ...host.env, OPENROUTER_API_KEY: `${FIXTURE}-openrouter` };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ root, base }) => {
        const current = await readApplicationSettings(root);
        await writeApplicationSettings(
          root,
          {
            ...current.data,
            connections: [
              ...current.data.connections,
              { id: typesafeId, label: "Existing TypeSafe", provider: "typesafe" },
            ],
          },
          current.revision,
        );
        await setConnectionCredential(root, typesafeId, `${FIXTURE}-existing-typesafe`);

        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        const body = await response.json() as {
          connections: Array<{ id: string; provider: string }>;
          scoring: { connectionId: string; modelId: string } | null;
        };
        expect(response.status).toBe(200);
        expect(body.connections.filter((connection) => connection.provider === "typesafe")).toHaveLength(1);
        expect(body.connections.filter((connection) => connection.provider === "openrouter")).toHaveLength(0);
        expect(body.scoring).toEqual({ connectionId: typesafeId, modelId: "jev-latest" });
      },
    );
  });

  it("returns 422 for sign-in detections and unknown ids", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".claude"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".claude/.credentials.json"),
          JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE } }),
        );
      },
      async ({ base }) => {
        const signIn = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "claude-code:anthropic" }),
        });
        expect(signIn.status).toBe(422);
        const unknown = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:missing-provider" }),
        });
        expect(unknown.status).toBe(422);
      },
    );
  });

  it("cursor adopt from a fixture store with a staging backendUrl → cursorBackendUrl persisted and the run env gets CURSOR_BACKEND_URL", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ backendUrl: "https://staging.cursor.example" }),
        );
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          connections: Array<{ provider: string; cursorBackendUrl?: string; id: string }>;
        };
        const cursor = body.connections.find((c) => c.provider === "cursor");
        expect(cursor?.cursorBackendUrl).toBe("https://staging.cursor.example");
        const prepared = await prepareAgentRun(
          root,
          "123e4567-e89b-12d3-a456-426614174099",
          "ui:gather",
          { CURSOR_BACKEND_URL: "https://evil.example" },
          "gather",
        );
        expect(prepared.env?.CURSOR_BACKEND_URL).toBe("https://staging.cursor.example");
        await prepared.cleanup();
      },
    );
  });

  it("refuses Cursor adoption when the signed-in account changed after detection (origin A never gets account B)", async () => {
    // Detection reads the Cursor store first and probes the keychain (darwin)
    // afterwards, so a keychain probe that parks the FIRST detection pass gives
    // a deterministic window: the request has already read account A, has not
    // yet taken the provider-store lock, and the external store can be
    // switched to account B before it continues.
    let firstPassReadCursor!: () => void;
    const reachedProbe = new Promise<void>((resolve) => { firstPassReadCursor = resolve; });
    let releaseFirstPass!: () => void;
    const released = new Promise<void>((resolve) => { releaseFirstPass = resolve; });
    let probeCalls = 0;
    await withServer(
      async (_root, host) => {
        host.platform = "darwin";
        host.keychainProbe = async () => {
          probeCalls += 1;
          if (probeCalls === 1) { firstPassReadCursor(); await released; }
          return "absent";
        };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ root, base, host }) => {
        const adopt = fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        await reachedProbe;
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ email: "other@example.com", apiKey: "FIXTURE-SECRET-do-not-leak-other" }),
        );
        releaseFirstPass();
        const res = await adopt;
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("CONFIG_INVALID");
        const settings = await readApplicationSettings(root);
        expect(settings.data.connections.some((c) => c.provider === "cursor")).toBe(false);
        expect(Object.keys(await readAuth(root))).toEqual([]);
      },
    );
  });

  it("adopts a Cursor store that carries no email (detection id without an account)", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson({ email: "" }));
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor" }),
        });
        expect(res.status).toBe(200);
        const settings = await readApplicationSettings(root);
        const cursor = settings.data.connections.find((c) => c.provider === "cursor");
        expect(cursor).toBeDefined();
        expect(cursor?.email).toBeUndefined();
        expect((await readAuth(root))[providerAlias(cursor!.id)]).toEqual({ type: "api_key", key: FIXTURE });
      },
    );
  });

  it("cursor alone → scoring: null and computeReadiness reports SCORING_MODEL_MISSING", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { scoring: unknown; readiness: { scoreBlockers: Array<{ code: string }> } };
        expect(body.scoring).toBeNull();
        const readiness = await computeReadiness(root);
        expect(readiness.scoreBlockers.some((b) => b.code === "SCORING_MODEL_MISSING")).toBe(true);
      },
    );
  });

  it("cursor plus a detected Google key adopts Google and selects its scoring default", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ...host.env, GEMINI_API_KEY: FIXTURE };
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(path.join(host.home, ".cursor/sdk/auth.json"), cursorSdkJson());
      },
      async ({ base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          connections: Array<{ id: string; provider: string }>;
          scoring: { connectionId: string; modelId: string } | null;
        };
        const google = body.connections.find((connection) => connection.provider === "google");
        expect(google).toBeTruthy();
        expect(body.scoring?.connectionId).toBe(google?.id);
        expect(body.scoring?.modelId).toBe("gemini-2.5-flash");
      },
    );
  });

  it("keeps an existing Cursor agent and uses a newly adopted Anthropic key for scoring", async () => {
    const cursorId = "123e4567-e89b-12d3-a456-426614174081";
    await withServer(
      async (_root, host) => {
        host.env = { ...host.env, ANTHROPIC_API_KEY: FIXTURE };
      },
      async ({ root, base }) => {
        const current = await readApplicationSettings(root);
        await writeApplicationSettings(
          root,
          {
            ...current.data,
            connections: [{ id: cursorId, label: "Existing Cursor", provider: "cursor" }],
            agent: { connectionId: cursorId, modelId: "composer-2.5" },
            scoring: null,
          },
          current.revision,
        );
        await setConnectionCredential(root, cursorId, `${FIXTURE}-cursor`);

        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:anthropic" }),
        });
        expect(response.status).toBe(200);
        const body = await response.json() as {
          connections: Array<{ id: string; provider: string }>;
          agent: { connectionId: string; modelId: string } | null;
          scoring: { connectionId: string; modelId: string } | null;
        };
        const anthropic = body.connections.find((connection) => connection.provider === "anthropic");
        expect(body.agent).toEqual({ connectionId: cursorId, modelId: "composer-2.5" });
        expect(body.scoring).toEqual({
          connectionId: anthropic?.id,
          modelId: "claude-sonnet-4-5",
        });
      },
    );
  });

  it("anthropic pi-auth alone → scoring: null (inherit) with the agent set", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }),
        );
      },
      async ({ base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "pi-auth:anthropic" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          agent: { connectionId: string; modelId: string } | null;
          scoring: unknown;
        };
        expect(body.agent).not.toBeNull();
        expect(body.scoring).toBeNull();
      },
    );
  });

  it("typesafe alone → scoring-only, agent untouched/null", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ...host.env, TYPESAFE_API_KEY: FIXTURE };
      },
      async ({ base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:typesafe" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          agent: unknown;
          scoring: { modelId: string } | null;
        };
        expect(body.agent).toBeNull();
        expect(body.scoring?.modelId).toBe("jev-latest");
      },
    );
  });

  it("repeat adopt → 200 with the same connection id", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ANTHROPIC_API_KEY: FIXTURE };
      },
      async ({ base }) => {
        const first = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:anthropic" }),
        });
        const a = (await first.json()) as { connections: Array<{ id: string; provider: string }> };
        const id = a.connections.find((c) => c.provider === "anthropic")?.id;
        const second = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:anthropic" }),
        });
        expect(second.status).toBe(200);
        const b = (await second.json()) as { connections: Array<{ id: string; provider: string }> };
        expect(b.connections.filter((c) => c.provider === "anthropic")).toHaveLength(1);
        expect(b.connections.find((c) => c.provider === "anthropic")?.id).toBe(id);
      },
    );
  });

  it("repeat pi-auth adoption keeps the connection id and replaces the copied API key", async () => {
    const oldKey = `${FIXTURE}-pi-old`;
    const newKey = `${FIXTURE}-pi-new`;
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ anthropic: { type: "api_key", key: oldKey } }),
        );
      },
      async ({ root, base, host }) => {
        const adopt = () => fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "pi-auth:anthropic" }),
        });
        const first = await adopt();
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { connections: Array<{ id: string; provider: string }> };
        const connectionId = firstBody.connections.find((connection) => connection.provider === "anthropic")?.id;
        expect(connectionId).toBeTruthy();
        expect((await readAuth(root))[`pi-jobs-${connectionId}`]).toEqual({ type: "api_key", key: oldKey });

        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ anthropic: { type: "api_key", key: newKey } }),
        );
        const second = await adopt();
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as { connections: Array<{ id: string; provider: string }> };
        expect(secondBody.connections.filter((connection) => connection.provider === "anthropic")).toHaveLength(1);
        expect(secondBody.connections.find((connection) => connection.provider === "anthropic")?.id).toBe(connectionId);
        expect((await readAuth(root))[`pi-jobs-${connectionId}`]).toEqual({ type: "api_key", key: newKey });
      },
    );
  });

  it("repeat Cursor adoption keeps the connection id and replaces an expired SDK credential and metadata", async () => {
    const oldKey = `${FIXTURE}-cursor-old`;
    const newKey = `${FIXTURE}-cursor-new`;
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ apiKey: oldKey, apiKeyExpiresAtMs: Date.now() + 60_000 }),
        );
      },
      async ({ root, base, host }) => {
        const adopt = () => fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "cursor-sdk:cursor:dev@example.com" }),
        });
        const first = await adopt();
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { connections: Array<{ id: string; provider: string }> };
        const connectionId = firstBody.connections.find((connection) => connection.provider === "cursor")?.id;
        expect(connectionId).toBeTruthy();

        const stale = await readApplicationSettings(root);
        await writeApplicationSettings(root, {
          ...stale.data,
          connections: stale.data.connections.map((connection) =>
            connection.id === connectionId
              ? { ...connection, email: "stale@example.com", expiresAt: new Date(0).toISOString() }
              : connection,
          ),
        }, stale.revision);
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ apiKey: oldKey, apiKeyExpiresAtMs: Date.now() - 60_000 }),
        );
        const renewedExpiry = Date.now() + 3_600_000;
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({
            apiKey: newKey,
            apiKeyExpiresAtMs: renewedExpiry,
            email: "dev@example.com",
            backendUrl: "https://staging.cursor.example",
          }),
        );

        const second = await adopt();
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as {
          connections: Array<{
            id: string;
            provider: string;
            email?: string;
            expiresAt?: string;
            cursorBackendUrl?: string;
          }>;
        };
        expect(secondBody.connections.filter((connection) => connection.provider === "cursor")).toHaveLength(1);
        const cursor = secondBody.connections.find((connection) => connection.provider === "cursor");
        expect(cursor).toMatchObject({
          id: connectionId,
          email: "dev@example.com",
          expiresAt: new Date(renewedExpiry).toISOString(),
          cursorBackendUrl: "https://staging.cursor.example",
        });
        expect((await readAuth(root))[`pi-jobs-${connectionId}`]).toEqual({ type: "api_key", key: newKey });
      },
    );
  });

  it("colliding existing label → suffixed label", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ANTHROPIC_API_KEY: FIXTURE };
      },
      async ({ root, base }) => {
        await fs.writeFile(
          path.join(root, "settings.json"),
          JSON.stringify({
            schemaVersion: 2,
            connections: [{ id: "11111111-1111-4111-8111-111111111111", label: "Anthropic", provider: "anthropic" }],
            agent: null,
            scoring: null,
            captcha: { provider: "off", api_key: "" },
          }),
        );
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:anthropic" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { connections: Array<{ label: string; provider: string }> };
        const labels = body.connections.filter((c) => c.provider === "anthropic").map((c) => c.label);
        expect(labels).toContain("Anthropic");
        expect(labels.some((l) => /^Anthropic \d+$/.test(l))).toBe(true);
      },
    );
  });

  it("adopts a 250-character Cursor account with bounded metadata and a unique bounded label", async () => {
    const account = `${"a".repeat(238)}@example.com`;
    const originAccount = `${account.slice(0, 150)}#${createHash("sha256").update(account).digest("hex").slice(0, 12)}`;
    expect(account).toHaveLength(250);
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ email: account }),
        );
      },
      async ({ root, base }) => {
        const current = await readApplicationSettings(root);
        const collidingLabel = `Cursor · ${account.slice(0, 67)}`;
        await writeApplicationSettings(
          root,
          {
            ...current.data,
            connections: [{
              id: "123e4567-e89b-12d3-a456-426614174298",
              label: collidingLabel,
              provider: "openai",
            }],
          },
          current.revision,
        );
        const request = () => fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: `cursor-sdk:cursor:${account}` }),
        });

        const response = await request();
        const body = await response.json() as {
          connections: Array<{
            id: string;
            label: string;
            provider: string;
            email?: string;
            origin?: { kind: string; account?: string };
          }>;
          error?: { code?: string };
        };
        expect(response.status).toBe(200);
        expect(body.error?.code).not.toBe("INTERNAL_ERROR");
        const cursor = body.connections.find((connection) => connection.provider === "cursor");
        expect(cursor?.origin).toEqual({ kind: "cursor-sdk", account: originAccount });
        expect(cursor?.email).toBe(account.slice(0, 200));
        expect(cursor?.label).toBe(`${collidingLabel} 2`);
        expect(cursor?.label.length).toBeLessThanOrEqual(80);
        expect(new Set(body.connections.map((connection) => connection.label.toLowerCase())).size)
          .toBe(body.connections.length);

        const repeated = await request();
        expect(repeated.status).toBe(200);
        const repeatedBody = await repeated.json() as { connections: Array<{ id: string; provider: string }> };
        const repeatedCursor = repeatedBody.connections.filter((connection) => connection.provider === "cursor");
        expect(repeatedCursor).toHaveLength(1);
        expect(repeatedCursor[0]?.id).toBe(cursor?.id);
      },
    );
  });

  it("keeps same-prefix long accounts as distinct stable origins under concurrent adoption", async () => {
    const prefix = "p".repeat(200);
    const firstAccount = `${prefix}-first@example.com`;
    const secondAccount = `${prefix}-second@example.com`;
    const expectedOrigin = (account: string) =>
      `${account.slice(0, 150)}#${createHash("sha256").update(account).digest("hex").slice(0, 12)}`;

    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ email: firstAccount }),
        );
      },
      async ({ root, base, host }) => {
        const storePath = path.join(host.home, ".cursor/sdk/auth.json");
        const adoptPair = async (account: string) => {
          await fs.writeFile(storePath, cursorSdkJson({ email: account }));
          const request = () => fetch(`${base}/api/providers/adopt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ detectionId: `cursor-sdk:cursor:${account}` }),
          });
          const responses = await Promise.all([request(), request()]);
          expect(responses.map((response) => response.status)).toEqual([200, 200]);
          return Promise.all(responses.map(async (response) => {
            const body = await response.json() as {
              connections: Array<{ id: string; provider: string; origin?: { kind: string; account?: string } }>;
            };
            return body.connections.find(
              (connection) => connection.provider === "cursor"
                && connection.origin?.account === expectedOrigin(account),
            )?.id;
          }));
        };

        const firstIds = await adoptPair(firstAccount);
        const secondIds = await adoptPair(secondAccount);
        expect(new Set(firstIds).size).toBe(1);
        expect(new Set(secondIds).size).toBe(1);
        expect(firstIds[0]).toBeTruthy();
        expect(secondIds[0]).toBeTruthy();
        expect(secondIds[0]).not.toBe(firstIds[0]);

        const cursor = (await readApplicationSettings(root)).data.connections.filter(
          (connection) => connection.provider === "cursor",
        );
        expect(cursor).toHaveLength(2);
        expect(new Set(cursor.map((connection) => connection.origin?.account))).toEqual(new Set([
          expectedOrigin(firstAccount),
          expectedOrigin(secondAccount),
        ]));
        expect(cursor.every((connection) => (connection.origin?.account?.length ?? 0) <= 200)).toBe(true);
      },
    );
  });

  it("preserves a short account origin byte-for-byte", async () => {
    const account = "short-account@example.com";
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".cursor/sdk"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".cursor/sdk/auth.json"),
          cursorSdkJson({ email: account }),
        );
      },
      async ({ root, base }) => {
        const response = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: `cursor-sdk:cursor:${account}` }),
        });
        expect(response.status).toBe(200);
        const cursor = (await readApplicationSettings(root)).data.connections.find(
          (connection) => connection.provider === "cursor",
        );
        expect(cursor?.origin).toEqual({ kind: "cursor-sdk", account });
      },
    );
  });

  it("two concurrent adopts (Promise.all) → exactly one connection", async () => {
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }),
        );
      },
      async ({ base }) => {
        const [a, b] = await Promise.all([
          fetch(`${base}/api/providers/adopt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ detectionId: "pi-auth:anthropic" }),
          }),
          fetch(`${base}/api/providers/adopt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ detectionId: "pi-auth:anthropic" }),
          }),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const bodyA = (await a.json()) as { connections: Array<{ id: string; provider: string; origin?: { kind: string } }> };
        const bodyB = (await b.json()) as { connections: Array<{ id: string; provider: string; origin?: { kind: string } }> };
        const anthropicA = bodyA.connections.filter((c) => c.provider === "anthropic");
        const anthropicB = bodyB.connections.filter((c) => c.provider === "anthropic");
        expect(anthropicA).toHaveLength(1);
        expect(anthropicB).toHaveLength(1);
        expect(anthropicA[0]?.origin?.kind).toBe("pi-auth");
        expect(anthropicB[0]?.id).toBe(anthropicA[0]?.id);
        expect((anthropicA[0] as { credential?: { source?: string } }).credential?.source).toBe("app-store");
        expect((anthropicB[0] as { credential?: { source?: string } }).credential?.source).toBe("app-store");
      },
    );
  });

  it("failure after the credential write (inject a failing settings write) → the auth.json alias entry is rolled back", async () => {
    const spy = vi
      .spyOn(finalizeDefaults, "finalizeDefaultsUnlocked")
      .mockRejectedValueOnce(new Error("injected finalize failure"));
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }),
        );
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "pi-auth:anthropic" }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        const auth = await readAuth(root);
        expect(Object.keys(auth)).toHaveLength(0);
        expect((await readApplicationSettings(root)).data.connections).toHaveLength(0);
      },
    );
    spy.mockRestore();
  });

  it("env-key adopt uses environment source without auth.json entries", async () => {
    await withServer(
      async (_root, host) => {
        host.env = { ANTHROPIC_API_KEY: FIXTURE };
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:anthropic" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          connections: Array<{ provider: string; credential: { source: string } }>;
          readiness: { steps: Array<{ id: string; complete: boolean }> };
        };
        const anthropic = body.connections.find((c) => c.provider === "anthropic");
        expect(anthropic?.credential.source).toBe("environment");
        expect(body.readiness.steps.find((step) => step.id === "connection")?.complete).toBe(true);

        const readiness = await fetch(`${base}/api/readiness`);
        expect(readiness.status).toBe(200);
        const readinessBody = await readiness.json() as {
          steps: Array<{ id: string; complete: boolean }>;
        };
        expect(readinessBody.steps.find((step) => step.id === "connection")?.complete).toBe(true);
        const auth = await readAuth(root);
        expect(Object.keys(auth)).toHaveLength(0);
      },
    );
  });

  it("env-key Cursor adopt is agent-only, uses the environment, and stores no credential", async () => {
    const cursorKey = `${FIXTURE}-cursor-env`;
    await withServer(
      async (_root, host) => {
        host.env = { CURSOR_API_KEY: cursorKey };
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "env-key:cursor" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          connections: Array<{ provider: string; credential: { source: string } }>;
          agent: { connectionId: string; modelId: string } | null;
          scoring: unknown;
        };
        const cursor = body.connections.find((connection) => connection.provider === "cursor");
        expect(cursor?.credential.source).toBe("environment");
        expect(body.agent?.modelId).toBe("composer-2.5");
        expect(body.scoring).toBeNull();
        expect(await readAuth(root)).toEqual({});
      },
    );
  });

  it("pi-auth Cursor adopt copies the key and selects composer-2.5 with no scoring override", async () => {
    const cursorKey = `${FIXTURE}-cursor-pi`;
    await withServer(
      async (_root, host) => {
        await fs.mkdir(path.join(host.home, ".pi/agent"), { recursive: true });
        await fs.writeFile(
          path.join(host.home, ".pi/agent/auth.json"),
          JSON.stringify({ cursor: { type: "api_key", key: cursorKey } }),
        );
      },
      async ({ root, base }) => {
        const res = await fetch(`${base}/api/providers/adopt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId: "pi-auth:cursor" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          connections: Array<{ id: string; provider: string; credential: { source: string } }>;
          agent: { connectionId: string; modelId: string } | null;
          scoring: unknown;
        };
        const cursor = body.connections.find((connection) => connection.provider === "cursor");
        expect(cursor?.credential.source).toBe("app-store");
        expect(body.agent).toEqual({ connectionId: cursor?.id, modelId: "composer-2.5" });
        expect(body.scoring).toBeNull();
        expect((await readAuth(root))[`pi-jobs-${cursor?.id}`]).toEqual({
          type: "api_key",
          key: cursorKey,
        });
      },
    );
  });
});
