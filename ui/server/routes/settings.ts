import { Router } from "express";
import { readSettingsFile, writeCaptchaSettings } from "../settingsStore";
import { MIN_SECRET_LENGTH } from "../runs/secrets";
import {
  CAPTCHA_PROVIDER_CHOICES,
  CAPTCHA_PROVIDER_IDS,
  MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY,
  MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY,
  PROVIDERS,
  checkBalance,
  resolveCaptchaSettings,
  resolveMaxPaidTasksPerDay,
  supportedKinds,
  SettingsShapeError,
  type CaptchaFileSettings,
  type CaptchaProviderChoice,
  type CaptchaProviderId,
} from "../../../.pi/extensions/lib/captcha";
import { countPaidTasksInWindow } from "../../../.pi/extensions/lib/captcha-spend";
import type { CaptchaSettingsPayload, CaptchaSettingsUpdateBody, CaptchaTestBody, CaptchaTestResponse } from "../../shared/types";

/**
 * `fetch` is the seam a test uses to script the provider; `env` is the seam
 * for the env-var override, defaulting to the sidecar's own environment — the
 * same one the spawned pi inherits, so what this route reports is what the
 * run will do.
 */
export interface SettingsRouteOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Long enough for any provider's key; short enough to keep the file readable. */
export const MAX_API_KEY_LENGTH = 256;

function isProviderChoice(value: unknown): value is CaptchaProviderChoice {
  return typeof value === "string" && (CAPTCHA_PROVIDER_CHOICES as readonly string[]).includes(value);
}

function isProviderId(value: unknown): value is CaptchaProviderId {
  return typeof value === "string" && (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(value);
}

const PROVIDER_LIST = CAPTCHA_PROVIDER_IDS.map((id) => ({
  id,
  label: PROVIDERS[id].label,
  envVar: PROVIDERS[id].envVar,
  supports: supportedKinds(id),
}));

async function payload(root: string, env: NodeJS.ProcessEnv): Promise<CaptchaSettingsPayload> {
  const file = await readSettingsFile(root);
  const resolved = resolveCaptchaSettings(file.captcha, env);
  const fileKey = file.captcha.api_key.trim();
  let dailyPaidTasksCount = 0;
  try {
    dailyPaidTasksCount = await countPaidTasksInWindow(root, Date.now());
  } catch {
    dailyPaidTasksCount = 0;
  }
  return {
    provider: resolved.provider,
    hasApiKey: resolved.apiKey !== "",
    // A stored file key gets a hint whenever it's there, even when it isn't
    // the EFFECTIVE key (an env key overriding it, or the provider off) —
    // hasApiKey/keySource stay the effective state below.
    keyHint: fileKey.length >= 4 ? `…${fileKey.slice(-4)}` : null,
    keySource: resolved.keySource,
    fileHasKey: fileKey !== "",
    warnings: [...file.warnings, ...resolved.warnings],
    providers: PROVIDER_LIST,
    maxPaidTasksPerDay: resolveMaxPaidTasksPerDay(file.captcha),
    dailyPaidTasksCount,
  };
}

export function settingsRouter(root: string, opts: SettingsRouteOptions = {}): Router {
  const router = Router();
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;

  /**
   * A corrupt settings.json reaches Express's default handler here and
   * answers 500 with an HTML body — the mutation below answers the same file
   * with a JSON 409, because its reason has to reach the form.
   */
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await payload(root, env));
    } catch (err) {
      next(err);
    }
  });

  router.put("/captcha", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<CaptchaSettingsUpdateBody>;
      if (!isProviderChoice(body.provider)) {
        res.status(400).json({ error: `provider must be one of: ${CAPTCHA_PROVIDER_CHOICES.join(", ")}`, field: "provider" });
        return;
      }
      let apiKey: string | undefined;
      if (body.apiKey === null || body.apiKey === "") {
        apiKey = "";
      } else if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== "string") {
          res.status(400).json({ error: "apiKey must be a string", field: "apiKey" });
          return;
        }
        // Trimmed, unlike passwords: a key is pasted, and the trailing newline
        // from a copied line is the single most common way one fails.
        apiKey = body.apiKey.trim();
        if (apiKey.length < MIN_SECRET_LENGTH) {
          res.status(400).json({
            error: `apiKey must be at least ${MIN_SECRET_LENGTH} characters — shorter values cannot be redacted from run transcripts`,
            field: "apiKey",
          });
          return;
        }
        if (apiKey.length > MAX_API_KEY_LENGTH) {
          res.status(400).json({ error: `apiKey must be ${MAX_API_KEY_LENGTH} characters or fewer`, field: "apiKey" });
          return;
        }
      }
      let maxPaidTasksPerDay: number | undefined;
      if (body.maxPaidTasksPerDay !== undefined) {
        if (typeof body.maxPaidTasksPerDay !== "number" || !Number.isInteger(body.maxPaidTasksPerDay)) {
          res.status(400).json({ error: "maxPaidTasksPerDay must be an integer", field: "maxPaidTasksPerDay" });
          return;
        }
        if (
          body.maxPaidTasksPerDay < MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY ||
          body.maxPaidTasksPerDay > MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY
        ) {
          res.status(400).json({
            error: `maxPaidTasksPerDay must be between ${MIN_MAX_PAID_CAPTCHA_TASKS_PER_DAY} and ${MAX_MAX_PAID_CAPTCHA_TASKS_PER_DAY}`,
            field: "maxPaidTasksPerDay",
          });
          return;
        }
        maxPaidTasksPerDay = body.maxPaidTasksPerDay;
      }
      let current: CaptchaFileSettings;
      try {
        current = (await readSettingsFile(root)).captcha;
      } catch (err) {
        // Only the two corruption errors are swallowed, because the writer's
        // locked read re-observes them and answers 409 with the bytes
        // untouched. Any other read failure — EACCES, EISDIR, a transient
        // EAGAIN — must not be mistaken for a fresh clone: the fallback's
        // empty key would then be written over a real one, silently
        // destroying a stored key on a 200.
        if (err instanceof SyntaxError || err instanceof SettingsShapeError) {
          current = { provider: "off", api_key: "" };
        } else {
          throw err;
        }
      }
      const updated: CaptchaFileSettings = {
        provider: body.provider,
        api_key: apiKey ?? current.api_key,
        max_paid_tasks_per_day: maxPaidTasksPerDay ?? resolveMaxPaidTasksPerDay(current),
      };
      const written = await writeCaptchaSettings(root, updated);
      if (!written.ok) {
        res.status(409).json({ error: written.error.message });
        return;
      }
      res.json(await payload(root, env));
    } catch (err) {
      next(err);
    }
  });

  router.post("/captcha/test", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<CaptchaTestBody>;
      let provider: CaptchaProviderId | null = null;
      let apiKey = "";
      const pasted = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (pasted !== "" && isProviderId(body.provider)) {
        provider = body.provider;
        apiKey = pasted;
      } else if (pasted === "" && body.provider === undefined) {
        const resolved = resolveCaptchaSettings((await readSettingsFile(root)).captcha, env);
        if (resolved.provider !== "off" && resolved.apiKey !== "") {
          provider = resolved.provider;
          apiKey = resolved.apiKey;
        }
      }
      if (!provider) {
        res.status(400).json({ error: "no CAPTCHA key to test: choose a provider and enter a key first" });
        return;
      }
      const balance = await checkBalance(provider, apiKey, fetchImpl);
      const out: CaptchaTestResponse = balance.ok
        ? { ok: true, provider, balance: balance.balance }
        : { ok: false, provider, error: balance.error };
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
