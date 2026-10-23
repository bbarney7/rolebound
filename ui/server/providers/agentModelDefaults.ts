import { PROVIDER_CATALOG } from "../../shared/providerCatalog";
import { defaultModels, type DefaultModelProvider } from "../../shared/defaultModels";
import { isKnownCursorPiModelId } from "./cursorModels";
import { isolatedMetadataRuntime } from "./metadataRuntime";

type RegistryModel = {
  id: string;
  input?: readonly string[];
  reasoning?: boolean;
  embedding?: boolean;
};

function pickFallbackAgentModel(models: RegistryModel[]): string | undefined {
  for (const model of models) {
    const input = model.input ?? [];
    if (!input.includes("text")) continue;
    if (model.reasoning === true && input.length === 0) continue;
    if (model.embedding === true) continue;
    return model.id;
  }
  return undefined;
}

export async function resolveAgentModelId(
  provider: string,
  availableModelIds?: readonly string[],
): Promise<string | undefined> {
  if (provider === "cursor") {
    const preferred = defaultModels.agent.cursor;
    if (isKnownCursorPiModelId(preferred)) {
      if (!availableModelIds || availableModelIds.includes(preferred)) return preferred;
    }
    return undefined;
  }
  if (provider in defaultModels.agent) {
    const explicit = defaultModels.agent[provider as DefaultModelProvider];
    if (!availableModelIds || availableModelIds.includes(explicit)) return explicit;
  }
  const runtime = await isolatedMetadataRuntime();
  let models = runtime.getModels(provider).map((m) => ({
    id: m.id,
    input: m.input as readonly string[] | undefined,
    reasoning: (m as { reasoning?: boolean }).reasoning,
    embedding: (m as { embedding?: boolean }).embedding,
  }));
  if (availableModelIds !== undefined) {
    const allowed = new Set(availableModelIds);
    models = models.filter((m) => allowed.has(m.id));
  }
  return pickFallbackAgentModel(models);
}

export function explicitScoringModelId(provider: string): string | undefined {
  if (provider in defaultModels.scoring) {
    return defaultModels.scoring[provider as keyof typeof defaultModels.scoring];
  }
  return undefined;
}

export function agentCapableCatalogProviders(): string[] {
  return PROVIDER_CATALOG.filter((e) => e.roles.includes("agent")).map((e) => e.id);
}
