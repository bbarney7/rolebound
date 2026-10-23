import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConnectionCredentialStore } from "../providers/connectionCredentialStore";
import type { LoginRuntimeFactory } from "../providers/loginSessions";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import type { ProviderHostDeps } from "../providers/hostDeps";
import {
  configureLoginSessions,
  drainLoginSessions,
  resetLoginSessions,
  startLogin,
} from "../providers/loginSessions";
import { readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";
import { readAuth } from "../providers/authStoreFile";
import { providerAlias } from "../providers/providerIds";

function fixtureHost(root: string): ProviderHostDeps {
  return {
    home: path.join(root, "fake-home"),
    env: {},
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
}

function oauthCredential(): Credential {
  return {
    type: "oauth",
    access: "FIXTURE-SECRET-do-not-leak-access",
    refresh: "FIXTURE-SECRET-do-not-leak-refresh",
    expires: 1_900_000_000_000,
  };
}

function persistingRuntime(
  login: (
    provider: string,
    interaction: AuthInteraction,
    store: ConnectionCredentialStore,
  ) => Promise<Credential>,
  checkAuth?: ModelRuntime["checkAuth"],
): { createRuntime: LoginRuntimeFactory } {
  return {
    createRuntime: async (options: Parameters<LoginRuntimeFactory>[0]) =>
      ({
        login: async (provider, _type, interaction) => {
          const credential = await login(provider, interaction, options.credentials);
          await options.credentials.modify(provider, async () => credential);
          return credential;
        },
        checkAuth: checkAuth ?? (async () => undefined),
      }) as Pick<ModelRuntime, "login" | "checkAuth">,
  };
}

async function withServer(
  run: (ctx: { root: string; base: string }) => Promise<void>,
  hostOverrides: Partial<ProviderHostDeps> = {},
): Promise<void> {
  const root = await makeFixtureWorkspace();
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
  const app = createApp(root, {
    security: { enabled: false },
    providerHost: { ...fixtureHost(root), ...hostOverrides },
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run({ root, base: `http://127.0.0.1:${port}` });
  } finally {
    await drainLoginSessions();
    resetLoginSessions();
    await new Promise((resolve) => server.close(resolve));
    await rmFixtureWorkspace(root);
  }
}

afterEach(async () => {
  await drainLoginSessions();
  configureLoginSessions(null);
  resetLoginSessions();
});

describe("POST /api/providers/login", () => {
  it("creates a connection, starts a session, and finalises agent defaults on success", async () => {
    configureLoginSessions(persistingRuntime(async () => oauthCredential()));
    await withServer(async ({ root, base }) => {
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connectionId: string; session: { status: string } };
      expect(body.connectionId).toBeTruthy();
      expect(body.session.status).toBe("pending");
      for (let i = 0; i < 80; i++) {
        const status = (await fetch(`${base}/api/connections/${body.connectionId}/login`).then((r) => r.json())) as {
          status: string;
        };
        const settings = await readApplicationSettings(root);
        if (status.status === "succeeded" && settings.data.agent?.connectionId === body.connectionId) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const settings = await readApplicationSettings(root);
      expect(settings.data.connections).toHaveLength(1);
      expect(settings.data.agent?.connectionId).toBe(body.connectionId);
      expect(settings.data.agent?.modelId).toBe("claude-sonnet-4-5");
    });
  });

  it.each([
    { scoringProvider: "typesafe", expectedModel: "jev-latest" },
    { scoringProvider: "openrouter", expectedModel: "typesafe/jev-1.13" },
  ])(
    "adopts a detected $scoringProvider key and applies Jev defaults after detected Claude sign-in",
    async ({ scoringProvider, expectedModel }) => {
      configureLoginSessions(persistingRuntime(async () => oauthCredential()));
      await withServer(async ({ root, base }) => {
        const fakeHome = path.join(root, "fake-home");
        await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
        await fs.writeFile(
          path.join(fakeHome, ".claude/.credentials.json"),
          JSON.stringify({ claudeAiOauth: { refreshToken: "FIXTURE-SECRET-do-not-leak-refresh" } }),
        );
        await fs.mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
        await fs.writeFile(
          path.join(fakeHome, ".pi/agent/auth.json"),
          JSON.stringify({
            [scoringProvider]: { type: "api_key", key: "FIXTURE-SECRET-do-not-leak" },
          }),
        );

        const response = await fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", detectionId: "claude-code:anthropic" }),
        });
        expect(response.status).toBe(200);
        const { connectionId } = (await response.json()) as { connectionId: string };

        for (let i = 0; i < 80; i += 1) {
          const status = await fetch(`${base}/api/connections/${connectionId}/login`)
            .then((result) => result.json() as Promise<{ status: string }>);
          if (status.status === "succeeded") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const settings = (await readApplicationSettings(root)).data;
        expect(settings.connections).toHaveLength(2);
        expect(settings.connections.map((connection) => connection.provider).sort()).toEqual(
          ["anthropic", scoringProvider].sort(),
        );
        expect(settings.agent?.connectionId).toBe(connectionId);
        const scoringConnection = settings.connections.find(
          (connection) => connection.id === settings.scoring?.connectionId,
        );
        expect(scoringConnection?.provider).toBe(scoringProvider);
        expect(settings.scoring?.modelId).toBe(expectedModel);
      });
    },
  );

  it("reuses the same credential-less connection on retry", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          throw new Error("pre-persist fail");
        },
        checkAuth: async () => undefined,
      }),
    });
    await withServer(async ({ base }) => {
      const first = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      const firstBody = (await first.json()) as { connectionId: string };
      await new Promise((r) => setTimeout(r, 30));
      const second = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      const secondBody = (await second.json()) as { connectionId: string };
      expect(secondBody.connectionId).toBe(firstBody.connectionId);
    });
  });

  it("creates a new connection instead of reusing an environment-credentialed connection", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          throw new Error("pre-persist fail");
        },
        checkAuth: async () => undefined,
      }),
    });
    const existingId = "123e4567-e89b-12d3-a456-426614174201";
    await withServer(async ({ root, base }) => {
      const current = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...current.data,
          connections: [{ id: existingId, label: "Anthropic from env", provider: "anthropic" }],
        },
        current.revision,
      );

      const response = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { connectionId: string };
      expect(body.connectionId).not.toBe(existingId);

      const settings = await readApplicationSettings(root);
      expect(settings.data.connections).toHaveLength(2);
      expect(settings.data.connections.find((connection) => connection.id === existingId)).toMatchObject({
        id: existingId,
        label: "Anthropic from env",
        provider: "anthropic",
      });
      const listed = (await fetch(`${base}/api/connections`).then((result) => result.json())) as {
        data: { connections: Array<{ id: string; credential: { configured: boolean; source: string } }> };
      };
      expect(listed.data.connections.find((connection) => connection.id === existingId)?.credential).toEqual({
        configured: true,
        source: "environment",
      });
      expect((await readAuth(root))[providerAlias(existingId)]).toBeUndefined();
    }, { env: { ANTHROPIC_API_KEY: "FIXTURE-SECRET-do-not-leak" } });
  });

  it("persists origin when detectionId is supplied", async () => {
    configureLoginSessions(persistingRuntime(async () => oauthCredential()));
    await withServer(async ({ root, base }) => {
      const fakeHome = path.join(root, "fake-home");
      await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".claude/.credentials.json"),
        JSON.stringify({ claudeAiOauth: { refreshToken: "FIXTURE-SECRET-do-not-leak-refresh" } }),
      );
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", detectionId: "claude-code:anthropic" }),
      });
      const body = (await res.json()) as { connectionId: string; session: { status: string } };
      expect(body.session.status).toBe("pending");
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((c) => c.id === body.connectionId);
      expect(connection?.origin).toEqual({ kind: "claude-code" });
      expect(connection?.label).toBe("Claude Pro/Max");
    });
  });

  it("rejects adopt-only detections as provider sign-in origins", async () => {
    await withServer(async ({ root, base }) => {
      const piDir = path.join(root, "fake-home", ".pi", "agent");
      await fs.mkdir(piDir, { recursive: true });
      await fs.writeFile(
        path.join(piDir, "auth.json"),
        JSON.stringify({ anthropic: { type: "api_key", key: "FIXTURE-SECRET-do-not-leak" } }),
      );
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", detectionId: "pi-auth:anthropic" }),
      });
      expect(res.status).toBe(422);
      expect((await readApplicationSettings(root)).data.connections).toHaveLength(0);
    });
  });

  it("creates distinct connections for two detected accounts of one provider", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) =>
          new Promise<Credential>((_resolve, reject) => {
            interaction.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
        checkAuth: async () => undefined,
      }),
    });
    await withServer(async ({ root, base }) => {
      const fakeHome = path.join(root, "fake-home");
      await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".claude/.credentials.json"),
        JSON.stringify({ claudeAiOauth: { refreshToken: "FIXTURE-SECRET-do-not-leak-refresh" } }),
      );
      await fs.mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".pi/agent/auth.json"),
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "FIXTURE-SECRET-do-not-leak-access",
            refresh: "FIXTURE-SECRET-do-not-leak-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      );
      const login = async (detectionId: string) => {
        const response = await fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", detectionId }),
        });
        expect(response.status).toBe(200);
        return response.json() as Promise<{ connectionId: string }>;
      };

      const claude = await login("claude-code:anthropic");
      const pi = await login("pi-auth:anthropic");

      expect(pi.connectionId).not.toBe(claude.connectionId);
      const anthropic = (await readApplicationSettings(root)).data.connections.filter(
        (connection) => connection.provider === "anthropic",
      );
      expect(anthropic).toHaveLength(2);
      expect(anthropic.map((connection) => connection.origin?.kind).sort()).toEqual(["claude-code", "pi-auth"]);
      expect(new Set(anthropic.map((connection) => connection.label)).size).toBe(2);
    });
  });

  it("labels two detected GitHub accounts distinctly", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) =>
          new Promise<Credential>((_resolve, reject) => {
            interaction.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
        checkAuth: async () => undefined,
      }),
    });
    await withServer(async ({ root, base }) => {
      const hosts = path.join(root, "fake-home", ".config", "gh", "hosts.yml");
      await fs.mkdir(path.dirname(hosts), { recursive: true });
      const login = async (account: string) => {
        await fs.writeFile(hosts, `github.com:\n  user: ${account}\n`);
        const response = await fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "github-copilot",
            detectionId: `github-cli:github-copilot:${account}`,
          }),
        });
        expect(response.status).toBe(200);
      };

      await login("octo-one");
      await login("octo-two");

      const github = (await readApplicationSettings(root)).data.connections.filter(
        (connection) => connection.provider === "github-copilot",
      );
      expect(github.map((connection) => connection.label).sort()).toEqual([
        "GitHub Copilot · octo-one",
        "GitHub Copilot · octo-two",
      ]);
    }, { ghProbe: async () => ({ exitCode: 0 }) });
  });

  it("labels two detected Cursor accounts distinctly", async () => {
    configureLoginSessions({
      loadCursorSdk: async () => ({
        Cursor: {
          auth: {
            login: async (options) => {
              options.onLoginUrl?.("https://cursor.com/login?challenge=fixture");
              return new Promise((_resolve, reject) => {
                options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
              });
            },
          },
        },
        FileCredentialStore: class {
          async load() { return undefined; }
        },
      }),
    });
    await withServer(async ({ root, base }) => {
      const store = path.join(root, "fake-home", ".cursor", "sdk", "auth.json");
      await fs.mkdir(path.dirname(store), { recursive: true });
      const login = async (account: string) => {
        await fs.writeFile(store, JSON.stringify({
          version: 1,
          apiKey: `FIXTURE-SECRET-do-not-leak-${account}`,
          backendUrl: "https://api2.cursor.sh",
          email: account,
          apiKeyExpiresAtMs: Date.now() - 60_000,
          // the real @cursor/sdk store rejects files without createdAtMs
          createdAtMs: Date.now(),
        }));
        const response = await fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "cursor",
            detectionId: `cursor-sdk:cursor:${account}`,
          }),
        });
        expect(response.status).toBe(200);
      };

      await login("first@example.com");
      await login("second@example.com");

      const cursor = (await readApplicationSettings(root)).data.connections.filter(
        (connection) => connection.provider === "cursor",
      );
      expect(cursor.map((connection) => connection.label).sort()).toEqual([
        "Cursor · first@example.com",
        "Cursor · second@example.com",
      ]);
    });
  });

  it("starts expired-Cursor sign-in with a 72-character email and a unique bounded label", async () => {
    const email = `${"a".repeat(60)}@example.com`;
    expect(email).toHaveLength(72);
    configureLoginSessions({
      loadCursorSdk: async () => ({
        Cursor: {
          auth: {
            login: async (options) => {
              options.onLoginUrl?.("https://cursor.com/login?challenge=long-account");
              return new Promise((_resolve, reject) => {
                options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
              });
            },
          },
        },
        FileCredentialStore: class {
          async load() { return undefined; }
        },
      }),
    });
    await withServer(async ({ root, base }) => {
      const store = path.join(root, "fake-home", ".cursor", "sdk", "auth.json");
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(store, JSON.stringify({
        version: 1,
        apiKey: "FIXTURE-SECRET-do-not-leak",
        backendUrl: "https://api2.cursor.sh",
        email,
        apiKeyExpiresAtMs: Date.now() - 60_000,
        createdAtMs: Date.now(),
      }));
      const current = await readApplicationSettings(root);
      const collidingLabel = `Cursor · ${email.slice(0, 67)}`;
      await writeApplicationSettings(
        root,
        {
          ...current.data,
          connections: [{
            id: "123e4567-e89b-12d3-a456-426614174299",
            label: collidingLabel,
            provider: "openai",
          }],
        },
        current.revision,
      );

      const response = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "cursor",
          detectionId: `cursor-sdk:cursor:${email}`,
        }),
      });
      const body = await response.json() as {
        connectionId?: string;
        error?: { code?: string };
      };
      expect(response.status).toBe(200);
      expect(body.error?.code).not.toBe("INTERNAL_ERROR");
      const connections = (await readApplicationSettings(root)).data.connections;
      const created = connections.find((connection) => connection.id === body.connectionId);
      expect(created?.origin).toEqual({ kind: "cursor-sdk", account: email });
      expect(created?.label.length).toBeLessThanOrEqual(80);
      expect(created?.label).toBe(`${collidingLabel} 2`);
      expect(new Set(connections.map((connection) => connection.label.toLowerCase())).size).toBe(connections.length);
    });
  });

  it("reuses provider-login connections by collision-resistant long-account origins", async () => {
    const prefix = "q".repeat(200);
    const firstAccount = `${prefix}-first@example.com`;
    const secondAccount = `${prefix}-second@example.com`;
    const expectedOrigin = (account: string) =>
      `${account.slice(0, 150)}#${createHash("sha256").update(account).digest("hex").slice(0, 12)}`;
    configureLoginSessions({
      loadCursorSdk: async () => ({
        Cursor: {
          auth: {
            login: async (options) => {
              options.onLoginUrl?.("https://cursor.com/login?challenge=collision-resistant-origin");
              return new Promise((_resolve, reject) => {
                options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
              });
            },
          },
        },
        FileCredentialStore: class {
          async load() { return undefined; }
        },
      }),
    });

    await withServer(async ({ root, base }) => {
      const storePath = path.join(root, "fake-home", ".cursor", "sdk", "auth.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const loginPair = async (account: string) => {
        await fs.writeFile(storePath, JSON.stringify({
          version: 1,
          apiKey: `FIXTURE-SECRET-do-not-leak-${account.slice(-24)}`,
          backendUrl: "https://api2.cursor.sh",
          email: account,
          apiKeyExpiresAtMs: Date.now() - 60_000,
          createdAtMs: Date.now(),
        }));
        const request = () => fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "cursor",
            detectionId: `cursor-sdk:cursor:${account}`,
          }),
        });
        const responses = await Promise.all([request(), request()]);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        return Promise.all(responses.map(async (response) =>
          ((await response.json()) as { connectionId: string }).connectionId));
      };

      const firstIds = await loginPair(firstAccount);
      const secondIds = await loginPair(secondAccount);
      expect(new Set(firstIds).size).toBe(1);
      expect(new Set(secondIds).size).toBe(1);
      expect(secondIds[0]).not.toBe(firstIds[0]);

      const cursor = (await readApplicationSettings(root)).data.connections.filter(
        (connection) => connection.provider === "cursor",
      );
      expect(cursor).toHaveLength(2);
      expect(new Set(cursor.map((connection) => connection.origin?.account))).toEqual(new Set([
        expectedOrigin(firstAccount),
        expectedOrigin(secondAccount),
      ]));
      expect(cursor.every((connection) => connection.label.length <= 80)).toBe(true);
    });
  });

  it("serializes concurrent detection-origin logins onto one connection", async () => {
    configureLoginSessions(
      persistingRuntime(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return oauthCredential();
      }),
    );
    await withServer(async ({ root, base }) => {
      const fakeHome = path.join(root, "fake-home");
      await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".claude/.credentials.json"),
        JSON.stringify({ claudeAiOauth: { refreshToken: "FIXTURE-SECRET-do-not-leak-refresh" } }),
      );
      const request = () =>
        fetch(`${base}/api/providers/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", detectionId: "claude-code:anthropic" }),
        });

      const [first, second] = await Promise.all([request(), request()]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { connectionId: string };
      const secondBody = (await second.json()) as { connectionId: string };
      expect(secondBody.connectionId).toBe(firstBody.connectionId);
      const settings = await readApplicationSettings(root);
      const detected = settings.data.connections.filter(
        (connection) =>
          connection.provider === "anthropic" && connection.origin?.kind === "claude-code",
      );
      expect(detected).toHaveLength(1);
    });
  });

  it("validates an injected connection reservation atomically before starting its provider flow", async () => {
    const reusableId = "123e4567-e89b-12d3-a456-426614174202";
    let resolved!: (connectionId: string) => void;
    const connectionResolved = new Promise<string>((resolve) => { resolved = resolve; });
    let releaseReservation!: () => void;
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve; });
    let runtimeStarts = 0;

    configureLoginSessions({
      createRuntime: async () => {
        runtimeStarts += 1;
        return {
          login: async () => oauthCredential(),
          checkAuth: async () => undefined,
        };
      },
    });
    await withServer(async ({ root, base }) => {
      const initial = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...initial.data,
          connections: [{ id: reusableId, label: "Reusable Claude", provider: "anthropic" }],
        },
        initial.revision,
      );

      const request = startLogin(root, undefined, fixtureHost(root), {
        expectedProvider: "anthropic",
        reserve: async () => {
          resolved(reusableId);
          await reservationReleased;
          return reusableId;
        },
      });
      expect(await connectionResolved).toBe(reusableId);

      const current = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...current.data,
          connections: current.data.connections.map((connection) =>
            connection.id === reusableId ? { ...connection, provider: "openai" } : connection),
        },
        current.revision,
      );
      releaseReservation();

      await expect(request).rejects.toMatchObject({ code: "CONFIG_INVALID", status: 409 });
      expect(runtimeStarts).toBe(0);
      const login = await fetch(`${base}/api/connections/${reusableId}/login`).then((result) => result.json());
      expect(login).toEqual({ status: "interrupted" });
    });
  });

  it("returns 422 for unknown detectionId", async () => {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", detectionId: "claude-code:anthropic" }),
      });
      expect(res.status).toBe(422);
    });
  });

  it("returns 422 for enterpriseDomain on non-copilot providers", async () => {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enterpriseDomain: "corp.example" }),
      });
      expect(res.status).toBe(422);
    });
  });

  it("rejects providers without browser auth before creating a connection", async () => {
    await withServer(async ({ root, base }) => {
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      expect(res.status).toBe(422);
      expect((await readApplicationSettings(root)).data.connections).toHaveLength(0);
    });
  });

  it("suffixes colliding labels", async () => {
    configureLoginSessions(persistingRuntime(async () => oauthCredential()));
    await withServer(async ({ root, base }) => {
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [{ id: "123e4567-e89b-12d3-a456-426614174001", label: "Claude Pro/Max", provider: "openai" }],
          agent: null,
          scoring: null,
          captcha: { provider: "off", api_key: "" },
        }),
      );
      const res = await fetch(`${base}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      expect(res.status).toBe(200);
      const settings = await readApplicationSettings(root);
      const anthropic = settings.data.connections.filter((c) => c.provider === "anthropic");
      expect(anthropic[0]?.label).toBe("Claude Pro/Max 2");
    });
  });
});
