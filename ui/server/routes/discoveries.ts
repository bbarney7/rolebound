import { Router } from "express";
import {
  DiscoveryLockedError,
  DiscoveryMalformedError,
  DiscoveryNotFoundError,
  DiscoveryWriteError,
  listDiscoveries,
  readDiscoveryDetail,
  setDiscoveryDismissed,
} from "../readers/discoveries";
import { TARGET_SOURCES, type DiscoveryListQuery, type TargetSource } from "../../shared/discovery";
import { isSafeSlug } from "../workspace";

function parseListQuery(req: { query: Record<string, unknown> }): DiscoveryListQuery {
  const query: DiscoveryListQuery = {};
  if (typeof req.query.q === "string") query.q = req.query.q;
  if (typeof req.query.cursor === "string") query.cursor = req.query.cursor;
  if (typeof req.query.limit === "string") query.limit = Number(req.query.limit);
  if (typeof req.query.sort === "string" && ["score", "recent", "company"].includes(req.query.sort)) {
    query.sort = req.query.sort as DiscoveryListQuery["sort"];
  }
  if (typeof req.query.source === "string" && TARGET_SOURCES.includes(req.query.source as TargetSource)) {
    query.source = req.query.source as TargetSource;
  }
  if (req.query.scored === "true" || req.query.scored === "false") query.scored = req.query.scored;
  if (req.query.dismissed === "true" || req.query.dismissed === "false" || req.query.dismissed === "all") {
    query.dismissed = req.query.dismissed;
  }
  return query;
}

function mutationError(res: import("express").Response, error: unknown): boolean {
  if (error instanceof DiscoveryNotFoundError) {
    res.status(404).json({ error: "discovery not found" });
    return true;
  }
  if (error instanceof DiscoveryMalformedError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  if (error instanceof DiscoveryLockedError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  if (error instanceof DiscoveryWriteError) {
    res.status(500).json({ error: error.message });
    return true;
  }
  return false;
}

export function discoveriesRouter(root: string): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      res.json(await listDiscoveries(root, parseListQuery(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:slug", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json({ error: "invalid slug" });
        return;
      }
      const detail = await readDiscoveryDetail(root, slug);
      if (!detail) {
        res.status(404).json({ error: "discovery not found" });
        return;
      }
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:slug/dismiss", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json({ error: "invalid slug" });
        return;
      }
      const detail = await setDiscoveryDismissed(root, slug, true);
      res.json({ item: detail });
    } catch (error) {
      if (mutationError(res, error)) return;
      next(error);
    }
  });

  router.post("/:slug/restore", async (req, res, next) => {
    try {
      const { slug } = req.params;
      if (!isSafeSlug(slug)) {
        res.status(400).json({ error: "invalid slug" });
        return;
      }
      const detail = await setDiscoveryDismissed(root, slug, false);
      res.json({ item: detail });
    } catch (error) {
      if (mutationError(res, error)) return;
      next(error);
    }
  });

  return router;
}
