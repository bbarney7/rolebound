import { Router } from "express";
import {
  MAX_INSTRUCTION_SECTION_LENGTH,
  readInstructionsEnvelope,
  writeInstructions,
} from "../../../.pi/extensions/lib/instructions";

export class InstructionsRevisionConflictError extends Error {
  code = "REVISION_CONFLICT" as const;
}

export class InstructionsValidationError extends Error {
  code = "BAD_BODY" as const;
}

function validateSections(body: { applying?: unknown; finding?: unknown; chat?: unknown }) {
  const sections = {
    applying: body.applying,
    finding: body.finding,
    chat: body.chat,
  };
  for (const [key, value] of Object.entries(sections)) {
    if (typeof value !== "string") {
      throw new InstructionsValidationError(`${key} must be a string`);
    }
    if (value.length > MAX_INSTRUCTION_SECTION_LENGTH) {
      throw new InstructionsValidationError(`${key} must be ${MAX_INSTRUCTION_SECTION_LENGTH} characters or fewer`);
    }
  }
  return {
    applying: sections.applying as string,
    finding: sections.finding as string,
    chat: sections.chat as string,
  };
}

export function instructionsRouter(root: string): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await readInstructionsEnvelope(root));
    } catch (err) {
      next(err);
    }
  });

  router.put("/", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        applying?: unknown;
        finding?: unknown;
        chat?: unknown;
        expectedRevision?: unknown;
      };
      const sections = validateSections(body);
      const expectedRevision =
        body.expectedRevision === null || typeof body.expectedRevision === "string"
          ? body.expectedRevision
          : undefined;
      if (expectedRevision === undefined) {
        res.status(428).json({ error: "instructions revision is required", field: "expectedRevision" });
        return;
      }
      if (typeof expectedRevision === "string" && expectedRevision.length !== 64) {
        res.status(400).json({ error: "expectedRevision must be a 64-character sha256 hex digest", field: "expectedRevision" });
        return;
      }
      try {
        await writeInstructions(root, sections, expectedRevision);
        res.json(await readInstructionsEnvelope(root));
      } catch (error: unknown) {
        if ((error as { code?: string })?.code === "REVISION_CONFLICT") {
          throw new InstructionsRevisionConflictError((error as Error).message);
        }
        throw error;
      }
    } catch (err) {
      if (err instanceof InstructionsRevisionConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof InstructionsValidationError) {
        res.status(400).json({ error: err.message, field: "body" });
        return;
      }
      next(err);
    }
  });

  return router;
}
