import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { readProfile } from "../readers/profile";
import { mutateProfile } from "../profileWriter";
import { setBulletValues } from "../profileText";

describe("profile revision writes", () => {
  it("rejects a stale revision and leaves both current and backup bytes unchanged", async () => {
    const root = await makeFixtureWorkspace();
    try {
      const file = path.join(root, "profile.md"); const before = await fs.readFile(file, "utf8");
      const revision = (await readProfile(root)).revision!;
      const first = await mutateProfile(root, (md) => setBulletValues(md, "identity", { email: "first@example.com" }), revision);
      expect(first.ok).toBe(true); const current = await fs.readFile(file, "utf8"); const backup = await fs.readFile(`${file}.bak`, "utf8"); expect(backup).toBe(before);
      const stale = await mutateProfile(root, (md) => setBulletValues(md, "identity", { email: "stale@example.com" }), revision);
      expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(await fs.readFile(file, "utf8")).toBe(current); expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(backup);
    } finally { await rmFixtureWorkspace(root); }
  });
});
