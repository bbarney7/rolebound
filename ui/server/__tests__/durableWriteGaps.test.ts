import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { paths } from "../workspace";
import { createAccountEntry } from "../accountsWriter";
import { markSeenUrlPromoted } from "../readers/gatherState";
describe("durable write gaps", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rmFixtureWorkspace(root);
  });

  it("refuses to write symlinked credentials.json", async () => {
    root = await makeFixtureWorkspace();
    const sentinel = path.join(root, "outside-creds.json");
    await fs.writeFile(sentinel, "{}", "utf8");
    const creds = paths.credentials(root);
    await fs.unlink(creds);
    await fs.symlink(sentinel, creds);
    await expect(
      createAccountEntry(root, "example.com", {
        username: "u",
        password: "p",
        ats: "greenhouse",
        company: "Co",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE" });
    expect(await fs.readFile(sentinel, "utf8")).toBe("{}");
  });

  it("refuses to write symlinked gather_state.json", async () => {
    root = await makeFixtureWorkspace();
    const sentinel = path.join(root, "outside-gather.json");
    await fs.writeFile(sentinel, JSON.stringify({ seen_urls: {}, per_company: {} }), "utf8");
    const gather = path.join(root, "gather_state.json");
    await fs.unlink(gather);
    await fs.symlink(sentinel, gather);
    const result = await markSeenUrlPromoted(root, "https://example.test/job", {
      company: "Co",
      title: "Role",
      source: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/symlink|UNSAFE|must not/i);
    expect(await fs.readFile(sentinel, "utf8")).toContain("seen_urls");
  });
});
