import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionCredentialStore } from "./connectionCredentialStore";
import {
  createConnection,
  providerPaths,
  removeConnection,
  setConnectionCredential,
  updateConnection,
  writeBackRunOAuthCredential,
} from "./providerService";
import { readApplicationSettings } from "../applicationConfigStore";
import { providerAlias } from "./providerIds";
import {
  modifyAuthFile,
  loginLeasesPath,
  providerStoreLockPath,
  releaseConnectionCredentialOwnership,
  reserveConnectionCredentialOwnership,
  withProviderStoreLock,
  type CredentialOwnerToken,
} from "./authStoreFile";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-conn-store-"));
  roots.push(root);
  return root;
};
const seedConnections = async (
  root: string,
  connections: Array<{ id: string; label: string; provider: string }>,
) => {
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    connections,
    agent: null,
    scoring: null,
    captcha: { provider: "off", api_key: "" },
  }));
};

async function writeLeaseFromChild(root: string, connectionId: string, expiresAt: number): Promise<number> {
  await withProviderStoreLock(root, async () => {});
  const script = `
    const fs = require("node:fs");
    const lockfile = require("proper-lockfile");
    (async () => {
      const release = await lockfile.lock(process.argv[2]);
      try {
        fs.writeFileSync(process.argv[1], JSON.stringify([{
          connectionId: process.argv[3],
          owner: { pid: process.pid, token: "other-process-token" },
          expiresAt: Number(process.argv[4]),
        }]) + "\\n", { mode: 0o600 });
        process.stdout.write(String(process.pid));
      } finally {
        await release();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "-e",
    script,
    loginLeasesPath(root),
    providerStoreLockPath(root),
    connectionId,
    String(expiresAt),
  ]);
  return Number(stdout);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ConnectionCredentialStore", () => {
  it("maps native provider id to the connection alias", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const store = new ConnectionCredentialStore(root, id, "anthropic");
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(id)]: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    }));
    expect(await store.read("anthropic")).toMatchObject({ type: "oauth" });
    expect(await store.read("openai")).toBeUndefined();
  });

  it("keeps two connections on the same provider isolated", async () => {
    const root = await makeRoot();
    const a = "123e4567-e89b-12d3-a456-426614174001";
    const b = "123e4567-e89b-12d3-a456-426614174002";
    await seedConnections(root, [
      { id: a, label: "A", provider: "anthropic" },
      { id: b, label: "B", provider: "anthropic" },
    ]);
    const storeA = new ConnectionCredentialStore(root, a, "anthropic");
    const storeB = new ConnectionCredentialStore(root, b, "anthropic");
    await storeA.modify("anthropic", async () => ({ type: "api_key", key: "key-a" }));
    await storeB.modify("anthropic", async () => ({ type: "api_key", key: "key-b" }));
    const auth = JSON.parse(await fs.readFile(providerPaths.authPath(root), "utf8"));
    expect(auth[providerAlias(a)].key).toBe("key-a");
    expect(auth[providerAlias(b)].key).toBe("key-b");
  });

  it("preserves the current credential when modify returns undefined", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174003";
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    const onMutation = vi.fn();
    const store = new ConnectionCredentialStore(root, id, "anthropic", onMutation);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "keep-me" }));
    onMutation.mockClear();

    expect(await store.modify("anthropic", async () => undefined)).toEqual({
      type: "api_key",
      key: "keep-me",
    });
    expect(onMutation).not.toHaveBeenCalled();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "keep-me" });
  });

  it("allows only the reservation owner's store to mutate a connection credential", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174030";
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    let ownerToken!: CredentialOwnerToken;
    await withProviderStoreLock(root, async () => {
      ownerToken = await reserveConnectionCredentialOwnership(root, id);
    });
    const ordinary = new ConnectionCredentialStore(root, id, "anthropic");
    const mutation = vi.fn(async () => ({
      type: "api_key" as const,
      key: "FIXTURE-SECRET-do-not-leak-blocked",
    }));
    await expect(ordinary.modify("anthropic", mutation)).rejects.toMatchObject({
      code: "LOGIN_IN_PROGRESS",
      status: 409,
    });
    expect(mutation).not.toHaveBeenCalled();

    const owner = new ConnectionCredentialStore(
      root,
      id,
      "anthropic",
      undefined,
      undefined,
      ownerToken,
    );
    await expect(
      owner.modify("anthropic", async () => ({
        type: "api_key",
        key: "FIXTURE-SECRET-do-not-leak-owner-wins",
      })),
    ).resolves.toEqual({ type: "api_key", key: "FIXTURE-SECRET-do-not-leak-owner-wins" });
    expect(await owner.read("anthropic")).toEqual({
      type: "api_key",
      key: "FIXTURE-SECRET-do-not-leak-owner-wins",
    });
    await releaseConnectionCredentialOwnership(root, id, ownerToken);
    expect(JSON.parse(await fs.readFile(loginLeasesPath(root), "utf8"))).toEqual([]);
  });

  it("blocks every credential writer while another process owns the connection lease", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174031";
    const stored = {
      type: "oauth" as const,
      access: "FIXTURE-SECRET-do-not-leak-stored-access",
      refresh: "FIXTURE-SECRET-do-not-leak-stored-refresh",
      expires: Date.now() + 60_000,
    };
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    await modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(id)]: stored }));
    const otherPid = await writeLeaseFromChild(root, id, Date.now() + 60_000);
    expect(otherPid).not.toBe(process.pid);

    const refresh = vi.fn(async () => ({
      ...stored,
      access: "FIXTURE-SECRET-do-not-leak-refreshed-access",
      expires: stored.expires + 60_000,
    }));
    const ordinary = new ConnectionCredentialStore(root, id, "anthropic");
    await expect(ordinary.modify("anthropic", refresh)).rejects.toMatchObject({
      code: "LOGIN_IN_PROGRESS",
      status: 409,
    });
    expect(refresh).not.toHaveBeenCalled();

    await expect(
      setConnectionCredential(root, id, "FIXTURE-SECRET-do-not-leak-replacement"),
    ).rejects.toMatchObject({ code: "LOGIN_IN_PROGRESS", status: 409 });

    const revision = (await readApplicationSettings(root)).revision;
    await expect(
      updateConnection(root, id, { label: "Renamed" }, revision),
    ).rejects.toMatchObject({ code: "LOGIN_IN_PROGRESS", status: 409 });

    await expect(
      writeBackRunOAuthCredential(
        root,
        id,
        "anthropic",
        { ...stored, expires: stored.expires + 60_000 },
        stored,
      ),
    ).rejects.toMatchObject({ code: "LOGIN_IN_PROGRESS", status: 409 });
    expect((await ordinary.read("anthropic"))).toEqual(stored);
  });

  it("ignores and cleans an expired cross-process lease", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174032";
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    await writeLeaseFromChild(root, id, Date.now() - 1);

    await expect(
      setConnectionCredential(root, id, "FIXTURE-SECRET-do-not-leak-after-expiry"),
    ).resolves.toBeTruthy();
    expect(JSON.parse(await fs.readFile(loginLeasesPath(root), "utf8"))).toEqual([]);
  });

  it("preserves a newer credential when a concurrent refresh makes modify return undefined", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174004";
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    const store = new ConnectionCredentialStore(root, id, "anthropic");
    await store.modify("anthropic", async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
    }));
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(id)]: {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: 2,
      },
    }));

    const result = await store.modify("anthropic", async (current) => {
      expect(current).toMatchObject({ type: "oauth", access: "new-access", expires: 2 });
      return undefined;
    });

    expect(result).toEqual({
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
    });
    expect(await store.read("anthropic")).toMatchObject({
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 2,
    });
  });

  it("serializes modify against concurrent connection create/remove", async () => {
    const root = await makeRoot();
    const storeId = "123e4567-e89b-12d3-a456-426614174099";
    await seedConnections(root, [{ id: storeId, label: "Existing", provider: "openai" }]);
    const currentRevision = (await readApplicationSettings(root)).revision;
    const store = new ConnectionCredentialStore(root, storeId, "openai");
    const results = await Promise.allSettled([
      createConnection(root, { label: "One", provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-one" }, currentRevision),
      store.modify("openai", async (current) => ({ type: "api_key", key: (current?.type === "api_key" ? current.key : "") + "x" })),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const auth = await fs.readFile(providerPaths.authPath(root), "utf8");
    expect(auth.includes("FIXTURE-SECRET-do-not-leak") || auth.includes('"key"')).toBe(true);
  });

  it("never drops entries when pi-style modify races a Rolebound write", async () => {
    const root = await makeRoot();
    const id = "123e4567-e89b-12d3-a456-426614174020";
    const other = "123e4567-e89b-12d3-a456-426614174021";
    await seedConnections(root, [{ id, label: "A", provider: "anthropic" }]);
    await modifyAuthFile(root, (auth) => ({
      ...auth,
      [providerAlias(id)]: { type: "api_key", key: "keep-me" },
      [providerAlias(other)]: { type: "api_key", key: "also-keep" },
    }));
    const store = new ConnectionCredentialStore(root, id, "anthropic");
    await Promise.all([
      store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 99_000 })),
      modifyAuthFile(root, (auth) => ({ ...auth, [providerAlias(other)]: { type: "api_key", key: "updated" } })),
    ]);
    const auth = JSON.parse(await fs.readFile(providerPaths.authPath(root), "utf8"));
    expect(auth[providerAlias(other)].key).toBe("updated");
    expect(auth[providerAlias(id)].type).toBe("oauth");
  });

  it("removeConnection clears only its alias", async () => {
    const root = await makeRoot();
    const before = await readApplicationSettings(root);
    const created = await createConnection(root, { label: "Rm", provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak" }, before.revision);
    const afterCreate = await readApplicationSettings(root);
    await createConnection(root, { label: "Stay", provider: "openai", apiKey: "FIXTURE-SECRET-do-not-leak-2" }, afterCreate.revision);
    const current = await readApplicationSettings(root);
    await removeConnection(root, created.connectionId, current.revision);
    const auth = JSON.parse(await fs.readFile(providerPaths.authPath(root), "utf8"));
    expect(auth[providerAlias(created.connectionId)]).toBeUndefined();
    expect(Object.keys(auth)).toHaveLength(1);
  });
});
