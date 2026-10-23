import { promises as fs } from "node:fs";
import path from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import type { DetectedLogin } from "../../shared/providers";
import { DETECTABLE_PROVIDER_ENTRIES, catalogEntryFor } from "../../shared/providerCatalog";
import { catalogApiKeyEnv } from "../../shared/config";
import type { ProviderHostDeps } from "./hostDeps";
import { CURSOR_PRODUCTION_BACKEND } from "./cursorReadiness";

type CursorSdkAuthModule = {
  FileCredentialStore: new (filePath?: string) => {
    load: () => Promise<
      | {
          apiKey?: string;
          backendUrl?: string;
          apiKeyExpiresAtMs?: number;
          email?: string;
        }
      | undefined
    >;
  };
};

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteDateNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

function detectionId(kind: string, provider: string, account?: string): string {
  return account ? `${kind}:${provider}:${account}` : `${kind}:${provider}`;
}

function catalogSupportsCredential(provider: string, credential: Credential): boolean {
  const entry = DETECTABLE_PROVIDER_ENTRIES.find((candidate) => candidate.id === provider);
  if (!entry) return false;
  if (credential.type === "api_key") return Boolean(entry.auth.apiKey);
  if (credential.type === "oauth") return Boolean(entry.auth.oauth);
  return false;
}

type CursorStored = {
  apiKey?: string;
  backendUrl?: string;
  apiKeyExpiresAtMs?: number;
  email?: string;
};

export async function loadCursorSdkStore(deps: ProviderHostDeps): Promise<CursorStored | undefined> {
  const storePath = path.join(deps.home, ".cursor/sdk/auth.json");
  try {
    const sdk = (await import("@cursor/sdk")) as CursorSdkAuthModule;
    const stored = await new sdk.FileCredentialStore(storePath).load();
    if (stored?.apiKey) return stored;
  } catch {
    return undefined;
  }
  return undefined;
}

async function detectCursorSdk(deps: ProviderHostDeps, now: number): Promise<DetectedLogin | undefined> {
  const stored = await loadCursorSdkStore(deps);
  if (!stored?.apiKey) return undefined;
  const expiry =
    typeof stored.apiKeyExpiresAtMs === "number" && Number.isFinite(stored.apiKeyExpiresAtMs)
      ? stored.apiKeyExpiresAtMs
      : undefined;
  const expired = expiry !== undefined && expiry <= now;
  const account = stored.email;
  const labelAccount = account ? ` · ${account}` : "";
  return {
    id: detectionId("cursor-sdk", "cursor", account),
    kind: "cursor-sdk",
    provider: "cursor",
    label: `Cursor${labelAccount}`,
    ...(account ? { account } : {}),
    ...(expiry !== undefined ? { expiresAt: new Date(expiry).toISOString() } : {}),
    expired,
    action: expired ? "sign-in" : "adopt",
  };
}

async function detectClaudeCode(deps: ProviderHostDeps, now: number): Promise<DetectedLogin | undefined> {
  const filePath = path.join(deps.home, ".claude/.credentials.json");
  const parsed = await readJsonFile<unknown>(filePath);
  const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth)
    ? parsed.claudeAiOauth
    : undefined;
  let fromFile = Boolean(nonEmptyString(oauth?.refreshToken));
  if (!fromFile && deps.platform === "darwin") {
    fromFile = (await deps.keychainProbe("Claude Code-credentials")) === "present";
  }
  if (!fromFile) return undefined;
  const subscription = nonEmptyString(oauth?.subscriptionType);
  const suffix = subscription ? ` (${subscription})` : "";
  const rawRefreshExp = oauth?.refreshTokenExpiresAt;
  const refreshExp = finiteDateNumber(rawRefreshExp);
  return {
    id: detectionId("claude-code", "anthropic"),
    kind: "claude-code",
    provider: "anthropic",
    label: `Claude Pro/Max${suffix}`,
    ...(refreshExp !== undefined ? { expiresAt: new Date(refreshExp).toISOString() } : {}),
    expired: refreshExp !== undefined && refreshExp <= now,
    action: "sign-in",
  };
}

async function detectCodex(deps: ProviderHostDeps): Promise<DetectedLogin | undefined> {
  const parsed = await readJsonFile<unknown>(path.join(deps.home, ".codex/auth.json"));
  if (!isRecord(parsed) || !isRecord(parsed.tokens) || !nonEmptyString(parsed.tokens.refresh_token)) {
    return undefined;
  }
  const last = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : Number.NaN;
  const lastLabel = Number.isFinite(last)
    ? ` · last used ${new Date(last).toLocaleDateString()}`
    : "";
  return {
    id: detectionId("codex", "openai-codex"),
    kind: "codex",
    provider: "openai-codex",
    label: `ChatGPT (Codex)${lastLabel}`,
    expired: false,
    action: "sign-in",
  };
}

function parseGhHostsUser(raw: string): string | undefined {
  const lines = raw.split("\n");
  let inGithub = false;
  for (const line of lines) {
    if (/^github\.com:\s*$/.test(line.trim())) {
      inGithub = true;
      continue;
    }
    if (inGithub && /^\S/.test(line) && !line.startsWith(" ")) {
      inGithub = false;
    }
    if (inGithub) {
      const match = line.match(/^\s+user:\s*(\S+)/);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

async function detectGithubCli(deps: ProviderHostDeps): Promise<DetectedLogin | undefined> {
  const hostsPath = path.join(deps.home, ".config/gh/hosts.yml");
  let user: string | undefined;
  try {
    const raw = await fs.readFile(hostsPath, "utf8");
    user = parseGhHostsUser(raw);
  } catch {
    return undefined;
  }
  if (!user) return undefined;
  const probe = await deps.ghProbe();
  if (probe.exitCode !== 0) return undefined;
  return {
    id: detectionId("github-cli", "github-copilot", user),
    kind: "github-cli",
    provider: "github-copilot",
    label: `GitHub account found (${user}), Copilot access is checked at sign-in`,
    account: user,
    expired: false,
    action: "sign-in",
  };
}

type PiAgentAuthFile = Record<string, Credential>;

async function detectPiAuth(deps: ProviderHostDeps, now: number): Promise<DetectedLogin[]> {
  const parsed = await readJsonFile<PiAgentAuthFile>(path.join(deps.home, ".pi/agent/auth.json"));
  if (!parsed || typeof parsed !== "object") return [];
  const results: DetectedLogin[] = [];
  for (const [provider, credential] of Object.entries(parsed)) {
    if (!credential || typeof credential !== "object") continue;
    if (!catalogSupportsCredential(provider, credential)) continue;
    const entry = catalogEntryFor(provider);
    if (!entry) continue;
    if (credential.type === "api_key") {
      if (typeof credential.key !== "string" || !credential.key.trim()) continue;
      const scoringOnly = entry.roles.length === 1 && entry.roles[0] === "scoring";
      results.push({
        id: detectionId("pi-auth", provider),
        kind: "pi-auth",
        provider,
        label: entry.name,
        expired: false,
        action: scoringOnly ? "adopt-scoring" : "adopt",
      });
    } else if (credential.type === "oauth") {
      if (
        typeof credential.access !== "string" ||
        typeof credential.refresh !== "string" ||
        typeof credential.expires !== "number" ||
        !Number.isFinite(credential.expires)
      ) {
        continue;
      }
      const expires = new Date(credential.expires).toISOString();
      results.push({
        id: detectionId("pi-auth", provider),
        kind: "pi-auth",
        provider,
        label: entry.auth.oauth?.name ?? entry.name,
        expiresAt: expires,
        expired: credential.expires <= now,
        action: "sign-in",
      });
    }
  }
  return results;
}

function detectEnvKeys(deps: ProviderHostDeps): DetectedLogin[] {
  const results: DetectedLogin[] = [];
  for (const entry of DETECTABLE_PROVIDER_ENTRIES) {
    if (!entry.auth.apiKey) continue;
    const envName = catalogApiKeyEnv({ id: "x", label: "x", provider: entry.id });
    if (!envName) continue;
    const value = deps.env[envName]?.trim();
    if (!value) continue;
    const scoringOnly = entry.roles.length === 1 && entry.roles[0] === "scoring";
    results.push({
      id: detectionId("env-key", entry.id),
      kind: "env-key",
      provider: entry.id,
      label: entry.name,
      expired: false,
      action: scoringOnly ? "adopt-scoring" : "adopt",
    });
  }
  return results;
}

export async function detectLogins(deps: ProviderHostDeps): Promise<DetectedLogin[]> {
  const now = Date.now();
  const results: DetectedLogin[] = [];
  const cursor = await detectCursorSdk(deps, now);
  if (cursor) results.push(cursor);
  const claude = await detectClaudeCode(deps, now);
  if (claude) results.push(claude);
  const codex = await detectCodex(deps);
  if (codex) results.push(codex);
  const gh = await detectGithubCli(deps);
  if (gh) results.push(gh);
  results.push(...(await detectPiAuth(deps, now)));
  results.push(...detectEnvKeys(deps));
  return results;
}

export async function findDetectedLogin(deps: ProviderHostDeps, detectionIdValue: string): Promise<DetectedLogin | undefined> {
  const all = await detectLogins(deps);
  return all.find((item) => item.id === detectionIdValue);
}
