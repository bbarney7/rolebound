import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isInWorkspace, WORKSPACE } from "./lib/workspace";

export default async function workspaceTools(pi: ExtensionAPI) {
  // Extra tool descriptions also change pi’s system prompt; preserve non-chat runs.
  if (process.env.PI_JOBS_RUN_KIND !== "chat") return;
  // Loaded only for chat: the helpers import ui/server, which other runs must not need.
  const { createWorkspaceTools } = await import("./lib/workspace-tools");
  const tools = createWorkspaceTools(WORKSPACE);
  const definitions = [
    { name: "profile_read", description: "Read raw profile Markdown and report present sections and remaining template placeholders.", parameters: Type.Object({}) },
    { name: "profile_update_section", description: "Replace or create one ## profile section by heading name. markdown is its body; preserves all other raw text. Never invent applicant facts.", parameters: Type.Object({ section: Type.String(), markdown: Type.String() }) },
    { name: "queue_add_url", description: "Add an http(s) job URL to the queue. Supply known company, title and location; omitted values remain visibly unspecified.", parameters: Type.Object({ url: Type.String(), company: Type.Optional(Type.String()), title: Type.Optional(Type.String()), location: Type.Optional(Type.String()) }) },
    { name: "resume_add", description: "Copy an uploaded workspace file into resumes/. setDefault selects a PDF as default.pdf. Existing named resumes are never overwritten.", parameters: Type.Object({ path: Type.String(), setDefault: Type.Optional(Type.Boolean()) }) },
    { name: "resume_extract_text", description: "Extract text locally from a PDF/DOCX/TXT/MD in uploads/ or resumes/. No network or OCR.", parameters: Type.Object({ path: Type.String() }) },
    { name: "start_application", description: "Hand off to an applying run for a queued job (optional slug; omit for the next queue item). Call this instead of browser automation in chat.", parameters: Type.Object({ slug: Type.Optional(Type.String()) }) },
    { name: "instructions_read", description: "Read the user's saved agent instructions (applying, finding/scoring, chat).", parameters: Type.Object({}) },
    { name: "instructions_update", description: "Update one agent-instructions section in instructions.md. Default mode appends a new paragraph or bullet.", parameters: Type.Object({ section: Type.Union([Type.Literal("applying"), Type.Literal("finding"), Type.Literal("chat")]), markdown: Type.String(), mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])) }) },
  ] as const;
  for (const definition of definitions) {
    pi.registerTool({
      ...definition, label: definition.name,
      async execute(_id, params, _signal, _update, ctx) {
        const card = definition.name.startsWith("profile_")
          ? "profile-diff"
          : definition.name === "queue_add_url"
            ? "job-list"
            : "run-progress";
        try {
          if (!isInWorkspace(ctx.cwd)) throw new Error("Not in the Rolebound workspace");
          // Each schema above supplies the corresponding helper's parameter shape.
          return await (tools[definition.name] as (params: any) => Promise<any>)(params);
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { card } };
        }
      },
    });
  }
}
