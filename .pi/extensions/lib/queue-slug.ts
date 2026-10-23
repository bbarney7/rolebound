import { readdirSync } from "node:fs";
import path from "node:path";
import { isSafeSlug } from "./workspace-files";

export function resolveQueueSlug(filenameOrSlug: string): string {
  return filenameOrSlug.replace(/\.md$/, "").replace(/^\d+-/, "");
}

/** Keep the application slug and the queue's actual filename together. */
export function resolveQueueJob(root: string, filenameOrSlug: string): { slug: string; filename: string } {
  const raw = filenameOrSlug.replace(/\.md$/, "");
  const slug = resolveQueueSlug(raw);
  if (!isSafeSlug(raw) || !isSafeSlug(slug)) throw new Error(`invalid queue slug: ${filenameOrSlug}`);
  let files: string[] = [];
  try {
    files = readdirSync(path.join(root, "jobs", "queue")).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const filename = files.includes(`${raw}.md`) ? `${raw}.md` :
    files.find((file) => resolveQueueSlug(file) === slug) ?? `${slug}.md`;
  return { slug, filename };
}
