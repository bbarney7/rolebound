import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readProfileText } from "../../../ui/server/readers/profile";
import { createProfileFromTemplate, mutateProfile } from "../../../ui/server/profileWriter";
import { indexSections, normalizeHeading } from "../../../ui/server/profileText";
import { textContainsProfilePlaceholder } from "../../../ui/shared/profilePlaceholders";
import { createQueueFile } from "../../../ui/server/queueWriter";
import { markSeenUrlPromoted } from "../../../ui/server/readers/gatherState";
import { readJobFile } from "../../../ui/server/readers/jobFiles";
import { resolveQueueJob } from "./queue-slug";
import { paths } from "../../../ui/server/workspace";
import { withResumeRunGuard } from "../../../ui/server/runConfig";
import { readResumeInput, writeResume } from "./resume-writer";
import type { ToolCardDetails } from "../../../ui/shared/types";
import {
  readInstructions,
  writeInstructionSection,
  type InstructionSectionKey,
} from "./instructions";

function result(text: string, details: ToolCardDetails, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

export function createWorkspaceTools(root: string) {
  return {
    async profile_read() {
      const markdown = await readProfileText(root);
      const sections = indexSections(markdown ?? "").filter(s => s.level === 2).map(s => ({
        section: s.heading, present: true,
        placeholders: textContainsProfilePlaceholder((markdown ?? "").slice(s.bodyStart, s.bodyWithSubsectionsEnd).replace(/<!--[\s\S]*?-->/g, "")),
      }));
      return result(markdown ?? "profile.md does not exist", { card: "profile-diff", markdown, sections });
    },
    async profile_update_section(params: { section: string; markdown: string }) {
      const section = params.section.replace(/^##\s+/, "").trim();
      if (!section || /[\r\n]/.test(section) || /^(#{1,2})\s+/m.test(params.markdown)) throw new Error("provide one section name and its body (only ### or deeper headings)");
      if (await readProfileText(root) === null) {
        const created = await createProfileFromTemplate(root);
        if (!created.ok && created.error.code !== "EXISTS") throw new Error(created.error.message);
      }
      let before = "";
      const changed = await mutateProfile(root, md => {
        const spans = indexSections(md).filter(s => s.level === 2 && normalizeHeading(s.heading) === normalizeHeading(section));
        if (spans.length > 1) throw new Error("section is ambiguous; remove duplicate headings in the form");
        const span = spans[0];
        before = span ? md.slice(span.bodyStart, span.bodyWithSubsectionsEnd) : "";
        const after = `${params.markdown.trimEnd()}\n\n`;
        return { ok: true, text: span
          ? md.slice(0, span.bodyStart) + after + md.slice(span.bodyWithSubsectionsEnd)
          : md + (md.endsWith("\n\n") ? "" : md.endsWith("\n") ? "\n" : "\n\n") + `## ${section}\n\n` + after };
      });
      if (!changed.ok) throw new Error(changed.error.message);
      return result(`Updated ## ${section}`, { card: "profile-diff", section, before, after: params.markdown });
    },
    async queue_add_url(params: { url: string; company?: string; title?: string; location?: string }) {
      const url = new URL(params.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must use http(s)");
      const created = await createQueueFile(root, {
        url: params.url, company: params.company?.trim() || "Unspecified",
        title: params.title?.trim() || "Job posting", location: params.location?.trim() || "Unspecified",
        ...(!params.company || !params.title ? { slug: `job-${createHash("sha256").update(params.url).digest("hex").slice(0, 16)}` } : {}),
        source: "manual",
      });
      if (!created.ok) throw new Error(created.error.message);
      const marked = await markSeenUrlPromoted(root, params.url, { company: params.company?.trim() || "Unspecified", title: params.title?.trim() || "Job posting", source: "manual" });
      const job = await readJobFile(root, "queue", created.slug);
      return result(`Queued ${created.slug}`, { card: "job-list", jobs: job ? [job] : [], warning: marked.warning });
    },
    async resume_add(params: { path: string; setDefault?: boolean }) {
      const bytes = await readResumeInput(root, params.path);
      const filename = path.basename(params.path);
      if (params.setDefault && path.extname(filename).toLowerCase() !== ".pdf") throw new Error("Only PDF resumes can be the application default; DOCX/TXT/MD can be imported for profile extraction");
      await withResumeRunGuard(root, async () => {
        // A chat owns its run; serialize with UI upload and run preparation without denying its own tool.
        if (params.path !== `resumes/${filename}`) {
          const added = await writeResume(root, filename, bytes);
          if ("error" in added) throw new Error(added.error);
        }
        if (params.setDefault && filename !== "default.pdf") {
          const selected = await writeResume(root, "default.pdf", bytes, true);
          if ("error" in selected) throw new Error(selected.error);
        }
      });
      const relative = params.setDefault ? "resumes/default.pdf" : `resumes/${filename}`;
      return result(`Resume saved to ${relative}`, { card: "run-progress", path: relative, setDefault: params.setDefault === true });
    },
    async start_application(params: { slug?: string }) {
      if (params.slug !== undefined) {
        const slug = params.slug.trim();
        if (!slug) throw new Error("slug must be nonempty when provided");
        // Numbered queue files (001-acme.md) resolve to their canonical slug, as other apply paths do.
        const resolved = resolveQueueJob(root, slug);
        try {
          await fs.stat(path.join(root, "jobs", "queue", resolved.filename));
        } catch {
          throw new Error("queue item not found");
        }
        return {
          content: [{ type: "text" as const, text: "Starting the application in a dedicated run with the applying model. End your turn now." }],
          details: { handoff: { kind: "apply", slug: resolved.slug } },
        };
      }
      return {
        content: [{ type: "text" as const, text: "Starting the application in a dedicated run with the applying model. End your turn now." }],
        details: { handoff: { kind: "apply-next", slug: null } },
      };
    },
    async instructions_read() {
      const sections = await readInstructions(root);
      return result("Read agent instructions", { card: "run-progress", ...sections });
    },
    async instructions_update(params: {
      section: InstructionSectionKey;
      markdown: string;
      mode?: "replace" | "append";
    }) {
      const sections = await writeInstructionSection(root, params.section, params.markdown, params.mode ?? "append");
      const label =
        params.section === "applying"
          ? "When applying"
          : params.section === "finding"
            ? "When finding and scoring jobs"
            : "In the chat";
      return result(`Saved under Agent instructions → ${label}`, { card: "run-progress", section: params.section, ...sections });
    },
    async resume_extract_text(params: { path: string }) {
      const bytes = await readResumeInput(root, params.path);
      const extension = path.extname(params.path).toLowerCase();
      let text: string;
      if (extension === ".pdf") {
        const { extractPdfText } = await import("./resume-extract");
        text = await extractPdfText(bytes);
      } else if (extension === ".docx") {
        const { extractDocxText } = await import("./resume-extract");
        text = await extractDocxText(bytes);
      } else { text = bytes.toString("utf8"); }
      return result(text || "No text found; ask the user for a text resume (scanned PDFs require OCR).", { card: "run-progress", path: params.path, text });
    },
  };
}
