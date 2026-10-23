import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import type { ProviderHostDeps } from "../providers/hostDeps";
import { configureLoginSessions, drainLoginSessions, resetLoginSessions } from "../providers/loginSessions";
import { providerAlias, setModelRuntimeFactoryForTests } from "../providers/providerService";
import { modifyAuthFile } from "../providers/authStoreFile";

afterEach(async () => {
  await drainLoginSessions();
  configureLoginSessions(null);
  resetLoginSessions();
  setModelRuntimeFactoryForTests(undefined);
});

describe("provider host deps isolation", () => {
  it("demo mode returns empty detected list without running probes", async () => {
    const root = await makeFixtureWorkspace();
    const probe = vi.fn(async () => ({ exitCode: 0 }));
    const host: ProviderHostDeps = {
      home: path.join(root, "home"),
      env: { ANTHROPIC_API_KEY: "FIXTURE-SECRET-do-not-leak" },
      platform: "linux",
      keychainProbe: vi.fn(async (): Promise<import("../providers/hostDeps").KeychainProbeResult> => "present"),
      ghProbe: probe,
    };
    await fs.mkdir(host.home, { recursive: true });
    const app = createApp(root, { demo: true, security: { enabled: false }, providerHost: host });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
      expect(await res.json()).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rmFixtureWorkspace(root);
    }
  });

  it("never reads the real HOME when fixture deps are injected", async () => {
    const root = await makeFixtureWorkspace();
    const realHome = os.homedir();
    const fakeHome = path.join(root, "isolated-home");
    await fs.mkdir(fakeHome, { recursive: true });
    const host: ProviderHostDeps = {
      home: fakeHome,
      env: {},
      platform: "linux",
      keychainProbe: async () => "absent",
      ghProbe: async () => ({ exitCode: 1 }),
    };
    const readSpy = vi.spyOn(fs, "readFile");
    const app = createApp(root, { security: { enabled: false }, providerHost: host });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      configureLoginSessions({
        createRuntime: async () => ({
          login: async () => ({
            type: "oauth" as const,
            access: "FIXTURE-SECRET-do-not-leak-access",
            refresh: "FIXTURE-SECRET-do-not-leak-refresh",
            expires: Date.now() + 60_000,
          }),
          checkAuth: async () => undefined,
        }),
      });
      const { port } = server.address() as AddressInfo;
      // Seed every file-backed detection source under the injected home so the
      // detection endpoint actually reads them while the spy is active.
      await fs.mkdir(path.join(fakeHome, ".cursor/sdk"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".cursor/sdk/auth.json"),
        JSON.stringify({
          version: 1,
          backendUrl: "https://api2.cursor.sh",
          apiKey: "FIXTURE-SECRET-do-not-leak-cursor",
          email: "dev@example.com",
          createdAtMs: Date.now(),
        }),
      );
      await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".claude/.credentials.json"),
        JSON.stringify({ claudeAiOauth: { refreshToken: "FIXTURE-SECRET-do-not-leak-claude" } }),
      );
      await fs.mkdir(path.join(fakeHome, ".codex"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".codex/auth.json"),
        JSON.stringify({ tokens: { refresh_token: "FIXTURE-SECRET-do-not-leak-codex" } }),
      );
      await fs.mkdir(path.join(fakeHome, ".pi/agent"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".pi/agent/auth.json"),
        JSON.stringify({ typesafe: { type: "api_key", key: "FIXTURE-SECRET-do-not-leak-pi" } }),
      );
      await fs.mkdir(path.join(fakeHome, ".config/gh"), { recursive: true });
      await fs.writeFile(path.join(fakeHome, ".config/gh/hosts.yml"), "github.com:\n  user: fixture\n");
      readSpy.mockClear();
      const detectedRes = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
      expect(detectedRes.status).toBe(200);
      const detected = (await detectedRes.json()) as Array<{ kind: string }>;
      expect(detected.map((item) => item.kind).sort()).toEqual(
        ["claude-code", "codex", "cursor-sdk", "pi-auth"].sort(),
      );
      const readPaths = readSpy.mock.calls.map(([target]) => String(target));
      expect(readPaths.some((p) => p.startsWith(fakeHome))).toBe(true);
      await fetch(`http://127.0.0.1:${port}/api/providers/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      await drainLoginSessions();
      const touchedRealHome = readSpy.mock.calls.some(([target]) => {
        const p = String(target);
        return p.startsWith(realHome) && !p.startsWith(root);
      });
      expect(touchedRealHome).toBe(false);
    } finally {
      readSpy.mockRestore();
      await drainLoginSessions();
      await new Promise((resolve) => server.close(resolve));
      await rmFixtureWorkspace(root);
    }
  });

  it("keeps the settings revision stable while loading an OAuth catalog before saving selections", async () => {
    const root = await makeFixtureWorkspace();
    const connectionId = "123e4567-e89b-12d3-a456-426614174099";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [{ id: connectionId, label: "Claude", provider: "anthropic" }],
        agent: null,
        scoring: null,
        captcha: { provider: "off", api_key: "" },
      }),
    );
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(connectionId)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-access",
        refresh: "FIXTURE-SECRET-do-not-leak-refresh",
        expires: Date.now() + 60_000,
      },
    }));
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
    }));
    const app = createApp(root, { security: { enabled: false } });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const before = (await (await fetch(`${base}/api/connections`)).json()) as { revision: string };
      const catalog = await fetch(`${base}/api/connections/${connectionId}/models`);
      expect(catalog.status).toBe(200);

      const saved = await fetch(`${base}/api/connections/selections`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: before.revision,
          agent: { connectionId, modelId: "claude-sonnet-4-5" },
          scoring: null,
        }),
      });
      expect(saved.status).toBe(200);
    } finally {
      await app.runs.dispose();
      await new Promise((resolve) => server.close(resolve));
      await rmFixtureWorkspace(root);
    }
  });
});
