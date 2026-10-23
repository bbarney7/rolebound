import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";

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

describe("targets API", () => {
  it("reads and updates targets with revision checks", async () => {
    const current = await (await fetch(`${base}/api/targets`)).json();
    expect(Array.isArray(current.entries)).toBe(true);
    expect(current.revision === null || typeof current.revision === "string").toBe(true);
    const updated = await fetch(`${base}/api/targets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: current.revision,
        entries: [
          { source: "greenhouse", slug: "fixture-co" },
          { source: "ashby", slug: "fixture-co" },
        ],
      }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.entries).toEqual([
      { source: "greenhouse", slug: "fixture-co" },
      { source: "ashby", slug: "fixture-co" },
    ]);
    expect(await fs.readFile(path.join(root, "targets.md"), "utf8")).toContain("- fixture-co");
    if (current.revision) {
      const conflict = await fetch(`${base}/api/targets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: current.revision, entries: body.entries }),
      });
      expect(conflict.status).toBe(409);
    }
  });

  it("rejects invalid ATS slugs", async () => {
    const current = await (await fetch(`${base}/api/targets`)).json();
    const res = await fetch(`${base}/api/targets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: current.revision, entries: [{ source: "greenhouse", slug: "../escape" }] }),
    });
    expect(res.status).toBe(400);
  });
});
