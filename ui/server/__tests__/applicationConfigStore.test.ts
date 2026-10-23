import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigRevisionConflictError, readApplicationSettings, revisionOf, writeApplicationSettings } from "../applicationConfigStore";
import { ConfigValidationError, migrateSettings, validateConnection, validateSettings } from "../../shared/config";

const roots: string[] = [];
const root = async () => { const value = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-config-")); roots.push(value); return value; };
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))); });

const connection = { id: "123e4567-e89b-12d3-a456-426614174000", label: "Local", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", envKeyName: "LOCAL_MODEL_KEY" } as const;

describe("application config contract", () => {
  it("validates provider URLs, env names, UUIDs, and selections", () => {
    expect(validateConnection(connection).baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(() => validateConnection({ ...connection, envKeyName: "$(leak)" })).toThrow(ConfigValidationError);
    expect(() => validateConnection({ ...connection, baseUrl: "https://user:pass@example.com" })).toThrow(ConfigValidationError);
    expect(() => validateSettings({ schemaVersion: 2, connections: [connection], agent: { connectionId: connection.id, modelId: "local" }, scoring: null, captcha: {} })).not.toThrow();
    expect(() => validateSettings({ schemaVersion: 2, connections: [connection], agent: { connectionId: connection.id, modelId: "" }, scoring: null, captcha: {} })).toThrow(ConfigValidationError);
  });

  it("migrates legacy settings and keeps captcha data", () => {
    const result = migrateSettings({ captcha: { provider: "2captcha", api_key: "fixture-only" }, customField: "kept" });
    expect(result.migrated).toBe(true);
    expect(result.settings.schemaVersion).toBe(2);
    expect(result.settings.captcha).toEqual({ provider: "2captcha", api_key: "fixture-only" });
  });

  it("writes under a revision and preserves unknown fields without returning keys", async () => {
    const workspace = await root();
    await fs.writeFile(path.join(workspace, "settings.json"), JSON.stringify({ schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: { provider: "2captcha", api_key: "fixture-secret" }, futureFlag: true }));
    const before = await readApplicationSettings(workspace);
    const next = { schemaVersion: 2, connections: [connection], agent: { connectionId: connection.id, modelId: "local" }, scoring: null, captcha: { provider: "off", api_key: "fixture-secret" } };
    const after = await writeApplicationSettings(workspace, next, before.revision);
    expect(after.data.connections[0]).not.toHaveProperty("api_key");
    expect(after.data.captcha).toEqual({ provider: "2captcha", configured: true });
    expect(JSON.parse(await fs.readFile(path.join(workspace, "settings.json"), "utf8")).futureFlag).toBe(true);
    await expect(writeApplicationSettings(workspace, next, before.revision)).rejects.toBeInstanceOf(ConfigRevisionConflictError);
  });

  it("supports first write and rejects a competing first writer", async () => {
    const workspace = await root();
    const initial = await readApplicationSettings(workspace);
    const next = { schemaVersion: 2, connections: [connection], agent: null, scoring: null, captcha: { provider: "off", api_key: "" } };
    const results = await Promise.allSettled([writeApplicationSettings(workspace, next, initial.revision), writeApplicationSettings(workspace, next, initial.revision)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").length).toBe(1);
  });

  it("does not overwrite primitive, future, or symlink settings", async () => {
    const workspace = await root();
    for (const value of ["[]", "null", '{"schemaVersion":99}']) {
      await fs.writeFile(path.join(workspace, "settings.json"), value);
      const before = await fs.readFile(path.join(workspace, "settings.json"));
      await expect(readApplicationSettings(workspace)).rejects.toThrow();
      await expect(writeApplicationSettings(workspace, { schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: {} }, revisionOf(before))).rejects.toThrow();
      expect(await fs.readFile(path.join(workspace, "settings.json"))).toEqual(before);
    }
    const outside = path.join(workspace, "outside.json"); await fs.writeFile(outside, "sentinel");
    await fs.unlink(path.join(workspace, "settings.json")); await fs.symlink(outside, path.join(workspace, "settings.json"));
    await expect(readApplicationSettings(workspace)).rejects.toThrow();
    await expect(writeApplicationSettings(workspace, { schemaVersion: 2, connections: [], agent: null, scoring: null, captcha: {} }, "x")).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("sentinel");
  });

  it("rejects future versions and has stable byte revisions", () => {
    expect(() => migrateSettings({ schemaVersion: 99 })).toThrow("unsupported settings schema version");
    expect(revisionOf("same")).toBe(revisionOf("same"));
    expect(() => validateConnection({ ...connection, baseUrl: "not a url" })).toThrow(ConfigValidationError);
    expect(() => validateConnection({ ...connection, baseUrl: "http://example.com" })).toThrow(ConfigValidationError);
  });
});
