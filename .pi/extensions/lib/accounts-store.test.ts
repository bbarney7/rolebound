import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAccount,
  mutateAccounts,
  NO_CHANGE,
  readAccountsFile,
} from "./accounts-store";

async function tempCredentials(): Promise<string> {
  const tmp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tmp, "pi-accounts-store-"));
  return path.join(dir, "credentials.json");
}

describe("accounts-store", () => {
  const files: string[] = [];

  afterEach(async () => {
    for (const file of files.splice(0)) {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("refuses to mutate corrupt or empty files and leaves bytes intact", async () => {
    const file = await tempCredentials();
    files.push(file);
    await fs.writeFile(file, "", "utf8");
    const before = await fs.readFile(file);
    const result = await mutateAccounts(() => ({} as any), file);
    expect(result.ok).toBe(false);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("bootstraps a missing file and preserves unknown fields", async () => {
    const file = await tempCredentials();
    files.push(file);
    const result = await mutateAccounts((creds) => {
      creds["acme.com"] = {
        username: "u",
        password: "p",
        email_used: "u",
        ats: "other",
        company: "Acme",
        host: "acme.com",
        created_at: "t",
        last_used_at: "t",
        extra_field: "kept",
      } as any;
      return creds;
    }, file);
    expect(result.ok).toBe(true);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toBe(
      JSON.stringify(
        {
          "acme.com": {
            username: "u",
            password: "p",
            email_used: "u",
            ats: "other",
            company: "Acme",
            host: "acme.com",
            created_at: "t",
            last_used_at: "t",
            extra_field: "kept",
          },
        },
        null,
        2,
      ),
    );
    const read = await readAccountsFile(file);
    expect((read["acme.com"] as any).extra_field).toBe("kept");
  });

  it("findAccount matches host then company", () => {
    const creds = Object.create(null) as Record<string, { company: string }>;
    creds["host.example"] = { company: "Other" };
    creds["other.example"] = { company: "Acme" };
    expect(findAccount(creds as any, "host.example", "Acme")?.key).toBe("host.example");
    expect(findAccount(creds as any, "missing", "Acme")?.key).toBe("other.example");
  });

  it("NO_CHANGE skips write", async () => {
    const file = await tempCredentials();
    files.push(file);
    await fs.writeFile(file, "{}", "utf8");
    const mtime = (await fs.stat(file)).mtimeMs;
    await mutateAccounts(() => NO_CHANGE, file);
    expect((await fs.stat(file)).mtimeMs).toBe(mtime);
  });
});
