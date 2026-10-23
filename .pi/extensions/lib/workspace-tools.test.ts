import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceTools } from "./workspace-tools";
import { writeResume } from "./resume-writer";

let root: string;
let tools: ReturnType<typeof createWorkspaceTools>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-tools-"));
  for (const dir of ["templates", "uploads", "resumes", "jobs/queue"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, "templates/profile.template.md"), "# Profile\n\n## Identity\n- **Name:** <FILL IN>\n\n## Resume\n");
  await fs.writeFile(path.join(root, "profile.md"), "# Profile\n<!-- preserve -->\n## Identity\n- **Name:** <FILL IN>\n\n## Work history\n### Engineer\nProse with **formatting**\n\n## Education\nUntouched prose\n");
  await fs.writeFile(path.join(root, "gather_state.json"), '{"seen_urls":{}}');
  tools = createWorkspaceTools(root);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("sanctioned workspace tools", () => {
  it("profile_read reports raw Markdown, section presence, and placeholders", async () => {
    const res = await tools.profile_read();
    expect(res.details.card).toBe("profile-diff");
    expect(res.details.sections).toEqual([
      { section: "Identity", present: true, placeholders: true },
      { section: "Work history", present: true, placeholders: false },
      { section: "Education", present: true, placeholders: false },
    ]);
    expect(res.content[0].text).toContain("<!-- preserve -->");
  });
  it("profile_update_section replaces raw text including subsections and preserves other bytes", async () => {
    const original = await fs.readFile(path.join(root, "profile.md"), "utf8");
    const res = await tools.profile_update_section({ section: "Work history", markdown: "### Manager\nRaw prose <!-- note -->" });
    const changed = await fs.readFile(path.join(root, "profile.md"), "utf8");
    expect(changed).toBe(original.replace("### Engineer\nProse with **formatting**\n\n", "### Manager\nRaw prose <!-- note -->\n\n"));
    expect(res.details.before).toContain("### Engineer");
    expect(await fs.readFile(path.join(root, "profile.md.bak"), "utf8")).toBe(original);
    await expect(tools.profile_update_section({ section: "Identity", markdown: "## Education\nInjected" })).rejects.toThrow("one section");
  });
  it("creates absent sections and serializes edits on the UI's profile lock", async () => {
    await Promise.all(["A", "B"].map(section => tools.profile_update_section({ section, markdown: `Custom ${section}` })));
    const res = await tools.profile_read();
    expect(res.content[0].text).toContain("## A\n\nCustom A");
    expect(res.content[0].text).toContain("## B\n\nCustom B");
    await fs.unlink(path.join(root, "profile.md"));
    await tools.profile_update_section({ section: "Identity", markdown: "Jane Doe" });
    expect((await tools.profile_read()).content[0].text).toContain("## Resume");
  });
  it("queue_add_url uses the UI writer and dedup hints, refuses collisions and unsafe URLs", async () => {
    const res = await tools.queue_add_url({ url: "https://example.com/job/1", company: "Acme", title: "Engineer", location: "Remote" });
    expect(res.details.card).toBe("job-list");
    expect(await fs.readFile(path.join(root, "jobs/queue/acme-engineer.md"), "utf8")).toContain("url: https://example.com/job/1");
    expect(JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8")).seen_urls["https://example.com/job/1"].decision).toBe("promoted");
    await expect(tools.queue_add_url({ url: "https://example.com/job/1", company: "Acme", title: "Engineer" })).rejects.toThrow("already exists");
    await expect(tools.queue_add_url({ url: "file:///etc/passwd" })).rejects.toThrow("http(s)");
    await expect(tools.queue_add_url({ url: "https://example.com", title: "a\nb", company: "Acme" })).rejects.toThrow("newlines");
    expect((await tools.queue_add_url({ url: "https://example.com/job/2" })).details.card).toBe("job-list");
  });
  it("resume_add copies uploaded PDFs privately, atomically selects default, and refuses named replacement", async () => {
    await fs.writeFile(path.join(root, "uploads/resume.pdf"), "%PDF-1.7\nfixture");
    await tools.resume_add({ path: "uploads/resume.pdf", setDefault: true });
    expect(await fs.readFile(path.join(root, "resumes/default.pdf"), "utf8")).toBe("%PDF-1.7\nfixture");
    expect((await fs.stat(path.join(root, "resumes/resume.pdf"))).mode & 0o777).toBe(0o600);
    await expect(tools.resume_add({ path: "uploads/resume.pdf" })).rejects.toThrow("already exists");
    await fs.writeFile(path.join(root, "uploads/resume.txt"), "Jane");
    await tools.resume_add({ path: "uploads/resume.txt" });
    await expect(tools.resume_add({ path: "uploads/resume.txt", setDefault: true })).rejects.toThrow("Only PDF");
  });
  it("shares the directory lock with the UI resume writer", async () => {
    const results = await Promise.all(["one", "two"].map(s => writeResume(root, "same.pdf", Buffer.from(`%PDF-${s}`))));
    expect(results.filter(r => "existed" in r)).toHaveLength(1);
    expect(results.filter(r => "error" in r)).toHaveLength(1);
  });
  it("rejects absolute paths, traversal, symlink files and directories, oversized or fake PDFs", async () => {
    for (const input of ["/tmp/private.pdf", "uploads/../profile.md", "profile.md", "uploads/x.exe"]) await expect(tools.resume_extract_text({ path: input })).rejects.toThrow();
    await fs.symlink(path.join(root, "profile.md"), path.join(root, "uploads/link.md"));
    await expect(tools.resume_extract_text({ path: "uploads/link.md" })).rejects.toThrow("regular file");
    await fs.writeFile(path.join(root, "uploads/big.txt"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(tools.resume_extract_text({ path: "uploads/big.txt" })).rejects.toThrow("10 MiB");
    await fs.writeFile(path.join(root, "uploads/fake.pdf"), "fake");
    await expect(tools.resume_add({ path: "uploads/fake.pdf" })).rejects.toThrow("valid PDF");
    await fs.rm(path.join(root, "resumes"), { recursive: true });
    await fs.symlink(path.join(root, "uploads"), path.join(root, "resumes"));
    await expect(writeResume(root, "x.pdf", Buffer.from("%PDF-x"))).rejects.toThrow("unsafe");
  });
  it.each(["txt", "md"])("resume_extract_text extracts %s locally without changing profile", async ext => {
    const before = await fs.readFile(path.join(root, "profile.md"), "utf8");
    await fs.writeFile(path.join(root, `uploads/resume.${ext}`), "Jane Doe\nEngineer");
    const res = await tools.resume_extract_text({ path: `uploads/resume.${ext}` });
    expect(res.content[0].text).toBe("Jane Doe\nEngineer");
    expect(res.details.card).toBe("run-progress");
    expect(await fs.readFile(path.join(root, "profile.md"), "utf8")).toBe(before);
  });
});

function textPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
function storedZip(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  for (const [filename, text] of Object.entries(entries)) {
    const name = Buffer.from(filename); const body = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, body); directory.push(central, name); offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
it("extracts real PDF text locally", async () => {
  await fs.writeFile(path.join(root, "uploads/resume.pdf"), textPdf("Jane Doe Engineer"));
  expect((await tools.resume_extract_text({ path: "uploads/resume.pdf" })).content[0].text).toContain("Jane Doe Engineer");
});
it("extracts real DOCX text locally", async () => {
  const bytes = storedZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Doe Engineer</w:t></w:r></w:p></w:body></w:document>',
  });
  await fs.writeFile(path.join(root, "uploads/resume.docx"), bytes);
  expect((await tools.resume_extract_text({ path: "uploads/resume.docx" })).content[0].text).toContain("Jane Doe Engineer");
});

  it("instructions_read and instructions_update round-trip a section", async () => {
    const read = await tools.instructions_read();
    expect(read.details.card).toBe("run-progress");
    expect(read.details.applying).toBe("");
    const updated = await tools.instructions_update({ section: "chat", markdown: "Keep it short." });
    expect(updated.content[0].text).toContain("In the chat");
    expect(updated.details.chat).toBe("Keep it short.");
    const again = await tools.instructions_read();
    expect(again.details.chat).toBe("Keep it short.");
  });

  it("start_application returns apply handoff details for a queued slug", async () => {
    await fs.writeFile(path.join(root, "jobs/queue/acme.md"), "url: https://example.com\n");
    const res = await tools.start_application({ slug: "acme" });
    expect(res.content[0].text).toContain("End your turn now");
    expect(res.details).toEqual({ handoff: { kind: "apply", slug: "acme" } });
    await expect(tools.start_application({ slug: "missing" })).rejects.toThrow("queue item not found");
  });

  it("start_application resolves a numbered queue file to its canonical slug", async () => {
    await fs.writeFile(path.join(root, "jobs/queue/001-globex-engineer.md"), "url: https://example.com\n");
    const res = await tools.start_application({ slug: "globex-engineer" });
    expect(res.details).toEqual({ handoff: { kind: "apply", slug: "globex-engineer" } });
  });