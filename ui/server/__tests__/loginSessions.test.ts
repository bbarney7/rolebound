import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import {
  configureLoginSessions,
  drainLoginSessions,
  isLoginActive,
  persistCursorLogin,
  resetLoginSessions,
  type CursorSdkAuthModule,
  type LoginRuntimeFactory,
} from "../providers/loginSessions";
import { CURSOR_PRODUCTION_BACKEND } from "../providers/cursorReadiness";
import type { ProviderHostDeps } from "../providers/hostDeps";
import {
  createConnection,
  listConnections,
  providerPaths,
  resolveCredential,
  setConnectionCredential,
  setModelRuntimeFactoryForTests,
} from "../providers/providerService";
import { ConnectionCredentialStore } from "../providers/connectionCredentialStore";
import { providerAlias } from "../providers/providerIds";
import { loginLeasesPath, readAuth, renewConnectionCredentialOwnership } from "../providers/authStoreFile";
import { finalizeDetectedLoginDefaults } from "../providers/adoptDetection";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { readApplicationSettings, writeApplicationSettings } from "../applicationConfigStore";

const CURSOR_ID = "123e4567-e89b-12d3-a456-426614174099";

async function seedCursorConnection(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      connections: [{ id: CURSOR_ID, label: "Cursor", provider: "cursor" }],
      agent: null,
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    }),
  );
}

function fixtureHost(root: string): ProviderHostDeps {
  return {
    home: path.join(root, "fake-home"),
    env: {},
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
}

async function withApp(run: (ctx: { root: string; base: string; host: ProviderHostDeps }) => Promise<void>): Promise<void> {
  const root = await makeFixtureWorkspace();
  await seedCursorConnection(root);
  const host = fixtureHost(root);
  await fs.mkdir(host.home, { recursive: true });
  const app = createApp(root, { security: { enabled: false }, providerHost: host });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run({ root, base: `http://127.0.0.1:${port}`, host });
  } finally {
    await drainLoginSessions();
    resetLoginSessions();
    await new Promise((resolve) => server.close(resolve));
    await rmFixtureWorkspace(root);
  }
}

async function updateApiKey(
  root: string,
  base: string,
  connectionId: string,
  apiKey: string | null,
): Promise<Response> {
  const current = await readApplicationSettings(root);
  return fetch(`${base}/api/connections/${connectionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: current.revision, apiKey }),
  });
}

async function waitForLoginStatus(base: string, connectionId: string, expected: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const result = await fetch(`${base}/api/connections/${connectionId}/login`);
    const body = await result.json() as { status: string };
    if (body.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`login did not reach ${expected}`);
}

class MockAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

function buildMockSdk(handlers: {
  login?: (options: {
    apiKeyName?: string;
    backendUrl?: string;
    websiteUrl?: string;
    openBrowser?: boolean | ((url: string) => void | Promise<void>);
    store?: null;
    signal?: AbortSignal;
    onLoginUrl?: (url: string) => void;
  }) => Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
  load?: () => Promise<
    | {
        apiKey: string;
        backendUrl: string;
        apiKeyExpiresAtMs?: number;
        email?: string;
      }
    | undefined
  >;
}): CursorSdkAuthModule {
  return {
    Cursor: {
      auth: {
        login: handlers.login ?? (async () => ({ apiKey: "unused", apiKeyExpiresAtMs: Date.now() + 1000 })),
      },
    },
    FileCredentialStore: class {
      load() {
        return handlers.load?.() ?? Promise.resolve(undefined);
      }
    },
    AuthenticationError: MockAuthenticationError,
  };
}

afterEach(async () => {
  await drainLoginSessions();
  configureLoginSessions(null);
  setModelRuntimeFactoryForTests(undefined);
  resetLoginSessions();
});

describe("connection login routes (cursor)", () => {
  it("stores the key and metadata on success without echoing the key", async () => {
    const secretKey = "cursor-secret-key-do-not-leak";
    const loginUrl = "https://cursor.com/login?challenge=one-time-challenge-value";
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            expect(options.apiKeyName).toBe("Rolebound");
            expect(options.backendUrl).toBe("https://api2.cursor.sh");
            expect(options.websiteUrl).toBe("https://cursor.com");
            expect(options.store).toBeNull();
            expect(options.openBrowser).toBe(false);
            options.onLoginUrl?.(loginUrl);
            await new Promise((r) => setTimeout(r, 5));
            return {
              apiKey: secretKey,
              email: "dev@example.com",
              apiKeyExpiresAtMs: 1_900_000_000_000,
            };
          },
        }),
    });

    await withApp(async ({ root, base }) => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });
      const post = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(post.status).toBe(200);
      const body = (await post.json()) as { authUrl?: string; status: string };
      expect(body.status).toBe("pending");
      expect(body.authUrl).toBe(loginUrl);
      expect(JSON.stringify(body)).not.toContain(secretKey);

      for (let i = 0; i < 80; i++) {
        const status = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // The settled outcome stays visible to later polls (the UI polls after the login ends).
      await new Promise((r) => setTimeout(r, 20));
      const settledStatus = (await (await fetch(`${base}/api/connections/${CURSOR_ID}/login`)).json()) as { status: string };
      expect(settledStatus.status).toBe("succeeded");
      let leases: unknown = null;
      for (let i = 0; i < 40; i += 1) {
        leases = JSON.parse(await fs.readFile(loginLeasesPath(root), "utf8"));
        if (Array.isArray(leases) && leases.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(leases).toEqual([]);

      const stored = await resolveCredential(root, {
        id: CURSOR_ID,
        label: "Cursor",
        provider: "cursor",
      });
      expect(stored.apiKey).toBe(secretKey);
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((c) => c.id === CURSOR_ID);
      expect(connection?.email).toBe("dev@example.com");
      expect(connection?.expiresAt).toBe(new Date(1_900_000_000_000).toISOString());
      const authText = await fs.readFile(providerPaths.authPath(root), "utf8");
      expect(authText).toContain(secretKey);
      expect(logs.join("\n")).not.toContain(secretKey);
      expect(logs.join("\n")).not.toContain("one-time-challenge-value");
      logSpy.mockRestore();
    });
  });

  it("bounds provider-returned Cursor login metadata", async () => {
    const email = `${"a".repeat(238)}@example.com`;
    expect(email).toHaveLength(250);
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            options.onLoginUrl?.("https://cursor.com/login?challenge=bounded-metadata");
            return {
              apiKey: "FIXTURE-SECRET-do-not-leak-cursor-signin",
              email,
              apiKeyExpiresAtMs: 1_900_000_000_000,
            };
          },
        }),
    });

    await withApp(async ({ root, base }) => {
      const started = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(started.status).toBe(200);
      await waitForLoginStatus(base, CURSOR_ID, "succeeded");

      const connection = (await readApplicationSettings(root)).data.connections.find(
        (candidate) => candidate.id === CURSOR_ID,
      );
      expect(connection?.email).toBe(email.slice(0, 200));
      expect(connection?.email?.length).toBeLessThanOrEqual(200);
      expect(connection?.label.length).toBeLessThanOrEqual(80);
    });
  });

  it("succeeds without an email", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            options.onLoginUrl?.("https://cursor.com/login?challenge=abc");
            return { apiKey: "key-no-email", apiKeyExpiresAtMs: 1_900_000_000_000 };
          },
        }),
    });
    await withApp(async ({ root, base }) => {
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      for (let i = 0; i < 30; i++) {
        const { status } = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((c) => c.id === CURSOR_ID);
      expect(connection?.email).toBeUndefined();
      expect(connection?.expiresAt).toBeTruthy();
    });
  });

  it("cancels through DELETE by aborting the signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            capturedSignal = options.signal;
            options.onLoginUrl?.("https://cursor.com/login?challenge=cancel-me");
            await new Promise((_, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(new MockAuthenticationError("Login was cancelled."));
              });
            });
            return { apiKey: "never", apiKeyExpiresAtMs: Date.now() + 1000 };
          },
        }),
    });
    await withApp(async ({ base }) => {
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(capturedSignal).toBeDefined();
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "DELETE" });
      for (let i = 0; i < 30; i++) {
        const { status } = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status === "cancelled") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const final = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
        status: string;
      };
      expect(final.status).toBe("cancelled");
    });
  });

  it("settles failed with the lease error when a Cursor login loses its lease", async () => {
    configureLoginSessions({
      leaseHeartbeatMs: 5,
      renewOwnership: async () => { throw new Error("simulated Cursor lease renewal failure"); },
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            options.onLoginUrl?.("https://cursor.com/login?challenge=lease-loss");
            await new Promise<void>((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => reject(new MockAuthenticationError("Login was cancelled.")),
                { once: true },
              );
            });
            return { apiKey: "never", apiKeyExpiresAtMs: Date.now() + 60_000 };
          },
        }),
    });
    await withApp(async ({ root, base }) => {
      const started = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(started.status).toBe(200);
      await waitForLoginStatus(base, CURSOR_ID, "failed");
      for (let i = 0; i < 80 && isLoginActive(root, CURSOR_ID); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isLoginActive(root, CURSOR_ID)).toBe(false);
      const settled = await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((response) => response.json()) as {
        status: string;
        error?: { code: string; message: string };
      };
      expect(settled).toMatchObject({
        status: "failed",
        error: { code: "LEASE_LOST" },
      });
      expect(settled.error?.message).toContain("Sign-in lease was lost");
      expect(settled.error?.message).toContain("simulated Cursor lease renewal failure");
    });
  });

  it("keeps a pending login alive across real lease renewals (heartbeat runs outside the store lock)", async () => {
    // Regression: the heartbeat timer used to be created inside the
    // provider-store lock, so every real renewal saw the lock as nested and
    // the session failed with LEASE_LOST at the first beat.
    configureLoginSessions({
      leaseHeartbeatMs: 5,
      renewOwnership: renewConnectionCredentialOwnership,
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            options.onLoginUrl?.("https://cursor.com/login?challenge=real-renewal");
            await new Promise<void>((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => reject(new MockAuthenticationError("Login was cancelled.")),
                { once: true },
              );
            });
            return { apiKey: "never", apiKeyExpiresAtMs: Date.now() + 60_000 };
          },
        }),
    });
    await withApp(async ({ base }) => {
      const started = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(started.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const view = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
        status: string;
        error?: { code: string; message: string };
      };
      expect(view.error).toBeUndefined();
      expect(view.status).toBe("pending");
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "DELETE" });
      await waitForLoginStatus(base, CURSOR_ID, "cancelled");
    });
  });

  it("returns failed when login rejects before a URL is issued", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async () => {
            throw new Error("Login failed or timed out. Please try again.");
          },
        }),
    });
    await withApp(async ({ base }) => {
      const res = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("failed");
    });
  });

  it("returns authUrl with openBrowser disabled for the UI popup", async () => {
    let seenOpenBrowser: unknown;
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            seenOpenBrowser = options.openBrowser;
            options.onLoginUrl?.("https://cursor.com/login?challenge=noop-browser");
            await new Promise((r) => setTimeout(r, 100));
            return { apiKey: "k", apiKeyExpiresAtMs: Date.now() + 60_000 };
          },
        }),
    });
    await withApp(async ({ base }) => {
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(seenOpenBrowser).toBe(false);
      let authUrl: string | undefined;
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
          authUrl?: string;
        };
        authUrl = body.authUrl;
        if (authUrl) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(authUrl).toBe("https://cursor.com/login?challenge=noop-browser");
    });
  });

  it("refuses a second concurrent login with 409", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          login: async (options) => {
            options.onLoginUrl?.("https://cursor.com/login?challenge=busy");
            await new Promise((r) => setTimeout(r, 200));
            return { apiKey: "k", apiKeyExpiresAtMs: Date.now() + 60_000 };
          },
        }),
    });
    await withApp(async ({ base }) => {
      const first = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(second.status).toBe(409);
    });
  });

  it("rejects provider edits during Cursor login and fails safely if a racing edit already won", async () => {
    let releaseLogin!: (value: { apiKey: string; apiKeyExpiresAtMs: number }) => void;
    const loginResult = new Promise<{ apiKey: string; apiKeyExpiresAtMs: number }>((resolve) => {
      releaseLogin = resolve;
    });
    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({
        login: async (options) => {
          options.onLoginUrl?.("https://cursor.com/login?challenge=provider-race");
          return loginResult;
        },
      }),
    });

    await withApp(async ({ root, base }) => {
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      const before = await readApplicationSettings(root);
      const blocked = await fetch(`${base}/api/connections/${CURSOR_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: before.revision,
          provider: "openai",
          apiKey: null,
        }),
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      const racing = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...racing.data,
          connections: racing.data.connections.map((connection) =>
            connection.id === CURSOR_ID ? { ...connection, provider: "openai" } : connection),
        },
        racing.revision,
      );
      releaseLogin({ apiKey: "FIXTURE-SECRET-do-not-leak-cursor-old-provider", apiKeyExpiresAtMs: Date.now() + 60_000 });

      let final: { status: string } = { status: "pending" };
      for (let i = 0; i < 80 && final.status === "pending"; i += 1) {
        final = await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((response) => response.json());
        if (final.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final.status).toBe("failed");
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toBeUndefined();
    });
  });

  it.each([
    { mutation: "clear", apiKey: null },
    { mutation: "replace", apiKey: "FIXTURE-SECRET-do-not-leak-user-cursor" },
  ])("rejects Cursor credential $mutation both before and after login persistence", async ({ apiKey }) => {
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => { releaseLogin = resolve; });
    let persistenceFinished!: () => void;
    const persisted = new Promise<void>((resolve) => { persistenceFinished = resolve; });
    let releaseFinalize!: () => void;
    const finalizeReleased = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const loginKey = "FIXTURE-SECRET-do-not-leak-browser-session";

    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({
        login: async (options) => {
          options.onLoginUrl?.("https://cursor.com/login?challenge=credential-owner");
          loginStarted();
          await loginReleased;
          return { apiKey: loginKey, apiKeyExpiresAtMs: 1_900_000_000_000 };
        },
      }),
      finalizeDefaults: async (...args) => {
        persistenceFinished();
        await finalizeReleased;
        return finalizeDetectedLoginDefaults(...args);
      },
    });

    await withApp(async ({ root, base }) => {
      const start = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(start.status).toBe(200);
      await started;

      const beforePersistence = await updateApiKey(root, base, CURSOR_ID, apiKey);
      expect(beforePersistence.status).toBe(409);
      expect(await beforePersistence.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });
      await expect(setConnectionCredential(root, CURSOR_ID, apiKey)).rejects.toMatchObject({
        code: "LOGIN_IN_PROGRESS",
        status: 409,
      });

      releaseLogin();
      await persisted;
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toEqual({ type: "api_key", key: loginKey });

      const afterPersistence = await updateApiKey(root, base, CURSOR_ID, apiKey);
      expect(afterPersistence.status).toBe(409);
      expect(await afterPersistence.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });
      const current = await readApplicationSettings(root);
      const remove = await fetch(`${base}/api/connections/${CURSOR_ID}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: current.revision }),
      });
      expect(remove.status).toBe(409);
      expect(await remove.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      releaseFinalize();
      await waitForLoginStatus(base, CURSOR_ID, "succeeded");
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toEqual({ type: "api_key", key: loginKey });
    });
  });

  it("reserves the session before a slow SDK load so only one login starts", async () => {
    let capturedSignal: AbortSignal | undefined;
    configureLoginSessions({
      loadCursorSdk: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return buildMockSdk({
          login: async (options) => {
            capturedSignal = options.signal;
            options.onLoginUrl?.("https://cursor.com/login?challenge=slow-sdk");
            await new Promise<void>((_, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  reject(new MockAuthenticationError("Login was cancelled."));
                },
                { once: true },
              );
            });
            return { apiKey: "slow-key", apiKeyExpiresAtMs: Date.now() + 60_000 };
          },
        });
      },
    });
    await withApp(async ({ base }) => {
      const first = fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 20));
      const second = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(second.status).toBe(409);
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect(capturedSignal).toBeDefined();
      const status = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
        status: string;
        authUrl?: string;
      };
      expect(status.status).toBe("pending");
      expect(status.authUrl).toContain("slow-sdk");
      await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "DELETE" });
      for (let i = 0; i < 30; i++) {
        const final = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (final.status === "cancelled") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const cancelled = (await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((r) => r.json())) as {
        status: string;
      };
      expect(cancelled.status).toBe("cancelled");
    });
  });
});

describe("persistCursorLogin", () => {
  it("persists key and metadata atomically and retries once on revision conflict", async () => {
    const root = await makeFixtureWorkspace();
    try {
      await seedCursorConnection(root);
      await setConnectionCredential(root, CURSOR_ID, "old-key");
      const before = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...before.data,
          connections: before.data.connections.map((c) =>
            c.id === CURSOR_ID
              ? { ...c, email: "old@example.com", expiresAt: "2020-01-01T00:00:00.000Z", cursorBackendUrl: "https://old.backend" }
              : c,
          ),
        },
        before.revision,
      );

      let readCount = 0;
      const originalRead = readApplicationSettings;
      const readSpy = vi.spyOn(await import("../applicationConfigStore"), "readApplicationSettings").mockImplementation(async (r) => {
        const envelope = await originalRead(r);
        readCount += 1;
        if (readCount === 1 && r === root) {
          const bumped = await originalRead(root);
          await writeApplicationSettings(
            root,
            { ...bumped.data, connections: bumped.data.connections.map((c) => (c.id === CURSOR_ID ? { ...c, label: "Cursor bumped" } : c)) },
            bumped.revision,
          );
        }
        return envelope;
      });

      await persistCursorLogin(
        root,
        CURSOR_ID,
        { apiKey: "new-key", email: "new@example.com", apiKeyExpiresAtMs: 1_900_000_000_000 },
        "https://api2.cursor.sh",
      );
      readSpy.mockRestore();

      const stored = await resolveCredential(root, { id: CURSOR_ID, label: "Cursor", provider: "cursor" });
      expect(stored.apiKey).toBe("new-key");
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((c) => c.id === CURSOR_ID);
      expect(connection?.email).toBe("new@example.com");
      expect(connection?.expiresAt).toBe(new Date(1_900_000_000_000).toISOString());
      expect(connection?.label).toBe("Cursor bumped");
    } finally {
      await rmFixtureWorkspace(root);
    }
  });
});

describe("cursor import via login", () => {
  it("imports a logged-in Cursor session", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          load: async () => ({
            apiKey: "imported-key",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            email: "import@example.com",
            apiKeyExpiresAtMs: 1_900_000_000_000,
          }),
        }),
    });
    await withApp(async ({ root, base }) => {
      const res = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings).toEqual([]);
      const stored = await resolveCredential(root, { id: CURSOR_ID, label: "Cursor", provider: "cursor" });
      expect(stored.apiKey).toBe("imported-key");
    });
  });

  it("bounds provider-returned Cursor import metadata", async () => {
    const email = `${"b".repeat(238)}@example.com`;
    expect(email).toHaveLength(250);
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          load: async () => ({
            apiKey: "FIXTURE-SECRET-do-not-leak-cursor-existing",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            email,
            apiKeyExpiresAtMs: 1_900_000_000_000,
          }),
        }),
    });

    await withApp(async ({ root, base }) => {
      const response = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
      const connection = (await readApplicationSettings(root)).data.connections.find(
        (candidate) => candidate.id === CURSOR_ID,
      );
      expect(connection?.email).toBe(email.slice(0, 200));
      expect(connection?.email?.length).toBeLessThanOrEqual(200);
      expect(connection?.label.length).toBeLessThanOrEqual(80);
    });
  });

  it("rejects import while a Cursor login owns the connection credential", async () => {
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const load = vi.fn(async () => ({
      apiKey: "FIXTURE-SECRET-do-not-leak-import",
      backendUrl: CURSOR_PRODUCTION_BACKEND,
      apiKeyExpiresAtMs: Date.now() + 60_000,
    }));
    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({
        login: async (options) => {
          options.onLoginUrl?.("https://cursor.com/login?challenge=import-owner");
          await loginReleased;
          return {
            apiKey: "FIXTURE-SECRET-do-not-leak-login-wins",
            apiKeyExpiresAtMs: Date.now() + 60_000,
          };
        },
        load,
      }),
    });

    await withApp(async ({ root, base }) => {
      const login = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "POST" });
      expect(login.status).toBe(200);

      const imported = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(imported.status).toBe(409);
      expect(await imported.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });
      expect(load).not.toHaveBeenCalled();

      releaseLogin();
      await waitForLoginStatus(base, CURSOR_ID, "succeeded");
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toEqual({
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-login-wins",
      });
    });
  });

  it("cancels a deferred Cursor import, drains its worker, and persists nothing", async () => {
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => { loadStarted = resolve; });
    let releaseLoad!: () => void;
    const released = new Promise<void>((resolve) => { releaseLoad = resolve; });
    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({
        load: async () => {
          loadStarted();
          await released;
          return {
            apiKey: "FIXTURE-SECRET-do-not-leak-cancelled-import",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            email: "cancelled@example.com",
            apiKeyExpiresAtMs: Date.now() + 60_000,
          };
        },
      }),
    });

    await withApp(async ({ root, base }) => {
      const importing = fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      await started;

      let cancellationSettled = false;
      const cancellation = fetch(`${base}/api/connections/${CURSOR_ID}/login`, { method: "DELETE" })
        .then(async (response) => {
          cancellationSettled = true;
          return { response, body: await response.json() as { status: string } };
        });
      await waitForLoginStatus(base, CURSOR_ID, "cancelled");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancellationSettled).toBe(false);

      const overlapping = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(overlapping.status).toBe(409);
      expect(await overlapping.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      releaseLoad();
      const cancelled = await cancellation;
      expect(cancelled.response.status).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");
      expect((await importing).status).toBeGreaterThanOrEqual(400);

      expect(await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((response) => response.json()))
        .toMatchObject({ status: "cancelled", error: { code: "CANCELLED" } });
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toBeUndefined();
      const settings = await readApplicationSettings(root);
      expect(settings.data.connections.find((connection) => connection.id === CURSOR_ID)?.email).toBeUndefined();
      expect(settings.data.agent).toBeNull();
      expect(settings.data.scoring).toBeNull();
    });
  });

  it("keeps LEASE_LOST terminal when a deferred Cursor import resumes and persists nothing", async () => {
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => { loadStarted = resolve; });
    let releaseLoad!: () => void;
    const released = new Promise<void>((resolve) => { releaseLoad = resolve; });
    configureLoginSessions({
      leaseHeartbeatMs: 5,
      renewOwnership: async () => { throw new Error("simulated import lease renewal failure"); },
      loadCursorSdk: async () => buildMockSdk({
        load: async () => {
          loadStarted();
          await released;
          return {
            apiKey: "FIXTURE-SECRET-do-not-leak-lease-lost-import",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            email: "lease-lost@example.com",
            apiKeyExpiresAtMs: Date.now() + 60_000,
          };
        },
      }),
    });

    await withApp(async ({ root, base }) => {
      const importing = fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      await started;
      await waitForLoginStatus(base, CURSOR_ID, "failed");
      const failedWhileBlocked = await fetch(`${base}/api/connections/${CURSOR_ID}/login`)
        .then((response) => response.json()) as { status: string; error?: { code: string; message: string } };
      expect(failedWhileBlocked).toMatchObject({ status: "failed", error: { code: "LEASE_LOST" } });
      expect(failedWhileBlocked.error?.message).toContain("simulated import lease renewal failure");

      releaseLoad();
      expect((await importing).status).toBeGreaterThanOrEqual(400);
      for (let i = 0; i < 80 && isLoginActive(root, CURSOR_ID); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isLoginActive(root, CURSOR_ID)).toBe(false);
      expect(await fetch(`${base}/api/connections/${CURSOR_ID}/login`).then((response) => response.json()))
        .toMatchObject({ status: "failed", error: { code: "LEASE_LOST" } });
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toBeUndefined();
      const settings = await readApplicationSettings(root);
      expect(settings.data.connections.find((connection) => connection.id === CURSOR_ID)?.email).toBeUndefined();
      expect(settings.data.agent).toBeNull();
      expect(settings.data.scoring).toBeNull();
    });
  });

  it("does not retain an imported Cursor key when the provider changes while the store load is pending", async () => {
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => { loadStarted = resolve; });
    let releaseLoad!: () => void;
    const released = new Promise<void>((resolve) => { releaseLoad = resolve; });
    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({
        load: async () => {
          loadStarted();
          await released;
          return {
            apiKey: "FIXTURE-SECRET-do-not-leak-imported-old-provider",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            apiKeyExpiresAtMs: Date.now() + 60_000,
          };
        },
      }),
    });

    await withApp(async ({ root, base }) => {
      const importing = fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      await started;
      const current = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...current.data,
          connections: current.data.connections.map((connection) =>
            connection.id === CURSOR_ID ? { ...connection, provider: "openai" } : connection),
        },
        current.revision,
      );
      releaseLoad();

      const response = await importing;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
      expect((await readAuth(root))[providerAlias(CURSOR_ID)]).toBeUndefined();
    });
  });

  it("rejects when not signed in on this computer", async () => {
    configureLoginSessions({
      loadCursorSdk: async () => buildMockSdk({ load: async () => undefined }),
    });
    await withApp(async ({ base }) => {
      const res = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Not signed in to Cursor on this computer");
    });
  });

  it("rejects expired stored credentials", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          load: async () => ({
            apiKey: "old",
            backendUrl: CURSOR_PRODUCTION_BACKEND,
            apiKeyExpiresAtMs: 1,
          }),
        }),
      now: () => 2,
    });
    await withApp(async ({ base }) => {
      const res = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Your Cursor login expired, sign in again");
    });
  });

  it("imports keys without expiry and warns on non-production backends", async () => {
    configureLoginSessions({
      loadCursorSdk: async () =>
        buildMockSdk({
          load: async () => ({
            apiKey: "staging-key",
            backendUrl: "https://staging.cursor.example/",
          }),
        }),
    });
    await withApp(async ({ root, base }) => {
      const res = await fetch(`${base}/api/connections/${CURSOR_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings[0]).toMatch(/non-production backend/);
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((c) => c.id === CURSOR_ID);
      expect(connection?.cursorBackendUrl).toBe("https://staging.cursor.example");
      expect(connection?.expiresAt).toBeUndefined();
    });
  });
});

const ANTHROPIC_ID = "123e4567-e89b-12d3-a456-426614174100";

async function seedProviderConnection(root: string, id: string, provider: string, label: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      connections: [{ id, label, provider }],
      agent: null,
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    }),
  );
}

async function withOAuthApp(
  provider: string,
  connectionId: string,
  label: string,
  run: (ctx: { root: string; base: string }) => Promise<void>,
): Promise<void> {
  const root = await makeFixtureWorkspace();
  await seedProviderConnection(root, connectionId, provider, label);
  const host = fixtureHost(root);
  const app = createApp(root, { security: { enabled: false }, providerHost: host });
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

describe("oauth login sessions (fake runtime)", () => {
  it("rejects unknown connection login modes with CONFIG_INVALID", async () => {
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      const response = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "imports" }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
      expect(await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((res) => res.json())).toEqual({
        status: "interrupted",
      });
    });
  });

  it("settles failed with the lease error when an OAuth login loses its lease", async () => {
    configureLoginSessions({
      leaseHeartbeatMs: 5,
      renewOwnership: async () => { throw new Error("simulated OAuth lease renewal failure"); },
      createRuntime: async () => ({
        login: async (_provider, _type, interaction) => {
          interaction.notify?.({ type: "auth_url", url: "https://example.com/oauth/lease-loss" });
          await new Promise<void>((_resolve, reject) => {
            interaction.signal?.addEventListener(
              "abort",
              () => reject(new Error("OAuth worker aborted")),
              { once: true },
            );
          });
          return oauthCredential();
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const started = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(started.status).toBe(200);
      await waitForLoginStatus(base, ANTHROPIC_ID, "failed");
      for (let i = 0; i < 80 && isLoginActive(root, ANTHROPIC_ID); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isLoginActive(root, ANTHROPIC_ID)).toBe(false);
      const settled = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json()) as {
        status: string;
        error?: { code: string; message: string };
      };
      expect(settled).toMatchObject({
        status: "failed",
        error: { code: "LEASE_LOST" },
      });
      expect(settled.error?.message).toContain("Sign-in lease was lost");
      expect(settled.error?.message).toContain("simulated OAuth lease renewal failure");
    });
  });

  it("rejects provider edits during OAuth login and rolls back if a racing edit already won", async () => {
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let releaseLogin!: () => void;
    const released = new Promise<void>((resolve) => { releaseLogin = resolve; });
    configureLoginSessions(
      persistingRuntime(async () => {
        loginStarted();
        await released;
        return oauthCredential();
      }),
    );

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await started;
      const before = await readApplicationSettings(root);
      const blocked = await fetch(`${base}/api/connections/${ANTHROPIC_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: before.revision,
          provider: "openai",
          apiKey: null,
        }),
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      const racing = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...racing.data,
          connections: racing.data.connections.map((connection) =>
            connection.id === ANTHROPIC_ID ? { ...connection, provider: "openai" } : connection),
        },
        racing.revision,
      );
      releaseLogin();

      let final: { status: string } = { status: "pending" };
      for (let i = 0; i < 80 && final.status === "pending"; i += 1) {
        final = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json());
        if (final.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final.status).toBe("failed");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
    });
  });

  it.each([
    { mutation: "clear", apiKey: null },
    { mutation: "replace", apiKey: "FIXTURE-SECRET-do-not-leak-user-oauth" },
  ])("rejects OAuth credential $mutation both before and after helper persistence", async ({ apiKey }) => {
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => { releaseLogin = resolve; });
    let helperPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => { helperPersisted = resolve; });
    let releaseCheck!: () => void;
    const checkReleased = new Promise<void>((resolve) => { releaseCheck = resolve; });
    const loginCredential = oauthCredential();

    configureLoginSessions(
      persistingRuntime(
        async () => {
          loginStarted();
          await loginReleased;
          return loginCredential;
        },
        async () => {
          helperPersisted();
          await checkReleased;
          return undefined;
        },
      ),
    );

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const start = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(start.status).toBe(200);
      await started;

      const beforePersistence = await updateApiKey(root, base, ANTHROPIC_ID, apiKey);
      expect(beforePersistence.status).toBe(409);
      expect(await beforePersistence.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      releaseLogin();
      await persisted;
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(loginCredential);

      const afterPersistence = await updateApiKey(root, base, ANTHROPIC_ID, apiKey);
      expect(afterPersistence.status).toBe(409);
      expect(await afterPersistence.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });

      releaseCheck();
      await waitForLoginStatus(base, ANTHROPIC_ID, "succeeded");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(loginCredential);
    });
  });

  it("rejects catalog OAuth refresh during login so the session credential wins", async () => {
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const loginCredential = {
      ...oauthCredential(),
      access: "FIXTURE-SECRET-do-not-leak-login-wins",
      refresh: "FIXTURE-SECRET-do-not-leak-login-refresh",
    };
    let refreshMutationRan = false;

    configureLoginSessions(persistingRuntime(async () => {
      loginStarted();
      await loginReleased;
      return loginCredential;
    }));

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const oldCredential: Credential = {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-old-access",
        refresh: "FIXTURE-SECRET-do-not-leak-old-refresh",
        expires: 1,
      };
      await new ConnectionCredentialStore(root, ANTHROPIC_ID, "anthropic").modify(
        "anthropic",
        async () => oldCredential,
      );
      setModelRuntimeFactoryForTests(async (options) => ({
        getAuth: async () => {
          await options.credentials.modify("anthropic", async () => {
            refreshMutationRan = true;
            return {
              ...oldCredential,
              access: "FIXTURE-SECRET-do-not-leak-refresh-loses",
              expires: 2_000_000_000_000,
            };
          });
          return { auth: { apiKey: "FIXTURE-SECRET-do-not-leak-refresh-loses" } };
        },
      }));

      const login = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(login.status).toBe(200);
      await started;

      const catalog = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/models`);
      expect(catalog.status).toBe(409);
      expect(await catalog.json()).toMatchObject({ error: { code: "LOGIN_IN_PROGRESS" } });
      expect(refreshMutationRan).toBe(false);
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(oldCredential);

      releaseLogin();
      await waitForLoginStatus(base, ANTHROPIC_ID, "succeeded");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(loginCredential);
    });
  });

  it("captures a credential mutation that commits before reservation, then owns later writes", async () => {
    let mutationHasLock!: () => void;
    const mutationLocked = new Promise<void>((resolve) => { mutationHasLock = resolve; });
    let releaseMutation!: () => void;
    const mutationReleased = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let releaseLogin!: () => void;
    const loginReleased = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const committed = { type: "api_key" as const, key: "FIXTURE-SECRET-do-not-leak-preexisting-mutation" };

    configureLoginSessions(persistingRuntime(async () => {
      loginStarted();
      await loginReleased;
      return oauthCredential();
    }));

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const externalStore = new ConnectionCredentialStore(root, ANTHROPIC_ID, "anthropic");
      const mutation = externalStore.modify("anthropic", async () => {
        mutationHasLock();
        await mutationReleased;
        return committed;
      });
      await mutationLocked;

      const login = fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      releaseMutation();
      await mutation;

      const response = await login;
      expect(response.status).toBe(200);
      await started;
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(committed);
      await expect(
        externalStore.modify("anthropic", async () => ({
          type: "api_key",
          key: "FIXTURE-SECRET-do-not-leak-blocked",
        })),
      ).rejects.toMatchObject({ code: "LOGIN_IN_PROGRESS", status: 409 });

      releaseLogin();
      await waitForLoginStatus(base, ANTHROPIC_ID, "succeeded");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(oauthCredential());
    });
  });

  it("rolls back an OAuth credential already written before a provider mismatch is detected", async () => {
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    let releaseCheck!: () => void;
    const released = new Promise<void>((resolve) => { releaseCheck = resolve; });
    configureLoginSessions(
      persistingRuntime(
        async () => oauthCredential(),
        async () => {
          checkStarted();
          await released;
          return undefined;
        },
      ),
    );

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await started;
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]?.type).toBe("oauth");
      const current = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...current.data,
          connections: current.data.connections.map((connection) =>
            connection.id === ANTHROPIC_ID ? { ...connection, provider: "openai" } : connection),
        },
        current.revision,
      );
      releaseCheck();

      let final: { status: string } = { status: "pending" };
      for (let i = 0; i < 80 && final.status === "pending"; i += 1) {
        final = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json());
        if (final.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final.status).toBe("failed");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
    });
  });

  it("settles failed when runtime creation rejects", async () => {
    configureLoginSessions({
      createRuntime: async () => {
        throw new Error("runtime creation failed");
      },
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let body: { status: string; error?: { message: string } } = { status: "pending" };
      for (let i = 0; i < 40 && body.status === "pending"; i += 1) {
        body = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json());
        if (body.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(body.status).toBe("failed");
      expect(body.error?.message).toContain("runtime creation failed");
    });
  });

  it("refuses to start when the initial credential-store read rejects and leaves no stuck session", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => oauthCredential(),
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fs.mkdir(path.dirname(providerPaths.authPath(root)), { recursive: true });
      await fs.writeFile(providerPaths.authPath(root), "{");
      // The session is reserved under the provider-store lock together with the
      // initial credential read, so a malformed store fails the POST itself
      // (fail closed) instead of producing a pending session that later fails.
      const started = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(started.status).toBe(400);
      const error = (await started.json()) as { error?: { code?: string; message?: string } };
      expect(error.error?.code).toBe("CONFIG_INVALID");
      expect(error.error?.message).toContain("credential store is malformed");
      const view = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as { status: string };
      expect(view.status).toBe("interrupted");
      await drainLoginSessions();
    });
  });

  it("surfaces authUrl and completes via manual_code answer", async () => {
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        interaction.notify?.({ type: "auth_url", url: "https://example.com/oauth" });
        const value = await interaction.prompt({
          type: "manual_code",
          message: "paste code",
          signal: new AbortController().signal,
        } as AuthPrompt);
        expect(value).toBe("FIXTURE-auth-code");
        return oauthCredential();
      }),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let promptId = "";
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          authUrl?: string;
          prompt?: { id: string };
        };
        if (body.authUrl) expect(body.authUrl).toBe("https://example.com/oauth");
        if (body.prompt?.id) {
          promptId = body.prompt.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(promptId).toBeTruthy();
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, value: "FIXTURE-auth-code" }),
      });
      for (let i = 0; i < 80; i++) {
        const status = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        const settings = await readApplicationSettings(root);
        if (status.status === "succeeded" && settings.data.agent?.connectionId === ANTHROPIC_ID) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const auth = await readAuth(root);
      expect(auth[providerAlias(ANTHROPIC_ID)]?.type).toBe("oauth");
      const settings = await readApplicationSettings(root);
      expect(settings.data.agent?.connectionId).toBe(ANTHROPIC_ID);
    });
  });

  it('copilot enterprise prompt auto-answered with "" and device_code reached', async () => {
    const replies: string[] = [];
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        const domain = await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
          signal: new AbortController().signal,
        } as AuthPrompt);
        replies.push(domain);
        interaction.notify?.({
          type: "device_code",
          userCode: "WXYZ-1234",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        });
        return oauthCredential();
      }),
    );
    await withOAuthApp("github-copilot", ANTHROPIC_ID, "Copilot", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 30));
      const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
        deviceCode?: { userCode: string };
      };
      expect(replies).toEqual([""]);
      expect(body.deviceCode?.userCode).toBe("WXYZ-1234");
    });
  });

  it("returns 409 PROMPT_STALE when answering an unknown prompt", async () => {
    configureLoginSessions(
      persistingRuntime(async () => {
        await new Promise((r) => setTimeout(r, 500));
        return oauthCredential();
      }),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      const res = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "missing", value: "x" }),
      });
      expect(res.status).toBe(409);
    });
  });

  it("treats CredentialSynchronizationError with credential as success", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          throw new CredentialSynchronizationError("anthropic", "login", oauthCredential(), { cause: new Error("sync") });
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      for (let i = 0; i < 40; i++) {
        const status = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const auth = await readAuth(root);
      expect(auth[providerAlias(ANTHROPIC_ID)]?.type).toBe("oauth");
    });
  });

  it("trusts a newer precommitted credential after CredentialSynchronizationError", async () => {
    const older = oauthCredential();
    if (older.type !== "oauth") throw new Error("fixture must be OAuth");
    const newer: Extract<Credential, { type: "oauth" }> = {
      type: "oauth",
      access: "FIXTURE-SECRET-do-not-leak-sync-newer",
      refresh: "FIXTURE-SECRET-do-not-leak-sync-newer-refresh",
      expires: older.expires + 60_000,
    };
    configureLoginSessions({
      createRuntime: async (options) => ({
        login: async (provider) => {
          await options.credentials.modify(provider, async () => newer);
          throw new CredentialSynchronizationError(provider, "login", older, { cause: new Error("sync") });
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let status = "pending";
      for (let i = 0; i < 40 && status === "pending"; i += 1) {
        status = ((await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json())) as {
          status: string;
        }).status;
        if (status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe("succeeded");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(newer);
    });
  });

  it("rolls back a persisted OAuth credential when post-login validation fails", async () => {
    configureLoginSessions(
      persistingRuntime(
        async () => oauthCredential(),
        async () => {
          throw new Error("post-persist check failed");
        },
      ),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let status = "pending";
      for (let i = 0; i < 80 && status === "pending"; i++) {
        status = ((await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        }).status;
        if (status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe("failed");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
      expect((await readApplicationSettings(root)).data.agent).toBeNull();
    });
  });

  it("preserves concurrent settings edits and rejects credential replacement while rolling back", async () => {
    let rejectCheck!: (error: Error) => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    configureLoginSessions(
      persistingRuntime(
        async () => oauthCredential(),
        async () => {
          checkStarted();
          return new Promise((_, reject) => {
            rejectCheck = reject;
          });
        },
      ),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await started;

      const settings = await readApplicationSettings(root);
      await writeApplicationSettings(
        root,
        {
          ...settings.data,
          connections: settings.data.connections.map((connection) =>
            connection.id === ANTHROPIC_ID ? { ...connection, label: "User renamed Claude" } : connection,
          ),
        },
        settings.revision,
      );
      const newerCredential: Credential = {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak",
        refresh: "FIXTURE-SECRET-do-not-leak",
        expires: 1_999_999_999_999,
      };
      await expect(
        new ConnectionCredentialStore(root, ANTHROPIC_ID, "anthropic").modify(
          "anthropic",
          async () => newerCredential,
        ),
      ).rejects.toMatchObject({ code: "LOGIN_IN_PROGRESS", status: 409 });
      rejectCheck(new Error("post-persist check failed"));

      let status = "pending";
      for (let i = 0; i < 80 && status === "pending"; i++) {
        status = ((await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        }).status;
        if (status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe("failed");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
      const current = await readApplicationSettings(root);
      expect(current.data.connections.find((connection) => connection.id === ANTHROPIC_ID)?.label).toBe(
        "User renamed Claude",
      );
    });
  });

  it("preserves an unrelated connection and API key added while post-login validation is deferred", async () => {
    let releaseCheck!: () => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    configureLoginSessions({
      ...persistingRuntime(
        async () => oauthCredential(),
        async () => {
          checkStarted();
          await new Promise<void>((resolve) => {
            releaseCheck = resolve;
          });
          return undefined;
        },
      ),
      finalizeDefaults: async () => {
        throw new Error("post-validation finalization failed");
      },
    });

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await started;

      const settings = await readApplicationSettings(root);
      const unrelated = await createConnection(
        root,
        {
          label: "Unrelated OpenAI",
          provider: "openai",
          apiKey: "FIXTURE-SECRET-do-not-leak",
        },
        settings.revision,
      );
      releaseCheck();

      let status = "pending";
      for (let i = 0; i < 80 && status === "pending"; i += 1) {
        status = ((await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        }).status;
        if (status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe("failed");

      const current = await readApplicationSettings(root);
      expect(current.data.connections.some((connection) => connection.id === unrelated.connectionId)).toBe(true);
      expect(current.data.connections.find((connection) => connection.id === ANTHROPIC_ID)?.expiresAt).toBeUndefined();
      expect(current.data.agent).toBeNull();
      expect(current.data.scoring).toBeNull();
      const auth = await readAuth(root);
      expect(auth[providerAlias(unrelated.connectionId)]).toEqual({
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak",
      });
      expect(auth[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
    });
  });

  it("settles failed when CredentialSynchronizationError recovery itself throws", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          throw new CredentialSynchronizationError("anthropic", "login", oauthCredential(), {
            cause: new Error("sync"),
          });
        },
        checkAuth: async () => undefined,
      }),
    });
    const modifySpy = vi
      .spyOn(ConnectionCredentialStore.prototype, "modify")
      .mockRejectedValueOnce(new Error("recovery write failed"));
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let status = "pending";
      for (let i = 0; i < 80 && status === "pending"; i++) {
        status = ((await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        }).status;
        if (status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(status).toBe("failed");
    });
    modifySpy.mockRestore();
  });

  it("returns interrupted after session maps are cleared", async () => {
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      resetLoginSessions();
      const status = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
        status: string;
      };
      expect(status.status).toBe("interrupted");
    });
  });

  it("codex device-code path", async () => {
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        interaction.notify?.({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 900,
        });
        return oauthCredential();
      }),
    );
    const CODEX_ID = "123e4567-e89b-12d3-a456-426614174101";
    await withOAuthApp("openai-codex", CODEX_ID, "ChatGPT", async ({ base }) => {
      await fetch(`${base}/api/connections/${CODEX_ID}/login`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 30));
      const body = (await fetch(`${base}/api/connections/${CODEX_ID}/login`).then((r) => r.json())) as {
        deviceCode?: { userCode: string; verificationUri: string };
      };
      expect(body.deviceCode?.userCode).toBe("ABCD-EFGH");
      expect(body.deviceCode?.verificationUri).toBe("https://auth.openai.com/codex/device");
    });
  });

  it("auto-answered select", async () => {
    let selectAnswer = "";
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        selectAnswer = await interaction.prompt({
          type: "select",
          message: "Choose login method",
          options: [
            { id: "browser", label: "Browser login (default)" },
            { id: "device_code", label: "Device code login (headless)" },
          ],
          signal: new AbortController().signal,
        } as AuthPrompt);
        return oauthCredential();
      }),
    );
    await withOAuthApp("openai-codex", ANTHROPIC_ID, "ChatGPT", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 30));
      expect(selectAnswer).toBe("browser");
    });
  });

  it("cancel rejects a parked prompt → status cancelled", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) => {
          await interaction.prompt({
            type: "manual_code",
            message: "waiting",
            signal: new AbortController().signal,
          } as AuthPrompt);
          return oauthCredential();
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          prompt?: { id: string };
        };
        if (body.prompt?.id) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "DELETE" });
      for (let i = 0; i < 40; i++) {
        const { status } = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status === "cancelled") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const final = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
        status: string;
        prompt?: unknown;
      };
      expect(final.status).toBe("cancelled");
      expect(final.prompt).toBeUndefined();
    });
  });

  it("cancellation stays terminal when an abort-ignoring runtime resolves later", async () => {
    let resolveLogin: ((credential: Credential) => void) | undefined;
    configureLoginSessions(
      persistingRuntime(async () =>
        new Promise<Credential>((resolve) => {
          resolveLogin = resolve;
        })),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      for (let i = 0; i < 40 && !resolveLogin; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(resolveLogin).toBeDefined();
      let cancellationSettled = false;
      const cancellation = fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "DELETE" })
        .then(async (response) => {
          cancellationSettled = true;
          return { response, body: await response.json() as { status: string } };
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancellationSettled).toBe(false);

      const overlapping = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(overlapping.status).toBe(409);

      resolveLogin!(oauthCredential());
      const cancelled = await cancellation;
      expect(cancelled.response.status).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");
      await drainLoginSessions();

      const final = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then(
        (response) => response.json() as Promise<{ status: string }>,
      );
      expect(final.status).toBe("cancelled");
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
      const settings = await readApplicationSettings(root);
      expect(settings.data.agent).toBeNull();
      expect(settings.data.scoring).toBeNull();
    });
  });

  it("restores the exact pre-existing OAuth credential when a re-login is cancelled", async () => {
    const previous: Credential = {
      type: "oauth",
      access: "FIXTURE-SECRET-do-not-leak-previous-access",
      refresh: "FIXTURE-SECRET-do-not-leak-previous-refresh",
      expires: 1_800_000_000_000,
    };
    const replacement: Credential = {
      type: "oauth",
      access: "FIXTURE-SECRET-do-not-leak-replacement-access",
      refresh: "FIXTURE-SECRET-do-not-leak-replacement-refresh",
      expires: 1_900_000_000_000,
    };
    let resolveLogin: ((credential: Credential) => void) | undefined;
    configureLoginSessions(
      persistingRuntime(async () =>
        new Promise<Credential>((resolve) => {
          resolveLogin = resolve;
        })),
    );

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await new ConnectionCredentialStore(root, ANTHROPIC_ID, "anthropic").modify(
        "anthropic",
        async () => previous,
      );
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      for (let i = 0; i < 40 && !resolveLogin; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(resolveLogin).toBeDefined();

      const cancellation = fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "DELETE" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolveLogin!(replacement);

      const cancelled = await cancellation;
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
      await drainLoginSessions();
      expect((await readAuth(root))[providerAlias(ANTHROPIC_ID)]).toEqual(previous);
    });
  });

  it("cancellation during finalization preserves an unrelated connection and API key", async () => {
    let finalizeStarted!: () => void;
    const enteredFinalize = new Promise<void>((resolve) => {
      finalizeStarted = resolve;
    });
    let releaseFinalize!: () => void;
    const finalizeReleased = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    configureLoginSessions({
      ...persistingRuntime(async () => oauthCredential()),
      finalizeDefaults: async (root, host, connectionId) => {
        const journal = await finalizeDetectedLoginDefaults(root, host, connectionId);
        finalizeStarted();
        await finalizeReleased;
        return journal;
      },
    });

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const piAuthPath = path.join(fixtureHost(root).home, ".pi/agent/auth.json");
      await fs.mkdir(path.dirname(piAuthPath), { recursive: true });
      await fs.writeFile(
        piAuthPath,
        JSON.stringify({ typesafe: { type: "api_key", key: "FIXTURE-SECRET-do-not-leak" } }),
      );
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await Promise.race([
        enteredFinalize,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("finalization hook was not reached")), 500)),
      ]);

      const beforeUnrelated = await readApplicationSettings(root);
      const unrelated = await createConnection(
        root,
        {
          label: "Unrelated OpenAI",
          provider: "openai",
          apiKey: "FIXTURE-SECRET-do-not-leak",
        },
        beforeUnrelated.revision,
      );

      const cancellation = fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "DELETE" });
      // Release the paused finalisation only once the server has registered the
      // cancel; a bare setImmediate fires before the DELETE reaches the handler.
      const cancelSeen = Date.now() + 2_000;
      for (;;) {
        const view = await (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`)).json();
        if (view.status === "cancelled") break;
        if (Date.now() > cancelSeen) throw new Error(`cancel not registered: ${JSON.stringify(view)}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      releaseFinalize();

      const cancelled = await cancellation;
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ status: "cancelled" });

      await drainLoginSessions();
      const settings = await readApplicationSettings(root);
      const auth = await readAuth(root);
      expect(auth[providerAlias(ANTHROPIC_ID)]).toBeUndefined();
      expect(auth[providerAlias(unrelated.connectionId)]).toEqual({
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak",
      });
      expect(Object.keys(auth)).toEqual([providerAlias(unrelated.connectionId)]);
      expect(settings.data.connections.some((connection) => connection.id === unrelated.connectionId)).toBe(true);
      expect(settings.data.connections.some((connection) => connection.provider === "typesafe")).toBe(false);
      expect(settings.data.agent).toBeNull();
      expect(settings.data.scoring).toBeNull();
    });
  });

  it("prompt-signal abort (callback wins) removes the prompt and a late answer gets 409 PROMPT_STALE", async () => {
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        interaction.notify?.({ type: "auth_url", url: "https://example.com/oauth" });
        const controller = new AbortController();
        const parked = interaction.prompt({
          type: "manual_code",
          message: "paste",
          signal: controller.signal,
        } as AuthPrompt);
        await new Promise((r) => setTimeout(r, 20));
        controller.abort();
        await parked.catch(() => undefined);
        return oauthCredential();
      }),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let promptId = "";
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          prompt?: { id: string };
        };
        if (body.prompt?.id) {
          promptId = body.prompt.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(promptId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 40));
      const mid = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
        prompt?: unknown;
      };
      expect(mid.prompt).toBeUndefined();
      const stale = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, value: "late" }),
      });
      expect(stale.status).toBe(409);
      const err = (await stale.json()) as { error: { code: string } };
      expect(err.error.code).toBe("PROMPT_STALE");
    });
  });

  it("does not publish or park a prompt whose signal is already aborted", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) => {
          const controller = new AbortController();
          controller.abort();
          await interaction.prompt({
            type: "manual_code",
            message: "too late",
            signal: controller.signal,
          } as AuthPrompt);
          return oauthCredential();
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let body: { status: string; prompt?: unknown } = { status: "pending" };
      for (let i = 0; i < 40 && body.status === "pending"; i += 1) {
        body = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((response) => response.json());
        if (body.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(body.status).toBe("failed");
      expect(body.prompt).toBeUndefined();
    });
  });

  it("invalid select id → 422 PROMPT_INVALID", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) => {
          await interaction.prompt({
            type: "select",
            message: "pick one",
            options: [{ id: "alpha", label: "Alpha only" }],
            signal: new AbortController().signal,
          } as AuthPrompt);
          return oauthCredential();
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let promptId = "";
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          prompt?: { id: string };
        };
        if (body.prompt?.id) {
          promptId = body.prompt.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      const bad = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, value: "not-an-option" }),
      });
      expect(bad.status).toBe(422);
      const err = (await bad.json()) as { error: { code: string } };
      expect(err.error.code).toBe("PROMPT_INVALID");
    });
  });

  it("duplicate answer → 409", async () => {
    configureLoginSessions({
      createRuntime: async () => ({
        login: async (_provider, _type, interaction: AuthInteraction) => {
          await interaction.prompt({
            type: "manual_code",
            message: "paste",
            signal: new AbortController().signal,
          } as AuthPrompt);
          return oauthCredential();
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      let promptId = "";
      for (let i = 0; i < 40; i++) {
        const body = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          prompt?: { id: string };
        };
        if (body.prompt?.id) {
          promptId = body.prompt.id;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      const first = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, value: "once" }),
      });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, value: "twice" }),
      });
      expect(second.status).toBe(409);
    });
  });

  it("settled session kept, then dropped after the 10-minute TTL", async () => {
    const origSetTimeout = globalThis.setTimeout.bind(globalThis);
    const observedDelays: number[] = [];
    let settledDrop: (() => void) | undefined;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
      const delayMs = typeof timeout === "number" ? timeout : 0;
      observedDelays.push(delayMs);
      if (delayMs >= 9 * 60 * 1000) {
        settledDrop = () => {
          if (typeof handler === "function") handler();
        };
      }
      return origSetTimeout(handler, timeout, ...args);
    });
    configureLoginSessions(persistingRuntime(async () => oauthCredential()));
    try {
      await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
        await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
        for (let i = 0; i < 120; i++) {
          const { status } = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
            status: string;
          };
          if (status === "succeeded" && settledDrop) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        const kept = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        expect(kept.status).toBe("succeeded");
        expect(settledDrop, `setTimeout delays: ${observedDelays.join(",")}`).toBeDefined();
        settledDrop?.();
        const dropped = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        expect(dropped.status).toBe("interrupted");
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('pre-persist failure → status failed, connection still present with credential.source: "none" and reusable by a second startLogin', async () => {
    let attempts = 0;
    configureLoginSessions({
      createRuntime: async () => ({
        login: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("pre-persist fail");
          throw new Error("unexpected second login call");
        },
        checkAuth: async () => undefined,
      }),
    });
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 30));
      const failed = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
        status: string;
      };
      expect(failed.status).toBe("failed");
      const view = (await listConnections(root, {})).data.connections[0];
      expect(view?.credential.source).toBe("none");

      configureLoginSessions(persistingRuntime(async () => oauthCredential()));
      const second = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(second.status).toBe(200);
      for (let i = 0; i < 40; i++) {
        const { status } = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const auth = await readAuth(root);
      expect(auth[providerAlias(ANTHROPIC_ID)]?.type).toBe("oauth");
    });
  });

  it("email/expiresAt recorded on the connection after success", async () => {
    const expires = 1_900_000_123_000;
    configureLoginSessions(
      persistingRuntime(
        async () => ({
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-access",
          refresh: "FIXTURE-SECRET-do-not-leak-refresh",
          expires,
        }),
        async () =>
          ({ type: "oauth", email: "oauth-user@example.com" }) as Awaited<ReturnType<ModelRuntime["checkAuth"]>> & {
            email: string;
          },
      ),
    );
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      for (let i = 0; i < 80; i++) {
        const { status } = (await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`).then((r) => r.json())) as {
          status: string;
        };
        const settings = await readApplicationSettings(root);
        const connection = settings.data.connections[0];
        if (status === "succeeded" && connection?.email === "oauth-user@example.com") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections[0];
      expect(connection?.email).toBe("oauth-user@example.com");
      expect(connection?.expiresAt).toBe(new Date(expires).toISOString());
    });
  });

  it("bounds OAuth checkAuth metadata without failing a successful login", async () => {
    const email = `${"c".repeat(238)}@example.com`;
    expect(email).toHaveLength(250);
    configureLoginSessions(
      persistingRuntime(
        async () => oauthCredential(),
        async () =>
          ({ type: "oauth", email }) as Awaited<ReturnType<ModelRuntime["checkAuth"]>> & {
            email: string;
          },
      ),
    );

    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ root, base }) => {
      const started = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, { method: "POST" });
      expect(started.status).toBe(200);
      await waitForLoginStatus(base, ANTHROPIC_ID, "succeeded");

      const connection = (await readApplicationSettings(root)).data.connections.find(
        (candidate) => candidate.id === ANTHROPIC_ID,
      );
      expect(connection?.email).toBe(email.slice(0, 200));
      expect(connection?.email?.length).toBeLessThanOrEqual(200);
      expect(connection?.label.length).toBeLessThanOrEqual(80);
    });
  });

  it("enterpriseDomain supplied → recorded as the Copilot text-prompt reply", async () => {
    const replies: string[] = [];
    configureLoginSessions(
      persistingRuntime(async (_provider, interaction) => {
        const domain = await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
          signal: new AbortController().signal,
        } as AuthPrompt);
        replies.push(domain);
        return oauthCredential();
      }),
    );
    await withOAuthApp("github-copilot", ANTHROPIC_ID, "Copilot", async ({ base }) => {
      await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enterpriseDomain: "corp.github.com" }),
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(replies).toEqual(["corp.github.com"]);
    });
  });

  it("rejects Cursor import for a non-Cursor connection", async () => {
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      const res = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import" }),
      });
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "CONFIG_INVALID" } });
    });
  });

  it("rejects enterpriseDomain for a non-Copilot connection", async () => {
    await withOAuthApp("anthropic", ANTHROPIC_ID, "Claude", async ({ base }) => {
      const res = await fetch(`${base}/api/connections/${ANTHROPIC_ID}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enterpriseDomain: "corp.example" }),
      });
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "CONFIG_INVALID" } });
    });
  });
});
