import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunKind } from "../shared/types";
import { readApplicationSettings } from "./applicationConfigStore";
import { isolatedMetadataRuntime } from "./providers/metadataRuntime";
import {
  persistConnectionHealth,
  providerAlias,
  readAuth,
  resolveCredential,
  writeBackRunOAuthCredential,
} from "./providers/providerService";
import { dualOAuthSelectionBlocker, selectionConfigBlockers } from "./providers/selectionRules";
import { parseAuthStoreText } from "./providers/authStoreFile";
import type { CredentialResolution } from "../shared/providers";
import type { Credential } from "@earendil-works/pi-ai";
import { withLock } from "./lock";
import { resolveContinueFromForkSource, saveChatSession } from "./runs/chatSession";
import type { Connection, ModelSelection } from "../shared/config";
import { isJevAgentSelection, isJevScoringModel, JEV_TYPESAFE_PROVIDER } from "../shared/jevModels";
import { ALL_SCRUB_ENV_NAMES } from "../shared/providerCatalog";
import { CURSOR_PRODUCTION_BACKEND } from "./providers/cursorReadiness";
import { ensureCursorCatalog, resolveCursorThinkingLevel } from "./providers/cursorModels";
import { ProviderServiceError } from "./providers/providerErrors";
import type { ProviderRuntime } from "./providers/hostDeps";

/**
 * The single source of the model, thinking level and binary that every
 * UI-started run is spawned with (D5).
 *
 * AC 7 forbids inheriting the user's global pi default, so both `--model` and
 * `--thinking` are passed explicitly on every spawn rather than left to
 * `~/.pi/agent/settings.json`. `index.ts` is the only production caller; tests
 * replace the command and args wholesale through the RunManager options.
 *
 * Each value is trimmed and emptiness-checked — the same discipline
 * `defaultWorkspaceRoot` applies to `PI_JOBS_ROOT` (workspace.ts:24-28).
 * `PI_JOBS_MODEL=` (set but empty) must fall through to the default rather
 * than spawn `--model ""`, which pi would reject.
 */
export interface RunConfig {
  model: string;
  thinking: string;
  bin: string;
}

import type { RunConfigSnapshot } from "../shared/config";

/** Optional per-run resolved configuration supplied by the provider worker. */
export interface PreparedRun {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  model: string;
  snapshot: RunConfigSnapshot;
  /** OAuth write-back baselines retained for terminal-event redaction. */
  oauthWriteBack?: readonly {
    startedWith: Extract<Credential, { type: "oauth" }>;
  }[];
  beforeCleanup?: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export function readRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
  return {
    model: env.PI_JOBS_MODEL?.trim() ?? "",
    thinking: env.PI_JOBS_THINKING?.trim() ?? "",
    bin: env.PI_BIN?.trim() ?? "",
  };
}

/**
 * Flags verified against `pi --help`: `--mode`, `--model`, `--thinking`,
 * `--name/-n`, `--approve/-a`.
 *
 * `-a` is the one that is not obvious: it trusts project-local files for the
 * run, which is what makes the child load `.pi/extensions` and `.pi/mcp.json` from
 * its cwd exactly as an interactive `pi` there does (AC 1). Without it, RPC
 * mode loads project extensions only when a trust decision was saved earlier,
 * and a run against a fresh clone would silently have no `/apply-next`.
 */
export function piArgs(cfg: RunConfig, sessionName: string, forkSessionPath?: string): string[] {
  const args = ["--mode", "rpc"];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  if (forkSessionPath) args.push("--fork", forkSessionPath);
  return [...args, "-n", sessionName, "-a"];
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function piCliPath() { return path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js"); }
function piCursorSdkRoot() { return path.dirname(fileURLToPath(import.meta.resolve("pi-cursor-sdk/package.json"))); }
function usesCursorConnection(connection: Connection) { return connection.provider === "cursor"; }
function cursorModelRef(modelId: string) { return `cursor/${modelId}`; }

type StoredCredentialKind = "oauth" | "api_key" | "none";

function resolutionCredentialKind(resolved: CredentialResolution): StoredCredentialKind {
  if (resolved.source === "oauth" || resolved.credential?.type === "oauth") return "oauth";
  if (resolved.apiKey || resolved.source === "app-store" || resolved.source === "environment") return "api_key";
  return "none";
}

/** Per-run model/auth key: native provider id when unambiguous, else `pi-jobs-<connectionId>`. */
export function runModelProviderKey(
  connection: Connection,
  agentConnection: Connection,
  scoringConnection: Connection,
  agentKind: StoredCredentialKind = "api_key",
  scoringKind: StoredCredentialKind = "api_key",
): string {
  if (usesCursorConnection(connection)) return "cursor";
  if (connection.provider === "openai-compatible") return providerAlias(connection.id);
  const sameProvider =
    scoringConnection.id !== agentConnection.id && scoringConnection.provider === agentConnection.provider;
  if (sameProvider) {
    const agentOAuth = agentKind === "oauth";
    const scoringOAuth = scoringKind === "oauth";
    if (agentOAuth && !scoringOAuth) {
      return connection.id === agentConnection.id ? connection.provider : providerAlias(connection.id);
    }
    if (scoringOAuth && !agentOAuth) {
      return connection.id === scoringConnection.id ? connection.provider : providerAlias(connection.id);
    }
  }
  if (connection.id === agentConnection.id) return connection.provider;
  if (sameProvider && connection.id === scoringConnection.id) {
    return providerAlias(connection.id);
  }
  return connection.provider;
}

function addRunAuthEntry(
  auth: Record<string, Credential>,
  resolved: CredentialResolution,
  providerKey: string,
): void {
  if (usesCursorConnection(resolved.connection) && resolved.apiKey) {
    auth.cursor = { type: "api_key", key: resolved.apiKey };
    return;
  }
  if (resolved.credential?.type === "oauth") {
    auth[providerKey] = resolved.credential;
    return;
  }
  if (resolved.apiKey) {
    auth[providerKey] = { type: "api_key", key: resolved.apiKey };
  }
}

async function refuseIfRefreshFailed(
  root: string,
  resolved: CredentialResolution,
): Promise<void> {
  if (!resolved.refreshFailed) return;
  await persistConnectionHealth(root, resolved.connection.id, { refreshFailedAt: new Date().toISOString() });
  throw new Error("CREDENTIAL_EXPIRED: sign in again");
}

function refuseUnavailableAccountModel(
  resolved: CredentialResolution,
  selection: ModelSelection,
  role: "agent" | "scoring",
): void {
  if (resolved.connection.provider !== "github-copilot" || resolved.credential?.type !== "oauth") return;
  const available = (resolved.credential as Credential & { availableModelIds?: unknown }).availableModelIds;
  if (Array.isArray(available) && !available.includes(selection.modelId)) {
    throw new Error(`MODEL_UNAVAILABLE: selected ${role} model is not available on this Copilot account`);
  }
}

function runModelRef(
  modelId: string,
  providerKey: string,
): string {
  if (providerKey === "cursor") return cursorModelRef(modelId);
  return `${providerKey}/${modelId}`;
}

function usesRunAliasProviderKey(key: string): boolean {
  return key.startsWith("pi-jobs-");
}

function validatedCursorChildBackend(connection: Connection): string | undefined {
  const raw = connection.cursorBackendUrl?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CONFIG_INVALID: cursor backend URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("CONFIG_INVALID: cursor backend URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CONFIG_INVALID: cursor backend URL must not include credentials, query, or fragment");
  }
  const normalized = parsed.toString().replace(/\/+$/, "");
  if (normalized === CURSOR_PRODUCTION_BACKEND) return undefined;
  return normalized;
}

type NativeModel = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
};

function serializeNativeModel(native: NativeModel): Record<string, unknown> {
  return {
    id: native.id,
    name: native.name,
    api: native.api,
    baseUrl: native.baseUrl,
    reasoning: native.reasoning,
    input: native.input,
    cost: native.cost,
    contextWindow: native.contextWindow,
    maxTokens: native.maxTokens,
    ...(native.thinkingLevelMap ? { thinkingLevelMap: native.thinkingLevelMap } : {}),
    ...(native.compat ? { compat: native.compat } : {}),
    ...(native.headers ? { headers: native.headers } : {}),
    ...(native.samplingParams ? { samplingParams: native.samplingParams } : {}),
  };
}

function manualModelDefinition(connection: Connection, selection: ModelSelection): Record<string, unknown> {
  const api = connection.api ?? "openai-completions";
  if (selection.thinking && selection.thinking !== "off") {
    throw new Error("MODEL_UNAVAILABLE: manual models require capability validation before selecting reasoning");
  }
  return {
    id: selection.modelId,
    name: selection.modelId,
    api,
    baseUrl: connection.baseUrl!,
    reasoning: false,
    input: ["text"],
    contextWindow: 32_768,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
    },
  };
}

async function validateNativeModelSelection(connection: Connection, selection: ModelSelection): Promise<void> {
  if (connection.provider === JEV_TYPESAFE_PROVIDER) {
    throw new Error(`MODEL_UNAVAILABLE: ${connection.provider} is scoring-only`);
  }
  if (isJevScoringModel(connection.provider, selection.modelId)) return;
  if (connection.provider === "openai-compatible" || connection.provider === "cursor") return;
  const registry = await isolatedMetadataRuntime();
  const native = registry.getModel(connection.provider, selection.modelId) as NativeModel | undefined;
  if (!native) throw new Error(`MODEL_UNAVAILABLE: model ${selection.modelId} is unavailable for ${connection.provider}`);
  if (selection.thinking && selection.thinking !== "off") {
    if (!native.reasoning || (native.thinkingLevelMap && native.thinkingLevelMap[selection.thinking] === null)) {
      throw new Error("MODEL_UNAVAILABLE: selected reasoning level is unsupported by this model");
    }
  }
}

export async function providerConfig(connection: Connection, selected: ModelSelection | ModelSelection[], keyless: boolean) {
  const selections = Array.isArray(selected) ? selected : [selected];
  const registry = await isolatedMetadataRuntime();
  const models: Array<Record<string, unknown>> = [];
  if (connection.provider === JEV_TYPESAFE_PROVIDER) {
    throw new Error(`MODEL_UNAVAILABLE: ${connection.provider} is scoring-only`);
  }
  for (const selection of new Map(selections.map(value => [value.modelId, value])).values()) {
    if (isJevScoringModel(connection.provider, selection.modelId)) continue;
    if (connection.provider === "openai-compatible") {
      models.push(manualModelDefinition(connection, selection));
      continue;
    }
    if (connection.provider === "cursor") continue;
    await validateNativeModelSelection(connection, selection);
    const native = registry.getModel(connection.provider, selection.modelId) as NativeModel;
    models.push(serializeNativeModel(native));
  }
  if (connection.provider === "openai-compatible") {
    const api = connection.api ?? "openai-completions";
    return { baseUrl: connection.baseUrl, api, ...(keyless ? { apiKey: "pi-jobs-keyless" } : {}), models };
  }
  if (connection.provider === "cursor") {
    return { baseUrl: "https://cursor.com", api: "cursor-sdk", models: [] };
  }
  const first = models[0] as { api?: string; baseUrl?: string };
  const provider = registry.getProvider(connection.provider);
  return {
    baseUrl: first.baseUrl ?? provider?.baseUrl,
    api: first.api,
    models,
  };
}

async function privateWrite(file: string, value: unknown) { const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); } }
export async function withResumeRunGuard<T>(root: string, callback: () => Promise<T>): Promise<T> {
  const dir = path.join(root, ".pi-jobs"); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, "resume-run-guard");
  try { const handle = await fs.open(file, "wx", 0o600); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return withLock(file, callback);
}
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function assertSafeDirectory(dir: string, label: string): Promise<void> {
  try {
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`CONFIG_INVALID: ${label} must not be a symlink`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertSafeRunDir(root: string, runId: string) {
  if (!RUN_ID.test(runId)) throw new Error("CONFIG_INVALID: run id must be a UUID");
  for (const dir of [path.join(root, ".pi-jobs"), path.join(root, ".pi-jobs", "runs")]) {
    await assertSafeDirectory(dir, "private run directory");
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function prepareAgentRun(
  root: string,
  runId: string,
  sessionName: string,
  runtime: NodeJS.ProcessEnv | ProviderRuntime = process.env,
  runKind: RunKind = "gather",
  continueFrom?: string,
): Promise<PreparedRun> {
  const env = typeof (runtime as ProviderRuntime).nodeMajor === "number"
    && typeof (runtime as ProviderRuntime).env === "object"
    ? (runtime as ProviderRuntime).env
    : runtime as NodeJS.ProcessEnv;
  return withResumeRunGuard(root, async () => {
    await assertSafeRunDir(root, runId);
    const settings = await readApplicationSettings(root);
    const selection = runKind === "chat" ? (settings.data.chat ?? settings.data.agent) : settings.data.agent;
    const storedAuth = await readAuth(root);
    const configBlockers = selectionConfigBlockers(settings.data, storedAuth);
    if (configBlockers.length) {
      throw new Error(`CONFIG_INVALID: ${configBlockers[0]!.message}`);
    }
    if (!selection) throw new Error("AGENT_MODEL_MISSING: configure an agent model before starting a run");
    const expectedConnection = settings.data.connections.find(item => item.id === selection.connectionId); if (!expectedConnection) throw new Error("CONNECTION_MISSING: selected agent connection does not exist");
    if (selection.thinking && !THINKING.has(selection.thinking)) throw new Error("MODEL_UNAVAILABLE: selected reasoning level is unsupported");
    const credential = await resolveCredential(root, expectedConnection, env);
    if (credential.connection.provider !== expectedConnection.provider) {
      throw new Error("CONFIG_INVALID: selected agent connection changed providers; reload and retry");
    }
    const connection = credential.connection;
    if (isJevAgentSelection(connection.provider, selection.modelId)) {
      throw new Error("AGENT_MODEL_MISSING: Jev can only score jobs; choose an agent model");
    }
    if (usesCursorConnection(connection)) await ensureCursorCatalog();
    const agentThinking = usesCursorConnection(connection)
      ? await resolveCursorThinkingLevel(selection.modelId, selection.thinking)
      : (selection.thinking ?? "off");
    await refuseIfRefreshFailed(root, credential);
    if (credential.connection.refreshFailedAt) {
      await persistConnectionHealth(root, credential.connection.id, { refreshFailedAt: null });
    }
    refuseUnavailableAccountModel(credential, selection, "agent");
    const scoringSelection = settings.data.scoring ?? selection;
    const expectedScoringConnection = settings.data.connections.find(item => item.id === scoringSelection.connectionId); if (!expectedScoringConnection) throw new Error("CONNECTION_MISSING: selected scoring connection does not exist");
    const requireScoring = runKind === "score";
    let scoringCredential = credential;
    let scoringConnection = connection;
    if (expectedScoringConnection.id !== connection.id) {
      try {
        scoringCredential = await resolveCredential(root, expectedScoringConnection, env);
        if (scoringCredential.connection.provider !== expectedScoringConnection.provider) {
          throw new Error("CONFIG_INVALID: selected scoring connection changed providers; reload and retry");
        }
        scoringConnection = scoringCredential.connection;
        await refuseIfRefreshFailed(root, scoringCredential);
        if (scoringCredential.connection.refreshFailedAt) {
          await persistConnectionHealth(root, scoringCredential.connection.id, { refreshFailedAt: null });
        }
      }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("CONFIG_INVALID:")) throw error;
        if (requireScoring) throw error;
        scoringConnection = expectedScoringConnection;
        scoringCredential = { connection: scoringConnection, alias: providerAlias(scoringConnection.id), source: "none" };
      }
    }
    refuseUnavailableAccountModel(scoringCredential, scoringSelection, "scoring");
    const agentKind = resolutionCredentialKind(credential);
    const scoringKind = resolutionCredentialKind(scoringCredential);
    const effectiveConfigBlocker = dualOAuthSelectionBlocker(
      connection,
      scoringConnection,
      agentKind,
      scoringKind,
    );
    if (effectiveConfigBlocker) {
      throw new Error(`CONFIG_INVALID: ${effectiveConfigBlocker.message}`);
    }
    const agentProviderKey = runModelProviderKey(connection, connection, scoringConnection, agentKind, scoringKind);
    const scoringProviderKey = runModelProviderKey(scoringConnection, connection, scoringConnection, agentKind, scoringKind);
    const scoringIsJev = isJevScoringModel(scoringConnection.provider, scoringSelection.modelId);
    const scoringUsesCursor = usesCursorConnection(scoringConnection);
    const defaultScorerIsCursorAgent = !settings.data.scoring && usesCursorConnection(connection);
    const scorerUsable = !scoringUsesCursor && !defaultScorerIsCursorAgent && (
      scoringConnection.id === connection.id
      || Boolean(scoringCredential.apiKey)
      || (scoringConnection.provider === "openai-compatible" && scoringConnection.baseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(scoringConnection.baseUrl).hostname))
    );
    if (requireScoring && !scorerUsable) {
      if (scoringUsesCursor || defaultScorerIsCursorAgent) throw new Error("SCORING_MODEL_MISSING: choose a scoring model");
      throw new Error("CREDENTIAL_MISSING: scoring connection credential is not configured");
    }
    if (!usesCursorConnection(connection)) {
      await validateNativeModelSelection(connection, selection);
    }
    if (scorerUsable && !scoringUsesCursor && !scoringIsJev) {
      await validateNativeModelSelection(scoringConnection, scoringSelection);
    }
    const runsDir = path.join(root, ".pi-jobs", "runs");
    const runDir = path.join(runsDir, runId);
    const agentDir = path.join(runDir, "pi-agent");
    await assertSafeDirectory(runDir, "run snapshot directory");
    await assertSafeDirectory(agentDir, "run agent directory");
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    let forkSessionPath: string | undefined;
    if (continueFrom) {
      forkSessionPath = await resolveContinueFromForkSource(root, continueFrom, runDir);
    }
    await assertSafeDirectory(agentDir, "run agent directory");
    const auth: Record<string, Credential> = {};
    const oauthWriteBack: Array<{
      connectionId: string;
      nativeProviderId: string;
      authKey: string;
      startedWith: Extract<Credential, { type: "oauth" }>;
    }> = [];
    addRunAuthEntry(auth, credential, agentProviderKey);
    if (credential.credential?.type === "oauth" && !usesCursorConnection(connection)) {
      oauthWriteBack.push({
        connectionId: connection.id,
        nativeProviderId: connection.provider,
        authKey: agentProviderKey,
        startedWith: credential.credential,
      });
    }
    if (scoringConnection.id !== connection.id && scorerUsable) {
      if (scoringProviderKey !== agentProviderKey || usesCursorConnection(scoringConnection)) {
        addRunAuthEntry(auth, scoringCredential, scoringProviderKey);
        if (scoringCredential.credential?.type === "oauth" && !usesCursorConnection(scoringConnection)) {
          oauthWriteBack.push({
            connectionId: scoringConnection.id,
            nativeProviderId: scoringConnection.provider,
            authKey: scoringProviderKey,
            startedWith: scoringCredential.credential,
          });
        }
      }
    }
    const providers: Record<string, Awaited<ReturnType<typeof providerConfig>>> = {};
    if (!usesCursorConnection(connection) && usesRunAliasProviderKey(agentProviderKey)) {
      const agentModels = scoringProviderKey === agentProviderKey && scorerUsable
        ? [selection, scoringSelection]
        : selection;
      providers[agentProviderKey] = await providerConfig(connection, agentModels, !credential.apiKey);
    }
    if (
      scorerUsable
      && !usesCursorConnection(scoringConnection)
      && !scoringIsJev
      && usesRunAliasProviderKey(scoringProviderKey)
      && scoringProviderKey !== agentProviderKey
    ) {
      providers[scoringProviderKey] = await providerConfig(scoringConnection, scoringSelection, !scoringCredential.apiKey);
    }
    const projectMcp = path.join(root, ".pi", "mcp.json");
    const loadsCursor = usesCursorConnection(connection) || usesCursorConnection(scoringConnection);
    try {
      await privateWrite(path.join(agentDir, "auth.json"), auth);
      if (loadsCursor) {
        await privateWrite(path.join(agentDir, "settings.json"), { packages: [piCursorSdkRoot()] });
      }
      await privateWrite(path.join(agentDir, "models.json"), { providers });
      try {
        await fs.copyFile(projectMcp, path.join(agentDir, "mcp.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (runKind === "apply" || runKind === "apply-next") {
          throw new Error("Browser tools are not configured: .pi/mcp.json is missing");
        }
      }
    } catch (error) { await fs.rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); throw error; }
    const snapshot: RunConfigSnapshot = { connectionId: connection.id, provider: connection.provider, modelId: selection.modelId, ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}), ...(selection.thinking ? { thinking: selection.thinking } : {}), credentialSource: credential.source, capturedAt: new Date().toISOString(), settingsRevision: settings.revision };
    const childEnv: NodeJS.ProcessEnv = { ...env };
    for (const key of [
      "PI_JOBS_SCORING_MODEL",
      "PI_JOBS_AGENT_MODEL",
      "PI_JOBS_SCORING_READY",
      "PI_JOBS_SCORING_KIND",
      "PI_JOBS_SCORING_JEV_MODEL",
      "PI_JOBS_SCORING_AUTH_ALIAS",
      "PI_JOBS_JEV_DECISIONS_BASE_URL",
      "PI_JOBS_RUN_ID",
      "PI_JOBS_RUN_DIR",
      "PI_JOBS_RUN_KIND",
      "PI_JOBS_APPLY_SLUG",
    ]) {
      delete childEnv[key];
    }
    for (const name of ALL_SCRUB_ENV_NAMES) delete childEnv[name];
    delete childEnv.PI_OAUTH_CALLBACK_HOST;
    for (const name of [connection.envKeyName, scoringConnection.envKeyName].filter((v): v is string => Boolean(v))) {
      delete childEnv[name];
    }
    delete childEnv.CURSOR_BACKEND_URL;
    delete childEnv.CURSOR_WEBSITE_URL;
    delete childEnv.CURSOR_DATA_DIR;
    childEnv.PI_CODING_AGENT_DIR = agentDir;
    childEnv.PI_JOBS_RUN_ID = runId;
    childEnv.PI_JOBS_RUN_DIR = path.resolve(runDir);
    childEnv.PI_JOBS_RUN_KIND = runKind;
    if (runKind === "apply" || runKind === "apply-next") {
      const applySlug = sessionName.startsWith("ui:") ? sessionName.slice(3) : "";
      if (applySlug && applySlug !== "apply" && applySlug !== "gather" && applySlug !== "score" && applySlug !== "status") {
        childEnv.PI_JOBS_APPLY_SLUG = applySlug;
      }
    }
    const agentModelRef = runModelRef(selection.modelId, agentProviderKey);
    const scoringModelRef = runModelRef(scoringSelection.modelId, scoringProviderKey);
    childEnv.PI_JOBS_AGENT_MODEL = agentModelRef;
    if (scoringIsJev) {
      childEnv.PI_JOBS_SCORING_KIND = scoringConnection.provider === JEV_TYPESAFE_PROVIDER ? "jev-typesafe" : "jev-openrouter";
      childEnv.PI_JOBS_SCORING_JEV_MODEL = scoringSelection.modelId;
      childEnv.PI_JOBS_SCORING_AUTH_ALIAS = scoringProviderKey;
      if (env.PI_JOBS_JEV_DECISIONS_BASE_URL !== undefined) {
        childEnv.PI_JOBS_JEV_DECISIONS_BASE_URL = env.PI_JOBS_JEV_DECISIONS_BASE_URL;
      }
    } else {
      childEnv.PI_JOBS_SCORING_MODEL = scoringModelRef;
    }
    if (scorerUsable) childEnv.PI_JOBS_SCORING_READY = "1";
    if (loadsCursor) {
      const cursorDataDir = path.join(runDir, "cursor-data");
      await fs.mkdir(cursorDataDir, { recursive: true, mode: 0o700 });
      childEnv.CURSOR_DATA_DIR = cursorDataDir;
      childEnv.PI_CURSOR_SDK_STATE_ROOT = path.join(runDir, "cursor-state");
      childEnv.PI_CURSOR_SETTING_SOURCES = "none";
      const cursorBackend = validatedCursorChildBackend(connection);
      if (cursorBackend) childEnv.CURSOR_BACKEND_URL = cursorBackend;
    }
    const runAuthPath = path.join(agentDir, "auth.json");
    const beforeCleanup = oauthWriteBack.length
      ? async () => {
          let runAuthText: string;
          try {
            runAuthText = await fs.readFile(runAuthPath, "utf8");
          } catch {
            throw new Error("run credential snapshot is unavailable");
          }
          const runAuth = parseAuthStoreText(runAuthText, "run credential snapshot is malformed");
          for (const target of oauthWriteBack) {
            const entry = runAuth[target.authKey];
            if (!entry || entry.type !== "oauth") continue;
            try {
              await writeBackRunOAuthCredential(
                root,
                target.connectionId,
                target.nativeProviderId,
                entry,
                target.startedWith,
              );
            } catch (error) {
              if (error instanceof ProviderServiceError && error.code === "LOGIN_IN_PROGRESS") {
                console.warn(
                  `OAuth write-back deferred for connection ${target.connectionId}: sign-in is in progress.`,
                );
              }
              throw error;
            }
          }
        }
      : undefined;
    const cfg = { model: agentModelRef, thinking: agentThinking, bin: process.execPath };
    return {
      command: process.execPath,
      args: [piCliPath(), ...piArgs(cfg, sessionName, forkSessionPath)],
      env: childEnv,
      model: cfg.model,
      snapshot,
      oauthWriteBack,
      beforeCleanup,
      cleanup: async () => {
        if (runKind === "chat") await saveChatSession(root, runId, runDir).catch(() => {});
        await fs.rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  });
}
