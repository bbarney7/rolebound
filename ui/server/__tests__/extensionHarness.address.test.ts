import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
  minimalProfileMd,
} from "./extensionHarness";

const ADDRESS_PROFILE = `${minimalProfileMd()}
## City → Address rules (\`address_city_key\`)

| \`address_city_key\` | Display "City, State" | Match terms | ZIP (reference only; Rolebound never generates an address) |
|---|---|---|---|
| \`seattle\` | Seattle, WA | seattle | 98101 |
| \`default\` | Remote | remote | n/a |
`;

async function loadJobApplier(ws: { root: string }) {
  const mod = await import(path.join(ws.root, ".pi", "extensions", "job-applier.ts"));
  const api = createRecordingExtensionApi();
  mod.default(api.pi);
  return api;
}

describe("extension harness — truthful addresses (T9)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.resetModules();
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(ws: { root: string }) {
    await fs.writeFile(path.join(ws.root, "profile.md"), ADDRESS_PROFILE, "utf8");
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }),
      "utf8",
    );
  }

  it("generate_address without an address persists nothing and returns ask-user", async () => {
    // boundary: B11 — address never fabricated in generate_address.
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const api = await loadJobApplier(ws);
    const gen = api.tools.get("generate_address")!;
    const out = await gen("x", { city_key: "seattle" });
    const details = (out as { details: { address: null; reason?: string } }).details;
    expect(details.address).toBeNull();
    expect(details.reason).toMatch(/Ask the user/i);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.addresses).toEqual({});
  });

  it("refuses partial address fields", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const api = await loadJobApplier(ws);
    const gen = api.tools.get("generate_address")!;
    const out = await gen("x", {
      city_key: "seattle",
      address: { street: "1 Main", city: "Seattle", state: "WA", zip: "" },
    });
    const details = (out as { details: { address: null } }).details;
    expect(details.address).toBeNull();
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.addresses).toEqual({});
  });

  it("returns null for city_key default (Remote)", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const api = await loadJobApplier(ws);
    const gen = api.tools.get("generate_address")!;
    const out = await gen("x", {
      city_key: "default",
      address: { street: "1 Main", city: "Remote", state: "WA", zip: "98101" },
    });
    const details = (out as { details: { address: null; reason?: string } }).details;
    expect(details.address).toBeNull();
    expect(details.reason).toMatch(/Remote/i);
  });

  it("returns an existing address unchanged", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const existing = { street: "99 Pike St", city: "Seattle", state: "WA", zip: "98101" };
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: { seattle: existing } }),
      "utf8",
    );
    const api = await loadJobApplier(ws);
    const gen = api.tools.get("generate_address")!;
    const out = await gen("x", {
      city_key: "seattle",
      address: { street: "other", city: "Seattle", state: "WA", zip: "98102" },
    });
    expect((out as { details: typeof existing }).details).toEqual(existing);
    const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
    expect(state.addresses.seattle).toEqual(existing);
  });

  it("match_resume does not invent an address", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await setup(ws);
    const api = await loadJobApplier(ws);
    const match = api.tools.get("match_resume")!;
    const out = await match("x", { location: "Seattle, WA" });
    const details = (out as { details: { address_city_key: string; address: null } }).details;
    expect(details.address_city_key).toBe("seattle");
    expect(details.address).toBeNull();
  });
});
