import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpRoots: string[] = [];

async function withTempWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, "pi-gather-int-"));
  tmpRoots.push(root);
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.cp(path.join(process.cwd(), "templates"), path.join(root, "templates"), { recursive: true });
  await fs.writeFile(
    path.join(root, "gather_state.json"),
    JSON.stringify({ seen_urls: {}, per_company: {} }, null, 2),
    "utf8",
  );
  vi.resetModules();
  vi.doMock("./workspace", async () => {
    const actual = await vi.importActual<typeof import("./workspace")>("./workspace");
    return {
      ...actual,
      WORKSPACE: root,
      wsPath: (...segments: string[]) => path.join(root, ...segments),
    };
  });
  await run(root);
}

afterEach(async () => {
  vi.doUnmock("./workspace");
  vi.resetModules();
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("gather-store integration", () => {
  it("merge does not drop rejected decisions written during gather", async () => {
    await withTempWorkspace(async (root) => {
      const { mergeGatherResults } = await import("./gather-store");
      const snapshot = { "https://x": { decision: "discovered", first_seen: "1" } };
      const current = {
        seen_urls: { "https://x": { decision: "rejected", first_seen: "1", reject_reason: "nope" } },
        per_company: {},
      };
      const proposed = {
        seen_urls: { "https://x": { decision: "discovered", first_seen: "2" } },
        per_company: {},
      };
      const merged = mergeGatherResults(current, snapshot, proposed, []);
      expect((merged.seen_urls as Record<string, { decision?: string }>)["https://x"].decision).toBe("rejected");
    });
  });

  it("promote collision returns EEXIST and keeps both files", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/wandb";
      const body = `url: ${url}\ncompany: W&B\n`;
      await fs.writeFile(path.join(root, "jobs", "discovered", "wandb.md"), body, "utf8");
      await fs.writeFile(path.join(root, "jobs", "queue", "wandb.md"), "other content\n", "utf8");
      const { promoteDiscovered } = await import("./gather-store");
      const result = await promoteDiscovered("wandb");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("EEXIST");
      expect(await fs.stat(path.join(root, "jobs", "discovered", "wandb.md"))).toBeDefined();
      expect(await fs.stat(path.join(root, "jobs", "queue", "wandb.md"))).toBeDefined();
    });
  });

  it("promote matches gather state by URL when slug differs from display name", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/weights-biases";
      const body = `url: ${url}\ncompany: Weights & Biases\n`;
      await fs.writeFile(path.join(root, "jobs", "discovered", "wandb.md"), body, "utf8");
      const { promoteDiscovered } = await import("./gather-store");
      const result = await promoteDiscovered("wandb");
      expect(result.ok).toBe(true);
      const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
      expect(gather.seen_urls[url].decision).toBe("promoted");
    });
  });

  it("reject with no URL deletes file and reports", async () => {
    await withTempWorkspace(async (root) => {
      await fs.writeFile(path.join(root, "jobs", "discovered", "nourl.md"), "company: x\n", "utf8");
      const { rejectDiscovered } = await import("./gather-store");
      const result = await rejectDiscovered("nourl", "reason");
      expect(result.ok).toBe(true);
      expect(result.error).toContain("no seen_urls");
      expect(await fs.stat(path.join(root, "jobs", "discovered", "nourl.md")).catch(() => null)).toBeNull();
    });
  });

  it("reject on changed identity deletes nothing", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/changed";
      const body = `url: ${url}\n`;
      const file = path.join(root, "jobs", "discovered", "chg.md");
      await fs.writeFile(file, body, "utf8");
      const { rejectDiscovered } = await import("./gather-store");
      const result = await rejectDiscovered("chg", "reason", {
        afterRejectPending: async () => {
          await fs.writeFile(file, `${body}edited\n`, "utf8");
        },
      });
      expect(result.ok).toBe(false);
      expect(await fs.stat(file)).toBeDefined();
    });
  });

  it("reject matches gather state by URL for slug file name", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/reject-by-url";
      await fs.writeFile(path.join(root, "jobs", "discovered", "wandb.md"), `url: ${url}\n`, "utf8");
      const { rejectDiscovered } = await import("./gather-store");
      const result = await rejectDiscovered("wandb", "not a fit");
      expect(result.ok).toBe(true);
      const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
      expect(gather.seen_urls[url].decision).toBe("rejected");
    });
  });

  it("writeDiscoveredJob does not clobber a scored file", async () => {
    await withTempWorkspace(async (root) => {
      const rel = "jobs/discovered/scored.md";
      const scored = "url: https://a\nllm_score: 5\n";
      await fs.writeFile(path.join(root, rel), scored, "utf8");
      const { writeDiscoveredJob } = await import("./gather-store");
      const out = await writeDiscoveredJob(rel, "url: https://a\n");
      expect(out).toBe("exists");
      expect(await fs.readFile(path.join(root, rel), "utf8")).toBe(scored);
    });
  });

  it("promoteDiscovered returns BUSY when the discovered lock is held", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/busy-promote";
      const src = path.join(root, "jobs", "discovered", "busy.md");
      await fs.writeFile(src, `url: ${url}\n`, "utf8");
      const lockTarget = `${src}.lock`;
      await fs.appendFile(lockTarget, "");
      const lockfile = await import("proper-lockfile");
      // The holder never compromises the run: its update timer must not throw
      // after cleanup, and it is released even if the call under test fails.
      const release = await lockfile.lock(lockTarget, { retries: 0, onCompromised: () => {} });
      const { promoteDiscovered } = await import("./gather-store");
      let result: Awaited<ReturnType<typeof promoteDiscovered>>;
      try {
        result = await promoteDiscovered("busy");
      } finally {
        await release().catch(() => {});
      }
      expect(result.ok).toBe(false);
      expect(result.code).toBe("BUSY");
    });
  }, 20_000);

  it("rejectDiscovered returns BUSY when the discovered lock is held", async () => {
    await withTempWorkspace(async (root) => {
      const url = "https://jobs.example/busy-reject";
      const src = path.join(root, "jobs", "discovered", "busy.md");
      await fs.writeFile(src, `url: ${url}\n`, "utf8");
      const lockTarget = `${src}.lock`;
      await fs.appendFile(lockTarget, "");
      const lockfile = await import("proper-lockfile");
      // The holder never compromises the run: its update timer must not throw
      // after cleanup, and it is released even if the call under test fails.
      const release = await lockfile.lock(lockTarget, { retries: 0, onCompromised: () => {} });
      const { rejectDiscovered } = await import("./gather-store");
      let result: Awaited<ReturnType<typeof rejectDiscovered>>;
      try {
        result = await rejectDiscovered("busy", "nope");
      } finally {
        await release().catch(() => {});
      }
      expect(result.ok).toBe(false);
      expect(result.code).toBe("BUSY");
    });
  }, 20_000);

  it("refuses traversal slug on reject", async () => {
    await withTempWorkspace(async () => {
      const { rejectDiscovered } = await import("./gather-store");
      const result = await rejectDiscovered("../applied/x", "n");
      expect(result.code).toBe("UNSAFE");
    });
  });
});
