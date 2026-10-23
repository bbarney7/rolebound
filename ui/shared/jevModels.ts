export const JEV_OPENROUTER_MODEL_IDS = ["typesafe/jev-1.13", "~typesafe/jev-latest"] as const;
export const JEV_TYPESAFE_PROVIDER = "typesafe";
export const JEV_TYPESAFE_MODEL_ID = "jev-latest";
export const JEV_SCORE_TEMPLATE = "job-fit-jev-v1";

export const JEV_OPENROUTER_PICKER_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "typesafe/jev-1.13", label: "Jev (decision model, scoring only)" },
  { id: "~typesafe/jev-latest", label: "Jev (decision model, scoring only)" },
];

export function isJevOpenRouterModelId(modelId: string): boolean {
  return (JEV_OPENROUTER_MODEL_IDS as readonly string[]).includes(modelId);
}

export function isJevScoringModel(provider: string, modelId: string): boolean {
  if (provider === JEV_TYPESAFE_PROVIDER) return modelId === JEV_TYPESAFE_MODEL_ID;
  if (provider === "openrouter") return isJevOpenRouterModelId(modelId);
  return false;
}

export function isJevAgentSelection(provider: string, modelId: string): boolean {
  if (provider === JEV_TYPESAFE_PROVIDER) return true;
  if (provider === "openrouter" && isJevOpenRouterModelId(modelId)) return true;
  return false;
}

export const JEV_AGENT_READINESS_MESSAGE = "Jev can only score jobs; choose an agent model";
