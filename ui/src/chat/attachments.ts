import { httpFetch } from "../http";

const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md"]);

export function isAllowedAttachment(file: File): boolean {
  const name = file.name.toLowerCase();
  for (const ext of ALLOWED_EXT) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

export function validateAttachmentSize(file: File): string | null {
  if (file.size > MAX_BYTES) return "File must be 10 MiB or smaller.";
  return null;
}

export async function uploadChatAttachment(file: File): Promise<string> {
  const sizeErr = validateAttachmentSize(file);
  if (sizeErr) throw new Error(sizeErr);
  if (!isAllowedAttachment(file)) throw new Error("Attachment must be PDF, DOCX, TXT, or MD.");

  const body = new FormData();
  body.append("file", file);
  // httpFetch adds the CSRF header every mutating API route requires.
  const res = await httpFetch("/api/chat/attachments", { method: "POST", body });
  const payload = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok) throw new Error(payload.error ?? `Upload failed (${res.status})`);
  if (!payload.path) throw new Error("Upload succeeded but no path was returned.");
  return payload.path;
}
