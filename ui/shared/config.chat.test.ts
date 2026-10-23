import { describe, expect, it } from "vitest";
import { migrateSettings, sanitizeSettings, validateSettings } from "./config";

const captcha = { provider: "off", api_key: "" };
const connection = { id: "123e4567-e89b-12d3-a456-426614174000", label: "A", provider: "openai" };

describe("settings chat selection", () => {
  it("round-trips chat through validate, migrate, and sanitize", () => {
    const raw = {
      schemaVersion: 2,
      connections: [connection],
      agent: { connectionId: connection.id, modelId: "gpt-4o-mini" },
      chat: { connectionId: connection.id, modelId: "gpt-4o" },
      scoring: null,
      captcha,
    };
    const validated = validateSettings(raw);
    expect(validated.chat?.modelId).toBe("gpt-4o");
    const migrated = migrateSettings({ schemaVersion: 1, captcha });
    expect(migrated.settings.chat).toBeNull();
    const view = sanitizeSettings(validated);
    expect(view.chat?.modelId).toBe("gpt-4o");
  });
});
