import { promises as fs } from "node:fs";
import path from "node:path";
import { isFilledProfileValue, isValidProfileEmail, parseProfile } from "../../.pi/extensions/lib/profile";
import { readProfile } from "./readers/profile";
import { readResumes } from "./readers/library";
import { parseTargetsMarkdown } from "./readers/targets";
import { listConnections, readAuth } from "./providers/providerService";
import { selectionConfigBlockers } from "./providers/selectionRules";
import { providerAlias } from "./providers/providerIds";
import type { StoredAuth } from "./providers/authStoreFile";
import { isolatedMetadataRuntime } from "./providers/metadataRuntime";
import { readApplicationSettings } from "./applicationConfigStore";
import { readJsonFile, WorkspaceFileError } from "../../.pi/extensions/lib/durable-store";
import { parseStateText } from "../../.pi/extensions/lib/workspace-files";
import { withLock } from "./lock";
import { paths } from "./workspace";
import {
  AUTO_SUBMIT_POLICY_VERSION,
  isVersionedAutoSubmitAcknowledged,
  MIN_SUBMIT_INTERVAL_MS,
} from "../shared/autoSubmitPolicy";
import type { Connection, ConnectionView } from "../shared/config";
import type {
  ProfilePayload,
  ReadinessAcknowledgement,
  ReadinessBlocker,
  ReadinessPayload,
  ReadinessWarning,
  SetupStep,
  SetupStepId,
  ResumesPayload,
} from "../shared/types";
import { ensureCursorCatalog, isKnownCursorPiModelId } from "./providers/cursorModels";
import { cursorCredentialExpiryReadiness } from "./providers/cursorReadiness";
import { isJevAgentSelection, isJevScoringModel, JEV_AGENT_READINESS_MESSAGE } from "../shared/jevModels";

export const CURSOR_MIN_NODE_MAJOR = 24;

function productionNodeMajor(): number {
  const match = process.versions.node.match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

function cursorNodeBlockers(connection: ConnectionView | undefined, nodeMajor: number): ReadinessBlocker[] {
  if (!connection || connection.provider !== "cursor") return [];
  if (nodeMajor >= CURSOR_MIN_NODE_MAJOR) return [];
  return [blocker("CURSOR_NODE_VERSION", "Cursor needs Node 24+", "/settings")];
}
import {
  analyzeProfilePlaceholders,
  PROFILE_PLACEHOLDERS_CODE,
  profilePlaceholderApplyMessage,
  profilePlaceholderHref,
  profilePlaceholderScoreMessage,
  TARGETS_PLACEHOLDER_CODE,
  targetsArePlaceholderOnly,
} from "../shared/profilePlaceholders";

const blocker = (code: string, message: string, href: string): ReadinessBlocker => ({ code, message, href });

function isKeylessLoopback(connection: Connection | undefined): boolean {
  if (!connection || connection.provider !== "openai-compatible" || !connection.baseUrl) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(connection.baseUrl).hostname);
  } catch {
    return false;
  }
}

function oauthConnectionBlockers(connection: ConnectionView | undefined): ReadinessBlocker[] {
  if (!connection || connection.credential?.source !== "oauth") return [];
  if (connection.refreshFailedAt) {
    return [blocker("CREDENTIAL_EXPIRED", "Sign in again", "/settings")];
  }
  return [];
}

function copilotModelBlockers(
  connection: ConnectionView | undefined,
  modelId: string | undefined,
  auth: StoredAuth,
): ReadinessBlocker[] {
  if (!connection || !modelId || connection.provider !== "github-copilot") return [];
  const stored = auth[providerAlias(connection.id)];
  if (!stored || stored.type !== "oauth") return [];
  const ids = (stored as { availableModelIds?: unknown }).availableModelIds;
  if (!Array.isArray(ids)) return [];
  if (!ids.includes(modelId)) {
    return [blocker("MODEL_UNAVAILABLE", `Model ${modelId} is not available on this Copilot account.`, "/settings")];
  }
  return [];
}

async function agentModelBlockers(
  connection: ConnectionView | undefined,
  modelId: string | undefined,
  thinking?: string,
  role: "agent" | "scoring" = "agent",
  auth: StoredAuth = {},
  nodeMajor = productionNodeMajor(),
): Promise<{ blockers: ReadinessBlocker[]; warnings: ReadinessWarning[] }> {
  const blockers: ReadinessBlocker[] = [];
  const warnings: ReadinessWarning[] = [];
  if (!connection || !modelId) {
    blockers.push(blocker("AGENT_MODEL_MISSING", "Choose an agent connection and model.", "/settings"));
    return { blockers, warnings };
  }
  blockers.push(...cursorNodeBlockers(connection, nodeMajor));
  blockers.push(...oauthConnectionBlockers(connection));
  blockers.push(...copilotModelBlockers(connection, modelId, auth));
  if (!connection.credential?.configured && !isKeylessLoopback(connection)) {
    blockers.push(blocker("CREDENTIAL_MISSING", `Add credentials for ${connection.label}.`, "/settings"));
  }
  if (role === "scoring" && isJevScoringModel(connection.provider, modelId)) {
    return { blockers, warnings };
  }
  if (role === "agent" && isJevAgentSelection(connection.provider, modelId)) {
    blockers.push(blocker("AGENT_MODEL_MISSING", JEV_AGENT_READINESS_MESSAGE, "/settings"));
    return { blockers, warnings };
  }
  if (connection.provider === "cursor") {
    await ensureCursorCatalog();
    if (connection.credential?.source === "app-store") {
      const expiry = cursorCredentialExpiryReadiness(connection, Date.now());
      blockers.push(...expiry.blockers.map((item) => blocker(item.code, item.message, item.href)));
      warnings.push(...expiry.warnings);
    }
    if (!isKnownCursorPiModelId(modelId)) {
      warnings.push({
        code: "MODEL_UNVERIFIED",
        message: `Model ${modelId} is not in the bundled Cursor catalog.`,
        href: "/settings",
      });
    }
    return { blockers, warnings };
  }
  try {
    const registry = await isolatedMetadataRuntime();
    const native = connection.provider === "openai-compatible" ? undefined : registry.getModel(connection.provider, modelId);
    if (connection.provider !== "openai-compatible" && !native) {
      blockers.push(blocker("MODEL_UNAVAILABLE", `Model ${modelId} is not in the ${connection.provider} catalog.`, "/settings"));
      return { blockers, warnings };
    }
    if (thinking && thinking !== "off") {
      if (!native) {
        blockers.push(blocker("MODEL_UNAVAILABLE", "Reasoning requires a catalog model with known capabilities.", "/settings"));
      } else if (!native.reasoning || (native.thinkingLevelMap && native.thinkingLevelMap[thinking as keyof typeof native.thinkingLevelMap] === null)) {
        blockers.push(blocker("MODEL_UNAVAILABLE", "Selected reasoning level is unsupported for this model.", "/settings"));
      }
    }
    if (native && Array.isArray(native.input) && !native.input.includes("text")) {
      blockers.push(blocker("TOOLS_UNSUPPORTED", "Selected model cannot accept text input required for agent tools.", "/settings"));
    }
  } catch {
    blockers.push(blocker("MODEL_UNAVAILABLE", "Could not validate the selected agent model.", "/settings"));
  }
  return { blockers, warnings };
}

function scoringSelectionBlockers(
  agentConnection: ConnectionView | undefined,
  scoringConnection: ConnectionView | undefined,
  scoringOverride: boolean,
): ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];
  if (scoringConnection?.provider === "cursor") {
    blockers.push(blocker("SCORING_MODEL_MISSING", "Choose a scoring model", "/settings"));
    return blockers;
  }
  if (!scoringOverride && agentConnection?.provider === "cursor") {
    blockers.push(blocker("SCORING_MODEL_MISSING", "Choose a scoring model", "/settings"));
  }
  return blockers;
}

function profilePlaceholderApplyBlockers(applySections: import("../shared/types").ProfileSectionId[]): ReadinessBlocker[] {
  if (applySections.length === 0) return [];
  return [
    blocker(
      PROFILE_PLACEHOLDERS_CODE,
      profilePlaceholderApplyMessage(applySections),
      profilePlaceholderHref(applySections),
    ),
  ];
}

function scorePlaceholderBlockers(scoreSections: import("../shared/types").ProfileSectionId[]): ReadinessBlocker[] {
  if (scoreSections.length === 0) return [];
  return [
    blocker(
      PROFILE_PLACEHOLDERS_CODE,
      profilePlaceholderScoreMessage(scoreSections),
      profilePlaceholderHref(scoreSections),
    ),
  ];
}

function scoreCandidateSummaryBlockers(profile: ProfilePayload, profileMd: string): ReadinessBlocker[] {
  if (!profile.exists) {
    return [blocker("PROFILE_MISSING", "Create profile.md.", "/profile")];
  }
  const summary = parseProfile(profileMd).candidateSummary?.trim();
  if (!summary) {
    return [
      blocker(
        "CANDIDATE_SUMMARY_MISSING",
        "Add a candidate summary or fill in Identity and Work history",
        "/profile?tab=candidateSummary",
      ),
    ];
  }
  return [];
}

function profileBlockers(profile: ProfilePayload): ReadinessBlocker[] {
  if (!profile.exists) return [blocker("PROFILE_MISSING", "Create profile.md.", "/profile")];
  const identity = profile.identity?.parsed;
  const blockers: ReadinessBlocker[] = [];
  if (!isFilledProfileValue(identity?.fullName)) {
    blockers.push(blocker("NAME_MISSING", "Add your full name.", "/profile?tab=identity"));
  }
  if (!isValidProfileEmail(identity?.email)) {
    blockers.push(blocker("EMAIL_MISSING", "Add a valid email address.", "/profile?tab=identity"));
  }
  return blockers;
}

/** Mirrors `resolveResumePath`: global override, `resumes/default.pdf`, or a region-keyed PDF. */
function resumeApplyReady(profile: ProfilePayload, resumes: ResumesPayload): boolean {
  if (profile.resume?.overridePath) return profile.resume.overrideExists === true;
  return resumes.files.some((file) => file.reachability === "default" || file.reachability === "region");
}

function readAcknowledgementFields(raw: {
  acknowledged_at?: string | null;
  acknowledged_policy?: string | null;
}): ReadinessAcknowledgement {
  const at = typeof raw.acknowledged_at === "string" && raw.acknowledged_at.length > 0 ? raw.acknowledged_at : null;
  const policy =
    typeof raw.acknowledged_policy === "string" && raw.acknowledged_policy.length > 0
      ? raw.acknowledged_policy
      : null;
  return { at, policy, current: AUTO_SUBMIT_POLICY_VERSION };
}

function acknowledgementBlockers(ack: ReadinessAcknowledgement): ReadinessBlocker[] {
  if (isVersionedAutoSubmitAcknowledged(ack.at, ack.policy)) return [];
  if (ack.at) {
    return [
      blocker(
        "ACKNOWLEDGEMENT_LEGACY",
        "Rolebound now states plainly that it submits applications automatically. Review and acknowledge again.",
        "/setup",
      ),
    ];
  }
  return [blocker("ACKNOWLEDGEMENT_MISSING", "Acknowledge automatic submission before applying.", "/setup")];
}

export async function computeReadiness(
  root: string,
  runtime: { nodeMajor?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ReadinessPayload> {
  const currentNodeMajor = runtime.nodeMajor ?? productionNodeMajor();
  const [profile, resumes, connections, settings] = await Promise.all([
    readProfile(root),
    readResumes(root),
    listConnections(root, runtime.env),
    readApplicationSettings(root),
  ]);
  let acknowledgement: ReadinessAcknowledgement = { at: null, policy: null, current: AUTO_SUBMIT_POLICY_VERSION };
  try {
    const raw = JSON.parse(await fs.readFile(paths.stateJson(root), "utf8")) as {
      acknowledged_at?: string | null;
      acknowledged_policy?: string | null;
    };
    acknowledgement = readAcknowledgementFields(raw);
  } catch {
    acknowledgement = { at: null, policy: null, current: AUTO_SUBMIT_POLICY_VERSION };
  }
  let targets = "";
  try {
    targets = await fs.readFile(path.join(root, "targets.md"), "utf8");
  } catch {
    /* absent targets.md */
  }
  let profileMd = "";
  if (profile.exists) {
    try {
      profileMd = await fs.readFile(path.join(root, "profile.md"), "utf8");
    } catch {
      profileMd = "";
    }
  }
  const placeholderAnalysis = profile.exists ? analyzeProfilePlaceholders(profileMd) : { applySections: [], scoreSections: [] };
  const placeholderApplyBlockers = profilePlaceholderApplyBlockers(placeholderAnalysis.applySections);
  const scoreBlockers = scorePlaceholderBlockers(placeholderAnalysis.scoreSections);

  const auth = await readAuth(root);
  const selectionBlockers = selectionConfigBlockers(settings.data, auth).map((item) =>
    blocker(item.code, item.message, "/settings"),
  );
  const active = connections.data.connections.find((c) => c.id === settings.data.agent?.connectionId);
  const targetEntries = parseTargetsMarkdown(targets);
  const agentReadiness = await agentModelBlockers(
    active,
    settings.data.agent?.modelId,
    settings.data.agent?.thinking,
    "agent",
    auth,
    currentNodeMajor,
  );
  const connectionBlockers = [...selectionBlockers, ...agentReadiness.blockers];
  const readinessWarnings = [...agentReadiness.warnings];
  const scoringSelection = settings.data.scoring ?? settings.data.agent;
  const scoringConnection = scoringSelection
    ? connections.data.connections.find((c) => c.id === scoringSelection.connectionId)
    : undefined;
  const scoringOverride =
    settings.data.scoring &&
    (settings.data.scoring.connectionId !== settings.data.agent?.connectionId ||
      settings.data.scoring.modelId !== settings.data.agent?.modelId ||
      settings.data.scoring.thinking !== settings.data.agent?.thinking);
  const scoringConnectionReadiness = scoringOverride
    ? await agentModelBlockers(
        scoringConnection,
        scoringSelection?.modelId,
        scoringSelection?.thinking,
        "scoring",
        auth,
        currentNodeMajor,
      )
    : { blockers: [], warnings: [] };
  const scoringConnectionBlockers = scoringOverride
    ? [...selectionBlockers, ...scoringConnectionReadiness.blockers]
    : scoringConnectionReadiness.blockers;
  readinessWarnings.push(...scoringConnectionReadiness.warnings);
  const scoringBlockers = scoringSelectionBlockers(active, scoringConnection, Boolean(scoringOverride));
  const mergeScoreBlockers = (...lists: ReadinessBlocker[][]): ReadinessBlocker[] => {
    const seen = new Set<string>();
    const out: ReadinessBlocker[] = [];
    for (const list of lists) {
      for (const blocker of list) {
        if (seen.has(blocker.code)) continue;
        seen.add(blocker.code);
        out.push(blocker);
      }
    }
    return out;
  };
  // A score run still starts pi with the agent model, so the agent's blockers apply too.
  const scoreBlockersFull = mergeScoreBlockers(
    connectionBlockers,
    scoringOverride ? scoringConnectionBlockers : [],
    scoringBlockers,
    scoreBlockers,
    scoreCandidateSummaryBlockers(profile, profileMd),
  );
  const profileBlockersList = [...profileBlockers(profile), ...placeholderApplyBlockers];
  const resumeBlockers = resumeApplyReady(profile, resumes)
    ? []
    : [blocker("RESUME_MISSING", "Upload and select a default or global PDF resume.", "/profile?tab=resumes")];
  const targetBlockers = targetEntries.length === 0
    ? [blocker("TARGETS_MISSING", "Add at least one valid ATS company target.", "/discover")]
    : targetsArePlaceholderOnly(targetEntries)
      ? [blocker(TARGETS_PLACEHOLDER_CODE, "Replace the example targets with real company board slugs", "/discover")]
      : [];
  const ackBlockers = acknowledgementBlockers(acknowledgement);
  const stateCorruptBlockers: ReadinessBlocker[] = [];
  try {
    await readJsonFile(paths.stateJson(root), parseStateText);
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
      stateCorruptBlockers.push(
        blocker("STATE_CORRUPT", "state.json is corrupt. Repair it before applying.", "/setup"),
      );
    }
  }
  const defs: Array<[SetupStepId, ReadinessBlocker[]]> = [
    ["connection", connectionBlockers],
    ["profile", profileBlockersList],
    ["resume", resumeBlockers],
    ["targets", targetBlockers],
    ["readiness", [...connectionBlockers, ...profileBlockersList, ...resumeBlockers, ...ackBlockers, ...stateCorruptBlockers]],
  ];
  const steps: SetupStep[] = defs.map(([id, blockers]) => ({ id, blockers, complete: blockers.length === 0, optional: false }));
  const complete = (id: SetupStepId) => steps.find((s) => s.id === id)!.complete;
  const applyReady = complete("connection") && complete("profile") && complete("resume") && ackBlockers.length === 0;
  return {
    steps,
    browseReady: true,
    discoverReady: complete("targets"),
    applyReady,
    scoreReady: scoreBlockersFull.length === 0,
    scoreBlockers: scoreBlockersFull,
    warnings: readinessWarnings,
    captchaOptional: true,
    acknowledgement,
    serverRuntime: { nodeMajor: currentNodeMajor },
  };
}

/** Exact token required by the pi `/acknowledge` command and supervised run gate. */
export const SUPERVISED_ACKNOWLEDGEMENT_TOKEN = "ACKNOWLEDGE";

export class AcknowledgementValidationError extends Error {
  readonly code = "ACKNOWLEDGEMENT_REQUIRED";

  constructor() {
    super("acknowledgement must be the exact token ACKNOWLEDGE");
  }
}

export function parseAcknowledgementBody(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AcknowledgementValidationError();
  }
  if ((body as { acknowledgement?: unknown }).acknowledgement !== SUPERVISED_ACKNOWLEDGEMENT_TOKEN) {
    throw new AcknowledgementValidationError();
  }
}

async function ensureStateFile(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw Object.assign(new Error("state.json is unsafe"), { code: "UNSAFE_STATE" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(file, "{}\n", { flag: "wx", mode: 0o600 });
      return;
    }
    throw error;
  }
}

/** One-time ethics gate: set versioned acknowledgement without touching unrelated fields. */
export async function recordSupervisedAcknowledgement(
  root: string,
  runtime: { nodeMajor?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ReadinessPayload> {
  const file = paths.stateJson(root);
  await ensureStateFile(file);
  await withLock(file, async () => {
    const rawText = await fs.readFile(file, "utf8");
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("state.json must be an object");
    }
    const at = typeof raw.acknowledged_at === "string" ? raw.acknowledged_at : null;
    const policy = typeof raw.acknowledged_policy === "string" ? raw.acknowledged_policy : null;
    if (!isVersionedAutoSubmitAcknowledged(at, policy)) {
      raw.acknowledged_at = new Date().toISOString();
      raw.acknowledged_policy = AUTO_SUBMIT_POLICY_VERSION;
      const tmp = path.join(path.dirname(file), `.state.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
  });
  return computeReadiness(root, runtime);
}

/** Documented apply rate limit (Settings copy). */
export const APPLY_RATE_LIMIT_MS = MIN_SUBMIT_INTERVAL_MS;
