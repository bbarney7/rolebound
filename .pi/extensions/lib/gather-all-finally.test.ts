import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedGatherState } from "./workspace-files";

const roots: string[] = [];

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-gather-finally-"));
  roots.push(root);
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
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("gatherAll finally merge", () => {
  it("persists partial gather state when the try block throws", async () => {
    await withTempRoot(async (root) => {
    const snapshot = { "https://u": { decision: "discovered", first_seen: "0" } };
    const proposed: ParsedGatherState = {
      seen_urls: {
        "https://u": { decision: "discovered", first_seen: "1" },
        "https://v": { decision: "discovered", first_seen: "2" },
      },
      per_company: { acme: { matched_count: 2 } },
      last_full_gather: "now",
    };

    await expect(
      (async () => {
        try {
          throw new Error("simulated gather failure");
        } finally {
          const { mergeGatherResults, mutateGatherState } = await import("./gather-store");
          const out = await mutateGatherState((current) =>
            mergeGatherResults(current, snapshot, proposed, ["acme"]),
          );
          if ("error" in out) throw out.error;
        }
      })(),
    ).rejects.toThrow("simulated gather failure");

    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls["https://v"]).toBeDefined();
    expect(gather.per_company.acme).toEqual({ matched_count: 2 });
    });
  });
});
