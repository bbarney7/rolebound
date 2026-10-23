import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { addressesRouter } from "../routes/profile";

let server: Server | null = null; let root = "";
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; if (root) await rmFixtureWorkspace(root); root = ""; });
describe("PUT /api/addresses/:key", () => {
  it("stores a truthful address while preserving unrelated state.json data", async () => {
    root = await makeFixtureWorkspace(); const file = path.join(root, "state.json"); const before = JSON.parse(await fs.readFile(file, "utf8"));
    const app = express(); app.use(express.json()); app.use("/api/addresses", addressesRouter(root)); server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const revision = (await (await fetch(`${base}/api/addresses`)).json()).revision;
    const response = await fetch(`${base}/api/addresses/denver`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, street: "100 Main St", city: "Denver", state: "CO", zip: "80202" }) });
    expect(response.status).toBe(200); const saved = JSON.parse(await fs.readFile(file, "utf8")); expect(saved.addresses.denver).toEqual({ street: "100 Main St", city: "Denver", state: "CO", zip: "80202" }); expect(saved.applications).toEqual(before.applications);
  });
  it("rejects stale revisions and malformed address stores without losing bytes", async () => {
    root = await makeFixtureWorkspace(); const file = path.join(root, "state.json");
    const app = express(); app.use(express.json()); app.use("/api/addresses", addressesRouter(root)); server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const revision = (await (await fetch(`${base}/api/addresses`)).json()).revision; await fs.writeFile(file, JSON.stringify({ addresses: [], keep: "me" })); const malformed = await fs.readFile(file, "utf8");
    const body = { revision, street: "1 Main", city: "Denver", state: "CO", zip: "80202" };
    expect((await fetch(`${base}/api/addresses/default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(409); expect(await fs.readFile(file, "utf8")).toBe(malformed);
  });
  it("creates state.json for a first default address without inventing other fields", async () => {
    root = await makeFixtureWorkspace(); await fs.rm(path.join(root, "state.json")); const app = express(); app.use(express.json()); app.use("/api/addresses", addressesRouter(root)); server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/addresses/default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: null, street: "1 Main", city: "Denver", state: "CO", zip: "80202" }) }); expect(response.status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"))).toEqual({ addresses: { default: { street: "1 Main", city: "Denver", state: "CO", zip: "80202" } } });
  });
});
