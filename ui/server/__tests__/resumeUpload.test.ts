import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resumesRouter } from "../routes/profile";

const roots: string[] = [];
const servers: Server[] = [];
async function fixture(active = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-upload-")); roots.push(root);
  await fs.mkdir(path.join(root, "resumes"));
  await fs.writeFile(path.join(root, "profile.md"), "# Applicant Profile\n\n## Resume\n");
  const app = express(); app.use(express.json()); app.use("/api/resumes", resumesRouter(root, { isRunActive: () => active }));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); servers.push(server);
  return { root, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function form(name: string, bytes: Uint8Array, replace = false) {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const body = new FormData(); body.append("file", new Blob([copy.buffer], { type: "application/pdf" }), name); body.append("replace", String(replace)); return body;
}
const pdf = (tail: string) => new TextEncoder().encode(`%PDF-1.7\n${tail}`);
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });

describe("POST /api/resumes", () => {
  it("uploads a PDF and requires explicit replacement while preserving old bytes", async () => {
    const { root, base } = await fixture();
    expect((await fetch(`${base}/api/resumes`, { method: "POST", body: form("resume.pdf", pdf("old")) })).status).toBe(201);
    const refused = await fetch(`${base}/api/resumes`, { method: "POST", body: form("resume.pdf", pdf("new")) });
    expect(refused.status).toBe(409); expect(await fs.readFile(path.join(root, "resumes/resume.pdf"), "utf8")).toContain("old");
    const replaced = await fetch(`${base}/api/resumes`, { method: "POST", body: form("resume.pdf", pdf("new"), true) });
    expect(replaced.status).toBe(200); expect(await fs.readFile(path.join(root, "resumes/resume.pdf"), "utf8")).toContain("new");
  });

  it("rejects oversized and fake PDFs without changing an existing file", async () => {
    const { root, base } = await fixture(); const target = path.join(root, "resumes/resume.pdf"); await fs.writeFile(target, pdf("old"));
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1); tooBig.set(pdf(""));
    expect((await fetch(`${base}/api/resumes`, { method: "POST", body: form("resume.pdf", tooBig, true) })).status).toBe(413);
    expect((await fetch(`${base}/api/resumes`, { method: "POST", body: form("resume.pdf", new TextEncoder().encode("not pdf"), true) })).status).toBe(415);
    expect(await fs.readFile(target, "utf8")).toContain("old");
  });

  it("refuses traversal, symlink targets, and changes during an active run", async () => {
    const first = await fixture(); const outside = path.join(first.root, "outside.pdf"); await fs.writeFile(outside, pdf("outside")); await fs.symlink(outside, path.join(first.root, "resumes/link.pdf"));
    expect((await fetch(`${first.base}/api/resumes`, { method: "POST", body: form("../escape.pdf", pdf("x")) })).status).toBe(400);
    expect((await fetch(`${first.base}/api/resumes`, { method: "POST", body: form("link.pdf", pdf("x"), true) })).status).toBe(409);
    expect(await fs.readFile(outside, "utf8")).toContain("outside");
    const busy = await fixture(true); expect((await fetch(`${busy.base}/api/resumes`, { method: "POST", body: form("busy.pdf", pdf("x")) })).status).toBe(409);
    await expect(fs.access(path.join(busy.root, "resumes/busy.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent creates so only one wins and its bytes stay whole", async () => {
    const { root, base } = await fixture();
    const responses = await Promise.all(["one", "two"].map((v) => fetch(`${base}/api/resumes`, { method: "POST", body: form("same.pdf", pdf(v)) })));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(["%PDF-1.7\none", "%PDF-1.7\ntwo"]).toContain(await fs.readFile(path.join(root, "resumes/same.pdf"), "utf8"));
  });
  it("assigns an uploaded PDF as the global override the agent resolves", async () => {
    const { root, base } = await fixture(); await fs.writeFile(path.join(root, "resumes/custom.pdf"), pdf("custom"));
    const revision = (await (await import("../readers/profile")).readProfile(root)).revision;
    const response = await fetch(`${base}/api/resumes/selection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "custom.pdf", mode: "override", revision }) });
    expect(response.status).toBe(200); const body = await response.json(); expect(body.profile.resume.overridePath).toBe("resumes/custom.pdf"); expect(body.resumes.files.find((f: any) => f.name === "custom.pdf").reachability).toBe("override");
  });
  it("copies a selected PDF atomically to the runtime default", async () => {
    const { root, base } = await fixture(); await fs.writeFile(path.join(root, "resumes/custom.pdf"), pdf("custom")); const revision = (await (await import("../readers/profile")).readProfile(root)).revision;
    const response = await fetch(`${base}/api/resumes/selection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "custom.pdf", mode: "default", revision }) }); expect(response.status).toBe(200); expect(await fs.readFile(path.join(root, "resumes/default.pdf"), "utf8")).toContain("custom");
  });
});
