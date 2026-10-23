process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AuthInteraction, AuthPrompt, AuthType, OAuthCredential } from "@earendil-works/pi-ai";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import { configureLoginSessions, drainLoginSessions, resetLoginSessions } from "../providers/loginSessions";
import type { ProviderHostDeps } from "../providers/hostDeps";
import { readAuth } from "../providers/authStoreFile";
import { providerAlias } from "../providers/providerIds";

const FIXTURE = "FIXTURE-SECRET-do-not-leak";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OPENAI_DEVICE_USER = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_DEVICE_TOKEN = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const GITHUB_DEVICE_CODE = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_TOKEN = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_COPILOT_MODELS = "https://api.individual.githubcopilot.com/models";

function fixtureHost(root: string): ProviderHostDeps {
  return {
    home: path.join(root, "fake-home"),
    env: {},
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
  };
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function openAiAccessToken(): string {
  return encodeJwt({ [JWT_CLAIM_PATH]: { chatgpt_account_id: "fixture-account-id" } });
}

function installFetchStub(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d+/i.test(url)) {
      return original(input, init);
    }
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url === prefix || url.startsWith(prefix)) {
        return handler(init);
      }
    }
    throw new Error(`unexpected network request: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function seedConnection(root: string, id: string, provider: string, label: string): Promise<void> {
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

async function withOAuthServer(
  provider: string,
  connectionId: string,
  label: string,
  run: (ctx: { root: string; base: string }) => Promise<void>,
): Promise<void> {
  const root = await makeFixtureWorkspace();
  await seedConnection(root, connectionId, provider, label);
  const app = createApp(root, { security: { enabled: false }, providerHost: fixtureHost(root) });
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

function realRuntimeWithSelectAnswer(selectAnswer: string) {
  return {
    createRuntime: async (options: {
      credentials: import("../providers/connectionCredentialStore").ConnectionCredentialStore;
      modelsPath: null;
      refreshOnCreate: false;
    }) => {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create(options);
      return {
        login: async (provider: string, authType: string, bridge: AuthInteraction) => {
          const interaction: AuthInteraction = {
            signal: bridge.signal,
            notify: (event) => bridge.notify?.(event),
            prompt: async (authPrompt: AuthPrompt) => {
              if (authPrompt.type === "select") return selectAnswer;
              return bridge.prompt(authPrompt);
            },
          };
          return runtime.login(provider, authType as AuthType, interaction);
        },
        checkAuth: runtime.checkAuth.bind(runtime),
      };
    },
  };
}

afterEach(async () => {
  await drainLoginSessions();
  configureLoginSessions(null);
  resetLoginSessions();
  vi.restoreAllMocks();
});

describe("loginSessions real pi runtime (fetch stubbed)", () => {
  it("anthropic", async () => {
    const restore = installFetchStub({
      [ANTHROPIC_TOKEN_URL]: () =>
        new Response(
          JSON.stringify({
            access_token: `sk-ant-oat-${FIXTURE}-access`,
            refresh_token: `${FIXTURE}-refresh`,
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const id = "123e4567-e89b-12d3-a456-426614174200";
    await withOAuthServer("anthropic", id, "Claude", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${id}/login`, { method: "POST" });
      let authUrl = "";
      for (let i = 0; i < 120; i++) {
        const body = (await fetch(`${base}/api/connections/${id}/login`).then((r) => r.json())) as {
          authUrl?: string;
          status: string;
        };
        if (body.authUrl) {
          authUrl = body.authUrl;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(authUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback");
      const state = new URL(authUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: 53692,
            path: `/callback?code=${encodeURIComponent("FIXTURE-auth-code")}&state=${encodeURIComponent(state!)}`,
            method: "GET",
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.end();
      });
      for (let i = 0; i < 120; i++) {
        const { status } = (await fetch(`${base}/api/connections/${id}/login`).then((r) => r.json())) as {
          status: string;
        };
        if (status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const stored = (await readAuth(root))[providerAlias(id)];
      expect(stored?.type).toBe("oauth");
      const oauth = stored as OAuthCredential;
      expect(oauth.access).toBe(`sk-ant-oat-${FIXTURE}-access`);
      expect(oauth.refresh).toBe(`${FIXTURE}-refresh`);
      expect(typeof oauth.expires).toBe("number");
    });
    restore();
  }, 60_000);

  it("openai-codex browser flow publishes a URL and saves the callback credential", async () => {
    const access = openAiAccessToken();
    const restore = installFetchStub({
      [OPENAI_TOKEN_URL]: () => new Response(JSON.stringify({
        access_token: access, refresh_token: `${FIXTURE}-browser-refresh`, expires_in: 3600,
      }), {status: 200, headers: {"content-type": "application/json"}}),
    });
    const id = "123e4567-e89b-12d3-a456-426614174209";
    try {
      await withOAuthServer("openai-codex", id, "ChatGPT", async ({root, base}) => {
        await fetch(`${base}/api/connections/${id}/login`, {method: "POST"});
        let authUrl = "";
        for (let i = 0; i < 120; i++) {
          const session = await fetch(`${base}/api/connections/${id}/login`).then(r => r.json());
          expect(session.status).not.toBe("failed");
          if (session.authUrl) { authUrl = session.authUrl; break; }
          await new Promise(r => setTimeout(r, 25));
        }
        expect(authUrl).toContain("https://auth.openai.com/oauth/authorize");
        const authorization = new URL(authUrl);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.hostname = "127.0.0.1";
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-browser-code");
        expect((await fetch(callback)).ok).toBe(true);
        await vi.waitFor(async () => {
          const session = await fetch(`${base}/api/connections/${id}/login`).then(r => r.json());
          expect(session.status).toBe("succeeded");
        });
        const stored = (await readAuth(root))[providerAlias(id)] as OAuthCredential;
        expect(stored.access).toBe(access);
        expect(stored.refresh).toBe(`${FIXTURE}-browser-refresh`);
      });
    } finally { restore(); }
  }, 60_000);

  it("openai-codex", async () => {
    const access = openAiAccessToken();
    const restore = installFetchStub({
      [OPENAI_DEVICE_USER]: () =>
        new Response(
          JSON.stringify({ device_auth_id: "fixture-device-auth", user_code: "ABCD-EFGH", interval: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      [OPENAI_DEVICE_TOKEN]: () =>
        new Response(
          JSON.stringify({ authorization_code: "fixture-auth-code", code_verifier: "fixture-verifier" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      [OPENAI_TOKEN_URL]: () =>
        new Response(
          JSON.stringify({
            access_token: access,
            refresh_token: `${FIXTURE}-codex-refresh`,
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    configureLoginSessions(realRuntimeWithSelectAnswer("device_code"));
    const id = "123e4567-e89b-12d3-a456-426614174201";
    await withOAuthServer("openai-codex", id, "ChatGPT", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${id}/login`, { method: "POST" });
      let sawDevice = false;
      for (let i = 0; i < 120; i++) {
        const body = (await fetch(`${base}/api/connections/${id}/login`).then((r) => r.json())) as {
          deviceCode?: { userCode: string; verificationUri: string };
          status: string;
        };
        if (body.deviceCode?.userCode === "ABCD-EFGH" && body.deviceCode.verificationUri) {
          sawDevice = true;
        }
        if (body.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(sawDevice).toBe(true);
      const stored = (await readAuth(root))[providerAlias(id)];
      expect(stored?.type).toBe("oauth");
      const oauth = stored as OAuthCredential;
      expect(oauth.access).toBe(access);
      expect(oauth.refresh).toBe(`${FIXTURE}-codex-refresh`);
      expect(typeof oauth.expires).toBe("number");
    });
    restore();
  }, 60_000);

  it("github-copilot", async () => {
    const restore = installFetchStub({
      [GITHUB_DEVICE_CODE]: () =>
        new Response(
          JSON.stringify({
            device_code: "fixture-device-code",
            user_code: "WXYZ-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      [GITHUB_ACCESS_TOKEN]: () =>
        new Response(JSON.stringify({ access_token: `${FIXTURE}-github-access` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      [GITHUB_COPILOT_TOKEN]: () =>
        new Response(
          JSON.stringify({ token: `${FIXTURE}-copilot-access`, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      [GITHUB_COPILOT_MODELS]: () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o", model_picker_enabled: true, policy: { state: "enabled" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const id = "123e4567-e89b-12d3-a456-426614174202";
    let enterpriseReply = "";
    configureLoginSessions({
      createRuntime: async (options) => {
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create(options);
        return {
          login: async (provider: string, authType: string, bridge: AuthInteraction) => {
            const interaction: AuthInteraction = {
              signal: bridge.signal,
              notify: (event) => bridge.notify?.(event),
              prompt: async (authPrompt: AuthPrompt) => {
                if (authPrompt.type === "text") {
                  const value = await bridge.prompt(authPrompt);
                  enterpriseReply = value;
                  return value;
                }
                return bridge.prompt(authPrompt);
              },
            };
            return runtime.login(provider, authType as AuthType, interaction);
          },
          checkAuth: runtime.checkAuth.bind(runtime),
        };
      },
    });
    await withOAuthServer("github-copilot", id, "Copilot", async ({ root, base }) => {
      await fetch(`${base}/api/connections/${id}/login`, { method: "POST" });
      let sawDevice = false;
      for (let i = 0; i < 120; i++) {
        const body = (await fetch(`${base}/api/connections/${id}/login`).then((r) => r.json())) as {
          deviceCode?: { userCode: string };
          status: string;
        };
        if (body.deviceCode?.userCode === "WXYZ-1234") sawDevice = true;
        if (body.status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(enterpriseReply).toBe("");
      expect(sawDevice).toBe(true);
      const stored = (await readAuth(root))[providerAlias(id)];
      expect(stored?.type).toBe("oauth");
      const oauth = stored as OAuthCredential;
      expect(oauth.access).toBe(`${FIXTURE}-copilot-access`);
      expect(oauth.refresh).toBe(`${FIXTURE}-github-access`);
      expect(typeof oauth.expires).toBe("number");
    });
    restore();
  }, 60_000);
});
