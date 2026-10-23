import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createExtensionHarnessWorkspace, createRecordingExtensionApi } from "./extensionHarness";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.resetModules(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
it("registers all six sanctioned tools and confines execution to the fixture workspace", async () => {
  vi.stubEnv("PI_JOBS_RUN_KIND", "chat");
  const ws = await createExtensionHarnessWorkspace(); cleanups.push(ws.cleanup);
  const api = createRecordingExtensionApi();
  await (await import(path.join(ws.root, ".pi/extensions/workspace-tools.ts"))).default(api.pi);
  expect([...api.tools.keys()]).toEqual([
    "profile_read",
    "profile_update_section",
    "queue_add_url",
    "resume_add",
    "resume_extract_text",
    "start_application",
    "instructions_read",
    "instructions_update",
  ]);
  await fs.writeFile(path.join(ws.root, "profile.md"), "## Identity\n<FILL IN>\n");
  const call = api.tools.get("profile_read")!;
  const read = await call("id", {}, undefined, undefined, { cwd: ws.root });
  expect(read.details.card).toBe("profile-diff");
  const wrong = await call("id", {}, undefined, undefined, { cwd: path.join(ws.root, "other") });
  expect(wrong.isError).toBe(true);
  expect(wrong.details.card).toBe("profile-diff");
});

it("preserves non-chat tool catalogs and their generated system prompts", async () => {
  const ws = await createExtensionHarnessWorkspace(); cleanups.push(ws.cleanup);
  const mod = await import(path.join(ws.root, ".pi/extensions/workspace-tools.ts"));
  for (const kind of ["", "apply", "apply-next", "gather", "score", "status"]) {
    vi.stubEnv("PI_JOBS_RUN_KIND", kind);
    const api = createRecordingExtensionApi(); await mod.default(api.pi);
    expect(api.tools.size).toBe(0);
  }
});
