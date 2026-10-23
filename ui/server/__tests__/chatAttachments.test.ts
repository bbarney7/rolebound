import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { chatRouter } from "../routes/chat";
import { createLocalAccess } from "../localAccess";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attachments-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function upload(parts: Array<{ filename: string; bytes: Buffer }>, extra = "") {
  const boundary = "chat-fixture-boundary";
  const chunks = parts.flatMap(p => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), p.bytes, Buffer.from("\r\n")]);
  chunks.push(Buffer.from(extra + `--${boundary}--\r\n`));
  const req = Readable.from(Buffer.concat(chunks)) as unknown as Request;
  Object.assign(req, { url: "/attachments", method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, header(name: string) { return (this.headers as Record<string, string>)[name]; } });
  return req;
}
function send(req: Request): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(value: number) { status = value; return this; }, json(body: unknown) { resolve({ status, body }); } } as unknown as Response;
    chatRouter(root)(req, res, error => { if (error) reject(error); else reject(new Error("route not matched")); });
  });
}

describe("POST /api/chat/attachments", () => {
  it.each(["pdf", "docx", "txt", "md"])("stores a unique private %s and returns a workspace-relative path", async ext => {
    const bytes = Buffer.from(ext === "pdf" ? "%PDF-1.7\nfixture" : ext === "docx" ? "PK\u0003\u0004fixture" : "Jane Doe");
    const a = await send(upload([{ filename: `../../resume.${ext}`, bytes }]));
    const b = await send(upload([{ filename: `../../resume.${ext}`, bytes }]));
    expect(a.status).toBe(201);
    expect(a.body.path).toMatch(new RegExp(`^uploads/resume-[a-f0-9-]+\\.${ext}$`));
    expect(a.body.path).not.toBe(b.body.path);
    expect(await fs.readFile(path.join(root, a.body.path))).toEqual(bytes);
    expect((await fs.stat(path.join(root, a.body.path))).mode & 0o777).toBe(0o600);
  });
  it("rejects invalid extensions, fake PDFs/DOCX, empty and multiple file forms", async () => {
    for (const filename of ["resume.exe", "resume.pdf", "resume.docx"]) {
      expect((await send(upload([{ filename, bytes: Buffer.from("not document") }]))).status).toBe(415);
    }
    expect((await send(upload([]))).status).toBe(400);
    expect((await send(upload([1, 2].map(() => ({ filename: "x.txt", bytes: Buffer.from("x") }))))).status).toBe(400);
    await expect(fs.access(path.join(root, "uploads"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts the exact 10 MiB boundary", async () => {
    const response = await send(upload([{ filename: "exact.txt", bytes: Buffer.alloc(10 * 1024 * 1024) }]));
    expect(response.status).toBe(201);
    expect((await fs.stat(path.join(root, response.body.path))).size).toBe(10 * 1024 * 1024);
  });
  it("rejects files above 10 MiB and non-multipart requests without writing", async () => {
    expect((await send(upload([{ filename: "big.txt", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }]))).status).toBe(413);
    const req = upload([]); req.headers["content-type"] = "application/json";
    expect((await send(req)).status).toBe(415);
    await expect(fs.access(path.join(root, "uploads"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a symlink uploads directory", async () => {
    await fs.mkdir(path.join(root, "other"));
    await fs.symlink(path.join(root, "other"), path.join(root, "uploads"));
    await expect(send(upload([{ filename: "x.txt", bytes: Buffer.from("x") }]))).rejects.toThrow("unsafe");
    expect(await fs.readdir(path.join(root, "other"))).toEqual([]);
  });
  it("uses the mutating API host, origin, and CSRF protection", () => {
    const access = createLocalAccess({ port: 4747 });
    const req = { path: "/api/chat/attachments", method: "POST", headers: { host: "localhost:4747", origin: "http://localhost:4747", "x-pi-jobs-csrf": access.token } };
    let status = 200; let passed = false;
    const res = { set() {}, status(n: number) { status = n; return this; }, json() {} };
    const check = () => { status = 200; passed = false; access.middleware(req as unknown as Request, res as unknown as Response, () => { passed = true; }); };
    check(); expect(passed).toBe(true);
    req.headers.origin = "https://attacker.example"; check(); expect(status).toBe(403);
    req.headers.origin = "http://localhost:4747"; req.headers.host = "attacker.example"; check(); expect(status).toBe(403);
    req.headers.host = "localhost:4747"; req.headers["x-pi-jobs-csrf"] = "bad"; check(); expect(status).toBe(403);
  });
});
