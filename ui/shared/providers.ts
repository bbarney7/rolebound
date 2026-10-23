import type { Credential, ModelAuth } from "@earendil-works/pi-ai";
import type {
  Connection,
  ConnectionOriginKind,
  ConnectionView,
  CredentialSource,
  ModelSelection,
  ProviderKind,
} from "./config";
import type { ReadinessPayload } from "./types";
export type { Connection, ConnectionView, ModelSelection, ProviderKind };
export interface ConnectionCreate { label: string; provider: ProviderKind; baseUrl?: string; api?: "openai-completions" | "openai-responses"; envKeyName?: string; apiKey?: string; }
/** `agent` runs applications; `chat` (null = same as `agent`) answers in the chat; `scoring` scores jobs. */
export interface ConnectionList { data: { connections: ConnectionView[]; agent: ModelSelection | null; chat: ModelSelection | null; scoring: ModelSelection | null }; revision: string; }
export interface ConnectionSelectionsUpdate { agent: ModelSelection | null; chat?: ModelSelection | null; scoring: ModelSelection | null; expectedRevision: string; }
export type ProviderErrorCode = "CONFIG_INVALID" | "CONNECTION_MISSING" | "CREDENTIAL_MISSING" | "CREDENTIAL_EXPIRED" | "MODEL_UNAVAILABLE" | "TOOLS_UNSUPPORTED" | "AUTH_REJECTED" | "QUOTA_EXCEEDED" | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "REVISION_CONFLICT" | "RUN_BUSY" | "LOGIN_IN_PROGRESS" | "PROMPT_STALE" | "PROMPT_INVALID";
export type DetectedLoginAction = "adopt" | "adopt-scoring" | "sign-in";

export interface DetectedLogin {
  id: string;
  kind: ConnectionOriginKind;
  provider: string;
  label: string;
  account?: string;
  expiresAt?: string;
  expired: boolean;
  action: DetectedLoginAction;
}

export interface AdoptResult {
  connections: ConnectionView[];
  agent: ModelSelection | null;
  chat: ModelSelection | null;
  scoring: ModelSelection | null;
  readiness: ReadinessPayload;
}

export interface CredentialResolution {
  connection: Connection;
  alias: string;
  source: CredentialSource;
  /** Always mirrors `auth.apiKey` when auth is present. */
  apiKey?: string;
  credential?: Credential;
  auth?: ModelAuth;
  refreshFailed?: boolean;
}
