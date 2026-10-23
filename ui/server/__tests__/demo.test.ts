import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp } from "../app";
import { makeFixtureWorkspace, rmFixtureWorkspace, seedRunsApplyReady } from "./helpers";
import { paths } from "../workspace";

const DEMO_BANNER = /demo synthetic runner loaded/i;

describe("demo runtime", () => {
  let root: string | undefined;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (root) await rmFixtureWorkspace(root);
  });

  it("uses the production demo runner for supervised runs", async () => {
    root = await makeFixtureWorkspace();
    const app = createApp(root, { demo: true, security: { enabled: false } });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}`;

    const start = await fetch(`${url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "status" }),
    });
    expect(start.status).toBe(201);
    const run = await start.json();
    expect(run.model).toBe("demo/fake");

    for (let i = 0; i < 40; i++) {
      const current = await (await fetch(`${url}/api/runs/current`)).json();
      if (current.run?.status === "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ready = await (await fetch(`${url}/api/runs/current`)).json();
    expect(ready.run?.status).toBe("waiting");
    expect(ready.events.some((entry: { type?: string; message?: string }) => entry.type === "notify" && DEMO_BANNER.test(String(entry.message)))).toBe(true);

    const reply = await fetch(`${url}/api/runs/${run.runId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/status" }),
    });
    expect(reply.status).toBe(200);

    const finish = await fetch(`${url}/api/runs/${run.runId}/finish`, { method: "POST" });
    expect(finish.status).toBe(200);
  });

  it(
    "records a synthetic demo application after demo verification code",
    async () => {
    // boundary: B16 — demo never submits to employers (synthetic receipt only).
    root = await makeFixtureWorkspace();
    await seedRunsApplyReady(root);
    const slug = "demo-apply-role";
    const queueDir = path.join(root, "jobs", "queue");
    for (const file of await fs.readdir(queueDir)) {
      if (file.endsWith(".md")) await fs.unlink(path.join(queueDir, file));
    }
    await fs.writeFile(
      paths.jobFile(root, "queue", slug),
      `---\nurl: https://example.invalid/jobs/${slug}\ncompany: Demo Co\ntitle: Demo Role\n---\nSynthetic queue item.\n`,
    );

    const app = createApp(root, { demo: true, security: { enabled: false } });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}`;

    const start = await fetch(`${url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "apply-next" }),
    });
    expect(start.status).toBe(201);
    const run = await start.json();
    expect(run.slug).toBe(slug);

    let uiRequest: { id: string; title?: string } | undefined;
    for (let i = 0; i < 80; i++) {
      const current = await (await fetch(`${url}/api/runs/current`)).json();
      uiRequest = current.events.find(
        (entry: { type?: string; method?: string; id?: string; title?: string }) =>
          entry.type === "ui_request" && entry.method === "input" && entry.title === "Demo verification code",
      );
      if (uiRequest) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(uiRequest?.id).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const confirm = await fetch(`${url}/api/runs/${run.runId}/ui-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: uiRequest!.id, value: "12345678" }),
    });
    expect(confirm.status).toBe(200);

    let appliedReady = false;
    for (let i = 0; i < 200; i++) {
      appliedReady = await fs.stat(paths.jobFile(root, "applied", slug)).then(() => true).catch(() => false);
      if (appliedReady) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(appliedReady).toBe(true);
    const final = await (await fetch(`${url}/api/runs/current`)).json();
    expect(final.events.some((entry: { type?: string; message?: string }) => entry.type === "notify" && String(entry.message).includes("Demo receipt written"))).toBe(true);

    const applied = await fs.readFile(paths.jobFile(root, "applied", slug), "utf8");
    expect(applied).toMatch(/demo:\s*true/);
    expect(applied).toMatch(/not sent to any employer/i);
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(state.applications.some((entry: { slug?: string; status?: string }) => entry.slug === slug && entry.status === "submitted")).toBe(true);
    await expect(fs.stat(paths.jobFile(root, "queue", slug))).rejects.toThrow();
    await expect(fs.stat(path.join(root, "screenshots", `demo-synthetic-${slug}-confirmation.svg`))).resolves.toBeDefined();

    const detailRes = await fetch(`${url}/api/applications/${slug}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.application.applyState).toBe("submitted");
    expect(detail.application.attempts[0]?.outcome).toBe("submitted");
    expect(detail.application.screenshot).toMatch(/demo-synthetic-.*\.svg$/);
    const shot = await fetch(`${url}/api/applications/${slug}/screenshot`);
    expect(shot.status).toBe(200);
    expect(await shot.text()).toContain("Demo application receipt");
  },
  20_000,
  );
});
