import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readApplicationSettings, revisionOf, writeApplicationSettings } from "../applicationConfigStore";
import {
  createConnection,
  listConnections,
  listModels,
  providerAlias,
  providerPaths,
  readAuth,
  removeConnection,
  resolveCredential,
  setConnectionCredential,
  setModelRuntimeFactoryForTests,
  testConnection,
  updateConnection,
  updateSelections,
} from "./providerService";
import { ProviderServiceError } from "./providerErrors";
import { modifyAuthFile } from "./authStoreFile";

const roots: string[] = [];
const makeRoot = async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-provider-")); roots.push(root); return root; };
afterEach(async () => {
  vi.unstubAllGlobals();
  setModelRuntimeFactoryForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const seedOAuth = async (
  root: string,
  connectionId: string,
  extra: Record<string, unknown> = {},
) => {
  await fs.mkdir(path.dirname(providerPaths.authPath(root)), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    providerPaths.authPath(root),
    JSON.stringify(
      {
        [providerAlias(connectionId)]: {
          type: "oauth",
          access: "FIXTURE-SECRET-do-not-leak-access",
          refresh: "FIXTURE-SECRET-do-not-leak-refresh",
          expires: 1_900_000_000_000,
          ...extra,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
};
const base = (id: string, label = id) => ({ id, label, provider: "openai" as const });
const settings = (connections: unknown[] = []) => ({ schemaVersion: 2, connections, agent: null, chat: null, scoring: null, captcha: { provider: "off", api_key: "" } });

describe("provider service", () => {
  it("keeps two same-provider credentials independent and supports replacement/removal", async () => {
    const root = await makeRoot(); await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([base("123e4567-e89b-12d3-a456-426614174000", "one"), base("123e4567-e89b-12d3-a456-426614174001", "two")])));
    await setConnectionCredential(root, "123e4567-e89b-12d3-a456-426614174000", "one-key"); await setConnectionCredential(root, "123e4567-e89b-12d3-a456-426614174001", "two-key");
    expect((await resolveCredential(root, base("123e4567-e89b-12d3-a456-426614174000"))).apiKey).toBe("one-key"); expect((await resolveCredential(root, base("123e4567-e89b-12d3-a456-426614174001"))).apiKey).toBe("two-key");
    await setConnectionCredential(root, "123e4567-e89b-12d3-a456-426614174000", "new-key"); expect((await resolveCredential(root, base("123e4567-e89b-12d3-a456-426614174000"))).apiKey).toBe("new-key");
  });
  it("rejects unknown IDs, expressions, and stale revisions", async () => { const root = await makeRoot(); await expect(setConnectionCredential(root, "missing", "!command" )).rejects.toThrow(); const current = await readApplicationSettings(root); await expect(updateConnection(root, "missing", {}, current.revision)).rejects.toThrow("connection not found"); await expect(updateConnection(root, "missing", {}, "x")).rejects.toThrow("reload and retry"); });
  it("uses environment before app store and allows keyless loopback", async () => { const root = await makeRoot(); const c = { ...base("123e4567-e89b-12d3-a456-426614174000"), envKeyName: "MODEL_KEY" }; const local = { id: "123e4567-e89b-12d3-a456-426614174002", label: "local", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9999" }; /* resolveCredential now reads the connection back from settings as one coherent generation, so both must be persisted */ await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([c, local]))); await setConnectionCredential(root, c.id, "stored"); expect((await resolveCredential(root, c, { MODEL_KEY: "env" })).apiKey).toBe("env"); expect((await resolveCredential(root, local, {})).source).toBe("none"); });
  it("returns bounded sanitized catalog errors", async () => { const root = await makeRoot(); const c = { id: "123e4567-e89b-12d3-a456-426614174000", label: "local", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9999" }; await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([c]))); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("timeout includes secret"), { name: "TimeoutError" }))); await expect(listModels(root, c)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" }); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream body", { status: 401 }))); await expect(listModels(root, c)).rejects.toMatchObject({ code: "AUTH_REJECTED" }); });
  it("prevents deleting selected connections", async () => { const root = await makeRoot(); const c = base("123e4567-e89b-12d3-a456-426614174000"); await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ ...settings([c]), agent: { connectionId: c.id, modelId: "x" } })); const current = await readApplicationSettings(root); await expect(removeConnection(root, c.id, current.revision)).rejects.toThrow("selected"); });
  it("persists pi auth entries under isolated aliases without exposing keys", async () => {
    const root = await makeRoot(); const before = await readApplicationSettings(root);
    const created = await createConnection(root, { label: "Primary", provider: "openai", apiKey: "secret-fixture" }, before.revision);
    const stored = JSON.parse(await fs.readFile(providerPaths.authPath(root), "utf8"));
    expect(stored[providerAlias(created.connectionId)]).toEqual({ type: "api_key", key: "secret-fixture" });
    expect(JSON.stringify(await listConnections(root, {}))).not.toContain("secret-fixture");
    expect((await fs.stat(providerPaths.authPath(root))).mode & 0o777).toBe(0o600);
  });
  it("allows only one concurrent settings revision and leaves no orphan credential", async () => {
    const root = await makeRoot(); const before = await readApplicationSettings(root);
    const results = await Promise.allSettled([
      createConnection(root, { label: "One", provider: "openai", apiKey: "key-one" }, before.revision),
      createConnection(root, { label: "Two", provider: "openai", apiKey: "key-two" }, before.revision),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const authText = await fs.readFile(providerPaths.authPath(root), "utf8");
    expect([authText.includes("key-one"), authText.includes("key-two")].filter(Boolean)).toHaveLength(1);
  });
  it("uses provider-specific catalog headers and never places keys in URLs", async () => {
    const root = await makeRoot(); const cases = [
      { connection: { ...base("123e4567-e89b-12d3-a456-426614174010"), provider: "openai" as const }, header: "authorization", value: "Bearer fixture" },
      { connection: { ...base("123e4567-e89b-12d3-a456-426614174011"), provider: "anthropic" as const }, header: "x-api-key", value: "fixture" },
      { connection: { ...base("123e4567-e89b-12d3-a456-426614174012"), provider: "google" as const }, header: "x-goog-api-key", value: "fixture" },
    ];
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings(cases.map((item) => item.connection))));
    for (const item of cases) {
      let seenUrl = "", seenHeaders: HeadersInit | undefined;
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { seenUrl = String(url); seenHeaders = init?.headers; return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
      expect(await listModels(root, item.connection, { [item.connection.provider === "openai" ? "OPENAI_API_KEY" : item.connection.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"]: "fixture" }, fetcher)).toEqual([{ id: "model-a" }]);
      expect(new Headers(seenHeaders).get(item.header)).toBe(item.value); expect(seenUrl).not.toContain("fixture");
    }
  });
  it("rejects credential-store and directory symlinks", async () => {
    const root = await makeRoot(), outside = path.join(root, "outside.json"); await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([base("123e4567-e89b-12d3-a456-426614174000")]))); await fs.writeFile(outside, "{}"); await fs.mkdir(path.dirname(providerPaths.authPath(root)), { recursive: true }); await fs.symlink(outside, providerPaths.authPath(root));
    await expect(resolveCredential(root, base("123e4567-e89b-12d3-a456-426614174000"), {})).rejects.toThrow("malformed"); expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });
  it("rejects a symlinked private parent even when auth.json is absent", async () => {
    const root = await makeRoot(), outside = await makeRoot(); await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([base("123e4567-e89b-12d3-a456-426614174000")]))); await fs.mkdir(path.join(root, ".pi-jobs")); await fs.symlink(outside, path.join(root, ".pi-jobs", "pi-agent"));
    /* the coherent read reaches the settings symlink guard first; either rejection is the fail-closed outcome */ await expect(resolveCredential(root, base("123e4567-e89b-12d3-a456-426614174000"), {})).rejects.toThrow(/unsafe|must not be a symlink/);
  });
  it("prefers environment keys for registry providers such as groq", async () => {
    const root = await makeRoot();
    const groq = { id: "123e4567-e89b-12d3-a456-426614174050", label: "Groq", provider: "groq" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([groq])));
    await setConnectionCredential(root, groq.id, "stored-groq");
    expect((await resolveCredential(root, groq, { GROQ_API_KEY: "env-groq" })).apiKey).toBe("env-groq");
  });

  it("stops reading oversized streamed catalogs", async () => {
    const root = await makeRoot(), c = { id: "123e4567-e89b-12d3-a456-426614174099", label: "local", provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9999" };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([c])));
    const fetcher = (async () => new Response(new Uint8Array(2_000_001))) as typeof fetch;
    await expect(listModels(root, c, {}, fetcher)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("reports oauth source and expiry from stored credentials", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174060";
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([{ id, label: "Claude", provider: "anthropic" }])));
    await seedOAuth(root, id);
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
    }));
    const view = (await listConnections(root, { ANTHROPIC_API_KEY: "env-would-lose" })).data.connections[0];
    expect(view.credential).toEqual({ configured: true, source: "oauth" });
    expect(view.expiresAt).toBe(new Date(1_900_000_000_000).toISOString());
  });

  it("prefers stored oauth over environment keys", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174061";
    const connection = { id, label: "Claude", provider: "anthropic" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id);
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "oauth-key" } }),
    }));
    const resolved = await resolveCredential(root, connection, { ANTHROPIC_API_KEY: "env-key" });
    expect(resolved.source).toBe("oauth");
    expect(resolved.apiKey).toBe("oauth-key");
  });

  it("restarts credential resolution when OAuth is replaced after getAuth resolves", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174098";
    const connection = { id, label: "Claude", provider: "anthropic" as const };
    const replacementKey = "FIXTURE-SECRET-do-not-leak-replacement-key";
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id);

    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    setModelRuntimeFactoryForTests(async ({ credentials }) => ({
      getAuth: async () => {
        const used = await credentials.read("anthropic");
        expect(used?.type).toBe("oauth");
        entered();
        await released;
        return { auth: { apiKey: used?.type === "oauth" ? used.access : "unexpected" } };
      },
    }));

    const resolution = resolveCredential(root, connection, {});
    await resolving;
    await setConnectionCredential(root, id, replacementKey);
    release();
    const resolved = await resolution;
    expect(resolved).toMatchObject({
      source: "app-store",
      apiKey: replacementKey,
      auth: { apiKey: replacementKey },
      credential: { type: "api_key", key: replacementKey },
    });
    expect(resolved.source === "oauth" && resolved.credential?.type === "api_key").toBe(false);
  });

  it("refuses model listing when the connection changes provider and key during resolution", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174093";
    const connection = { id, label: "Claude", provider: "anthropic" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id);
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        entered();
        await released;
        return { auth: { apiKey: "FIXTURE-SECRET-do-not-leak-old-provider" } };
      },
    }));
    const fetcher = vi.fn();

    const listing = listModels(root, connection, {}, fetcher as unknown as typeof fetch);
    await resolving;
    const current = await readApplicationSettings(root);
    await updateConnection(
      root,
      id,
      { provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-new-provider" },
      current.revision,
    );
    release();

    await expect(listing).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses provider testing when the connection changes provider and key during resolution", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174092";
    const connection = { id, label: "Claude", provider: "anthropic" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id);
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        entered();
        await released;
        return { auth: { apiKey: "FIXTURE-SECRET-do-not-leak-old-provider" } };
      },
    }));
    const fetcher = vi.fn();

    const testing = testConnection(root, connection, {}, fetcher as unknown as typeof fetch);
    await resolving;
    const current = await readApplicationSettings(root);
    await updateConnection(
      root,
      id,
      { provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-new-provider" },
      current.revision,
    );
    release();

    await expect(testing).resolves.toEqual({ ok: false, code: "CONFIG_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed oauth entries without rewriting auth.json", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.dirname(providerPaths.authPath(root)), { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify({ [providerAlias("123e4567-e89b-12d3-a456-426614174062")]: { type: "oauth", access: "a", refresh: 1, expires: "not-a-number" } }, null, 2)}\n`;
    await fs.writeFile(providerPaths.authPath(root), bytes, { mode: 0o600 });
    await expect(readAuth(root)).rejects.toThrow("malformed");
    expect(await fs.readFile(providerPaths.authPath(root), "utf8")).toBe(bytes);
  });

  it("round-trips origin and refreshFailedAt and ignores them on client patches", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174063";
    const connection = {
      id,
      label: "Claude",
      provider: "anthropic",
      origin: { kind: "pi-auth" as const, account: "dev@example.com" },
      refreshFailedAt: "2030-01-02T00:00:00.000Z",
    };
    const before = await readApplicationSettings(root);
    await writeApplicationSettings(
      root,
      { schemaVersion: 2, connections: [connection], agent: null, scoring: null, captcha: { provider: "off", api_key: "" } },
      before.revision,
    );
    const loaded = await readApplicationSettings(root);
    expect(loaded.data.connections[0].origin).toEqual({ kind: "pi-auth", account: "dev@example.com" });
    expect(loaded.data.connections[0].refreshFailedAt).toBe("2030-01-02T00:00:00.000Z");
    const current = await readApplicationSettings(root);
    await updateConnection(
      root,
      id,
      {
        label: "Claude renamed",
        origin: { kind: "env-key" },
        refreshFailedAt: "2099-01-01T00:00:00.000Z",
      } as never,
      current.revision,
    );
    const after = await readApplicationSettings(root);
    expect(after.data.connections[0].origin).toEqual({ kind: "pi-auth", account: "dev@example.com" });
    expect(after.data.connections[0].refreshFailedAt).toBe("2030-01-02T00:00:00.000Z");
  });

  it("rejects apiKey on oauth-only providers for create and PUT", async () => {
    const root = await makeRoot();
    const before = await readApplicationSettings(root);
    await expect(createConnection(root, { label: "Codex", provider: "openai-codex", apiKey: "nope" }, before.revision)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const created = await createConnection(root, { label: "Codex", provider: "openai-codex" }, before.revision);
    const current = await readApplicationSettings(root);
    await expect(updateConnection(root, created.connectionId, { apiKey: "nope" }, current.revision)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("validates an existing API key against the provider produced by an update", async () => {
    const root = await makeRoot();
    const before = await readApplicationSettings(root);
    const created = await createConnection(
      root,
      { label: "OpenAI", provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak" },
      before.revision,
    );
    const current = await readApplicationSettings(root);

    await expect(
      updateConnection(root, created.connectionId, { provider: "openai-codex" }, current.revision),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const after = await readApplicationSettings(root);
    expect(after.data.connections.find((connection) => connection.id === created.connectionId)?.provider).toBe("openai");
    expect((await readAuth(root))[providerAlias(created.connectionId)]).toEqual({
      type: "api_key",
      key: "FIXTURE-SECRET-do-not-leak",
    });
  });

  it("rejects a provider change while OAuth is stored without changing either file", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174064";
    await fs.writeFile(
      path.join(root, "settings.json"),
      `${JSON.stringify(settings([{ id, label: "Claude", provider: "anthropic" }]), null, 2)}\n`,
    );
    await seedOAuth(root, id);
    const current = await readApplicationSettings(root);
    const settingsBefore = await fs.readFile(path.join(root, "settings.json"));
    const authBefore = await fs.readFile(providerPaths.authPath(root));

    await expect(
      updateConnection(root, id, { provider: "github-copilot" }, current.revision),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", status: 422 });

    expect(await fs.readFile(path.join(root, "settings.json"))).toEqual(settingsBefore);
    expect(await fs.readFile(providerPaths.authPath(root))).toEqual(authBefore);
  });

  it("changes provider only when the same update replaces OAuth with a pasted API key", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174065";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify(settings([{ id, label: "Claude", provider: "anthropic" }])),
    );
    await seedOAuth(root, id);
    const current = await readApplicationSettings(root);

    await updateConnection(
      root,
      id,
      {
        provider: "github-copilot",
        apiKey: "FIXTURE-SECRET-do-not-leak-copilot-replacement",
      },
      current.revision,
    );

    expect((await readApplicationSettings(root)).data.connections[0]?.provider).toBe("github-copilot");
    expect((await readAuth(root))[providerAlias(id)]).toEqual({
      type: "api_key",
      key: "FIXTURE-SECRET-do-not-leak-copilot-replacement",
    });
  });

  it("allows a provider change when the same update explicitly clears the stored credential", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174095";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify(settings([{ id, label: "Claude", provider: "anthropic" }])),
    );
    await seedOAuth(root, id);
    const current = await readApplicationSettings(root);

    await updateConnection(root, id, { provider: "openai", apiKey: null }, current.revision);

    expect((await readApplicationSettings(root)).data.connections[0]?.provider).toBe("openai");
    expect((await readAuth(root))[providerAlias(id)]).toBeUndefined();
  });

  it("validates a replacement key against the resulting provider", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174096";
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify(settings([{ id, label: "ChatGPT", provider: "openai-codex" }])),
    );
    await seedOAuth(root, id);
    const current = await readApplicationSettings(root);

    await updateConnection(
      root,
      id,
      { provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-openai" },
      current.revision,
    );

    expect((await readApplicationSettings(root)).data.connections[0]?.provider).toBe("openai");
    expect((await readAuth(root))[providerAlias(id)]).toEqual({
      type: "api_key",
      key: "FIXTURE-SECRET-do-not-leak-openai",
    });
  });

  it("accepts pasted keys for TypeSafe, Cursor, and openai-compatible", async () => {
    const root = await makeRoot();
    let revision = (await readApplicationSettings(root)).revision;
    await createConnection(root, { label: "TS", provider: "typesafe", apiKey: "FIXTURE-SECRET-do-not-leak" }, revision);
    revision = (await readApplicationSettings(root)).revision;
    await createConnection(root, { label: "Cur", provider: "cursor", apiKey: "FIXTURE-SECRET-do-not-leak" }, revision);
    revision = (await readApplicationSettings(root)).revision;
    await createConnection(
      root,
      { label: "Local", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080", apiKey: "FIXTURE-SECRET-do-not-leak" },
      revision,
    );
    const auth = JSON.parse(await fs.readFile(providerPaths.authPath(root), "utf8"));
    expect(Object.keys(auth)).toHaveLength(3);
  });

  it("lists oauth models without HTTP and filters Copilot by availableModelIds", async () => {
    const fetcher = vi.fn();
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-access" } }),
    }));
    for (const provider of ["anthropic", "openai-codex"] as const) {
      const root = await makeRoot();
      const id = provider === "anthropic" ? "123e4567-e89b-12d3-a456-426614174070" : "123e4567-e89b-12d3-a456-426614174071";
      await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([{ id, label: provider, provider }])));
      await seedOAuth(root, id);
      await expect(listModels(root, { id, label: provider, provider }, {}, fetcher)).resolves.not.toHaveLength(0);
    }
    const copilotRoot = await makeRoot();
    const copilotId = "123e4567-e89b-12d3-a456-426614174072";
    await fs.writeFile(
      path.join(copilotRoot, "settings.json"),
      JSON.stringify(settings([{ id: copilotId, label: "Copilot", provider: "github-copilot" }])),
    );
    await seedOAuth(copilotRoot, copilotId, { availableModelIds: ["claude-sonnet-4.6"] });
    const copilotModels = await listModels(copilotRoot, { id: copilotId, label: "Copilot", provider: "github-copilot" }, {}, fetcher);
    expect(copilotModels.every((m) => m.id === "claude-sonnet-4.6")).toBe(true);
    await modifyAuthFile(copilotRoot, (auth) => ({
      ...auth,
      [providerAlias(copilotId)]: {
        ...(auth[providerAlias(copilotId)] as Extract<(typeof auth)[string], { type: "oauth" }>),
        availableModelIds: [],
      },
    }));
    expect(
      await listModels(copilotRoot, { id: copilotId, label: "Copilot", provider: "github-copilot" }, {}, fetcher),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("restarts OAuth model resolution when the credential generation changes", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174066";
    const connection = { id, label: "Copilot", provider: "github-copilot" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id, { availableModelIds: ["claude-sonnet-4.6"] });

    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    setModelRuntimeFactoryForTests(async ({ credentials }) => ({
      getAuth: async () => {
        const used = await credentials.read("github-copilot");
        expect(used?.type).toBe("oauth");
        entered();
        await released;
        return { auth: { apiKey: used?.type === "oauth" ? used.access : "unexpected" } };
      },
    }));

    const listing = listModels(root, connection, {}, vi.fn());
    await resolving;
    await setConnectionCredential(root, id, "FIXTURE-SECRET-do-not-leak-replaced-after-resolution");
    release();
    const models = await listing;
    expect(models.length).toBeGreaterThan(1);
    expect((await readAuth(root))[providerAlias(id)]).toEqual({
      type: "api_key",
      key: "FIXTURE-SECRET-do-not-leak-replaced-after-resolution",
    });
  });

  it("returns CREDENTIAL_EXPIRED when oauth refresh fails", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174073";
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([{ id, label: "Claude", provider: "anthropic" }])));
    await seedOAuth(root, id);
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => {
        throw new Error("OAuth refresh failed for anthropic: unauthorized");
      },
    }));
    await expect(listModels(root, { id, label: "Claude", provider: "anthropic" })).rejects.toMatchObject({ code: "CREDENTIAL_EXPIRED" });
    const tested = await testConnection(root, { id, label: "Claude", provider: "anthropic" }, {}, vi.fn());
    expect(tested).toEqual({ ok: false, code: "CREDENTIAL_EXPIRED" });
  });

  it("keeps model listing read-only and changes refresh health only through connection tests", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174074";
    const connection = { id, label: "Claude", provider: "anthropic" as const };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings([connection])));
    await seedOAuth(root, id);
    const initialRevision = (await readApplicationSettings(root)).revision;
    let refreshSignal: AbortSignal | undefined;
    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async (_provider, options) => {
        refreshSignal = options?.signal;
        throw new DOMException("timed out", "TimeoutError");
      },
    }));

    await expect(listModels(root, connection)).rejects.toMatchObject({ code: "CREDENTIAL_EXPIRED" });
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    const afterListFailure = await readApplicationSettings(root);
    expect(afterListFailure.revision).toBe(initialRevision);
    expect(afterListFailure.data.connections[0]?.refreshFailedAt).toBeUndefined();
    expect(await testConnection(root, connection)).toEqual({ ok: false, code: "CREDENTIAL_EXPIRED" });
    const failed = await readApplicationSettings(root);
    expect(failed.data.connections[0]?.refreshFailedAt).toBeTruthy();

    setModelRuntimeFactoryForTests(async () => ({
      getAuth: async () => ({ auth: { apiKey: "FIXTURE-SECRET-do-not-leak-refreshed" } }),
    }));
    await listModels(root, connection);
    expect(await readApplicationSettings(root)).toEqual(failed);
    expect((await testConnection(root, connection)).ok).toBe(true);
    const cleared = await readApplicationSettings(root);
    expect(cleared.data.connections[0]?.refreshFailedAt).toBeUndefined();
    expect((await testConnection(root, connection)).ok).toBe(true);
    expect((await readApplicationSettings(root)).revision).toBe(cleared.revision);
  });

  it("rejects a valid-to-invalid transition to dual same-provider oauth selections", async () => {
    const root = await makeRoot();
    const agentId = "123e4567-e89b-12d3-a456-426614174080";
    const scoringId = "123e4567-e89b-12d3-a456-426614174081";
    const envelope = {
      schemaVersion: 2,
      connections: [
        { id: agentId, label: "A", provider: "anthropic" },
        { id: scoringId, label: "B", provider: "anthropic" },
      ],
      agent: { connectionId: agentId, modelId: "claude-sonnet-4-5" },
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(envelope));
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(agentId)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-a",
        refresh: "FIXTURE-SECRET-do-not-leak-r",
        expires: Date.now() + 60_000,
      },
      [providerAlias(scoringId)]: {
        type: "oauth",
        access: "FIXTURE-SECRET-do-not-leak-b",
        refresh: "FIXTURE-SECRET-do-not-leak-s",
        expires: Date.now() + 60_000,
      },
    }));
    expect(Object.keys(await readAuth(root))).toHaveLength(2);
    const revision = (await readApplicationSettings(root)).revision;
    await expect(
      updateSelections(
        root,
        {
          agent: envelope.agent,
          scoring: { connectionId: scoringId, modelId: "claude-sonnet-4-5" },
        },
        revision,
      ),
    ).rejects.toBeInstanceOf(ProviderServiceError);
    const loaded = await readApplicationSettings(root);
    expect(loaded.data.agent?.connectionId).toBe(agentId);
    expect(loaded.data.scoring).toBeNull();
  });

  it("keeps chat on undefined updateSelections and clears on null", async () => {
    const root = await makeRoot();
    const c = base("123e4567-e89b-12d3-a456-426614174030");
    const initial = {
      ...settings([c]),
      agent: { connectionId: c.id, modelId: "gpt-4o-mini" },
      chat: { connectionId: c.id, modelId: "gpt-4o" },
    };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(initial));
    let revision = (await readApplicationSettings(root)).revision;
    await updateSelections(root, { agent: initial.agent, scoring: null }, revision);
    let loaded = await readApplicationSettings(root);
    expect(loaded.data.chat?.modelId).toBe("gpt-4o");
    revision = loaded.revision;
    await updateSelections(root, { agent: initial.agent, chat: null, scoring: null }, revision);
    loaded = await readApplicationSettings(root);
    expect(loaded.data.chat).toBeNull();
  });

  it("prevents deleting a connection selected for chat", async () => {
    const root = await makeRoot();
    const c = base("123e4567-e89b-12d3-a456-426614174031");
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ ...settings([c]), chat: { connectionId: c.id, modelId: "gpt-4o" } }),
    );
    const current = await readApplicationSettings(root);
    await expect(removeConnection(root, c.id, current.revision)).rejects.toThrow("selected");
  });

});
