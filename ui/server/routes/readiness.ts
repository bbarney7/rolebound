import { Router } from "express";
import {
  AcknowledgementValidationError,
  computeReadiness,
  parseAcknowledgementBody,
  recordSupervisedAcknowledgement,
} from "../readiness";

export function readinessRouter(
  root: string,
  runtime: { nodeMajor?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await computeReadiness(root, runtime));
    } catch (error) {
      next(error);
    }
  });
  router.post("/acknowledgement", async (req, res, next) => {
    try {
      parseAcknowledgementBody(req.body);
      const readiness = await recordSupervisedAcknowledgement(root, runtime);
      res.set("Cache-Control", "no-store").json(readiness);
    } catch (error) {
      if (error instanceof AcknowledgementValidationError) {
        res.status(400).set("Cache-Control", "no-store").json({ error: error.message, code: error.code });
        return;
      }
      if ((error as NodeJS.ErrnoException & { code?: string }).code === "UNSAFE_STATE") {
        res.status(409).set("Cache-Control", "no-store").json({ error: "state.json is unsafe" });
        return;
      }
      next(error);
    }
  });
  return router;
}
