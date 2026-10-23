import { describe, expect, it } from "vitest";
import { selectionConfigBlockers } from "./selectionRules";
import type { SettingsV2 } from "../../shared/config";
import { providerAlias } from "./providerIds";

const captcha = { provider: "off", api_key: "" };

describe("selectionConfigBlockers", () => {
  it("rejects two OAuth connections on the same provider for agent and scoring", () => {
    const agentId = "123e4567-e89b-12d3-a456-426614174000";
    const scoringId = "123e4567-e89b-12d3-a456-426614174001";
    const settings: SettingsV2 = {
      schemaVersion: 2,
      captcha,
      connections: [
        { id: agentId, label: "A", provider: "anthropic" },
        { id: scoringId, label: "B", provider: "anthropic" },
      ],
      agent: { connectionId: agentId, modelId: "claude-sonnet-4-5" },
      chat: null,
      scoring: { connectionId: scoringId, modelId: "claude-sonnet-4-5" },
    };
    const auth = {
      [providerAlias(agentId)]: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000 },
      [providerAlias(scoringId)]: { type: "oauth" as const, access: "b", refresh: "s", expires: Date.now() + 60_000 },
    };
    expect(selectionConfigBlockers(settings, auth)).toEqual([
      { code: "CONFIG_INVALID", message: "use the same connection for scoring, or an API-key connection" },
    ]);
  });

  it("rejects two OAuth connections on the same provider for chat and scoring", () => {
    const chatId = "123e4567-e89b-12d3-a456-426614174020";
    const scoringId = "123e4567-e89b-12d3-a456-426614174021";
    const settings: SettingsV2 = {
      schemaVersion: 2,
      captcha,
      connections: [
        { id: chatId, label: "C", provider: "anthropic" },
        { id: scoringId, label: "S", provider: "anthropic" },
      ],
      agent: null,
      chat: { connectionId: chatId, modelId: "claude-sonnet-4-5" },
      scoring: { connectionId: scoringId, modelId: "claude-sonnet-4-5" },
    };
    const auth = {
      [providerAlias(chatId)]: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000 },
      [providerAlias(scoringId)]: { type: "oauth" as const, access: "b", refresh: "s", expires: Date.now() + 60_000 },
    };
    expect(selectionConfigBlockers(settings, auth)).toEqual([
      { code: "CONFIG_INVALID", message: "use the same connection for scoring, or an API-key connection" },
    ]);
  });

  it("allows OAuth agent with API-key scorer on the same provider", () => {
    const agentId = "123e4567-e89b-12d3-a456-426614174010";
    const scoringId = "123e4567-e89b-12d3-a456-426614174011";
    const settings: SettingsV2 = {
      schemaVersion: 2,
      captcha,
      connections: [
        { id: agentId, label: "A", provider: "anthropic" },
        { id: scoringId, label: "B", provider: "anthropic" },
      ],
      agent: { connectionId: agentId, modelId: "claude-sonnet-4-5" },
      chat: null,
      scoring: { connectionId: scoringId, modelId: "claude-sonnet-4-5" },
    };
    const auth = {
      [providerAlias(agentId)]: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000 },
      [providerAlias(scoringId)]: { type: "api_key" as const, key: "FIXTURE-SECRET-do-not-leak" },
    };
    expect(selectionConfigBlockers(settings, auth)).toEqual([]);
  });
});
