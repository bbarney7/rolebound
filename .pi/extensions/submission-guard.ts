/**
 * Submission guard — blocks tool calls that violate submission boundaries (PJR-15).
 * Always loaded; inert outside the workspace root. See `lib/submission-policy.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToCwd } from "./lib/pi-path-resolve";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readApplicationStateStrict } from "./lib/applications";
import {
  classifyToolCall,
  evaluateApplyRunGate,
  evaluateGate,
  jobPlaywrightToolName,
  writeObservation,
  type ClassifiedToolCall,
  type GateContext,
  type GateResult,
  type ObservationRead,
  type StrictStateResult,
  type ToolCallKind,
} from "./lib/submission-policy";
import { isInWorkspace, WORKSPACE } from "./lib/workspace";
import { resolveQueueSlug } from "./lib/queue-slug";
import { parseRecordedJobFile, type ParsedStateJson } from "./lib/workspace-files";

type SubmitCorrelation = {
  slug: string;
  scriptKind: "submit" | "otp";
  parentToolCallId?: string;
};

const submitCorrelation = new Map<string, SubmitCorrelation>();
const browserCallsInFlight = new Set<string>();
let currentPageUrl: string | undefined;
let chatApplySlug: string | undefined;

const STATE_READ_KINDS = new Set<ToolCallKind>([
  "browser_navigation",
  "browser_mutating",
  "submit_script",
  "greenhouse_submit_prep",
  "paid",
  "state_override",
]);

function runEnv(): {
  runId?: string;
  runDir?: string;
  kind?: string;
  applySlug?: string;
} {
  return {
    runId: process.env.PI_JOBS_RUN_ID?.trim() || undefined,
    runDir: process.env.PI_JOBS_RUN_DIR?.trim() || undefined,
    kind: process.env.PI_JOBS_RUN_KIND?.trim() || undefined,
    applySlug: process.env.PI_JOBS_RUN_KIND === "chat"
      ? chatApplySlug
      : process.env.PI_JOBS_APPLY_SLUG?.trim() || undefined,
  };
}

function resolveWithRealpathAncestor(resolved: string): string | null {
  let pending = "";
  let cur = resolved;
  for (;;) {
    if (existsSync(cur)) {
      try {
        const real = realpathSync(cur);
        return pending ? path.join(real, pending) : real;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    const base = path.basename(cur);
    pending = pending ? path.join(base, pending) : base;
    cur = parent;
  }
}

function makeResolvePath(cwd: string, home: string): (filePath: string) => string | null {
  return (filePath: string): string | null => {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    try {
      const resolved = resolveToCwd(filePath, cwd, home);
      return resolveWithRealpathAncestor(resolved);
    } catch {
      return null;
    }
  };
}

function queueFilenameMatchesSlug(fileSlug: string, appSlug: string): boolean {
  return resolveQueueSlug(fileSlug) === appSlug;
}

function queueFileExists(root: string, state: ParsedStateJson, appSlug: string): boolean {
  let filenames: string[];
  try {
    filenames = readdirSync(path.join(root, "jobs", "queue"));
  } catch {
    return false;
  }
  const exactQueueFile = filenames.some((name) => name.endsWith(".md") &&
    queueFilenameMatchesSlug(name.slice(0, -3), appSlug));
  const apps = state.applications;
  if (!Array.isArray(apps)) return exactQueueFile;
  let entry: Record<string, unknown> | undefined;
  for (const item of apps) {
    if (item !== null && typeof item === "object" && (item as Record<string, unknown>).slug === appSlug) {
      entry = item as Record<string, unknown>;
      break;
    }
  }
  const recorded = typeof entry?.queue_file === "string" ? entry.queue_file.trim() : "";
  if (recorded) {
    const parsed = parseRecordedJobFile(recorded);
    if (parsed?.dir === "applied" && entry?.status === "submitted") {
      return false;
    }
    if (parsed?.dir === "queue" && queueFilenameMatchesSlug(parsed.slug, appSlug)) {
      if (filenames.includes(path.basename(recorded))) return true;
    }
  }
  return exactQueueFile;
}

/**
 * A prefixed queue filename (`2024-summer`) names the same application as its apply slug
 * (`summer`), but the tools key state, CAPTCHA counts and scripts by the slug they are given.
 * Ask for the canonical slug instead of mapping it, so the guard and the tools agree.
 */
function prefixedApplySlugAlias(call: ClassifiedToolCall, root: string): string | null {
  const { applySlug } = runEnv();
  if (!call.slug || !applySlug || call.slug === applySlug || resolveQueueSlug(call.slug) !== applySlug) return null;
  try {
    if (readdirSync(path.join(root, "jobs", "queue")).includes(`${call.slug}.md`)) return applySlug;
  } catch {
    // Missing or unreadable queue fails closed in the policy.
  }
  return null;
}

function aliasReason(alias: string, applySlug: string): string {
  return `STATE_INVALID: "${alias}" is the queue filename; use slug "${applySlug}" in tool calls and retry`;
}

function readObservationSync(root: string, slug: string): ObservationRead {
  const file = path.join(root, ".pi-jobs", "observed", `${slug}.json`);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).slug !== "string" ||
      typeof (parsed as Record<string, unknown>).state !== "string" ||
      typeof (parsed as Record<string, unknown>).source !== "string" ||
      typeof (parsed as Record<string, unknown>).at !== "string" ||
      typeof (parsed as Record<string, unknown>).runId !== "string"
    ) {
      return { status: "corrupt" };
    }
    const rec = parsed as Record<string, string>;
    return {
      status: "ok",
      value: {
        slug: rec.slug,
        state: rec.state,
        source: rec.source,
        at: rec.at,
        runId: rec.runId,
      },
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "missing" };
    return { status: "corrupt" };
  }
}

function parseSubmitResultText(text: string): { state?: string } | null {
  const marker = /^### Result[ \t]*\r?\n/m.exec(text);
  if (!marker) return null;
  const rest = text.slice(marker.index + marker[0].length);
  const nextHeading = rest.search(/^### /m);
  const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  try {
    const parsed = JSON.parse(body.trim()) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const state = (parsed as Record<string, unknown>).state;
    return { state: typeof state === "string" ? state : undefined };
  } catch {
    return null;
  }
}

function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n");
}

function appendWarningToContent(
  content: Array<{ type: string; text?: string }>,
  warning: string,
): Array<{ type: string; text?: string }> {
  if (content.length === 0) {
    return [{ type: "text", text: warning }];
  }
  const next = content.map((c) => ({ ...c }));
  const last = next[next.length - 1];
  if (last.type === "text" && typeof last.text === "string") {
    last.text = `${last.text}\n${warning}`;
  } else {
    next.push({ type: "text", text: warning });
  }
  return next;
}

function scriptKindFromFilename(filename: string): "submit" | "otp" | null {
  const base = path.basename(filename);
  if (base.endsWith("-submit.js")) return "submit";
  if (base.endsWith("-otp.js")) return "otp";
  return null;
}

const UNRESOLVABLE_PATH_REASON =
  "STATE_DIRECT_WRITE: path could not be resolved; use application tools, the dashboard Queue, or Settings instead; stop; do not retry through another tool";

async function buildGateContext(
  root: string,
  cwd: string,
  kind: ToolCallKind,
  resolvePathStrict: (p: string) => string | null,
): Promise<GateContext> {
  const env = runEnv();
  const runDir = env.runDir;
  const stopMarkerExists = runDir ? existsSync(path.join(runDir, "stop.json")) : false;
  const runDirExists = runDir ? existsSync(runDir) : false;

  let state: StrictStateResult = { ok: true, value: { applications: [], addresses: {} } };
  if (STATE_READ_KINDS.has(kind)) {
    const read = await readApplicationStateStrict();
    if ("error" in read) {
      state = { ok: false, corrupt: true };
    } else {
      state = { ok: true, value: read };
    }
  }

  const stateValue = state.ok ? state.value : null;

  return {
    root,
    cwd,
    platform: process.platform,
    runId: env.runId,
    runDir,
    kind: env.kind,
    applySlug: env.applySlug,
    stopMarkerExists,
    runDirExists,
    state,
    queueFileExists: (slug: string) =>
      stateValue ? queueFileExists(root, stateValue, slug) : false,
    observationForSlug: (slug: string) => readObservationSync(root, slug),
    now: Date.now(),
    resolvePath: (p: string) => resolvePathStrict(p),
  };
}

export async function evaluateWorkspaceToolGate(
  cwd: string,
  toolName: string,
  input: unknown,
): Promise<GateResult> {
  if (!isInWorkspace(cwd)) return { allow: true };

  const root = WORKSPACE;
  const platform = process.platform;
  const home = os.homedir();
  const resolvePathStrict = makeResolvePath(cwd, home);

  if (
    (toolName === "write" || toolName === "edit") &&
    input !== null &&
    typeof input === "object" &&
    typeof (input as { path?: string }).path === "string"
  ) {
    const rawPath = (input as { path: string }).path;
    const resolved = resolvePathStrict(rawPath);
    if (resolved === null) {
      return {
        allow: false,
        code: "STATE_DIRECT_WRITE",
        reason: UNRESOLVABLE_PATH_REASON,
        terminate: true,
      };
    }
  }

  const classified = classifyToolCall(toolName, input, {
    root,
    cwd,
    platform,
    home,
    resolvePath: (p) => resolvePathStrict(p),
  });
  const canonical = prefixedApplySlugAlias(classified, root);
  if (canonical) {
    return { allow: false, code: "STATE_INVALID", reason: aliasReason(classified.slug!, canonical), terminate: false };
  }

  const context = await buildGateContext(root, cwd, classified.kind, resolvePathStrict);
  return evaluateGate(
    { ...classified, toolName, input },
    { ...context, currentPageUrl, browserBusy: browserCallsInFlight.size > 0 },
  );
}

export default function submissionGuard(pi: ExtensionAPI): void {
  pi.on("turn_end", () => { browserCallsInFlight.clear(); });
  pi.on("agent_end", () => { browserCallsInFlight.clear(); });
  pi.on("session_shutdown", () => {
    browserCallsInFlight.clear();
    submitCorrelation.clear();
    currentPageUrl = undefined;
    chatApplySlug = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isInWorkspace(ctx.cwd)) return;

    const root = WORKSPACE;
    const platform = process.platform;
    const home = os.homedir();
    const resolvePathStrict = makeResolvePath(ctx.cwd, home);

    if (
      (event.toolName === "write" || event.toolName === "edit") &&
      event.input !== null &&
      typeof event.input === "object" &&
      typeof (event.input as { path?: string }).path === "string"
    ) {
      const rawPath = (event.input as { path: string }).path;
      const resolved = resolvePathStrict(rawPath);
      if (resolved === null) {
        return { block: true, reason: UNRESOLVABLE_PATH_REASON, terminate: true };
      }
    }

    const classified = classifyToolCall(event.toolName, event.input, {
      root,
      cwd: ctx.cwd,
      platform,
      home,
      resolvePath: (p) => resolvePathStrict(p),
    });
    const canonical = prefixedApplySlugAlias(classified, root);
    if (canonical) {
      return { block: true, reason: aliasReason(classified.slug!, canonical), terminate: false };
    }

    const context = await buildGateContext(root, ctx.cwd, classified.kind, resolvePathStrict);
    // Check and reserve without yielding, including concurrent codemode preparations.
    const gate = evaluateGate(
      { ...classified, toolName: event.toolName, input: event.input },
      { ...context, currentPageUrl, browserBusy: browserCallsInFlight.size > 0 },
    );
    if (!gate.allow) {
      return { block: true, reason: gate.reason, terminate: gate.terminate };
    }

    if (jobPlaywrightToolName(event.toolName, event.input)) {
      browserCallsInFlight.add(event.toolCallId);
    }

    if (classified.kind === "submit_script" && classified.slug) {
      const filename =
        typeof (event.input as { filename?: string }).filename === "string"
          ? (event.input as { filename: string }).filename
          : "";
      const scriptKind = scriptKindFromFilename(filename) ?? "submit";
      submitCorrelation.set(event.toolCallId, {
        slug: classified.slug,
        scriptKind,
        parentToolCallId: event.parentToolCallId,
      });
    }
  });

  // pi-coding-agent types omit tool_result; T0 spike confirms the event at runtime.
  (pi as ExtensionAPI & { on(event: "tool_result", handler: typeof toolResultHandler): void }).on(
    "tool_result",
    toolResultHandler,
  );
}

async function toolResultHandler(event: {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  isError?: boolean;
  parentToolCallId?: string;
  content: Array<{ type: string; text?: string }>;
}, ctx: { cwd: string }) {
    if (!isInWorkspace(ctx.cwd)) return;

    browserCallsInFlight.delete(event.toolCallId);
    if (process.env.PI_JOBS_RUN_KIND === "chat" && event.toolName === "update_application_state" && event.isError !== true) {
      const input = event.input as { slug?: unknown } | undefined;
      const state = await readApplicationStateStrict();
      if (typeof input?.slug === "string" && input.slug !== chatApplySlug && !("error" in state) &&
          state.applications?.some(app => app !== null && typeof app === "object" && (app as { slug?: unknown }).slug === input.slug)) {
        // Selecting a new application in chat passes the same start gate a dedicated apply run
        // does (acknowledgement, duplicate URL, unrecorded submission, rate limit). Later updates
        // to the selected slug are not re-gated, so post-submit steps such as an OTP still work.
        const gate = await evaluateApplyRunGate(WORKSPACE, input.slug).catch((error: unknown) => ({
          ok: false as const,
          code: "STATE_INVALID" as const,
          message: error instanceof Error ? error.message : String(error),
        }));
        if (gate.ok) {
          chatApplySlug = input.slug;
        } else {
          return {
            content: appendWarningToContent(
              event.content as Array<{ type: string; text?: string }>,
              `[submission-guard] ${input.slug} cannot be applied to: ${gate.code}: ${gate.message}`,
            ),
          };
        }
      }
    }
    const text = textFromContent(event.content);
    if (jobPlaywrightToolName(event.toolName, event.input)) {
      let inPage = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^### /.test(line)) inPage = /^### Page[ \t]*$/.test(line);
        if (!inPage) continue;
        const match = /^- Page URL:[ \t]*(\S.*)$/.exec(line);
        if (match) currentPageUrl = match[1].trim();
      }
    }

    let corr = submitCorrelation.get(event.toolCallId);
    if (!corr && event.parentToolCallId) {
      corr = submitCorrelation.get(event.parentToolCallId);
    }
    if (!corr) return;

    const parsed = parseSubmitResultText(text);
    if (!parsed?.state || (parsed.state !== "submitted" && parsed.state !== "otp_required")) {
      if (parsed === null) {
        return {
          content: appendWarningToContent(
            event.content as Array<{ type: string; text?: string }>,
            "[submission-guard] warning: could not parse submit script result for observation",
          ),
        };
      }
      return undefined;
    }

    const { runId } = runEnv();
    const source = corr.scriptKind === "otp" ? "greenhouse_otp_script" : "greenhouse_submit_script";
    try {
      await writeObservation(WORKSPACE, {
        slug: corr.slug,
        state: parsed.state,
        source,
        at: new Date().toISOString(),
        runId: runId ?? "terminal",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: appendWarningToContent(
          event.content as Array<{ type: string; text?: string }>,
          `[submission-guard] failed to persist observation: ${msg}`,
        ),
      };
    }
    return undefined;
}
