import { Router } from "express";
import { readTargets } from "../readers/targets";
import { writeTargets, TargetsRevisionConflictError, TargetsValidationError } from "../targetsWriter";
import type { TargetsPayload, TargetsUpdateBody } from "../../shared/discovery";

export function targetsRouter(root: string): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const parsed = await readTargets(root);
      const payload: TargetsPayload = { revision: parsed.revision, entries: parsed.entries, text: parsed.text };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Partial<TargetsUpdateBody>;
      if (!Array.isArray(body.entries)) {
        res.status(400).json({ error: "entries must be an array" });
        return;
      }
      const written = await writeTargets(root, body.entries, body.revision ?? null);
      const payload: TargetsPayload = { revision: written.revision, entries: written.entries, text: written.text };
      res.json(payload);
    } catch (error) {
      if (error instanceof TargetsRevisionConflictError) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof TargetsValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });

  return router;
}
