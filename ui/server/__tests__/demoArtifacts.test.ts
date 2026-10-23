import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitDemoApplication, buildDemoReceiptSvg } from "../demoArtifacts.mjs";
import { getApplication } from "../union";
import { createApp } from "../app";

describe("demoArtifacts", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function seedQueue(slug: string) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-demo-artifacts-"));
    for (const dir of ["jobs/queue", "jobs/applied", "screenshots"]) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
    await fs.writeFile(
      path.join(root, "state.json"),
      `${JSON.stringify({ acknowledged_at: "2026-01-01T00:00:00.000Z", addresses: {}, applications: [], last_updated: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(root, "jobs", "queue", `${slug}.md`),
      `---\nurl: https://example.invalid/jobs/${slug}\ncompany: Demo Co\ntitle: Demo Role\nlocation: Remote\n---\nSynthetic queue item.\n`,
    );
  }

  it("writes readable SVG receipt and state attempt schema visible via application API", async () => {
    const slug = "demo-artifact-role";
    await seedQueue(slug);
    const result = commitDemoApplication(root!, slug);
    expect(result.screenshotRel).toMatch(/\.svg$/);

    const receipt = await fs.readFile(path.join(root!, result.screenshotRel), "utf8");
    expect(receipt).toContain("Demo application receipt");
    expect(receipt).toContain("Synthetic — not sent to any employer");
    expect(buildDemoReceiptSvg({ slug, title: "Demo Role", company: "Demo Co", submittedAt: "2026-01-01T00:00:00.000Z" }))
      .toContain("Demo Role");
    const escaped = buildDemoReceiptSvg({
      slug: "x",
      title: `<script>alert(1)</script>`,
      company: `Evil "Co'`,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&apos;");

    const app = await getApplication(root!, slug);
    expect(app?.applyState).toBe("submitted");
    expect(app?.attempts).toHaveLength(1);
    expect(app?.attempts[0]?.outcome).toBe("submitted");
    expect(app?.screenshot).toBe(result.screenshotRel);
    const state = JSON.parse(await fs.readFile(path.join(root!, "state.json"), "utf8"));
    expect(state.applications[0].confirmation_source).toBe("demo");
    expect(app?.queueFile).toBe(`jobs/applied/${slug}.md`);
    await expect(fs.stat(path.join(root!, "jobs", "queue", `${slug}.md`))).rejects.toThrow();
  });

  it("rolls back partial commit on injected failure and preserves queue for retry", async () => {
    const slug = "demo-rollback-role";
    await seedQueue(slug);
    const queuePath = path.join(root!, "jobs", "queue", `${slug}.md`);
    const stateBefore = await fs.readFile(path.join(root!, "state.json"), "utf8");

    expect(() => commitDemoApplication(root!, slug, { injectFailureAfter: "screenshot" }))
      .toThrow(/injected failure/);

    await expect(fs.stat(path.join(root!, "jobs", "applied", `${slug}.md`))).rejects.toThrow();
    await expect(fs.stat(path.join(root!, "screenshots", `demo-synthetic-${slug}-confirmation.svg`))).rejects.toThrow();
    expect(await fs.readFile(path.join(root!, "state.json"), "utf8")).toBe(stateBefore);
    await expect(fs.stat(queuePath)).resolves.toBeDefined();

    const retry = commitDemoApplication(root!, slug);
    expect(retry.appliedPath).toBe(`jobs/applied/${slug}.md`);
    const app = await getApplication(root!, slug);
    expect(app?.applyState).toBe("submitted");
  });

  it("pipeline edit preserves attempt outcome and screenshot evidence", async () => {
    const slug = "demo-pipeline-role";
    await seedQueue(slug);
    commitDemoApplication(root!, slug);

    const app = createApp(root!, { security: { enabled: false } });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const patch = await fetch(`${base}/api/applications/${slug}/pipeline`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pipelineStatus: "interviewing" }),
      });
      expect(patch.status).toBe(200);
      const detail = await patch.json();
      expect(detail.application.pipelineStatus).toBe("interviewing");
      expect(detail.application.attempts[0]?.outcome).toBe("submitted");
      expect(detail.application.screenshot).toMatch(/demo-synthetic-.*\.svg$/);

      const shot = await fetch(`${base}/api/applications/${slug}/screenshot`);
      expect(shot.status).toBe(200);
      expect(shot.headers.get("content-type")).toMatch(/svg|image/);
      expect(await shot.text()).toContain("Demo application receipt");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
