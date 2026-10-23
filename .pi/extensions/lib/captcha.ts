/**
 * CAPTCHA solver: settings contract, provider clients, solve orchestration.
 *
 * Shared by the pi extension (the `solve_captcha` tool and the conditional
 * system prompt) and the UI server (Settings view, balance check, redactor),
 * which imports it across the package boundary. Hence the two rules this file
 * lives by: it imports nothing but node:fs/promises, and every path, clock and
 * fetch is a parameter — the workspace root is the CALLER's business.
 *
 * The user's key lives in `<workspace>/settings.json`:
 *
 *   { "captcha": { "provider": "off" | "capsolver" | "2captcha", "api_key": "…" } }
 *
 * settings.json alone chooses the provider; the provider's env var
 * (CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY) can only supply or override the
 * KEY for whichever provider the file already selected. A file whose
 * captcha.provider is "off", or no file at all, means the solver is off no
 * matter what is exported — a paid, terms-of-service-relevant solver must
 * never switch itself on because of an unrelated variable sitting in the
 * user's shell. The legacy capsolver.json is deliberately not read.
 *
 * boundary: B12 — CAPTCHA off by default; env alone cannot enable a solver.
 */

import fs from "node:fs/promises";

// ── Settings ────────────────────────────────────────────────────────────────

export type CaptchaProviderId = "capsolver" | "2captcha";
export const CAPTCHA_PROVIDER_IDS: readonly CaptchaProviderId[] = ["capsolver", "2captcha"];

export type CaptchaProviderChoice = CaptchaProviderId | "off";
export const CAPTCHA_PROVIDER_CHOICES: readonly CaptchaProviderChoice[] = ["off", ...CAPTCHA_PROVIDER_IDS];

/** The env var each provider's key may arrive in. Also the redactor's list. */
export const PROVIDER_ENV_VARS: Record<CaptchaProviderId, string> = {
  capsolver: "CAPSOLVER_API_KEY",
  "2captcha": "TWOCAPTCHA_API_KEY",
};

export const DEFAULT_MAX_PAID_CAPTCHA_TASKS_PER_DAY = 20;
export const MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY = 1;
export const MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY = 200;

/** The `captcha` block of settings.json, as stored. */
export interface CaptchaFileSettings {
  provider: CaptchaProviderChoice;
  api_key: string;
  max_paid_tasks_per_day?: number;
}

/**
 * Browser-side token injection for solve_captcha (Playwright browser_evaluate `function`).
 * Passed through `inject_function` so the agent does not rebuild it by hand.
 */
export const CAPTCHA_INJECT_SRC = `(token, kind) => {
  const setField = (name, host) => {
    let el = document.querySelector('[name="' + name + '"]');
    if (!el) { el = document.createElement('textarea'); el.name = name; el.style.display = 'none'; (host || document.body).appendChild(el); }
    el.value = token; el.innerHTML = token;
  };
  if (kind === 'hcaptcha') {
    setField('h-captcha-response', document.querySelector('.h-captcha'));
    setField('g-recaptcha-response', document.querySelector('.h-captcha'));
    if (window.hcaptcha) {
      window.hcaptcha.getResponse = () => token;
      window.hcaptcha.execute = () => Promise.resolve({ response: token, key: token });
    }
    const cb = document.querySelector('.h-captcha[data-callback]');
    if (cb && typeof window[cb.getAttribute('data-callback')] === 'function') window[cb.getAttribute('data-callback')](token);
  } else if (kind === 'turnstile') {
    let el = document.querySelector('[name="cf-turnstile-response"]');
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = 'cf-turnstile-response'; (document.querySelector('.cf-turnstile') || document.body).appendChild(el); }
    el.value = token;
    const cb = document.querySelector('.cf-turnstile[data-callback]');
    if (cb && typeof window[cb.getAttribute('data-callback')] === 'function') window[cb.getAttribute('data-callback')](token);
  } else {
    setField('g-recaptcha-response', document.querySelector('.g-recaptcha'));
    document.querySelectorAll('[name="g-recaptcha-response"]').forEach((el) => { el.value = token; el.innerHTML = token; });
    const cb = document.querySelector('.g-recaptcha[data-callback]');
    if (cb && typeof window[cb.getAttribute('data-callback')] === 'function') window[cb.getAttribute('data-callback')](token);
    const cfg = window.___grecaptcha_cfg;
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return false;
      seen.add(o);
      for (const k of Object.keys(o)) {
        if (k === 'callback' && typeof o[k] === 'function') { o[k](token); return true; }
        if (walk(o[k], depth + 1)) return true;
      }
      return false;
    };
    if (cfg && cfg.clients) walk(cfg.clients, 0);
  }
  return { ok: true, kind };
}`;

export function buildCaptchaInjectFunction(token: string, kind: string): string {
  return `() => (${CAPTCHA_INJECT_SRC})(${JSON.stringify(token)}, ${JSON.stringify(kind)})`;
}

/** The effective configuration after file + env are combined. */
export interface CaptchaSettings {
  provider: CaptchaProviderChoice;
  apiKey: string;
  keySource: "env" | "file" | "none";
  /** Non-fatal problems, shown by /status and the Settings view. */
  warnings: string[];
}

const DEFAULT_FILE_SETTINGS: CaptchaFileSettings = {
  provider: "off",
  api_key: "",
  max_paid_tasks_per_day: DEFAULT_MAX_PAID_CAPTCHA_TASKS_PER_DAY,
};

export function resolveMaxPaidTasksPerDay(file: CaptchaFileSettings): number {
  const raw = file.max_paid_tasks_per_day;
  if (raw === undefined) return DEFAULT_MAX_PAID_CAPTCHA_TASKS_PER_DAY;
  return raw;
}

export function validateMaxPaidTasksPerDay(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_PAID_CAPTCHA_TASKS_PER_DAY;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("captcha.max_paid_tasks_per_day must be an integer");
  }
  if (value < MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY || value > MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY) {
    throw new Error(
      `captcha.max_paid_tasks_per_day must be between ${MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY} and ${MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY}`,
    );
  }
  return value;
}

/** A settings.json that parsed as JSON but is not an object with a usable shape. */
export class SettingsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsShapeError";
  }
}

function isProviderChoice(value: unknown): value is CaptchaProviderChoice {
  return typeof value === "string" && (CAPTCHA_PROVIDER_CHOICES as readonly string[]).includes(value);
}

/**
 * The one read rule for settings.json, shared by the extension, the UI reader
 * and the UI writer. Empty/whitespace is the defaults (a scaffolded but
 * untouched file); bad JSON throws SyntaxError; a non-object document or a
 * non-object `captcha` throws SettingsShapeError. Anything else degrades to
 * a default plus a warning, so a typo never takes the agent down at load.
 */
export function parseSettingsText(text: string): {
  raw: Record<string, unknown>;
  captcha: CaptchaFileSettings;
  warnings: string[];
} {
  if (text.trim() === "") return { raw: {}, captcha: { ...DEFAULT_FILE_SETTINGS }, warnings: [] };
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsShapeError("settings.json must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  const block = raw.captcha;
  if (block === undefined) return { raw, captcha: { ...DEFAULT_FILE_SETTINGS }, warnings };
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new SettingsShapeError("settings.json `captcha` must be an object");
  }
  const { provider, api_key } = block as Record<string, unknown>;
  const captcha: CaptchaFileSettings = { ...DEFAULT_FILE_SETTINGS };
  if (provider !== undefined) {
    if (isProviderChoice(provider)) captcha.provider = provider;
    else warnings.push(`settings.json captcha.provider "${String(provider)}" is not one of ${CAPTCHA_PROVIDER_CHOICES.join(", ")} — treating it as off.`);
  }
  if (api_key !== undefined) {
    if (typeof api_key === "string") captcha.api_key = api_key;
    else warnings.push("settings.json captcha.api_key must be a string — ignoring it.");
  }
  const maxDay = (block as Record<string, unknown>).max_paid_tasks_per_day;
  if (maxDay !== undefined) {
    if (typeof maxDay === "number" && Number.isInteger(maxDay) && maxDay >= MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY && maxDay <= MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY) {
      captcha.max_paid_tasks_per_day = maxDay;
    } else {
      warnings.push(
        `settings.json captcha.max_paid_tasks_per_day must be an integer ${MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY}-${MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY} — using default ${DEFAULT_MAX_PAID_CAPTCHA_TASKS_PER_DAY}.`,
      );
    }
  }
  return { raw, captcha, warnings };
}

/** Pure: combine the file's block (null when there is no file) with the environment. */
export function resolveCaptchaSettings(
  file: CaptchaFileSettings | null,
  env: NodeJS.ProcessEnv,
): CaptchaSettings {
  const warnings: string[] = [];
  const provider: CaptchaProviderChoice = file?.provider ?? "off";
  if (provider === "off") return { provider: "off", apiKey: "", keySource: "none", warnings };

  const envVar = PROVIDER_ENV_VARS[provider];
  const envKey = (env[envVar] ?? "").trim();
  if (envKey) return { provider, apiKey: envKey, keySource: "env", warnings };
  const fileKey = (file?.api_key ?? "").trim();
  if (fileKey) return { provider, apiKey: fileKey, keySource: "file", warnings };
  warnings.push(
    `settings.json selects CAPTCHA provider "${provider}" but no key is set — add captcha.api_key or export ${envVar}. CAPTCHAs will stop the run.`,
  );
  return { provider, apiKey: "", keySource: "none", warnings };
}

/** Read `file` (a settings.json path) and resolve against `env`. Never throws. */
export async function readCaptchaSettings(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptchaSettings> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return resolveCaptchaSettings(null, env);
  }
  try {
    const parsed = parseSettingsText(text);
    const resolved = resolveCaptchaSettings(parsed.captcha, env);
    return { ...resolved, warnings: [...parsed.warnings, ...resolved.warnings] };
  } catch (err) {
    const why = err instanceof SyntaxError ? "settings.json is not valid JSON" : (err as Error).message;
    const resolved = resolveCaptchaSettings(null, env);
    return { ...resolved, warnings: [`${why} — CAPTCHA solver settings ignored.`, ...resolved.warnings] };
  }
}

// ── Providers ───────────────────────────────────────────────────────────────

export type CaptchaKind = "hcaptcha" | "recaptcha_v2" | "recaptcha_v3" | "turnstile";
export const CAPTCHA_KINDS: readonly CaptchaKind[] = ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile"];

/** Widget details the page exposes beyond sitekey + URL. All optional. */
export interface TaskExtras {
  /** hCaptcha / reCAPTCHA v2 rendered with size=invisible. */
  invisible?: boolean;
  /** hCaptcha Enterprise `rqdata`. */
  rqdata?: string;
  /** reCAPTCHA v3 `pageAction`, Turnstile `action`. */
  action?: string;
  /** Turnstile `cData`. */
  cdata?: string;
}

export interface ProviderSpec {
  id: CaptchaProviderId;
  label: string;
  baseUrl: string;
  envVar: string;
  /** How long to wait between getTaskResult polls. */
  pollIntervalMs: number;
  /** Task types to try in order. Empty means the provider cannot solve the kind. */
  taskTypes(kind: CaptchaKind): string[];
  /** The `task` object for createTask. */
  buildTask(
    type: string,
    kind: CaptchaKind,
    websiteURL: string,
    websiteKey: string,
    extras: TaskExtras,
  ): Record<string, unknown>;
}

/**
 * Both providers speak the same JSON API (createTask / getTaskResult /
 * getBalance keyed by `clientKey`), which is why there is one client below and
 * the specs differ only in host, task-type spelling, and per-task fields.
 * Type strings are as documented on 2026-08-28; "ProxyLess" vs "Proxyless" is
 * real, not a typo.
 */
const CAPSOLVER: ProviderSpec = {
  id: "capsolver",
  label: "CapSolver",
  baseUrl: "https://api.capsolver.com",
  envVar: PROVIDER_ENV_VARS.capsolver,
  pollIntervalMs: 2_000,
  taskTypes(kind) {
    switch (kind) {
      // CapSolver dropped hCaptcha: it is absent from docs.capsolver.com's
      // index and the HCaptchaTask* types are deprecated. An empty chain makes
      // solveCaptcha answer `unsupported_kind` instead of burning a task.
      case "hcaptcha":
        return [];
      case "recaptcha_v2":
        return ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2EnterpriseTaskProxyLess"];
      case "recaptcha_v3":
        return ["ReCaptchaV3TaskProxyLess", "ReCaptchaV3EnterpriseTaskProxyLess"];
      case "turnstile":
        return ["AntiTurnstileTaskProxyLess"];
    }
  },
  buildTask(type, kind, websiteURL, websiteKey, extras) {
    const task: Record<string, unknown> = { type, websiteURL, websiteKey };
    if (kind === "recaptcha_v2" && extras.invisible) task.isInvisible = true;
    if (kind === "recaptcha_v3") task.pageAction = extras.action ?? "submit";
    if (kind === "turnstile" && (extras.action || extras.cdata)) {
      task.metadata = { ...(extras.action ? { action: extras.action } : {}), ...(extras.cdata ? { cdata: extras.cdata } : {}) };
    }
    return task;
  },
};

const TWOCAPTCHA: ProviderSpec = {
  id: "2captcha",
  label: "2Captcha",
  baseUrl: "https://api.2captcha.com",
  envVar: PROVIDER_ENV_VARS["2captcha"],
  // The docs say "wait at least 5 seconds" before the first getTaskResult.
  pollIntervalMs: 5_000,
  taskTypes(kind) {
    switch (kind) {
      case "hcaptcha":
        return ["HCaptchaTaskProxyless"];
      case "recaptcha_v2":
        return ["RecaptchaV2TaskProxyless", "RecaptchaV2EnterpriseTaskProxyless"];
      case "recaptcha_v3":
        return ["RecaptchaV3TaskProxyless"];
      case "turnstile":
        return ["TurnstileTaskProxyless"];
    }
  },
  buildTask(type, kind, websiteURL, websiteKey, extras) {
    const task: Record<string, unknown> = { type, websiteURL, websiteKey };
    if ((kind === "hcaptcha" || kind === "recaptcha_v2") && extras.invisible) task.isInvisible = true;
    if (kind === "hcaptcha" && extras.rqdata) task.enterprisePayload = { rqdata: extras.rqdata };
    if (kind === "recaptcha_v3") {
      task.pageAction = extras.action ?? "submit";
      task.minScore = 0.3;
    }
    if (kind === "turnstile") {
      if (extras.action) task.action = extras.action;
      if (extras.cdata) task.data = extras.cdata;
    }
    return task;
  },
};

export const PROVIDERS: Record<CaptchaProviderId, ProviderSpec> = { capsolver: CAPSOLVER, "2captcha": TWOCAPTCHA };

export function supportedKinds(id: CaptchaProviderId): CaptchaKind[] {
  return CAPTCHA_KINDS.filter((kind) => PROVIDERS[id].taskTypes(kind).length > 0);
}

// ── Client ──────────────────────────────────────────────────────────────────

export type SolveErrorCode =
  | "disabled"
  | "unsupported_kind"
  | "provider_error"
  | "timeout"
  | "network"
  | "budget_exhausted";

export type SolveResult =
  | {
      ok: true;
      provider: CaptchaProviderId;
      task_type: string;
      token: string;
      /** The UA the provider solved under, when it says; some tokens are bound to it. */
      user_agent: string | null;
      elapsed_ms: number;
    }
  | { ok: false; code: SolveErrorCode; error: string };

export interface SolveDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** When set, called before each provider createTask; false stops the chain with budget_exhausted. */
  beforeTask?: () => Promise<boolean>;
  /** When set, called after the provider accepts a task (createTask returned a taskId). */
  onTaskCreated?: () => void;
  /** When beforeTask returns false, used as the budget_exhausted error message. */
  getBudgetError?: () => string | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface ApiEnvelope {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number | string;
  status?: string;
  solution?: { gRecaptchaResponse?: string; token?: string; userAgent?: string };
  balance?: number;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ ok: true; data: ApiEnvelope } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as ApiEnvelope;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function describeError(data: ApiEnvelope): string {
  return `${data.errorCode ?? `errorId=${data.errorId}`}: ${data.errorDescription ?? "no description"}`;
}

async function runOneTask(
  spec: ProviderSpec,
  apiKey: string,
  task: Record<string, unknown>,
  deps: Required<Pick<SolveDeps, "fetch" | "sleep" | "now" | "timeoutMs">> & SolveDeps,
): Promise<{ ok: true; token: string; userAgent: string | null } | { ok: false; code: SolveErrorCode; error: string }> {
  if (deps.beforeTask) {
    const allowed = await deps.beforeTask();
    if (!allowed) {
      return {
        ok: false,
        code: "budget_exhausted",
        error: deps.getBudgetError?.() ?? "Paid CAPTCHA task budget exhausted before createTask.",
      };
    }
  }
  const created = await postJson(deps.fetch, `${spec.baseUrl}/createTask`, { clientKey: apiKey, task });
  if (!created.ok) return { ok: false, code: "network", error: created.error };
  if (created.data.errorId !== 0 || created.data.taskId === undefined) {
    return { ok: false, code: "provider_error", error: `createTask ${describeError(created.data)}` };
  }
  deps.onTaskCreated?.();
  const startedAt = deps.now();
  while (deps.now() - startedAt < deps.timeoutMs) {
    await deps.sleep(spec.pollIntervalMs);
    const polled = await postJson(deps.fetch, `${spec.baseUrl}/getTaskResult`, { clientKey: apiKey, taskId: created.data.taskId });
    if (!polled.ok) return { ok: false, code: "network", error: polled.error };
    if (polled.data.errorId !== 0) return { ok: false, code: "provider_error", error: `getTaskResult ${describeError(polled.data)}` };
    if (polled.data.status === "failed") return { ok: false, code: "provider_error", error: "getTaskResult status=failed" };
    if (polled.data.status === "ready") {
      const token = polled.data.solution?.gRecaptchaResponse ?? polled.data.solution?.token ?? "";
      if (!token) return { ok: false, code: "provider_error", error: "getTaskResult ready but no token in solution" };
      return { ok: true, token, userAgent: polled.data.solution?.userAgent ?? null };
    }
  }
  return { ok: false, code: "timeout", error: `no solution within ${deps.timeoutMs}ms` };
}

/**
 * Solve one widget. Walks the provider's task-type chain for the kind; the
 * first type the provider accepts and solves wins. Never throws.
 */
export async function solveCaptcha(
  settings: CaptchaSettings,
  req: { kind: CaptchaKind; sitekey: string; page_url: string; extras?: TaskExtras },
  deps: SolveDeps = {},
): Promise<SolveResult> {
  if (settings.provider === "off" || settings.apiKey === "") {
    return { ok: false, code: "disabled", error: "No CAPTCHA solver configured (settings.json captcha.provider is off or has no key)." };
  }
  const spec = PROVIDERS[settings.provider];
  const chain = spec.taskTypes(req.kind);
  if (chain.length === 0) {
    const alternatives = CAPTCHA_PROVIDER_IDS.filter((id) => id !== spec.id && PROVIDERS[id].taskTypes(req.kind).length > 0)
      .map((id) => PROVIDERS[id].label);
    return {
      ok: false,
      code: "unsupported_kind",
      error: `${spec.label} cannot solve ${req.kind}${alternatives.length ? `; switch the provider to ${alternatives.join(" or ")} in settings.json` : ""}.`,
    };
  }
  const full = {
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    beforeTask: deps.beforeTask,
    onTaskCreated: deps.onTaskCreated,
    getBudgetError: deps.getBudgetError,
  };
  const startedAt = full.now();
  let last: { code: SolveErrorCode; error: string } = { code: "provider_error", error: "no task type attempted" };
  for (const type of chain) {
    const task = spec.buildTask(type, req.kind, req.page_url, req.sitekey, req.extras ?? {});
    const result = await runOneTask(spec, settings.apiKey, task, full);
    if (result.ok) {
      return {
        ok: true,
        provider: spec.id,
        task_type: type,
        token: result.token,
        user_agent: result.userAgent,
        elapsed_ms: full.now() - startedAt,
      };
    }
    last = {
      code: result.code,
      error: result.code === "budget_exhausted" ? result.error : `${type}: ${result.error}`,
    };
    if (result.code === "budget_exhausted") break;
    // A dead network or an exhausted clock will not improve with another type.
    if (result.code === "network" || result.code === "timeout") break;
  }
  return { ok: false, ...last };
}

export type BalanceResult = { ok: true; balance: number } | { ok: false; error: string };

/** The cheapest call that proves a key works: the account balance, in USD. */
export async function checkBalance(
  id: CaptchaProviderId,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BalanceResult> {
  const spec = PROVIDERS[id];
  const res = await postJson(fetchImpl, `${spec.baseUrl}/getBalance`, { clientKey: apiKey });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.data.errorId !== 0) return { ok: false, error: describeError(res.data) };
  if (typeof res.data.balance !== "number") return { ok: false, error: "getBalance returned no balance" };
  return { ok: true, balance: res.data.balance };
}
