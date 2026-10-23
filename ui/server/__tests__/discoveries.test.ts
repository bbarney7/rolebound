import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import * as jobFiles from "../readers/jobFiles";

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
  const app = createApp(root, { security: { enabled: false } });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rmFixtureWorkspace(root);
});

async function seedDiscoveries(count: number) {
  const dir = path.join(root, "jobs", "discovered");
  for (let i = 0; i < count; i++) {
    const slug = `discover-${String(i).padStart(4, "0")}`;
    await fs.writeFile(
      path.join(dir, `${slug}.md`),
      `---\nurl: https://example.invalid/${slug}\ncompany: Co ${i}\ntitle: Role ${i}\nlocation: Remote\nsource: greenhouse\nllm_score: ${(i % 5) + 1}\nllm_reasoning: Synthetic ${i}\ndiscovered_at: 2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z\n---\nBody ${i}\n`,
    );
  }
}

describe("discoveries API", () => {
  it("pages 1000+ discoveries with stable cursors", async () => {
    await seedDiscoveries(1005);
    const first = await (await fetch(`${base}/api/discoveries?limit=100`)).json();
    expect(first.items).toHaveLength(100);
    expect(first.total).toBeGreaterThanOrEqual(1005);
    expect(first.nextCursor).toBeTruthy();
    const second = await (await fetch(`${base}/api/discoveries?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.items[0].slug).not.toBe(first.items[0].slug);
    expect(second.items).toHaveLength(100);
  });

  it("loads queue/applied once when listing many discoveries", async () => {
    const listSpy = vi.spyOn(jobFiles, "listJobFiles");
    await seedDiscoveries(1000);
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(
        path.join(root, "jobs", "queue", `queue-${String(i).padStart(3, "0")}.md`),
        `---\nurl: https://example.invalid/queue/${i}\ncompany: Queue Co\ntitle: Queue ${i}\n---\n`,
      );
      await fs.writeFile(
        path.join(root, "jobs", "applied", `applied-${String(i).padStart(3, "0")}.md`),
        `---\nurl: https://example.invalid/applied/${i}\ncompany: Applied Co\ntitle: Applied ${i}\n---\n`,
      );
    }
    const started = performance.now();
    listSpy.mockClear();
    const payload = await (await fetch(`${base}/api/discoveries?limit=50`)).json();
    const elapsed = performance.now() - started;
    expect(payload.items).toHaveLength(50);
    expect(listSpy).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeLessThan(3000);
    listSpy.mockRestore();
  });

  it("returns detail, dismisses, and restores without deleting source files", async () => {
    const slug = "discover-detail";
    await fs.writeFile(
      path.join(root, "jobs", "discovered", `${slug}.md`),
      "---\nurl: https://example.invalid/detail\ncompany: Detail Co\ntitle: Detail Role\nlocation: Remote\nsource: greenhouse\n---\nDetail body\n",
    );
    const detail = await (await fetch(`${base}/api/discoveries/${slug}`)).json();
    expect(detail.body).toContain("Detail body");
    const dismissed = await fetch(`${base}/api/discoveries/${slug}/dismiss`, { method: "POST" });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).item.dismissed).toBe(true);
    expect(await fs.readFile(path.join(root, "jobs", "discovered", `${slug}.md`), "utf8")).toMatch(/dismissed:\s+'?true'?/);
    const restored = await fetch(`${base}/api/discoveries/${slug}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect((await restored.json()).item.dismissed).toBe(false);
  });

  it("returns 404 for missing dismiss targets and 400 for invalid slugs", async () => {
    expect((await fetch(`${base}/api/discoveries/missing-slug/dismiss`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/discoveries/${encodeURIComponent("../escape")}/dismiss`, { method: "POST" })).status).toBe(400);
  });
});
