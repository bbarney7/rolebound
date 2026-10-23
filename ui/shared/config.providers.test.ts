import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConnection, validateSelection, validateSettings } from "./config";

const captcha = { provider: "off", api_key: "" };

describe("settings v2 provider connections", () => {
  it("loads legacy openai, anthropic, and google connections unchanged", () => {
    const connections = [
      { id: "123e4567-e89b-12d3-a456-426614174000", label: "OpenAI", provider: "openai" },
      { id: "123e4567-e89b-12d3-a456-426614174001", label: "Anthropic", provider: "anthropic" },
      { id: "123e4567-e89b-12d3-a456-426614174002", label: "Google", provider: "google" },
    ];
    const settings = validateSettings({
      schemaVersion: 2,
      connections,
      agent: { connectionId: connections[0].id, modelId: "gpt-4o-mini" },
      scoring: null,
      captcha,
    });
    expect(settings.connections.map((c) => c.provider)).toEqual(["openai", "anthropic", "google"]);
  });

  it("accepts registry providers such as openrouter and cursor", () => {
    const openrouter = validateConnection({
      id: "123e4567-e89b-12d3-a456-426614174010",
      label: "OR",
      provider: "openrouter",
    });
    const cursor = validateConnection({
      id: "123e4567-e89b-12d3-a456-426614174011",
      label: "Cursor",
      provider: "cursor",
    });
    expect(openrouter.provider).toBe("openrouter");
    expect(cursor.provider).toBe("cursor");
  });

  it("accepts cursor sign-in metadata on cursor connections", () => {
    const cursor = validateConnection({
      id: "123e4567-e89b-12d3-a456-426614174012",
      label: "Cursor",
      provider: "cursor",
      email: "user@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      cursorBackendUrl: "https://api2.cursor.sh",
    });
    expect(cursor.email).toBe("user@example.com");
    expect(cursor.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("rejects cursor metadata on non-cursor connections", () => {
    expect(() =>
      validateConnection({
        id: "123e4567-e89b-12d3-a456-426614174013",
        label: "OpenAI",
        provider: "openai",
        email: "user@example.com",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects cursor as the scoring connection", () => {
    const connections = [
      { id: "123e4567-e89b-12d3-a456-426614174000", label: "Cursor", provider: "cursor" },
    ];
    expect(() =>
      validateSelection({ connectionId: connections[0].id, modelId: "composer-2.5" }, connections, "scoring"),
    ).toThrow(ConfigValidationError);
  });

  it("accepts email and expiresAt on OAuth-capable providers", () => {
    const anthropic = validateConnection({
      id: "123e4567-e89b-12d3-a456-426614174030",
      label: "Claude",
      provider: "anthropic",
      email: "user@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(anthropic.email).toBe("user@example.com");
    expect(anthropic.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("round-trips origin and refreshFailedAt through validateSettings", () => {
    const settings = validateSettings({
      schemaVersion: 2,
      connections: [
        {
          id: "123e4567-e89b-12d3-a456-426614174040",
          label: "Claude",
          provider: "anthropic",
          origin: { kind: "pi-auth", account: "dev@example.com" },
          refreshFailedAt: "2030-06-01T12:00:00.000Z",
        },
      ],
      agent: null,
      scoring: null,
      captcha,
    });
    expect(settings.connections[0].origin).toEqual({ kind: "pi-auth", account: "dev@example.com" });
    expect(settings.connections[0].refreshFailedAt).toBe("2030-06-01T12:00:00.000Z");
  });

  it("rejects invalid origin kinds and long origin accounts", () => {
    expect(() =>
      validateConnection({
        id: "123e4567-e89b-12d3-a456-426614174041",
        label: "Claude",
        provider: "anthropic",
        origin: { kind: "not-a-kind" },
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      validateConnection({
        id: "123e4567-e89b-12d3-a456-426614174042",
        label: "Claude",
        provider: "anthropic",
        origin: { kind: "env-key", account: "x".repeat(201) },
      }),
    ).toThrow(ConfigValidationError);
  });

  it.each([
    "PI_CODING_AGENT_DIR",
    "PI_JOBS_RUN_ID",
    "CURSOR_DATA_DIR",
    "CURSOR_BACKEND_URL",
    "CURSOR_WEBSITE_URL",
    "PI_CURSOR_SDK_STATE_ROOT",
    "PI_OAUTH_CALLBACK_HOST",
    "PATH",
    "HOME",
    "NODE_OPTIONS",
  ])("rejects reserved connection environment key %s", (envKeyName) => {
    expect(() =>
      validateConnection({
        id: "123e4567-e89b-12d3-a456-426614174043",
        label: "Claude",
        provider: "anthropic",
        envKeyName,
      }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects Jev and TypeSafe as agent selections", () => {
    const connections = [
      { id: "123e4567-e89b-12d3-a456-426614174020", label: "OR", provider: "openrouter" },
      { id: "123e4567-e89b-12d3-a456-426614174021", label: "TS", provider: "typesafe" },
    ];
    expect(() =>
      validateSelection({ connectionId: connections[0].id, modelId: "typesafe/jev-1.13" }, connections, "agent"),
    ).toThrow(ConfigValidationError);
    expect(() =>
      validateSelection({ connectionId: connections[1].id, modelId: "jev-latest" }, connections, "agent"),
    ).toThrow(ConfigValidationError);
    expect(
      validateSelection({ connectionId: connections[0].id, modelId: "typesafe/jev-1.13" }, connections, "scoring"),
    ).toEqual({ connectionId: connections[0].id, modelId: "typesafe/jev-1.13" });
  });
});
