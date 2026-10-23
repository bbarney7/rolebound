declare module "pi-cursor-sdk/dist/model-discovery.js" {
  export function discoverModels(options?: { allowNetwork?: boolean }): Promise<unknown>;
  export function getCursorModelMetadata(modelId: string): { thinkingLevelMap?: Record<string, string | null> } | undefined;
}

declare module "pi-cursor-sdk/dist/cursor-fallback-models.generated.js" {
  export const FALLBACK_MODEL_ITEMS: readonly unknown[];
}

declare module "pi-cursor-sdk/shared/cursor-model-selection-identities.mjs" {
  export function getCursorModelSelectionIdentities(models: readonly unknown[]): Array<{ piModelId: string }>;
}
