import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listApplications } from "../union";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
  minimalProfileMd,
} from "./extensionHarness";
import { seedRunsApplyReady } from "./helpers";

describe("extension harness — job-applier", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("complete_application tool runs through the harness", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    const slug = "role-a";
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        {
          applications: [{ slug, status: "submitted", queue_file: `jobs/queue/0-${slug}.md` }],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(ws.root, "jobs", "queue", `0-${slug}.md`), "url: https://ex.test/a\n", "utf8");

    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
    const { pi, tools } = createRecordingExtensionApi();
    mod.default(pi);
    const complete = tools.get("complete_application");
    expect(complete).toBeDefined();
    const out = await complete!("t", { slug });
    expect(out.isError).not.toBe(true);
    const apps = await listApplications(ws.root);
    expect(apps.filter((a) => a.slug === slug)).toHaveLength(1);
  });

  it("/apply-next skips a queue file that duplicates applied content for a submitted URL", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    const url = "https://ex.test/dup";
    const slug = "x";
    const body = `url: ${url}\n`;
    const queuePath = path.join(ws.root, "jobs", "queue", `0-${slug}.md`);
    const appliedPath = path.join(ws.root, "jobs", "applied", `${slug}.md`);
    await fs.writeFile(queuePath, body, "utf8");
    await fs.writeFile(appliedPath, body, "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify(
        { applications: [{ slug, status: "submitted", url }], addresses: {}, acknowledged_at: "t" },
        null,
        2,
      ),
      "utf8",
    );

    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
    const { pi, commands, sentMessages } = createRecordingExtensionApi();
    mod.default(pi);
    const applyNext = commands.get("apply-next");
    expect(applyNext).toBeDefined();
    await applyNext!("", {
      cwd: ws.root,
      ui: { notify: () => {} },
    });
    expect(sentMessages.some((m) => m.includes("0-x.md"))).toBe(false);
  });

  it("/acknowledge declined leaves state unchanged", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }, null, 2),
      "utf8",
    );

    const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
    const { pi, commands } = createRecordingExtensionApi();
    mod.default(pi);
    const acknowledge = commands.get("acknowledge");
    expect(acknowledge).toBeDefined();
    await acknowledge!("", {
      cwd: ws.root,
      hasUI: true,
      ui: { confirm: async () => false, notify: () => {} },
    });
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8")) as {
      acknowledged_at?: string;
      acknowledged_policy?: string;
    };
    expect(state.acknowledged_at).toBeUndefined();
    expect(state.acknowledged_policy).toBeUndefined();
  });
  it("/apply-next uses the canonical numbered slug and the actual queue filename", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await seedRunsApplyReady(ws.root);
    await fs.writeFile(path.join(ws.root, "state.json"), JSON.stringify({
      applications: [], addresses: {}, acknowledged_at: "2026-01-01T00:00:00Z", acknowledged_policy: "auto-submit-v1",
    }));
    await fs.writeFile(path.join(ws.root, "jobs/queue/01-foo.md"), "url: https://example.invalid/foo\n");
    const mod = await import(path.join(ws.root, ".pi/extensions/job-applier.ts"));
    const api = createRecordingExtensionApi();
    mod.default(api.pi);
    await api.commands.get("apply-next")!("", { cwd: ws.root, ui: { notify: () => {} } });
    expect(api.sentMessages).toContain("Apply to the next queued job: foo (file: jobs/queue/01-foo.md); use slug `foo` in tool calls");
  });

});
