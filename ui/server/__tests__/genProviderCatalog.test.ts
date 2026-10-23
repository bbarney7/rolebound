import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPENAI_COMPATIBLE_ENTRY,
  PROVIDER_CATALOG,
  providerSupportsApiKey,
  providerSupportsOAuth,
} from "../../shared/providerCatalog";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("provider catalog generator", () => {
  it("matches the committed catalog for pi 1.0.4", () => {
    const committed = readFileSync(path.join(REPO, "ui/shared/providerCatalog.ts"), "utf8");
    execFileSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts/gen-provider-catalog.mts")], {
      cwd: REPO,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const regenerated = readFileSync(path.join(REPO, "ui/shared/providerCatalog.ts"), "utf8");
    expect(regenerated).toBe(committed);
    expect(regenerated).toContain('PI_CODING_AGENT_VERSION = "1.0.4"');
    expect(regenerated).toContain('"openrouter"');
  });

  it("emits auth blocks, roles, copilot, and openai-codex without apiKeyEnv", () => {
    const anthropic = PROVIDER_CATALOG.find((entry) => entry.id === "anthropic");
    const copilot = PROVIDER_CATALOG.find((entry) => entry.id === "github-copilot");
    const codex = PROVIDER_CATALOG.find((entry) => entry.id === "openai-codex");
    const openai = PROVIDER_CATALOG.find((entry) => entry.id === "openai");
    const typesafe = PROVIDER_CATALOG.find((entry) => entry.id === "typesafe");

    expect(anthropic?.auth.apiKey?.env).toBe("ANTHROPIC_API_KEY");
    expect(anthropic?.auth.oauth?.name).toContain("Anthropic");
    expect(anthropic?.roles).toEqual(["agent", "scoring"]);

    expect(copilot).toBeDefined();
    expect(copilot?.auth.oauth).toBeDefined();
    expect(copilot?.scrubEnv).toContain("COPILOT_GITHUB_TOKEN");

    expect(codex?.auth.oauth).toBeDefined();
    expect(codex?.auth.apiKey).toBeUndefined();
    expect(codex?.apiKeyEnv).toBeUndefined();
    expect(codex?.scrubEnv).toEqual([]);

    expect(openai?.auth.oauth).toBeUndefined();
    expect(providerSupportsOAuth("openai")).toBe(false);
    expect(providerSupportsApiKey("openai-codex")).toBe(false);

    expect(typesafe?.roles).toEqual(["scoring"]);
    expect(OPENAI_COMPATIBLE_ENTRY.auth.apiKey).toEqual({});
    expect(OPENAI_COMPATIBLE_ENTRY.apiKeyEnv).toBeUndefined();
  });
});
