import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountEntry } from "../accountsWriter";
import {
  createExtensionHarnessWorkspace,
  createRecordingExtensionApi,
  credentialsPath,
  loadJobAccountsExtension,
  minimalProfileMd,
} from "./extensionHarness";

describe("extension harness — job-accounts", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("loads job-accounts and runs list_accounts on an empty workspace", async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");

    const { pi, tools } = createRecordingExtensionApi();
    const register = await loadJobAccountsExtension(ws.root);
    register(pi);

    const list = tools.get("list_accounts");
    expect(list).toBeDefined();
    const out = await list!("t1", {});
    expect(out.isError).not.toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("No accounts");
  });

  it(
    "create_account races createAccountEntry — exactly one winner per host",
    async () => {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");

    const { pi, tools } = createRecordingExtensionApi();
    const register = await loadJobAccountsExtension(ws.root);
    register(pi);
    const createTool = tools.get("create_account");
    expect(createTool).toBeDefined();

    const hostsA = Array.from({ length: 25 }, (_, i) => `a${i + 1}.example.com`);
    const hostsB = Array.from({ length: 25 }, (_, i) => `b${i + 1}.example.com`);

    const extensionCreates = hostsA.map((host) =>
      createTool!("race", { host, company: `Co ${host}`, ats: "other" }),
    );
    const serverCreates = hostsB.map((host) =>
      createAccountEntry(ws.root, host, { username: "srv", ats: "other", company: `Co ${host}` }),
    );

    const extResults = await Promise.all(extensionCreates);
    const srvResults = await Promise.all(serverCreates);

    for (const r of extResults) {
      expect(r.isError).not.toBe(true);
    }
    for (const r of srvResults) {
      expect(r.ok).toBe(true);
    }

    const raw = JSON.parse(await fs.readFile(credentialsPath(ws.root), "utf8")) as Record<string, unknown>;
    for (const host of hostsA) {
      expect(raw[host]).toBeDefined();
    }
    for (const host of hostsB) {
      expect(raw[host]).toBeDefined();
    }

    const dupHost = hostsA[0];
    const dupExt = await createTool!("dup", { host: dupHost, company: "Co", ats: "other" });
    expect((dupExt.details as { already_exists?: boolean })?.already_exists).toBe(true);
    const dupSrv = await createAccountEntry(ws.root, dupHost, { username: "x", ats: "other" });
    expect(dupSrv.ok).toBe(false);
  },
    30_000,
  );
});
