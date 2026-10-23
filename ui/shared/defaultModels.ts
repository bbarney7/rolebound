import { JEV_TYPESAFE_MODEL_ID } from "./jevModels";

/** Default model ids per provider (agent / scoring). */
export const defaultModels = {
  agent: {
    anthropic: "claude-sonnet-4-5",
    openai: "gpt-5-chat-latest",
    "openai-codex": "gpt-5.5",
    "github-copilot": "claude-sonnet-4.6",
    google: "gemini-2.5-flash",
    openrouter: "openai/gpt-5.2-chat",
    cursor: "composer-2.5",
  },
  scoring: {
    anthropic: "claude-sonnet-4-5",
    openai: "gpt-5-chat-latest",
    "openai-codex": "gpt-5.5",
    "github-copilot": "claude-sonnet-4.6",
    google: "gemini-2.5-flash",
    openrouter: "openai/gpt-5.2-chat",
    typesafe: JEV_TYPESAFE_MODEL_ID,
  },
} as const;

export type DefaultModelProvider = keyof typeof defaultModels.agent;
