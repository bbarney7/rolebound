import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, withFileLock } from "./durable-store";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const RESUME_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

export async function safeWorkspaceDirectory(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} directory is unsafe`);
  return dir;
}

/** UI and tools share the directory lock and atomic replacement protocol. */
export async function writeResume(
  root: string, filename: string, bytes: Buffer, replace = false,
  isBusy: () => boolean = () => false,
): Promise<{ existed: boolean } | { error: string; code?: string }> {
  if (path.basename(filename) !== filename || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(filename) || !RESUME_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    return { error: "choose a safe PDF/DOCX/TXT/MD filename" };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { error: "resume exceeds 10 MiB" };
  if (path.extname(filename).toLowerCase() === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return { error: "resume is not a valid PDF" };
  const dir = await safeWorkspaceDirectory(root, "resumes");
  return withFileLock(dir, async ctx => {
    if (isBusy()) return { error: "Cannot change a resume while a run is active", code: "RUN_BUSY" };
    const target = path.join(dir, filename);
    let existed = false;
    try {
      const stat = await fs.lstat(target); existed = true;
      if (stat.isSymbolicLink() || !stat.isFile()) return { error: "resume target is unsafe" };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existed && !replace) return { error: "resume already exists; confirm replacement", code: "REPLACE_REQUIRED" };
    await atomicWriteFile(target, bytes, { mode: 0o600, lockCtx: ctx });
    return { existed };
  });
}

/** Uploaded inputs are workspace-relative and confined to uploads/ or resumes/. */
export async function readResumeInput(root: string, relative: string): Promise<Buffer> {
  const parts = relative.split("/");
  if (parts.length !== 2 || !["uploads", "resumes"].includes(parts[0]) || !parts[1] || parts[1] === "." || parts[1] === ".." || relative.includes("\\") || path.isAbsolute(relative) || !RESUME_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    throw new Error("path must name a PDF/DOCX/TXT/MD inside uploads/ or resumes/");
  }
  const dir = path.join(root, parts[0]);
  const dirStat = await fs.lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("input directory is unsafe");
  const file = path.join(dir, parts[1]);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("input must be a regular file");
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("input must be a regular file");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("input exceeds 10 MiB");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("input exceeds 10 MiB");
    return bytes;
  } finally { await handle.close(); }
}
