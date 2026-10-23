import { describe, expect, it } from "vitest";
import { defaultModels } from "../../shared/defaultModels";
import { isKnownCursorPiModelId } from "../providers/cursorModels";
import { isJevScoringModel } from "../../shared/jevModels";
import { agentCapableCatalogProviders, resolveAgentModelId } from "../providers/agentModelDefaults";
import { isolatedMetadataRuntime } from "../providers/metadataRuntime";

describe("defaultModels", () => {
  it("validates explicit agent ids against registry metadata", async () => {
    const runtime = await isolatedMetadataRuntime();
    for (const [provider, modelId] of Object.entries(defaultModels.agent)) {
      if (provider === "cursor") {
        expect(isKnownCursorPiModelId(modelId)).toBe(true);
        continue;
      }
      const models = runtime.getModels(provider);
      expect(models.some((m) => m.id === modelId)).toBe(true);
    }
  });

  it("validates Jev scoring id", () => {
    expect(isJevScoringModel("typesafe", defaultModels.scoring.typesafe)).toBe(true);
  });

  it("Copilot fixture whose availableModelIds excludes the global default → the chosen agent model is the first allowed one", async () => {
    const globalDefault = defaultModels.agent["github-copilot"];
    const runtime = await isolatedMetadataRuntime();
    const registryIds = runtime.getModels("github-copilot").map((m) => m.id);
    const allowed = registryIds.filter((id) => id !== globalDefault).slice(0, 3);
    expect(allowed.length).toBeGreaterThan(0);
    const narrowed = [allowed[0]!];
    const chosen = await resolveAgentModelId("github-copilot", narrowed);
    expect(chosen).toBe(narrowed[0]);
    expect(chosen).not.toBe(globalDefault);
  });

  it("treats a present empty availableModelIds list as allowing no Copilot models", async () => {
    await expect(resolveAgentModelId("github-copilot", [])).resolves.toBeUndefined();
  });

  it("yields a registry-valid agent selection for every agent-capable catalog provider", async () => {
    for (const provider of agentCapableCatalogProviders()) {
      const modelId = await resolveAgentModelId(provider);
      expect(modelId, provider).toBeTruthy();
      if (provider === "cursor") {
        expect(isKnownCursorPiModelId(modelId!)).toBe(true);
      } else {
        const runtime = await isolatedMetadataRuntime();
        expect(runtime.getModels(provider).some((m) => m.id === modelId)).toBe(true);
      }
    }
  });
});
