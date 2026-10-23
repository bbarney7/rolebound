import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../app";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";

describe("GET /api/overview corrupt workspace files", () => {
  let root: string;
  let server: Server;
  let base: string;

  async function bootWorkspace(): Promise<void> {
    root = await makeFixtureWorkspace();
    const app = createApp(root, { security: { enabled: false }, settings: { env: {} } });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (root) await rmFixtureWorkspace(root);
  });

  it("returns 200 with null accounts and corrupt for zero-byte credentials.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "credentials.json"), "", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toBeNull();
    expect(body.corrupt).toContain("credentials.json");
  });

  it("returns 200 with corrupt for garbage credentials.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "credentials.json"), "{not-json", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toBeNull();
    expect(body.corrupt).toContain("credentials.json");
  });

  it("returns 200 with corrupt gather summary for zero-byte gather_state.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "gather_state.json"), "", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.corrupt).toContain("gather_state.json");
  });

  it("returns 200 with corrupt gather summary for garbage gather_state.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "gather_state.json"), "[][]", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.corrupt).toContain("gather_state.json");
  });

  it("returns 200 with null applications and corrupt for zero-byte state.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "state.json"), "", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toBeNull();
    expect(body.corrupt).toContain("state.json");
  });

  it("returns 200 with null applications and corrupt for garbage state.json", async () => {
    await bootWorkspace();
    await fs.writeFile(path.join(root, "state.json"), "null", "utf8");
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toBeNull();
    expect(body.corrupt).toContain("state.json");
  });
});
