import { validateMaxPaidTasksPerDay } from "../../.pi/extensions/lib/captcha";
import {
  isJevAgentSelection,
  isJevOpenRouterModelId,
  isJevScoringModel,
  JEV_AGENT_READINESS_MESSAGE,
  JEV_TYPESAFE_MODEL_ID,
  JEV_TYPESAFE_PROVIDER,
} from "./jevModels";
import { catalogEntryFor, providerSupportsOAuth, PROVIDER_CATALOG_IDS } from "./providerCatalog";

export type ProviderKind = string;
export type CredentialSource = "environment" | "app-store" | "oauth" | "none";

export type ConnectionOriginKind = "cursor-sdk" | "claude-code" | "codex" | "github-cli" | "pi-auth" | "env-key";

export interface ConnectionOrigin {
  kind: ConnectionOriginKind;
  account?: string;
}
export type ValidationStatus = "untested" | "valid" | "invalid";
export type ApiProtocol = "openai-completions" | "openai-responses";

export interface Connection {
  id: string;
  label: string;
  provider: ProviderKind;
  baseUrl?: string;
  api?: ApiProtocol;
  envKeyName?: string;
  /** Cursor sign-in email (non-secret metadata). */
  email?: string;
  /** ISO-8601 expiry for the stored Cursor API key (non-secret metadata). */
  expiresAt?: string;
  /** Non-production Cursor backend when imported or signed in against a custom host. */
  cursorBackendUrl?: string;
  /** Server-set adopt/sign-in provenance (non-secret). */
  origin?: ConnectionOrigin;
  /** ISO-8601 timestamp when OAuth refresh last failed (server-managed health). */
  refreshFailedAt?: string;
}
export interface ModelSelection { connectionId: string; modelId: string; thinking?: string; }
export interface RunConfigSnapshot { connectionId: string; provider: ProviderKind; modelId: string; baseUrl?: string; thinking?: string; credentialSource: CredentialSource; capturedAt: string; settingsRevision: string; }
export interface SettingsV2 {
  schemaVersion: 2;
  connections: Connection[];
  agent: ModelSelection | null;
  /** Chat runs use this model; null means the same model as `agent`. */
  chat: ModelSelection | null;
  scoring: ModelSelection | null;
  captcha: Record<string, unknown>;
}
export interface ConnectionView extends Connection {
  credential: { configured: boolean; source: CredentialSource };
  validation: { status: ValidationStatus; checkedAt: string | null; code?: string };
}
export interface SettingsView extends Omit<SettingsV2, "captcha"> { captcha: { provider: string; configured: boolean }; }
export interface SettingsEnvelope<T> { data: T; revision: string; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function isSupportedProviderKind(provider: string): boolean {
  return provider === "openai-compatible" || provider === "cursor" || PROVIDER_CATALOG_IDS.has(provider);
}

export class ConfigValidationError extends Error { code: "CONFIG_INVALID" | "CONFIG_VERSION_UNSUPPORTED" = "CONFIG_INVALID"; }
export class UnsupportedSettingsVersionError extends ConfigValidationError { code = "CONFIG_VERSION_UNSUPPORTED" as const; }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigValidationError(`${label} must be a nonempty string`);
  return value.trim();
}
function url(value: unknown): string {
  let parsed: URL;
  try { parsed = new URL(string(value, "baseUrl")); } catch { throw new ConfigValidationError("baseUrl must be a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!["http:", "https:"].includes(parsed.protocol) || (parsed.protocol === "http:" && !loopback) || parsed.username || parsed.password || parsed.hash) throw new ConfigValidationError("baseUrl must be HTTPS unless it targets loopback, without credentials or fragments");
  return parsed.toString().replace(/\/$/, "");
}

export function validateConnection(input: unknown): Connection {
  const raw = object(input, "connection");
  const id = string(raw.id, "connection.id");
  if (!UUID.test(id)) throw new ConfigValidationError("connection.id must be a UUID");
  const label = string(raw.label, "connection.label");
  if (label.length > 80) throw new ConfigValidationError("connection.label must be at most 80 characters");
  const provider = string(raw.provider, "connection.provider");
  if (!isSupportedProviderKind(provider)) throw new ConfigValidationError("unsupported connection provider");
  const result: Connection = { id, label, provider: provider as ProviderKind };
  if (provider === "openai-compatible") {
    if (raw.baseUrl === undefined) throw new ConfigValidationError("openai-compatible connections require baseUrl");
    result.baseUrl = url(raw.baseUrl);
    result.api = raw.api === undefined ? "openai-completions" : string(raw.api, "connection.api") as ApiProtocol;
    if (!["openai-completions", "openai-responses"].includes(result.api)) throw new ConfigValidationError("unsupported compatible API protocol");
  } else if (raw.baseUrl !== undefined || raw.api !== undefined) throw new ConfigValidationError("baseUrl/api are only valid for openai-compatible connections");
  const allowsSignInMetadata = provider === "cursor" || providerSupportsOAuth(provider);
  if (provider === "cursor" && raw.cursorBackendUrl !== undefined) {
    result.cursorBackendUrl = url(raw.cursorBackendUrl);
  } else if (raw.cursorBackendUrl !== undefined) {
    throw new ConfigValidationError("cursorBackendUrl is only valid for cursor connections");
  }
  if (allowsSignInMetadata) {
    if (raw.email !== undefined) {
      const email = string(raw.email, "connection.email");
      if (email.length > 200) throw new ConfigValidationError("connection.email must be at most 200 characters");
      result.email = email;
    }
    if (raw.expiresAt !== undefined) {
      const expiresAt = string(raw.expiresAt, "connection.expiresAt");
      const parsed = Date.parse(expiresAt);
      if (!Number.isFinite(parsed)) throw new ConfigValidationError("connection.expiresAt must be a valid ISO-8601 timestamp");
      result.expiresAt = new Date(parsed).toISOString();
    }
  } else if (raw.email !== undefined || raw.expiresAt !== undefined) {
    throw new ConfigValidationError("email and expiresAt are only valid for cursor and OAuth-capable connections");
  }
  if (raw.origin !== undefined) {
    const originRaw = object(raw.origin, "connection.origin");
    const kind = string(originRaw.kind, "connection.origin.kind");
    const allowedKinds: ConnectionOriginKind[] = ["cursor-sdk", "claude-code", "codex", "github-cli", "pi-auth", "env-key"];
    if (!allowedKinds.includes(kind as ConnectionOriginKind)) {
      throw new ConfigValidationError("connection.origin.kind is invalid");
    }
    const origin: ConnectionOrigin = { kind: kind as ConnectionOriginKind };
    if (originRaw.account !== undefined) {
      const account = string(originRaw.account, "connection.origin.account");
      if (account.length > 200) throw new ConfigValidationError("connection.origin.account must be at most 200 characters");
      origin.account = account;
    }
    result.origin = origin;
  }
  if (raw.refreshFailedAt !== undefined) {
    const refreshFailedAt = string(raw.refreshFailedAt, "connection.refreshFailedAt");
    const parsed = Date.parse(refreshFailedAt);
    if (!Number.isFinite(parsed)) throw new ConfigValidationError("connection.refreshFailedAt must be a valid ISO-8601 timestamp");
    result.refreshFailedAt = new Date(parsed).toISOString();
  }
  if (raw.envKeyName !== undefined) {
    const env = string(raw.envKeyName, "connection.envKeyName");
    if (!ENV_NAME.test(env)) throw new ConfigValidationError("envKeyName must be an uppercase environment variable name");
    const reserved = new Set([
      "PI_CODING_AGENT_DIR",
      "CURSOR_DATA_DIR",
      "CURSOR_BACKEND_URL",
      "CURSOR_WEBSITE_URL",
      "PATH",
      "HOME",
      "NODE_OPTIONS",
    ]);
    if (
      reserved.has(env)
      || env.startsWith("PI_JOBS_")
      || env.startsWith("PI_CURSOR_")
      || env.startsWith("PI_OAUTH_")
    ) {
      throw new ConfigValidationError("envKeyName is reserved for Rolebound run control");
    }
    result.envKeyName = env;
  }
  return result;
}

export function validateSelection(input: unknown, connections: readonly Connection[], label: string): ModelSelection | null {
  if (input === null || input === undefined) return null;
  const raw = object(input, label);
  const connectionId = string(raw.connectionId, `${label}.connectionId`);
  if (!connections.some((connection) => connection.id === connectionId)) throw new ConfigValidationError(`${label}.connectionId is unknown`);
  const connection = connections.find((item) => item.id === connectionId);
  const modelId = string(raw.modelId, `${label}.modelId`);
  if ((label === "agent" || label === "chat") && connection && isJevAgentSelection(connection.provider, modelId)) {
    throw new ConfigValidationError(JEV_AGENT_READINESS_MESSAGE);
  }
  if (label === "scoring" && connection?.provider === "cursor") {
    throw new ConfigValidationError("Cursor cannot be used as the scoring model; choose an API-key provider");
  }
  if (label === "scoring" && connection?.provider === JEV_TYPESAFE_PROVIDER && modelId !== JEV_TYPESAFE_MODEL_ID) {
    throw new ConfigValidationError("TypeSafe connections only support the Jev scoring model");
  }
  return { connectionId, modelId, ...(raw.thinking === undefined ? {} : { thinking: string(raw.thinking, `${label}.thinking`) }) };
}

export function catalogApiKeyEnv(connection: Connection): string | undefined {
  const entry = catalogEntryFor(connection.provider);
  if (!entry?.auth.apiKey) return undefined;
  if (connection.envKeyName) return connection.envKeyName;
  const env = entry.auth.apiKey.env ?? entry.apiKeyEnv;
  return env || undefined;
}

export function validateSettings(input: unknown): SettingsV2 {
  const raw = object(input, "settings");
  if (raw.schemaVersion !== 2) throw new UnsupportedSettingsVersionError("settings schemaVersion must be 2");
  if (!Array.isArray(raw.connections)) throw new ConfigValidationError("connections must be an array");
  const connections = raw.connections.map(validateConnection);
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length) throw new ConfigValidationError("connection ids must be unique");
  const captchaRaw = object(raw.captcha ?? { provider: "off", api_key: "" }, "captcha");
  let maxPaid: number;
  try {
    maxPaid = validateMaxPaidTasksPerDay(captchaRaw.max_paid_tasks_per_day);
  } catch (err) {
    throw new ConfigValidationError((err as Error).message);
  }
  const captcha = { ...captchaRaw, max_paid_tasks_per_day: maxPaid };
  return {
    schemaVersion: 2,
    connections,
    agent: validateSelection(raw.agent, connections, "agent"),
    chat: validateSelection(raw.chat, connections, "chat"),
    scoring: validateSelection(raw.scoring, connections, "scoring"),
    captcha,
  };
}

export function migrateSettings(input: unknown): { settings: SettingsV2; migrated: boolean; raw: Record<string, unknown> } {
  const raw = object(input ?? {}, "settings");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new UnsupportedSettingsVersionError("unsupported settings schema version");
  if (raw.schemaVersion === 2) return { settings: validateSettings(raw), migrated: false, raw };
  const settings: SettingsV2 = {
    schemaVersion: 2,
    connections: [],
    agent: null,
    chat: null,
    scoring: null,
    captcha: object(raw.captcha ?? { provider: "off", api_key: "" }, "captcha"),
  };
  return { settings, migrated: true, raw };
}

export function sanitizeSettings(settings: SettingsV2, credentialStatus: (connection: Connection) => ConnectionView["credential"] = () => ({ configured: false, source: "none" })): SettingsView {
  return {
    schemaVersion: 2,
    connections: settings.connections.map((connection) => ({
      ...connection,
      credential: credentialStatus(connection),
      validation: { status: "untested", checkedAt: null },
    })),
    agent: settings.agent,
    chat: settings.chat,
    scoring: settings.scoring,
    captcha: {
      provider: typeof settings.captcha.provider === "string" ? settings.captcha.provider : "off",
      configured: Boolean(settings.captcha.api_key),
    },
  };
}
