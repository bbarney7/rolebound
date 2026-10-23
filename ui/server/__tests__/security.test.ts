import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { request } from "node:http";
import { createApp } from "../app";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import type { ProviderHostDeps } from "../providers/hostDeps";

describe("local API security", () => {
  let root: string | undefined;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); if (root) await rmFixtureWorkspace(root); });

  it("issues a session token and enforces host, origin, and CSRF", async () => {
    root = await makeFixtureWorkspace();
    const port = 4789;
    const app = createApp(root, { security: { enabled: true, port } });
    server = app.listen(port, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", () => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const session = await fetch(`${url}/api/session`, { headers: { host: `127.0.0.1:${port}` } });
    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    const token = (await session.json() as { csrfToken: string }).csrfToken;
    expect(token.length).toBeGreaterThan(20);
    expect((await fetch(`${url}/api/accounts`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${url}/api/accounts`, { headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" } })).status).toBe(403);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/api/accounts`, { headers: { host: `evil.example:${port}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    expect(hostileHostStatus).toBe(403);
    expect((await fetch(`${url}/api/accounts`, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${url}/api/accounts`, { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    const ok = await fetch(`${url}/api/accounts`, { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-pi-jobs-csrf": token }, body: JSON.stringify({}) });
    expect(ok.status).toBe(400);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const malformed = await fetch(`${url}/api/accounts`, { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-pi-jobs-csrf": token }, body: "{" });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
  });

  it("demo mode — spy on every providerHost probe and on fs reads under the fixture home; GET /api/providers/detected returns [] and no probe or read happens; every /api/providers/* mutation and /api/connections/:id/login* route returns 409 DEMO_DISABLED", async () => {
    root = await makeFixtureWorkspace();
    const fakeHome = path.join(root, "demo-home");
    await fs.mkdir(fakeHome, { recursive: true });
    const keychainProbe = vi.fn(async (): Promise<import("../providers/hostDeps").KeychainProbeResult> => "present");
    const ghProbe = vi.fn(async () => ({ exitCode: 0 }));
    const host: ProviderHostDeps = {
      home: fakeHome,
      env: { ANTHROPIC_API_KEY: "FIXTURE-SECRET-do-not-leak" },
      platform: "darwin",
      keychainProbe,
      ghProbe,
    };
    const readSpy = vi.spyOn(fs, "readFile");
    const app = createApp(root, { demo: true, security: { enabled: false }, providerHost: host });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}`;

    const detected = await fetch(`${url}/api/providers/detected`);
    expect(await detected.json()).toEqual([]);
    expect(keychainProbe).not.toHaveBeenCalled();
    expect(ghProbe).not.toHaveBeenCalled();
    const readsUnderHome = readSpy.mock.calls.filter(([target]) => String(target).startsWith(fakeHome));
    expect(readsUnderHome).toHaveLength(0);

    expect((await fetch(`${url}/api/providers/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await fetch(`${url}/api/providers/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "GET" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "DELETE" })).status).toBe(409);
    expect(
      (await fetch(`${url}/api/connections/fixture/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).status,
    ).toBe(409);

    readSpy.mockRestore();
  });

  it("demo mode blocks external services but allows fake supervised runs", async () => {
    root = await makeFixtureWorkspace();
    const app = createApp(root, { demo: true, security: { enabled: false } });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ demo: true });
    expect((await fetch(`${url}/api/connections/fixture/test`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/models`)).status).toBe(409);
    expect((await fetch(`${url}/api/settings/captcha/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await fetch(`${url}/api/providers/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "GET" })).status).toBe(409);
    expect((await fetch(`${url}/api/connections/fixture/login`, { method: "DELETE" })).status).toBe(409);
    expect(
      (await fetch(`${url}/api/connections/fixture/login/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).status,
    ).toBe(409);
    const start = await fetch(`${url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "status" }) });
    expect(start.status).toBe(201);
  });
});
