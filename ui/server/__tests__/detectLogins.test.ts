import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { detectLogins } from "../providers/detectLogins";
import type { ProviderHostDeps } from "../providers/hostDeps";
import { createApp } from "../app";
import { authPath } from "../providers/authStoreFile";

const FIXTURE = "FIXTURE-SECRET-do-not-leak";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rmFixtureWorkspace(r)));
});

async function hostEnv(root: string, overrides: Partial<ProviderHostDeps> = {}): Promise<ProviderHostDeps> {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  return {
    home,
    env: {},
    platform: "linux",
    keychainProbe: async () => "absent",
    ghProbe: async () => ({ exitCode: 1 }),
    ...overrides,
  };
}

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

describe("detectLogins", () => {
  it("detects cursor sdk and marks expired credentials as sign-in", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".cursor/sdk"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".cursor/sdk/auth.json"),
      cursorSdkJson({ apiKeyExpiresAtMs: 1 }),
    );
    const found = await detectLogins({ ...deps, platform: "linux" });
    const cursor = found.find((d) => d.kind === "cursor-sdk");
    expect(cursor?.action).toBe("sign-in");
    expect(cursor?.expired).toBe(true);
  });

  it("ignores malformed Cursor expiry metadata without throwing", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".cursor/sdk"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".cursor/sdk/auth.json"),
      cursorSdkJson({ apiKeyExpiresAtMs: "not-a-timestamp" }),
    );

    const cursor = (await detectLogins(deps)).find((detected) => detected.kind === "cursor-sdk");

    expect(cursor).toBeUndefined();
  });

  it("marks finite expired Claude and pi OAuth timestamps and omits malformed timestamps", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(deps.home, ".pi/agent"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".claude/.credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE, refreshTokenExpiresAt: 1 } }),
    );
    await fs.writeFile(
      path.join(deps.home, ".pi/agent/auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: FIXTURE,
          refresh: `${FIXTURE}-refresh`,
          expires: 1,
        },
      }),
    );

    const expired = await detectLogins(deps);
    expect(expired.find((detected) => detected.kind === "claude-code")).toMatchObject({ expired: true });
    expect(expired.find((detected) => detected.kind === "pi-auth")).toMatchObject({ expired: true });

    await fs.writeFile(
      path.join(deps.home, ".claude/.credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE, refreshTokenExpiresAt: "bad" } }),
    );
    await fs.writeFile(
      path.join(deps.home, ".pi/agent/auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: FIXTURE,
          refresh: `${FIXTURE}-refresh`,
          expires: "bad",
        },
      }),
    );
    const malformed = await detectLogins(deps);
    const claude = malformed.find((detected) => detected.kind === "claude-code");
    expect(claude).toMatchObject({ expired: false });
    expect(claude?.expiresAt).toBeUndefined();
    expect(malformed.some((detected) => detected.kind === "pi-auth")).toBe(false);
  });

  it("detects pi-auth api keys and env keys without leaking secrets via GET", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root, { env: { ANTHROPIC_API_KEY: FIXTURE, TYPESAFE_API_KEY: FIXTURE } });
    await fs.mkdir(path.join(deps.home, ".pi/agent"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".pi/agent/auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }),
    );
    const readSpy = vi.spyOn(fs, "readFile");
    const realHome = os.homedir();
    const detected = await detectLogins(deps);
    expect(detected.some((d) => d.kind === "pi-auth" && d.provider === "anthropic")).toBe(true);
    expect(detected.some((d) => d.kind === "env-key" && d.provider === "typesafe")).toBe(true);
    const touchedRealHome = readSpy.mock.calls.some(([target]) => {
      const p = String(target);
      return p.startsWith(realHome) && !p.startsWith(root);
    });
    expect(touchedRealHome).toBe(false);
    readSpy.mockRestore();

    const app = createApp(root, { security: { enabled: false }, providerHost: deps });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const beforePi = await fs.readFile(path.join(deps.home, ".pi/agent/auth.json"));
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
    const body = await res.text();
    expect(body.includes(FIXTURE)).toBe(false);
    expect(await fs.readFile(path.join(deps.home, ".pi/agent/auth.json"))).toEqual(beforePi);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("detects Cursor env-key and pi-auth credentials without returning either key", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const envKey = `${FIXTURE}-cursor-env`;
    const piKey = `${FIXTURE}-cursor-pi`;
    const deps = await hostEnv(root, { env: { CURSOR_API_KEY: envKey } });
    await fs.mkdir(path.join(deps.home, ".pi/agent"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".pi/agent/auth.json"),
      JSON.stringify({ cursor: { type: "api_key", key: piKey } }),
    );

    const detected = await detectLogins(deps);
    expect(detected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "env-key:cursor", provider: "cursor", action: "adopt" }),
      expect.objectContaining({ id: "pi-auth:cursor", provider: "cursor", action: "adopt" }),
    ]));
    expect(JSON.stringify(detected)).not.toContain(envKey);
    expect(JSON.stringify(detected)).not.toContain(piKey);

    const app = createApp(root, { security: { enabled: false }, providerHost: deps });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("env-key:cursor");
      expect(body).toContain("pi-auth:cursor");
      expect(body).not.toContain(envKey);
      expect(body).not.toContain(piKey);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses keychain probe on darwin when claude file is absent", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const probe = vi.fn(async () => "present" as const);
    const deps = await hostEnv(root, { platform: "darwin", keychainProbe: probe });
    const found = await detectLogins(deps);
    expect(probe).toHaveBeenCalledWith("Claude Code-credentials");
    expect(found.some((d) => d.kind === "claude-code")).toBe(true);
  });

  it("requires gh probe success for github-cli detection", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".config/gh"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".config/gh/hosts.yml"),
      "github.com:\n  user: fixture-user\n",
    );
    const missing = await detectLogins({ ...deps, ghProbe: async () => ({ exitCode: 1 }) });
    expect(missing.some((d) => d.kind === "github-cli")).toBe(false);
    const ok = await detectLogins({ ...deps, ghProbe: async () => ({ exitCode: 0 }) });
    expect(ok.some((d) => d.kind === "github-cli" && d.account === "fixture-user")).toBe(true);
  });

  it("does not take a GitHub username from a later enterprise host", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root, { ghProbe: async () => ({ exitCode: 0 }) });
    await fs.mkdir(path.join(deps.home, ".config/gh"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".config/gh/hosts.yml"),
      [
        "github.com:",
        "  git_protocol: https",
        "enterprise.example.com:",
        "  user: enterprise-user",
        "",
      ].join("\n"),
    );

    const found = await detectLogins(deps);
    expect(found.some((d) => d.kind === "github-cli")).toBe(false);
  });

  it("full matrix per source × absent / malformed / unreadable", async () => {
    const runCase = async (
      label: string,
      setup: (home: string) => Promise<void>,
      kind: string,
      expectPresent: boolean,
      extra?: Partial<ProviderHostDeps>,
    ) => {
      const root = await makeFixtureWorkspace();
      roots.push(root);
      const deps = await hostEnv(root, extra);
      await setup(deps.home);
      const found = await detectLogins(deps);
      const hit = found.some((d) => d.kind === kind);
      expect(hit, label).toBe(expectPresent);
    };

    const cursorPath = (home: string) => path.join(home, ".cursor/sdk/auth.json");
    const claudePath = (home: string) => path.join(home, ".claude/.credentials.json");
    const codexPath = (home: string) => path.join(home, ".codex/auth.json");
    const ghPath = (home: string) => path.join(home, ".config/gh/hosts.yml");
    const piPath = (home: string) => path.join(home, ".pi/agent/auth.json");

    const ghOk = { ghProbe: async () => ({ exitCode: 0 }) } satisfies Partial<ProviderHostDeps>;

    await runCase("cursor absent", async () => {}, "cursor-sdk", false);
    await runCase(
      "cursor malformed",
      async (home) => {
        await fs.mkdir(path.dirname(cursorPath(home)), { recursive: true });
        await fs.writeFile(cursorPath(home), "{not-json");
      },
      "cursor-sdk",
      false,
    );
    await runCase(
      "cursor unreadable",
      async (home) => {
        await fs.mkdir(path.dirname(cursorPath(home)), { recursive: true });
        await fs.writeFile(cursorPath(home), cursorSdkJson(), { mode: 0o000 });
      },
      "cursor-sdk",
      false,
    );
    await runCase(
      "cursor present",
      async (home) => {
        await fs.mkdir(path.dirname(cursorPath(home)), { recursive: true });
        await fs.writeFile(cursorPath(home), cursorSdkJson());
      },
      "cursor-sdk",
      true,
    );

    await runCase("claude absent", async () => {}, "claude-code", false);
    await runCase(
      "claude malformed",
      async (home) => {
        await fs.mkdir(path.dirname(claudePath(home)), { recursive: true });
        await fs.writeFile(claudePath(home), "{}");
      },
      "claude-code",
      false,
    );
    await runCase(
      "claude unreadable",
      async (home) => {
        await fs.mkdir(path.dirname(claudePath(home)), { recursive: true });
        await fs.writeFile(
          claudePath(home),
          JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE } }),
          { mode: 0o000 },
        );
      },
      "claude-code",
      false,
    );
    await runCase(
      "claude present",
      async (home) => {
        await fs.mkdir(path.dirname(claudePath(home)), { recursive: true });
        await fs.writeFile(claudePath(home), JSON.stringify({ claudeAiOauth: { refreshToken: FIXTURE } }));
      },
      "claude-code",
      true,
    );

    await runCase("codex absent", async () => {}, "codex", false);
    await runCase(
      "codex malformed",
      async (home) => {
        await fs.mkdir(path.dirname(codexPath(home)), { recursive: true });
        await fs.writeFile(codexPath(home), "{}");
      },
      "codex",
      false,
    );
    await runCase(
      "codex unreadable",
      async (home) => {
        await fs.mkdir(path.dirname(codexPath(home)), { recursive: true });
        await fs.writeFile(
          codexPath(home),
          JSON.stringify({ tokens: { refresh_token: FIXTURE } }),
          { mode: 0o000 },
        );
      },
      "codex",
      false,
    );
    await runCase(
      "codex present",
      async (home) => {
        await fs.mkdir(path.dirname(codexPath(home)), { recursive: true });
        await fs.writeFile(codexPath(home), JSON.stringify({ tokens: { refresh_token: FIXTURE } }));
      },
      "codex",
      true,
    );

    await runCase("github-cli absent", async () => {}, "github-cli", false);
    await runCase(
      "github-cli malformed",
      async (home) => {
        await fs.mkdir(path.dirname(ghPath(home)), { recursive: true });
        await fs.writeFile(ghPath(home), "not:\n  yaml: [");
      },
      "github-cli",
      false,
    );
    await runCase(
      "github-cli unreadable",
      async (home) => {
        await fs.mkdir(path.dirname(ghPath(home)), { recursive: true });
        await fs.writeFile(ghPath(home), "github.com:\n  user: u\n", { mode: 0o000 });
      },
      "github-cli",
      false,
      ghOk,
    );
    await runCase(
      "github-cli present",
      async (home) => {
        await fs.mkdir(path.dirname(ghPath(home)), { recursive: true });
        await fs.writeFile(ghPath(home), "github.com:\n  user: u\n");
      },
      "github-cli",
      true,
      ghOk,
    );

    await runCase("pi-auth absent", async () => {}, "pi-auth", false);
    await runCase(
      "pi-auth malformed",
      async (home) => {
        await fs.mkdir(path.dirname(piPath(home)), { recursive: true });
        await fs.writeFile(piPath(home), "{");
      },
      "pi-auth",
      false,
    );
    await runCase(
      "pi-auth unreadable",
      async (home) => {
        await fs.mkdir(path.dirname(piPath(home)), { recursive: true });
        await fs.writeFile(
          piPath(home),
          JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }),
          { mode: 0o000 },
        );
      },
      "pi-auth",
      false,
    );
    await runCase(
      "pi-auth present",
      async (home) => {
        await fs.mkdir(path.dirname(piPath(home)), { recursive: true });
        await fs.writeFile(piPath(home), JSON.stringify({ anthropic: { type: "api_key", key: FIXTURE } }));
      },
      "pi-auth",
      true,
    );

    await runCase("env-key absent", async () => {}, "env-key", false);
    await runCase(
      "env-key present",
      async () => {},
      "env-key",
      true,
      { env: { ANTHROPIC_API_KEY: FIXTURE } },
    );
  });

  it("Claude file vs keychain precedence when both present (same id, one result)", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const probe = vi.fn(async () => "present" as const);
    const deps = await hostEnv(root, { platform: "darwin", keychainProbe: probe });
    await fs.mkdir(path.join(deps.home, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".claude/.credentials.json"),
      JSON.stringify({
        claudeAiOauth: { refreshToken: FIXTURE, subscriptionType: "from-file" },
      }),
    );
    const found = await detectLogins(deps);
    const claude = found.filter((d) => d.kind === "claude-code");
    expect(claude).toHaveLength(1);
    expect(claude[0]?.id).toBe("claude-code:anthropic");
    expect(claude[0]?.label).toContain("from-file");
    expect(probe).not.toHaveBeenCalled();
  });

  it("Codex present / absent / malformed", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    const codexPath = path.join(deps.home, ".codex/auth.json");
    expect((await detectLogins(deps)).some((d) => d.kind === "codex")).toBe(false);
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "{}");
    expect((await detectLogins(deps)).some((d) => d.kind === "codex")).toBe(false);
    await fs.writeFile(codexPath, JSON.stringify({ tokens: { refresh_token: FIXTURE } }));
    expect((await detectLogins(deps)).some((d) => d.kind === "codex")).toBe(true);
  });

  it("ignores non-string and empty Claude/Codex refresh tokens while the server remains available", async () => {
    const malformedTokens: Array<{ label: string; value: unknown }> = [
      { label: "object", value: { secret: FIXTURE } },
      { label: "number", value: 42 },
      { label: "array", value: [FIXTURE] },
      { label: "empty string", value: "" },
      { label: "null", value: null },
    ];
    const sources = [
      {
        kind: "claude-code",
        relativePath: ".claude/.credentials.json",
        contents: (value: unknown) => ({
          claudeAiOauth: {
            refreshToken: value,
            subscriptionType: { malformed: true },
            refreshTokenExpiresAt: "not-a-number",
          },
        }),
      },
      {
        kind: "codex",
        relativePath: ".codex/auth.json",
        contents: (value: unknown) => ({
          tokens: { refresh_token: value },
          last_refresh: 123,
        }),
      },
    ];

    for (const source of sources) {
      for (const malformed of malformedTokens) {
        const root = await makeFixtureWorkspace();
        roots.push(root);
        const deps = await hostEnv(root);
        const file = path.join(deps.home, source.relativePath);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(source.contents(malformed.value)));

        expect(
          (await detectLogins(deps)).some((detected) => detected.kind === source.kind),
          `${source.kind} ${malformed.label}`,
        ).toBe(false);

        const app = createApp(root, { security: { enabled: false }, providerHost: deps });
        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", resolve));
        try {
          const port = (server.address() as { port: number }).port;
          const response = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
          expect(response.status, `${source.kind} ${malformed.label}`).toBe(200);
          const detected = await response.json() as Array<{ kind: string }>;
          expect(detected.some((item) => item.kind === source.kind)).toBe(false);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  });

  it("pi-auth oauth entry for a provider without auth.oauth omitted and api_key entry for an oauth-only provider omitted", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".pi/agent"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".pi/agent/auth.json"),
      JSON.stringify({
        openrouter: {
          type: "oauth",
          access: FIXTURE,
          refresh: FIXTURE,
          expires: Date.now() + 60_000,
        },
        "openai-codex": { type: "api_key", key: FIXTURE },
        anthropic: { type: "api_key", key: FIXTURE },
      }),
    );
    const found = await detectLogins(deps);
    expect(found.some((d) => d.provider === "openrouter")).toBe(false);
    expect(found.some((d) => d.provider === "openai-codex")).toBe(false);
    expect(found.some((d) => d.provider === "anthropic" && d.kind === "pi-auth")).toBe(true);
  });

  it("env-key absent when env empty", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root, { env: { ANTHROPIC_API_KEY: "" } });
    const found = await detectLogins(deps);
    expect(found.some((d) => d.kind === "env-key")).toBe(false);
  });

  it("keychain probe non-zero and timeout", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const absent = await hostEnv(root, {
      platform: "darwin",
      keychainProbe: async () => "absent",
    });
    expect((await detectLogins(absent)).some((d) => d.kind === "claude-code")).toBe(false);

    const timedOut = await hostEnv(root, {
      platform: "darwin",
      keychainProbe: async () => "absent",
    });
    expect((await detectLogins(timedOut)).some((d) => d.kind === "claude-code")).toBe(false);
  });

  it("ghProbe timeout and missing binary", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".config/gh"), { recursive: true });
    await fs.writeFile(
      path.join(deps.home, ".config/gh/hosts.yml"),
      "github.com:\n  user: fixture-user\n",
    );
    const missing = await detectLogins({ ...deps, ghProbe: async () => ({ exitCode: 127 }) });
    expect(missing.some((d) => d.kind === "github-cli")).toBe(false);

    const timedOut = await detectLogins({ ...deps, ghProbe: async () => ({ exitCode: 124 }) });
    expect(timedOut.some((d) => d.kind === "github-cli")).toBe(false);
  });

  it("linux (no keychain probe call at all) vs darwin", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const probe = vi.fn(async () => "present" as const);
    const linuxDeps = await hostEnv(root, { platform: "linux", keychainProbe: probe });
    await detectLogins(linuxDeps);
    expect(probe).not.toHaveBeenCalled();

    probe.mockClear();
    const darwinDeps = await hostEnv(root, { platform: "darwin", keychainProbe: probe });
    await detectLogins(darwinDeps);
    expect(probe).toHaveBeenCalledWith("Claude Code-credentials");
  });

  it("app-store auth.json seeded and byte-identical before/after GET /api/providers/detected", async () => {
    const root = await makeFixtureWorkspace();
    roots.push(root);
    const deps = await hostEnv(root);
    await fs.mkdir(path.join(deps.home, ".cursor/sdk"), { recursive: true });
    await fs.writeFile(path.join(deps.home, ".cursor/sdk/auth.json"), cursorSdkJson());
    await fs.mkdir(path.dirname(authPath(root)), { recursive: true });
    const appAuthBytes = Buffer.from(JSON.stringify({ "pi-jobs-seed": { type: "api_key", key: "seed-only" } }));
    await fs.writeFile(authPath(root), appAuthBytes);

    const app = createApp(root, { security: { enabled: false }, providerHost: deps });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const before = await fs.readFile(authPath(root));
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/detected`);
    expect(res.status).toBe(200);
    expect(await fs.readFile(authPath(root))).toEqual(before);
    expect(before.equals(appAuthBytes)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
