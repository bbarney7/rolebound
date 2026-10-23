import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionHarnessWorkspace, createRecordingExtensionApi } from "./extensionHarness";

async function loadPrompt(ws: { root: string }): Promise<string> {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  const result = await api.invokeEvent(
    "before_agent_start",
    { systemPrompt: "BASE" },
    { cwd: ws.root },
  );
  const merged = (result as { systemPrompt?: string })?.systemPrompt ?? "";
  const idx = merged.indexOf("## Job Applier Agent");
  return idx >= 0 ? merged.slice(idx) : merged;
}

describe("extension harness — job-applier prompt (T10)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const c of cleanups.splice(0)) await c();
  });

  it("appends chat guidance only for chat; every other run keeps identical bytes", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    vi.stubEnv("PI_JOBS_RUN_KIND", "");
    const original = await loadPrompt(ws);
    for (const kind of ["apply", "apply-next", "gather", "score", "status"]) {
      vi.stubEnv("PI_JOBS_RUN_KIND", kind);
      expect(await loadPrompt(ws)).toBe(original);
    }
    vi.stubEnv("PI_JOBS_RUN_KIND", "chat");
    const chat = await loadPrompt(ws);
    expect(chat.startsWith(original + "\n\n## Rolebound chat")).toBe(true);
    expect(chat).toContain("resume_extract_text");
    expect(chat).toContain("profile_update_section");
    expect(chat).toContain("Never invent facts");
  });

  it("includes applying instructions when instructions.md has an Applying section", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(ws.root, "instructions.md"),
      "## Applying\n\nNever skip salary.\n",
      "utf8",
    );
    const prompt = await loadPrompt(ws);
    expect(prompt).toContain("## Standing instructions from the user");
    expect(prompt).toContain("Never skip salary.");
    for (const kind of ["gather", "score", "status"]) {
      vi.stubEnv("PI_JOBS_RUN_KIND", kind);
      expect(await loadPrompt(ws)).not.toContain("Never skip salary.");
    }
  });

  it("discloses auto-submit, submission guard, and no false confirmation gate", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    const prompt = await loadPrompt(ws);
    expect(prompt.toLowerCase()).not.toContain("explicit submit confirmation");
    expect(prompt).toMatch(/Submit automatically/i);
    expect(prompt).toContain("### Submission guard");
    expect(prompt).not.toMatch(/reply\s+`?ACKNOWLEDGE`?/i);
    expect(prompt).not.toMatch(/reply ACKNOWLEDGE/i);
  });
});
