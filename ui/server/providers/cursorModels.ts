import { discoverModels, getCursorModelMetadata } from "pi-cursor-sdk/dist/model-discovery.js";
import { FALLBACK_MODEL_ITEMS } from "pi-cursor-sdk/dist/cursor-fallback-models.generated.js";
import { getCursorModelSelectionIdentities } from "pi-cursor-sdk/shared/cursor-model-selection-identities.mjs";

let catalogPrimed = false;

export async function ensureCursorCatalog(): Promise<void> {
  if (catalogPrimed) return;
  await discoverModels({ allowNetwork: false });
  catalogPrimed = true;
}

export function listCursorPiModelIds(): string[] {
  return getCursorModelSelectionIdentities(FALLBACK_MODEL_ITEMS).map((identity) => identity.piModelId).sort();
}

const knownIds = new Set(listCursorPiModelIds());

export function isKnownCursorPiModelId(modelId: string): boolean {
  return knownIds.has(modelId);
}

export async function resolveCursorThinkingLevel(modelId: string, thinking?: string): Promise<string> {
  await ensureCursorCatalog();
  const level = thinking?.trim() || "off";
  const metadata = getCursorModelMetadata(modelId);
  if (!metadata?.thinkingLevelMap) return "off";
  if (level === "off") return "off";
  const mapped = metadata.thinkingLevelMap[level as keyof typeof metadata.thinkingLevelMap];
  if (mapped === null || mapped === undefined) return "off";
  return level;
}
