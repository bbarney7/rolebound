import { Router, type Response } from "express";
import { ConfigRevisionConflictError } from "../applicationConfigStore";
import { readApplicationSettings } from "../applicationConfigStore";
import {
  createConnection,
  listConnections,
  listModels,
  ProviderServiceError,
  removeConnection,
  testConnection,
  updateConnection,
  updateSelections,
} from "./providerService";
import {
  answerLogin,
  cancelLogin,
  getLogin,
  importCursorLogin,
  startLogin,
} from "./loginSessions";
import type { ProviderHostDeps } from "./hostDeps";

function revision(req: { header(name: string): string | undefined; body?: unknown }) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return typeof body.expectedRevision === "string" ? body.expectedRevision : String(req.header("if-match") ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}
function input(req: { body?: unknown }) { const value = req.body && typeof req.body === "object" ? { ...(req.body as Record<string, unknown>) } : {}; delete value.expectedRevision; return value; }
function fail(res: Response, error: unknown) {
  if (error instanceof ConfigRevisionConflictError) return res.status(409).json({ error: { code: "REVISION_CONFLICT", message: "Settings changed; reload and retry." } });
  if (error instanceof ProviderServiceError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  return res.status(400).json({ error: { code: "CONFIG_INVALID", message: "Connection configuration is invalid." } });
}
export function providerRouter(root: string, deps: ProviderHostDeps) {
  const router = Router();
  router.get("/connections", async (_req, res) => { try { res.set("Cache-Control", "no-store").json(await listConnections(root, deps.env)); } catch (error) { fail(res, error); } });
  router.post("/connections", async (req, res) => { try { res.status(201).set("Cache-Control", "no-store").json(await createConnection(root, input(req) as never, revision(req))); } catch (error) { fail(res, error); } });
  router.put("/connections/selections", async (req, res) => {
    try {
      const body = input(req);
      res.set("Cache-Control", "no-store").json(await updateSelections(root, {
        agent: body.agent as never,
        scoring: body.scoring as never,
        ...(body.chat !== undefined ? { chat: body.chat as never } : {}),
      }, revision(req)));
    } catch (error) { fail(res, error); }
  });
  router.put("/connections/:id", async (req, res) => { try { res.set("Cache-Control", "no-store").json(await updateConnection(root, req.params.id, input(req), revision(req))); } catch (error) { fail(res, error); } });
  router.delete("/connections/:id", async (req, res) => { try { res.set("Cache-Control", "no-store").json(await removeConnection(root, req.params.id, revision(req))); } catch (error) { fail(res, error); } });
  router.post("/connections/:id/test", async (req, res) => { try { const settings = await readApplicationSettings(root); const connection = settings.data.connections.find(item => item.id === req.params.id); if (!connection) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404); res.set("Cache-Control", "no-store").json(await testConnection(root, connection, deps.env)); } catch (error) { fail(res, error); } });
  router.get("/connections/:id/models", async (req, res) => { try { const settings = await readApplicationSettings(root); const connection = settings.data.connections.find(item => item.id === req.params.id); if (!connection) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404); res.set("Cache-Control", "no-store").json({ models: await listModels(root, connection, deps.env) }); } catch (error) { fail(res, error); } });

  router.post("/connections/:id/login", async (req, res) => {
    try {
      const body = input(req);
      if (body.mode !== undefined && body.mode !== "login" && body.mode !== "import") {
        throw new ProviderServiceError("CONFIG_INVALID", "mode must be login or import", 422);
      }
      const enterpriseDomain = typeof body.enterpriseDomain === "string" ? body.enterpriseDomain : undefined;
      const settings = await readApplicationSettings(root);
      const connection = settings.data.connections.find((item) => item.id === req.params.id);
      if (!connection) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      if (body.mode === "import") {
        if (connection.provider !== "cursor") {
          throw new ProviderServiceError("CONFIG_INVALID", "Cursor import is only available for Cursor connections", 422);
        }
        const imported = await importCursorLogin(root, req.params.id, deps);
        res.set("Cache-Control", "no-store").json({ status: "succeeded", warnings: imported.warnings });
        return;
      }
      if (enterpriseDomain !== undefined && connection.provider !== "github-copilot") {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "enterpriseDomain is only supported for GitHub Copilot",
          422,
        );
      }
      const session = await startLogin(root, req.params.id, deps, {
        enterpriseDomain,
        expectedProvider: connection.provider,
      });
      res.set("Cache-Control", "no-store").json(session);
    } catch (error) {
      fail(res, error);
    }
  });
  router.get("/connections/:id/login", async (req, res) => {
    try {
      res.set("Cache-Control", "no-store").json(getLogin(root, req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });
  router.delete("/connections/:id/login", async (req, res) => {
    try {
      res.set("Cache-Control", "no-store").json(await cancelLogin(root, req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });
  router.post("/connections/:id/login/answer", async (req, res) => {
    try {
      const body = input(req);
      const promptId = typeof body.promptId === "string" ? body.promptId : "";
      const value = typeof body.value === "string" ? body.value : "";
      res.set("Cache-Control", "no-store").json(await answerLogin(root, req.params.id, promptId, value));
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
