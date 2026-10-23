import { Router, type Request } from "express";
import Busboy from "busboy";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicCreateFile } from "../../../.pi/extensions/lib/durable-store";
import { MAX_ATTACHMENT_BYTES, RESUME_EXTENSIONS, safeWorkspaceDirectory } from "../../../.pi/extensions/lib/resume-writer";

type Upload = { filename: string; bytes: Buffer };

/** Buffer at most 10 MiB; no workspace write occurs before the whole form validates. */
export function parseChatAttachment(req: Request): Promise<Upload> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    const fail = (status: number, message: string) => { failure ??= Object.assign(new Error(message), { status }); };
    let file: Upload | undefined;
    let files = 0;
    let bb: ReturnType<typeof Busboy>;
    try { bb = Busboy({ headers: req.headers, preservePath: true, limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1, fields: 1, parts: 2, headerPairs: 100 } }); }
    catch { reject(Object.assign(new Error("invalid multipart request"), { status: 400 })); return; }
    bb.on("file", (name, stream, info) => {
      files++;
      const extension = path.extname(info.filename).toLowerCase();
      if (name !== "file") fail(400, "exactly one file named file is required");
      if (!RESUME_EXTENSIONS.has(extension)) fail(415, "attachment must be PDF/DOCX/TXT/MD");
      // Never use the client-supplied path; retain only a sanitized basename for display.
      const stem = path.basename(info.filename, path.extname(info.filename)).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "attachment";
      const filename = `${stem}-${randomUUID()}${extension}`;
      const chunks: Buffer[] = [];
      let received = 0;
      stream.on("limit", () => fail(413, "attachment exceeds 10 MiB"));
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_ATTACHMENT_BYTES) fail(413, "attachment exceeds 10 MiB");
        if (!failure) chunks.push(chunk);
      });
      stream.on("error", () => fail(400, "invalid attachment stream"));
      stream.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) fail(415, "attachment is not a PDF");
        if (extension === ".docx" && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail(415, "attachment is not a DOCX archive");
        file = { filename, bytes };
      });
    });
    bb.on("field", () => fail(400, "form fields are not supported"));
    bb.on("filesLimit", () => fail(400, "exactly one file is required"));
    bb.on("fieldsLimit", () => fail(400, "form fields are not supported"));
    bb.on("partsLimit", () => fail(400, "exactly one file is required"));
    bb.on("error", () => fail(400, "invalid multipart request"));
    req.on("aborted", () => { reject(Object.assign(new Error("upload aborted"), { status: 400 })); bb.destroy(); });
    bb.on("close", () => {
      if (failure) reject(failure);
      else if (files !== 1 || !file) reject(Object.assign(new Error("exactly one file is required"), { status: 400 }));
      else resolve(file);
    });
    req.pipe(bb);
  });
}

export function chatRouter(root: string): Router {
  const router = Router();
  router.post("/attachments", async (req, res, next) => {
    try {
      if (!/^multipart\/form-data\s*;/i.test(req.header("content-type") ?? "")) {
        res.status(415).json({ error: "attachment upload must use multipart/form-data" }); return;
      }
      const file = await parseChatAttachment(req);
      const dir = await safeWorkspaceDirectory(root, "uploads");
      await atomicCreateFile(path.join(dir, file.filename), file.bytes, { mode: 0o600 });
      res.status(201).json({ path: `uploads/${file.filename}` });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) res.status(status).json({ error: (error as Error).message });
      else next(error);
    }
  });
  return router;
}
