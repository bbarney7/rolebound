import { promises as fs } from "node:fs";
import path from "node:path";
import { readApplicationState } from "./applications";
import { atomicWriteFile } from "./durable-store";
import { resolveToCwd } from "./pi-path-resolve";
import { resolveQueueJob } from "./queue-slug";
import { isSafeSlug, type ParsedStateJson } from "./workspace-files";
import {
  AUTO_SUBMIT_POLICY_VERSION,
  isVersionedAutoSubmitAcknowledged,
  MIN_SUBMIT_INTERVAL_MS,
} from "../../../ui/shared/autoSubmitPolicy";

export { AUTO_SUBMIT_POLICY_VERSION, MIN_SUBMIT_INTERVAL_MS };
export const MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION = 2;

export type ToolCallKind =
  | "off_pipeline_browser"
  | "queue_mutation"
  | "workspace_mutation"
  | "invalid_slug"
  | "read_only"
  | "browser_navigation"
  | "browser_mutating"
  | "submit_script"
  | "unsafe_code"
  | "paid"
  | "greenhouse_submit_prep"
  | "state"
  | "state_override"
  | "state_direct_write"
  | "other";

export type ClassifiedToolCall = {
  kind: ToolCallKind;
  slug?: string;
};

export type ClassifyOptions = {
  root: string;
  cwd: string;
  platform: NodeJS.Platform;
  home?: string;
  resolvePath: (p: string) => string | null;
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

const UNICODE_SPACES = /[\u00a0\u2007\u202f\u2000-\u200a\u3000]/g;

export function defaultResolvePath(
  p: string,
  opts: { root: string; cwd: string; platform: NodeJS.Platform; home?: string },
): string {
  let s = typeof p === "string" ? p : "";
  if (s.startsWith("@")) s = s.slice(1);
  s = s.replace(UNICODE_SPACES, " ");
  if (s.startsWith("~")) {
    const home = opts.home ?? "";
    s = path.join(home, s.slice(1).replace(/^[/\\]/, ""));
  }
  return path.resolve(opts.cwd, s);
}

const READ_ONLY_BROWSER_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_wait_for",
]);

const NAVIGATION_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_resize",
  "browser_close",
]);

const FILE_WRITE_BROWSER_TOOLS = new Set([
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_evaluate",
  "browser_pdf_save",
  "browser_storage_state",
]);

const FILE_WRITE_EXEMPT_BROWSER_TOOLS = new Set([
  "browser_file_upload",
  "browser_drop",
  "browser_set_storage_state",
  "browser_run_code_unsafe",
]);

const STATE_TOOLS = new Set([
  "read_application_state",
  "update_application_state",
  "complete_application",
  "match_resume",
  "list_queued_jobs",
  "generate_address",
  "request_manual_verification",
]);

const PROTECTED_BASENAMES = new Set([
  "state.json",
  "settings.json",
  "credentials.json",
  "gather_state.json",
  "package.json",
  "package-lock.json",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
]);

const GENERATED_SCRIPT_BASENAME_RE = /^([A-Za-z0-9._-]+)-(fill|submit|otp)\.js$/;

function normPathCompare(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function pathForDirCompare(p: string, platform: NodeJS.Platform): string {
  return platform === "darwin" ? p.toLowerCase() : p;
}

function isUnderWorkspaceDir(
  resolved: string,
  root: string,
  relDir: string,
  platform: NodeJS.Platform,
): boolean {
  const base = path.resolve(root, relDir);
  const rel = path.relative(pathForDirCompare(base, platform), pathForDirCompare(resolved, platform));
  if (rel === "") return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

function isRootProtectedFile(resolved: string, root: string, platform: NodeJS.Platform): boolean {
  const rootResolved = path.resolve(root);
  if (!normPathCompare(path.dirname(resolved), rootResolved, platform)) return false;
  const basename = path.basename(resolved);
  for (const protectedName of PROTECTED_BASENAMES) {
    if (normPathCompare(basename, protectedName, platform)) return true;
  }
  return false;
}

function isProtectedWorkspacePath(resolved: string, root: string, platform: NodeJS.Platform): boolean {
  const rootResolved = path.resolve(root);
  if (isRootProtectedFile(resolved, rootResolved, platform)) return true;
  if (isUnderWorkspaceDir(resolved, rootResolved, ".pi-jobs", platform)) return true;
  if (isUnderWorkspaceDir(resolved, rootResolved, "jobs", platform)) return true;
  if (isUnderWorkspaceDir(resolved, rootResolved, "screenshots", platform)) return true;
  for (const dir of [".pi", "ui", "scripts", "node_modules"]) {
    if (isUnderWorkspaceDir(resolved, rootResolved, dir, platform)) return true;
  }
  return false;
}

function isAllowedBrowserOutputPath(resolved: string, root: string, platform: NodeJS.Platform): boolean {
  return (
    isUnderWorkspaceDir(resolved, root, "screenshots", platform) ||
    isUnderWorkspaceDir(resolved, root, ".playwright-mcp", platform)
  );
}

function isJobPlaywrightServer(server: string): boolean {
  return server.replace(/-/g, "_") === "job_playwright";
}

function parseMcpBrowserToolName(toolName: string): string | null {
  if (toolName.startsWith("job_playwright_browser_")) {
    return toolName.slice("job_playwright_".length);
  }
  if (toolName.startsWith("browser_")) return toolName;
  const prefix = "mcp__job_playwright__";
  if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (match && match[1].replace(/-/g, "_") === "job_playwright") return match[2];
  return null;
}

function workspaceScriptsDir(root: string): string {
  return path.resolve(root, ".pi-jobs", "scripts");
}

function parseGeneratedScript(
  filename: string,
  opts: ClassifyOptions,
): { slug: string; kind: "fill" | "submit" | "otp" } | null {
  const resolved = opts.resolvePath(filename);
  if (resolved === null) return null;
  const scriptsDir = workspaceScriptsDir(opts.root);
  if (!normPathCompare(path.dirname(resolved), scriptsDir, opts.platform)) return null;
  const m = GENERATED_SCRIPT_BASENAME_RE.exec(path.basename(resolved));
  if (!m || !isSafeSlug(m[1])) return null;
  return { slug: m[1], kind: m[2] as "fill" | "submit" | "otp" };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return null;
}

function unwrapToolCall(
  toolName: string,
  input: unknown,
): { toolName: string; input: Record<string, unknown>; proxyParseFailed?: boolean } {
  if (toolName === "mcp") {
    const rec = asRecord(input);
    if (!rec) return { toolName, input: {} };
    const server = typeof rec.server === "string" ? rec.server : "";
    const innerTool = typeof rec.tool === "string" ? rec.tool : "";
    if (!isJobPlaywrightServer(server)) {
      return { toolName, input: rec };
    }
    let innerInput: Record<string, unknown> = {};
    if (typeof rec.args === "string") {
      try {
        const parsed = JSON.parse(rec.args) as unknown;
        innerInput = asRecord(parsed) ?? {};
      } catch {
        return { toolName: `browser_${innerTool}`, input: {}, proxyParseFailed: true };
      }
    } else if (asRecord(rec.args)) {
      innerInput = asRecord(rec.args)!;
    }
    const browserName = innerTool.startsWith("browser_") ? innerTool : `browser_${innerTool}`;
    return { toolName: browserName, input: innerInput };
  }
  return { toolName, input: asRecord(input) ?? {} };
}

function collectPathLikeArgs(
  toolName: string,
  input: Record<string, unknown>,
  knownTool: boolean,
): string[] {
  const paths: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) paths.push(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) paths.push(item);
      }
    }
  };

  if (knownTool && FILE_WRITE_BROWSER_TOOLS.has(toolName)) {
    add(input.filename);
    return paths;
  }

  if (!knownTool) {
    const skipPathKeys = toolName.startsWith("browser_cookie_");
    for (const [key, value] of Object.entries(input)) {
      if (!skipPathKeys && /file|path|dir/i.test(key)) {
        add(value);
      }
    }
  }
  return paths;
}

function classifyBrowserFileWrite(
  browserTool: string,
  input: Record<string, unknown>,
  opts: ClassifyOptions,
): ToolCallKind | null {
  if (FILE_WRITE_EXEMPT_BROWSER_TOOLS.has(browserTool)) return null;
  const knownForFilename = FILE_WRITE_BROWSER_TOOLS.has(browserTool);
  const paths = collectPathLikeArgs(browserTool, input, knownForFilename || FILE_WRITE_BROWSER_TOOLS.has(browserTool));
  if (paths.length === 0 && !knownForFilename) {
    // unknown tool: regex fallback only
    const fallbackPaths = collectPathLikeArgs(browserTool, input, false);
    if (fallbackPaths.length === 0) return null;
    for (const p of fallbackPaths) {
      const resolved = opts.resolvePath(p);
      if (resolved === null || !isAllowedBrowserOutputPath(resolved, opts.root, opts.platform)) {
        return "state_direct_write";
      }
    }
    return null;
  }
  for (const p of paths) {
    const resolved = opts.resolvePath(p);
    if (resolved === null || !isAllowedBrowserOutputPath(resolved, opts.root, opts.platform)) {
      return "state_direct_write";
    }
  }
  return null;
}

function classifyUnsafeCode(browserTool: string, input: Record<string, unknown>, opts: ClassifyOptions): ClassifiedToolCall | null {
  if (browserTool !== "browser_run_code_unsafe") return null;
  if (typeof input.code === "string" && input.code.trim()) {
    return { kind: "unsafe_code" };
  }
  const filename = typeof input.filename === "string" ? input.filename : "";
  if (!filename) return { kind: "unsafe_code" };
  const generated = parseGeneratedScript(filename, opts);
  if (!generated) return { kind: "unsafe_code" };
  if (generated.kind === "submit" || generated.kind === "otp") {
    return { kind: "submit_script", slug: generated.slug };
  }
  return { kind: "browser_mutating", slug: generated.slug };
}

function isLocalBrowserUrl(url: string): boolean {
  try {
    // WHATWG URL also canonicalizes decimal, hex and abbreviated IPv4.
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return host === "localhost" || host.endsWith(".localhost") ||
      host.startsWith("127.") || host === "0.0.0.0" || host === "::1" || host === "::" ||
      host.startsWith("::ffff:");
  } catch {
    return false;
  }
}

function containsLocalBrowserUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const urls = value.match(/https?:\/\/[^\s"'`<>\)]+/gi) ?? [];
  return urls.some(isLocalBrowserUrl);
}

export function jobPlaywrightToolName(toolName: string, input: unknown): string | null {
  return parseMcpBrowserToolName(unwrapToolCall(toolName, input).toolName);
}

function canLeaveDashboard(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "browser_navigate") {
    if (typeof input.url !== "string" || input.url.startsWith("/")) return false;
    try {
      let destination: URL;
      try {
        destination = new URL(input.url);
      } catch {
        destination = new URL(`https://${input.url}`);
      }
      return input.url === "about:blank" ||
        (["http:", "https:"].includes(destination.protocol) && !isLocalBrowserUrl(destination.href));
    } catch {
      return false;
    }
  }
  if (toolName === "browser_tabs") return ["select", "close", "list"].includes(String(input.action));
  return toolName === "browser_navigate_back" || toolName === "browser_close";
}

function classifyBrowserTool(
  browserTool: string,
  input: Record<string, unknown>,
  opts: ClassifyOptions,
  _annotations?: ToolAnnotations,
): ClassifiedToolCall {
  const urlArgument = browserTool === "browser_navigate" || browserTool === "browser_tabs" ? input.url :
    browserTool === "browser_evaluate" ? input.function :
    browserTool === "browser_run_code_unsafe" ? input.code : undefined;
  if (containsLocalBrowserUrl(urlArgument)) return { kind: "off_pipeline_browser" };

  const unsafe = classifyUnsafeCode(browserTool, input, opts);
  if (unsafe) return unsafe;

  const fileWrite = classifyBrowserFileWrite(browserTool, input, opts);
  if (fileWrite) return { kind: fileWrite };

  if (browserTool === "browser_tabs") {
    const action = input.action;
    if (action === "list") return { kind: "read_only" };
    return { kind: "browser_navigation" };
  }

  if (READ_ONLY_BROWSER_TOOLS.has(browserTool)) return { kind: "read_only" };
  if (NAVIGATION_BROWSER_TOOLS.has(browserTool)) return { kind: "browser_navigation" };

  if (browserTool.startsWith("browser_")) return { kind: "browser_mutating" };
  return { kind: "browser_mutating" };
}

function classifyWriteEdit(toolName: string, input: Record<string, unknown>, opts: ClassifyOptions): ClassifiedToolCall {
  const rawPath = typeof input.path === "string" ? input.path : "";
  if (!rawPath) return { kind: "other" };
  const resolved = opts.resolvePath(rawPath);
  if (resolved === null ||
    isProtectedWorkspacePath(resolveToCwd(rawPath, opts.cwd, opts.home), opts.root, opts.platform) ||
    isProtectedWorkspacePath(resolved, opts.root, opts.platform)) {
    return { kind: "state_direct_write" };
  }
  return { kind: "other" };
}

export function classifyToolCall(
  toolName: string,
  input: unknown,
  opts: ClassifyOptions,
  annotations?: ToolAnnotations,
): ClassifiedToolCall {
  const unwrapped = unwrapToolCall(toolName, input);
  if (unwrapped.proxyParseFailed) return { kind: "unsafe_code" };

  const name = unwrapped.toolName;
  const args = unwrapped.input;
  if (args.slug !== undefined && (typeof args.slug !== "string" || !isSafeSlug(args.slug))) {
    return { kind: "invalid_slug", slug: String(args.slug) };
  }
  if (name === "promote_to_queue" || name === "reject_discovered" || name === "add_target" || name === "queue_add_url") {
    return { kind: "queue_mutation" };
  }

  if (name === "profile_update_section" || name === "resume_add") {
    return { kind: "workspace_mutation" };
  }

  if (name === "write" || name === "edit") {
    return classifyWriteEdit(name, args, opts);
  }

  if (name === "solve_captcha") {
    const slug = typeof args.slug === "string" ? args.slug : undefined;
    return { kind: "paid", slug };
  }

  if (name === "greenhouse_prepare_submit" || name === "greenhouse_prepare_otp") {
    const slug = typeof args.slug === "string" ? args.slug : undefined;
    return { kind: "greenhouse_submit_prep", slug };
  }

  if (name === "update_application_state") {
    if (args.override_submitted === true) {
      const slug = typeof args.slug === "string" ? args.slug : undefined;
      return { kind: "state_override", slug };
    }
    return { kind: "state" };
  }

  if (STATE_TOOLS.has(name)) return { kind: "state" };

  const browserTool = parseMcpBrowserToolName(name);
  if (browserTool) {
    return classifyBrowserTool(browserTool, args, opts, annotations);
  }

  return { kind: "other" };
}

export type GateCode =
  | "STATE_DIRECT_WRITE"
  | "UNSAFE_CODE"
  | "OFF_PIPELINE_BROWSER"
  | "RUN_STOPPED"
  | "BROWSER_BUSY"
  | "STATE_CORRUPT"
  | "STATE_INVALID"
  | "ACK_REQUIRED"
  | "ALREADY_SUBMITTED"
  | "SUBMIT_OBSERVED_UNRECORDED"
  | "QUEUE_ITEM_REMOVED"
  | "RATE_LIMITED"
  | "CAPTCHA_BUDGET";

export type GateResult = { allow: true } | { allow: false; code: GateCode; reason: string; terminate: boolean };

export type StrictStateResult = { ok: true; value: ParsedStateJson } | { ok: false; corrupt: true };

export type ObservationRecord = {
  slug: string;
  state: string;
  source: string;
  at: string;
  runId: string;
};

export type ObservationRead =
  | { status: "missing" }
  | { status: "ok"; value: ObservationRecord }
  | { status: "corrupt" };

export type GateContext = {
  root: string;
  cwd: string;
  platform: NodeJS.Platform;
  runId?: string;
  runDir?: string;
  kind?: string;
  applySlug?: string;
  currentPageUrl?: string;
  browserBusy?: boolean;
  stopMarkerExists: boolean;
  runDirExists: boolean;
  state: StrictStateResult;
  queueFileExists: (slug: string) => boolean;
  observationForSlug: (slug: string) => ObservationRead;
  now: number;
  resolvePath: (p: string) => string | null;
};

export type GateCall = ClassifiedToolCall & {
  toolName: string;
  input: unknown;
};

function deny(code: GateCode, detail: string, terminate = false): GateResult {
  return {
    allow: false,
    code,
    reason: `${code}: ${detail}; stop; do not retry through another tool`,
    terminate,
  };
}

function isApplyKind(kind: string | undefined): boolean {
  return kind === "apply" || kind === "apply-next";
}

function isApplicationBrowserRun(kind: string | undefined): boolean {
  return isApplyKind(kind) || kind === "chat";
}

function hasVersionedAck(state: ParsedStateJson): boolean {
  const at = typeof state.acknowledged_at === "string" ? state.acknowledged_at : null;
  const policy = typeof state.acknowledged_policy === "string" ? state.acknowledged_policy : null;
  return isVersionedAutoSubmitAcknowledged(at, policy);
}

function findApplication(state: ParsedStateJson, slug: string): Record<string, unknown> | undefined {
  const apps = state.applications;
  if (!Array.isArray(apps)) return undefined;
  for (const entry of apps) {
    if (entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).slug === slug) {
      return entry as Record<string, unknown>;
    }
  }
  return undefined;
}

function slugForGate(call: GateCall, ctx: GateContext): string | undefined {
  if (call.slug) return call.slug;
  if (ctx.applySlug) return ctx.applySlug;
  return undefined;
}

const STOP_SCOPE_KINDS = new Set<ToolCallKind>([
  "workspace_mutation",
  "queue_mutation",
  "browser_navigation",
  "browser_mutating",
  "submit_script",
  "greenhouse_submit_prep",
  "paid",
  "state_override",
]);

const SLUG_GATED_KINDS = new Set<ToolCallKind>([
  "browser_navigation",
  "browser_mutating",
  "submit_script",
  "greenhouse_submit_prep",
  "paid",
]);

const ACK_ALWAYS_KINDS = new Set<ToolCallKind>(["submit_script", "greenhouse_submit_prep", "paid"]);

const BROWSER_ACK_KINDS = new Set<ToolCallKind>(["browser_navigation", "browser_mutating", "submit_script"]);

function isFutureSubmittedAt(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t > now + 60_000;
}

function findFutureTimestampSlug(state: ParsedStateJson, now: number): string | null {
  const apps = state.applications;
  if (!Array.isArray(apps)) return null;
  for (const entry of apps) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.demo === "true" || rec.demo === true) continue;
    const slug = typeof rec.slug === "string" ? rec.slug : "";
    const submittedAt = typeof rec.submitted_at === "string" ? rec.submitted_at : undefined;
    if (submittedAt && isFutureSubmittedAt(submittedAt, now)) return slug || null;
    const reopenedFrom =
      typeof rec.reopened_from_submitted_at === "string" ? rec.reopened_from_submitted_at : undefined;
    if (reopenedFrom && isFutureSubmittedAt(reopenedFrom, now)) return slug || null;
  }
  return null;
}

function corruptStateBlocksGate(call: GateCall, ctx: GateContext): boolean {
  const kind = call.kind;
  const uiRun = Boolean(ctx.runDir);
  if (kind === "state_override") return true;
  if (ACK_ALWAYS_KINDS.has(kind)) return true;
  const slug = slugForGate(call, ctx);
  if (slug && SLUG_GATED_KINDS.has(kind)) return true;
  if (uiRun && isApplicationBrowserRun(ctx.kind) && BROWSER_ACK_KINDS.has(kind)) return true;
  return false;
}

function observationBlocks(
  slug: string,
  entry: Record<string, unknown> | undefined,
  observationForSlug: (slug: string) => ObservationRead,
): boolean {
  const read = observationForSlug(slug);
  if (read.status === "corrupt") return true;
  if (read.status !== "ok" || read.value.state !== "submitted") return false;
  const reopenedAt = typeof entry?.reopened_at === "string" ? Date.parse(entry.reopened_at) : NaN;
  const obsAt = Date.parse(read.value.at);
  if (!Number.isNaN(reopenedAt) && !Number.isNaN(obsAt) && obsAt <= reopenedAt) return false;
  return true;
}

function bashOffPipeline(input: unknown): boolean {
  const rec = asRecord(input);
  const command = typeof rec?.command === "string" ? rec.command : "";
  if (!command) return false;
  const patterns = [
    ".pi-jobs/",
    "state.json",
    "settings.json",
    "credentials.json",
    "screenshots/",
    "jobs/",
    "playwright",
    "127.0.0.1:",
    "localhost:",
    "/api/",
  ];
  return patterns.some((p) => command.includes(p));
}

export function evaluateGate(call: GateCall, ctx: GateContext): GateResult {
  const kind = call.kind;
  const unwrapped = unwrapToolCall(call.toolName, call.input);
  const browserTool = parseMcpBrowserToolName(unwrapped.toolName);
  if (browserTool && ctx.currentPageUrl && isLocalBrowserUrl(ctx.currentPageUrl) &&
    !canLeaveDashboard(browserTool, unwrapped.input)) {
    return deny("OFF_PIPELINE_BROWSER", "the controlled browser is on the local Rolebound dashboard; navigate away; never operate the dashboard from the agent browser");
  }

  if (kind === "invalid_slug" || (call.slug !== undefined && !isSafeSlug(call.slug))) {
    return deny("STATE_INVALID", `invalid tool slug ${JSON.stringify(call.slug)}`, true);
  }
  if (kind === "off_pipeline_browser") {
    return deny("OFF_PIPELINE_BROWSER", "browser calls must not access loopback or local hosts");
  }
  if (kind === "state_direct_write") {
    return deny("STATE_DIRECT_WRITE", "direct write to protected workspace files is not allowed", true);
  }
  if (kind === "unsafe_code") {
    return deny("UNSAFE_CODE", "browser_run_code_unsafe is only allowed for generated Rolebound scripts", true);
  }

  if (call.toolName === "bash" && bashOffPipeline(call.input)) {
    return deny("OFF_PIPELINE_BROWSER", "bash must not drive browser or workspace state outside the tool pipeline");
  }

  const uiRun = Boolean(ctx.runDir);
  if (uiRun) {
    const stopped = ctx.stopMarkerExists || !ctx.runDirExists;
    if (stopped) {
      const inStopScope =
        STOP_SCOPE_KINDS.has(kind) ||
        call.toolName === "bash" ||
        call.toolName === "write" ||
        call.toolName === "edit";
      if (inStopScope) {
        return deny("RUN_STOPPED", "this supervised run has stopped");
      }
    }
  }

  if (browserTool && ctx.browserBusy) {
    return {
      allow: false,
      code: "BROWSER_BUSY",
      reason: "BROWSER_BUSY: another browser action is still running; retry this call after it completes",
      terminate: false,
    };
  }

  if (uiRun && isApplyKind(ctx.kind)) {
    if (kind === "queue_mutation") {
      return deny("OFF_PIPELINE_BROWSER", "use the dashboard Queue to change queued jobs during an apply run");
    }
    if (SLUG_GATED_KINDS.has(kind) && call.slug !== undefined && ctx.applySlug && call.slug !== ctx.applySlug) {
      return deny("STATE_INVALID", `tool slug ${JSON.stringify(call.slug)} differs from apply slug ${JSON.stringify(ctx.applySlug)}`, true);
    }
  }

  if (!ctx.state.ok && corruptStateBlocksGate(call, ctx)) {
    return deny("STATE_CORRUPT", "state.json is corrupt or unreadable", true);
  }

  const state = ctx.state.ok ? ctx.state.value : null;
  const slug = slugForGate(call, ctx);
  // Chat can apply to several jobs in one process. A successful state-tool update
  // selects the current application; never permit unbound browser form actions.
  if (uiRun && ctx.kind === "chat" && !slug &&
      (kind === "browser_mutating" || ACK_ALWAYS_KINDS.has(kind))) {
    return deny("STATE_INVALID", "call update_application_state for the queued job before browser form actions");
  }

  if (state) {
    const invalidSlug = findFutureTimestampSlug(state, ctx.now);
    if (invalidSlug) {
      return deny("STATE_INVALID", `stored timestamp on application ${invalidSlug} is invalid`, true);
    }
  }

  if (state) {
    const needsAck =
      ACK_ALWAYS_KINDS.has(kind) ||
      (uiRun && isApplicationBrowserRun(ctx.kind) && BROWSER_ACK_KINDS.has(kind));
    if (needsAck && !hasVersionedAck(state)) {
      return deny("ACK_REQUIRED", "automatic submission must be acknowledged once in Setup");
    }
  }

  if (state && slug) {
    const entry = findApplication(state, slug);
    const status = typeof entry?.status === "string" ? entry.status : undefined;
    if (status === "submitted") {
      if (kind !== "browser_navigation" && SLUG_GATED_KINDS.has(kind)) {
        return deny("ALREADY_SUBMITTED", `application ${slug} is already submitted`);
      }
    } else if (observationBlocks(slug, entry, ctx.observationForSlug)) {
      if (kind !== "browser_navigation" && SLUG_GATED_KINDS.has(kind)) {
        return deny("SUBMIT_OBSERVED_UNRECORDED", `a submission was observed for ${slug} but not recorded in state`);
      }
    }
  }

  if (state && slug) {
    const entry = findApplication(state, slug);
    const status = typeof entry?.status === "string" ? entry.status : undefined;
    if (status !== "submitted" && !ctx.queueFileExists(slug)) {
      if (SLUG_GATED_KINDS.has(kind)) {
        return deny("QUEUE_ITEM_REMOVED", `queue item for ${slug} was removed`);
      }
    }
  }

  if (state && slug && SLUG_GATED_KINDS.has(kind)) {
    const latest = latestRealSubmissionAt(state, slug);
    if (latest !== null && ctx.now - latest < MIN_SUBMIT_INTERVAL_MS) {
      return deny("RATE_LIMITED", "ten-minute submission rate limit is in effect");
    }
  }

  if (kind === "paid" && state && slug) {
    const entry = findApplication(state, slug);
    const used = typeof entry?.captcha_paid_tasks === "number" ? entry.captcha_paid_tasks : 0;
    if (used >= MAX_PAID_CAPTCHA_TASKS_PER_APPLICATION) {
      return deny("CAPTCHA_BUDGET", "paid CAPTCHA task budget for this application is exhausted");
    }
  }

  return { allow: true };
}

export type ApplyRunGateCode =
  | "ACK_REQUIRED"
  | "ALREADY_SUBMITTED"
  | "SUBMIT_OBSERVED_UNRECORDED"
  | "RATE_LIMITED"
  | "STATE_INVALID";

export type ApplyRunGateResult =
  | { ok: true }
  | { ok: false; code: ApplyRunGateCode; message: string; retryAfterMs?: number };

function urlFromQueueMarkdown(content: string): string | null {
  const m = content.match(/^url:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** Server apply-run start gate (reads state from `root`, not extension WORKSPACE). */
export async function evaluateApplyRunGate(
  root: string,
  slug: string,
  opts: { now?: number; skipRateLimit?: boolean } = {},
): Promise<ApplyRunGateResult> {
  const queueJob = resolveQueueJob(root, slug);
  slug = queueJob.slug;
  const now = opts.now ?? Date.now();
  let state: ParsedStateJson;
  try {
    state = await readApplicationState(root);
  } catch {
    return { ok: false, code: "STATE_INVALID", message: "state.json is corrupt or unreadable" };
  }

  const invalidSlug = findFutureTimestampSlug(state, now);
  if (invalidSlug) {
    return {
      ok: false,
      code: "STATE_INVALID",
      message: `stored timestamp on application ${invalidSlug} is invalid`,
    };
  }

  if (!hasVersionedAck(state)) {
    return {
      ok: false,
      code: "ACK_REQUIRED",
      message: "automatic submission must be acknowledged once in Setup",
    };
  }

  const entry = findApplication(state, slug);
  const status = typeof entry?.status === "string" ? entry.status : undefined;
  if (status === "submitted") {
    return { ok: false, code: "ALREADY_SUBMITTED", message: `application ${slug} is already submitted` };
  }

  const queuePath = path.join(root, "jobs", "queue", queueJob.filename);
  try {
    const content = await fs.readFile(queuePath, "utf8");
    const queueUrl = urlFromQueueMarkdown(content);
    if (queueUrl) {
      const apps = state.applications;
      if (Array.isArray(apps)) {
        for (const app of apps) {
          if (app === null || typeof app !== "object") continue;
          const rec = app as Record<string, unknown>;
          if (rec.status === "submitted" && rec.url === queueUrl) {
            return {
              ok: false,
              code: "ALREADY_SUBMITTED",
              message: "this job URL was already submitted under another application",
            };
          }
        }
      }
    }
  } catch {
    // queue file existence is checked by the route before start()
  }

  const observation = await readObservation(root, slug);
  if (observationBlocks(slug, entry, () => observation)) {
    return {
      ok: false,
      code: "SUBMIT_OBSERVED_UNRECORDED",
      message: `a submission was observed for ${slug} but not recorded in state`,
    };
  }

  if (!opts.skipRateLimit) {
    const latest = latestRealSubmissionAt(state, slug);
    if (latest !== null && now - latest < MIN_SUBMIT_INTERVAL_MS) {
      return {
        ok: false,
        code: "RATE_LIMITED",
        message: "ten-minute submission rate limit is in effect",
        retryAfterMs: MIN_SUBMIT_INTERVAL_MS - (now - latest),
      };
    }
  }

  return { ok: true };
}

export function runStopMarkerPath(root: string, runId: string): string {
  return path.join(root, ".pi-jobs", "runs", runId, "stop.json");
}

export function latestRealSubmissionAt(state: ParsedStateJson, exceptSlug: string | null): number | null {
  let latest: number | null = null;
  const apps = state.applications;
  if (!Array.isArray(apps)) return null;

  for (const entry of apps) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.demo === "true" || rec.demo === true) continue;
    const slug = typeof rec.slug === "string" ? rec.slug : "";

    const reopenedFrom = typeof rec.reopened_from_submitted_at === "string" ? rec.reopened_from_submitted_at : undefined;
    if (reopenedFrom) {
      const t = Date.parse(reopenedFrom);
      if (!Number.isNaN(t)) latest = latest === null ? t : Math.max(latest, t);
    }

    const submittedAt = typeof rec.submitted_at === "string" ? rec.submitted_at : undefined;
    if (submittedAt) {
      const skip = slug === exceptSlug && rec.status === "submitted";
      if (!skip) {
        const t = Date.parse(submittedAt);
        if (!Number.isNaN(t)) latest = latest === null ? t : Math.max(latest, t);
      }
    }
  }
  return latest;
}

export async function readObservation(root: string, slug: string): Promise<ObservationRead> {
  if (!isSafeSlug(slug)) return { status: "corrupt" };
  const file = path.join(root, ".pi-jobs", "observed", `${slug}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "corrupt" };
    }
    const rec = asRecord(parsed);
    if (
      !rec ||
      typeof rec.slug !== "string" ||
      typeof rec.state !== "string" ||
      typeof rec.source !== "string" ||
      typeof rec.at !== "string" ||
      typeof rec.runId !== "string"
    ) {
      return { status: "corrupt" };
    }
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

export async function writeObservation(root: string, obs: ObservationRecord): Promise<void> {
  if (!isSafeSlug(obs.slug)) {
    throw new Error(`unsafe observation slug: ${obs.slug}`);
  }
  const file = path.join(root, ".pi-jobs", "observed", `${obs.slug}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify(obs)}\n`);
}
