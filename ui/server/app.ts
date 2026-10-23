import { chatRouter } from "./routes/chat";
import express, { type NextFunction, type Request, type Response } from "express";
import { applicationsRouter } from "./routes/applications";
import { overviewRouter } from "./routes/overview";
import { queueRouter } from "./routes/queue";
import { accountsRouter } from "./routes/accounts";
import { settingsRouter, type SettingsRouteOptions } from "./routes/settings";
import { addressesRouter, profileRouter, resumesRouter } from "./routes/profile";
import { eventsRouter } from "./routes/events";
import type { EventsOptions } from "./routes/events";
import { runsRouter } from "./routes/runs";
import { RunManager, type RunManagerOptions } from "./runs/runManager";
import { piArgs, prepareAgentRun, readRunConfig } from "./runConfig";
import { createLocalAccess } from "./localAccess";
import { providerRouter } from "./providers/routes";
import { providersRouter } from "./routes/providers";
import type { ProviderHostDeps } from "./providers/hostDeps";
import { buildProductionProviderHostDeps, providerRuntimeFromHost } from "./providers/hostDeps";
import { readinessRouter } from "./routes/readiness";
import { targetsRouter } from "./routes/targets";
import { instructionsRouter } from "./routes/instructions";
import { discoveriesRouter } from "./routes/discoveries";
import { e2eResetRouter } from "./routes/e2eReset";
import { createApplyGate } from "./applyGate";
import { demoRunManagerOptions } from "./demoRuntime";

const DEMO_DISABLED = { error: { code: "DEMO_DISABLED", message: "Demo mode cannot contact external services." } };

/**
 * `runs` is `Partial<RunManagerOptions>` rather than a hand-rolled duplicate so
 * the test seam — `command`, an `args` function, `model`, the two grace
 * periods — type-checks against the one shape the manager actually takes.
 * `root` is always supplied by `createApp` and an override is ignored: the app
 * and its run manager must agree about which workspace this is.
 *
 * The whole object is still passed to `eventsRouter`, which reads only the two
 * keys it knows and ignores the rest, so `/api/events` behaviour is untouched.
 */
export type AppOptions = EventsOptions & {
  runs?: Partial<RunManagerOptions> & { heartbeatMs?: number };
  /** The settings routes' provider fetch and env seams (tests). */
  settings?: SettingsRouteOptions;
  security?: { enabled?: boolean; port?: number; allowDevProxy?: boolean };
  demo?: boolean;
  /** Injected host/env probes for provider detection and sign-in (tests). */
  providerHost?: ProviderHostDeps;
};

function demoExternalBlock(req: Request, res: Response, next: NextFunction) {
  if (req.method === "POST" && req.path === "/api/settings/captcha/test") return res.status(409).json(DEMO_DISABLED);
  if (req.path.startsWith("/api/providers") && req.method !== "GET") return res.status(409).json(DEMO_DISABLED);
  if (/^\/api\/connections\/[^/]+\/login/.test(req.path)) return res.status(409).json(DEMO_DISABLED);
  if (req.path.startsWith("/api/connections") && !(req.path === "/api/connections" && req.method === "GET")) {
    return res.status(409).json(DEMO_DISABLED);
  }
  return next();
}

export function createApp(root: string, opts: AppOptions = {}) {
  const app = express();
  const demo = opts.demo ?? process.env.PI_JOBS_DEMO === "1";
  const providerHost = opts.providerHost ?? buildProductionProviderHostDeps();
  const providerRuntime = providerRuntimeFromHost(providerHost);
  const demoRuns: Partial<RunManagerOptions> = demo ? demoRunManagerOptions(root) : {};
  const effectiveProviderRuntime = {
    ...providerRuntime,
    env: opts.runs?.env ?? demoRuns.env ?? providerRuntime.env,
  };
  const access = createLocalAccess({ port: opts.security?.port ?? 4747, enabled: opts.security?.enabled, allowDevProxy: opts.security?.allowDevProxy });
  if (demo) app.use(demoExternalBlock);
  app.use(access.middleware);
  app.use(express.json());
  app.get("/api/session", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ csrfToken: access.token }); });

  /**
   * Malformed JSON, and ONLY malformed JSON (D36).
   *
   * express.json() rejects a bad body BEFORE any router runs, so no route
   * handler can answer it. With no error middleware, Express 5's default
   * handler does: measured in-session, status 400 with
   * `content-type: text/html; charset=utf-8` and an HTML document body. That
   * made the plan's "every expected failure returns JSON" claim false for a
   * case the UI can trivially produce, and it made Task 13's HTML-body check
   * — which treats an HTML error body as evidence of a MISSING ROUTE BRANCH —
   * point at a bug that is not there.
   *
   * MUST be registered here: after express.json() so it sees that
   * middleware's failures, and BEFORE the routers so it does NOT see theirs.
   * Express only routes an error to handlers registered AFTER the layer that
   * raised it, so every existing `next(err)` inside a router still skips past
   * this and reaches the default handler exactly as it does today.
   *
   * `type === "entity.parse.failed"` is the discriminator, not
   * `instanceof SyntaxError`: body-parser tags its own failures with that
   * string (body-parser/lib/read.js:166), while a JSON.parse error raised
   * anywhere else is also a SyntaxError and must NOT be swallowed here.
   */
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      err &&
      typeof err === "object" &&
      (err as { type?: string }).type === "entity.parse.failed"
    ) {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    next(err);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      root,
      ...(demo ? { demo: true, demoLabel: "Synthetic demo — no external calls or real submissions" } : {}),
    });
  });
  app.use("/api/overview", overviewRouter(root, opts.settings?.env));
  app.use("/api/applications", applicationsRouter(root));
  app.use("/api/accounts", accountsRouter(root));
  app.use("/api/settings", settingsRouter(root, opts.settings));
  app.use("/api/profile", profileRouter(root));
  app.use("/api/chat", chatRouter(root));
  app.use("/api/readiness", readinessRouter(root, effectiveProviderRuntime));
  app.use("/api/targets", targetsRouter(root));
  app.use("/api/instructions", instructionsRouter(root));
  app.use("/api/discoveries", discoveriesRouter(root));
  if (demo) app.use("/api/e2e", e2eResetRouter(root));
  const cfg = readRunConfig(effectiveProviderRuntime.env);
  const runs = new RunManager({
    root,
    command: opts.runs?.command ?? demoRuns.command ?? cfg.bin ?? process.execPath,
    args: opts.runs?.args ?? demoRuns.args ?? ((sessionName: string) => piArgs(cfg, sessionName)),
    model: opts.runs?.model ?? demoRuns.model ?? cfg.model ?? "demo/fake",
    env: effectiveProviderRuntime.env,
    providerRuntime: effectiveProviderRuntime,
    idleGraceMs: opts.runs?.idleGraceMs ?? demoRuns.idleGraceMs,
    killGraceMs: opts.runs?.killGraceMs,
    secrets: opts.runs?.secrets,
    prepare: opts.runs?.prepare ?? demoRuns.prepare ?? (opts.runs?.command
      ? undefined
      : (runId, sessionName, kind, runtime, continueFrom) => prepareAgentRun(root, runId, sessionName, runtime, kind, continueFrom)),
    applyGate: opts.runs?.applyGate ?? createApplyGate(root, demo, effectiveProviderRuntime),
  });
  app.use("/api/queue", queueRouter(root, runs));
  app.use("/api/resumes", resumesRouter(root, { isRunActive: () => {
    const current = runs.current();
    return current?.status === "starting" || current?.status === "running" || current?.status === "waiting";
  }}));
  app.use("/api/addresses", addressesRouter(root, { isRunActive: () => {
    const current = runs.current();
    return current?.status === "starting" || current?.status === "running" || current?.status === "waiting";
  }}));
  app.use("/api/events", eventsRouter(root, opts));

  app.use("/api", providerRouter(root, providerHost));
  app.use("/api/providers", providersRouter(root, providerHost, { demo }));
  app.use("/api/runs", runsRouter(root, runs, { ...opts.runs, demo }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number" && (err as { status: number }).status >= 400 && (err as { status: number }).status < 500 ? (err as { status: number }).status : 500;
    res.status(status).json({ error: status === 400 ? "bad request" : "internal server error" });
  });

  // Exposed so index.ts's signal handlers can stop the child and release the
  // lock, and so a test can dispose of the manager when it closes the server.
  return Object.assign(app, { runs });
}
