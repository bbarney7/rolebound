import { Router, type Response } from "express";
import { ConfigRevisionConflictError, readApplicationSettings } from "../applicationConfigStore";
import { catalogEntryFor, providerSupportsOAuth } from "../../shared/providerCatalog";
import type { ConnectionOrigin } from "../../shared/config";
import { validateConnection } from "../../shared/config";
import { randomUUID } from "node:crypto";
import type { ProviderHostDeps } from "../providers/hostDeps";
import {
  getLogin,
  startLogin,
} from "../providers/loginSessions";
import { adoptDetectedLogin } from "../providers/adoptDetection";
import { detectLogins, findDetectedLogin } from "../providers/detectLogins";
import { effectiveCredentialSource, ProviderServiceError } from "../providers/providerService";
import { readAuth } from "../providers/authStoreFile";
import { writeApplicationSettings } from "../applicationConfigStore";
import {
  connectionOrigin,
  normalizeConnectionAccount,
  uniqueConnectionLabel,
} from "../providers/connectionMetadata";

function fail(res: Response, error: unknown) {
  if (error instanceof ConfigRevisionConflictError) {
    return res.status(409).json({ error: { code: "REVISION_CONFLICT", message: "Settings changed; reload and retry." } });
  }
  if (error instanceof ProviderServiceError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  console.error("provider route error:", error);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Provider request failed." } });
}

type ProviderLoginMetadata = {
  origin?: ConnectionOrigin;
  name: string;
  account?: string;
};

function providerLoginName(provider: string): string {
  return provider === "anthropic"
    ? "Claude Pro/Max"
    : provider === "openai-codex"
      ? "ChatGPT Plus/Pro"
      : provider === "github-copilot"
        ? "GitHub Copilot"
        : provider === "cursor"
          ? "Cursor"
          : catalogEntryFor(provider)?.auth.oauth?.name ?? catalogEntryFor(provider)?.name ?? provider;
}

async function resolveProviderLoginMetadata(
  deps: ProviderHostDeps,
  provider: string,
  detectionId?: string,
): Promise<ProviderLoginMetadata> {
  const name = providerLoginName(provider);
  if (!detectionId) return { name };
  const live = await findDetectedLogin(deps, detectionId);
  if (!live || live.provider !== provider) {
    throw new ProviderServiceError("CONFIG_INVALID", "unknown detection id", 422);
  }
  if (live.action !== "sign-in") {
    throw new ProviderServiceError("CONFIG_INVALID", "this detection must be adopted instead of signed in", 422);
  }
  const account = normalizeConnectionAccount(live.account);
  return { name, account, origin: connectionOrigin(live.kind, live.account) };
}

async function resolveConnectionForProviderLoginUnlocked(
  root: string,
  deps: ProviderHostDeps,
  provider: string,
  metadata: ProviderLoginMetadata,
): Promise<string> {
  const entry = catalogEntryFor(provider);
  if (!entry) throw new ProviderServiceError("CONFIG_INVALID", "unknown provider", 422);
  const { origin } = metadata;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readApplicationSettings(root);
    const auth = await readAuth(root);
    const existing = origin
      ? current.data.connections.find((connection) => {
          if (connection.provider !== provider || connection.origin?.kind !== origin.kind) return false;
          return origin.account ? connection.origin.account === origin.account : !connection.origin.account;
        })
      : undefined;
    if (existing) return existing.id;

    const reusable = current.data.connections.find(
      (connection) =>
        connection.provider === provider
        && effectiveCredentialSource(connection, auth, deps.env) === "none"
        && (
          !connection.origin
          || (
            origin !== undefined
            && connection.origin.kind === origin.kind
            && connection.origin.account === origin.account
          )
        ),
    );
    const labelPeers = reusable
      ? current.data.connections.filter((candidate) => candidate.id !== reusable.id)
      : current.data.connections;
    const connection = reusable
      ? validateConnection({
          ...reusable,
          label: uniqueConnectionLabel(metadata.name, metadata.account, labelPeers),
          ...(origin ? { origin } : {}),
        })
      : validateConnection({
          id: randomUUID(),
          label: uniqueConnectionLabel(metadata.name, metadata.account, current.data.connections),
          provider,
          ...(origin ? { origin } : {}),
        });
    const connections = reusable
      ? current.data.connections.map((candidate) => (candidate.id === reusable.id ? connection : candidate))
      : [...current.data.connections, connection];
    try {
      await writeApplicationSettings(root, { ...current.data, connections }, current.revision);
      return connection.id;
    } catch (error) {
      if (error instanceof ConfigRevisionConflictError) continue;
      throw error;
    }
  }
  throw new ConfigRevisionConflictError("settings changed; reload and retry");
}

export function providersRouter(root: string, deps: ProviderHostDeps, opts: { demo: boolean }) {
  const router = Router();

  router.get("/detected", async (_req, res) => {
    try {
      if (opts.demo) {
        res.set("Cache-Control", "no-store").json([]);
        return;
      }
      const detected = await detectLogins(deps);
      res.set("Cache-Control", "no-store").json(detected);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/adopt", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const detectionId = typeof body.detectionId === "string" ? body.detectionId : "";
      if (!detectionId) throw new ProviderServiceError("CONFIG_INVALID", "detectionId is required", 422);
      const result = await adoptDetectedLogin(root, deps, detectionId);
      res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/login", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const provider = typeof body.provider === "string" ? body.provider : "";
      const detectionId = typeof body.detectionId === "string" ? body.detectionId : undefined;
      const enterpriseDomain = typeof body.enterpriseDomain === "string" ? body.enterpriseDomain : undefined;

      if (!provider || !catalogEntryFor(provider)) {
        throw new ProviderServiceError("CONFIG_INVALID", "unknown provider", 422);
      }
      if (provider !== "cursor" && !providerSupportsOAuth(provider)) {
        throw new ProviderServiceError("CONFIG_INVALID", "provider does not support browser sign-in", 422);
      }
      if (enterpriseDomain !== undefined && provider !== "github-copilot") {
        throw new ProviderServiceError("CONFIG_INVALID", "enterpriseDomain is only valid for GitHub Copilot", 422);
      }

      const metadata = await resolveProviderLoginMetadata(deps, provider, detectionId);
      let connectionId: string | undefined;
      let session;
      try {
        session = await startLogin(root, undefined, deps, {
          enterpriseDomain,
          expectedProvider: provider,
          reserve: async () => {
            connectionId = await resolveConnectionForProviderLoginUnlocked(root, deps, provider, metadata);
            return connectionId;
          },
        });
      } catch (error) {
        if (
          !(error instanceof ProviderServiceError)
          || error.code !== "LOGIN_IN_PROGRESS"
          || !connectionId
        ) throw error;
        session = getLogin(root, connectionId);
      }
      if (!connectionId) throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
      res.set("Cache-Control", "no-store").json({ connectionId, session });
    } catch (error) {
      fail(res, error);
    }
  });

  void opts;
  return router;
}
