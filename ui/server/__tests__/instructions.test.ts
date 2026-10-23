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

describe("instructions API", () => {
  it("reads and updates instructions with revision checks", async () => {
    const instructionsPath = path.join(root, "instructions.md");
    await fs.rm(instructionsPath, { force: true });

    const current = await (await fetch(`${base}/api/instructions`)).json();
    expect(current.revision).toBeNull();
    expect(current.data).toEqual({ applying: "", finding: "", chat: "" });

    const updated = await fetch(`${base}/api/instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: null,
        applying: "Use midpoint salary",
        finding: "Score low pay as 1",
        chat: "Be brief",
      }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.data.applying).toBe("Use midpoint salary");
    expect(body.revision).toHaveLength(64);
    expect(await fs.readFile(instructionsPath, "utf8")).toContain("Use midpoint salary");

    const stale = await fetch(`${base}/api/instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: "0".repeat(64),
        applying: "x",
        finding: "y",
        chat: "z",
      }),
    });
    expect(stale.status).toBe(409);
  });

  it("rejects sections over 20,000 characters", async () => {
    const current = await (await fetch(`${base}/api/instructions`)).json();
    const res = await fetch(`${base}/api/instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: current.revision,
        applying: "x".repeat(20_001),
        finding: "",
        chat: "",
      }),
    });
    expect(res.status).toBe(400);
  });
});
