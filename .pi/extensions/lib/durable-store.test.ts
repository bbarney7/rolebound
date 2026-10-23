import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicCreateFile,
  atomicWriteFile,
  LOCK_RETRY_BUDGET_MS,
  LOCK_STALE_MS,
  LOCKFILE_RETRY_OPTIONS,
  LockCompromisedError,
  LockReentryError,
  minimumLockRetryBudgetMs,
  mutateJsonFile,
  NO_CHANGE,
  readJsonFile,
  withFileLock,
  WorkspaceFileError,
} from "./durable-store";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "durable-store-"));
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.trim() === "") {
    throw new WorkspaceFileError("CORRUPT", "", "empty");
  }
  const v = JSON.parse(raw);
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new WorkspaceFileError("CORRUPT", "", "shape");
  }
  return v as Record<string, unknown>;
}

describe("durable-store", () => {
  it("lock retry budget is at least the stale window", () => {
    expect(minimumLockRetryBudgetMs(LOCKFILE_RETRY_OPTIONS)).toBeGreaterThanOrEqual(LOCK_STALE_MS);
    expect(minimumLockRetryBudgetMs(LOCKFILE_RETRY_OPTIONS)).toBeGreaterThanOrEqual(LOCK_RETRY_BUDGET_MS - 500);
  });

  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it("reads missing as missing", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    const r = await readJsonFile(file, parseJsonObject);
    expect(r.state).toBe("missing");
  });

  it("throws CORRUPT for empty and bad shape without changing bytes", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    await fs.writeFile(file, "");
    await expect(readJsonFile(file, parseJsonObject)).rejects.toMatchObject({ code: "CORRUPT" });
    expect(await fs.readFile(file)).toEqual(Buffer.from(""));

    await fs.writeFile(file, "   \n");
    await expect(readJsonFile(file, parseJsonObject)).rejects.toMatchObject({ code: "CORRUPT" });

    await fs.writeFile(file, "[]");
    await expect(readJsonFile(file, parseJsonObject)).rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("refuses symlink and directory on read and write", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const real = path.join(dir, "real.json");
    await fs.writeFile(real, "{}");
    const link = path.join(dir, "credentials.json");
    await fs.symlink(real, link);
    await expect(readJsonFile(link, parseJsonObject)).rejects.toMatchObject({ code: "UNSAFE" });

    await fs.unlink(link);
    await fs.mkdir(link);
    await expect(readJsonFile(link, parseJsonObject)).rejects.toMatchObject({ code: "UNSAFE" });
    await fs.rmdir(link);
    await fs.symlink(real, link);
    await expect(atomicWriteFile(link, "{}", { mode: 0o644 })).rejects.toMatchObject({ code: "UNSAFE" });
  });

  it("leaves original intact when temp write fails and uses dot-tmp pattern", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "note.json");
    await fs.writeFile(file, "original", { mode: 0o644 });

    await expect(
      atomicWriteFile(file, "new", {
        testHooks: {
          afterTempWrite: async () => {
            throw new Error("injected write failure");
          },
        },
      }),
    ).rejects.toThrow("injected");

    expect(await fs.readFile(file, "utf8")).toBe("original");
    const names = await fs.readdir(dir);
    expect(names.some((n) => n.includes(".note.json.") && n.endsWith(".tmp"))).toBe(false);
  });

  it("atomicWriteFile creates a missing file with the requested mode", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "new-secret.json");
    await atomicWriteFile(file, '{"ok":true}', { mode: 0o600 });
    expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("preserves mode by default and forces 0600 for secrets", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const pub = path.join(dir, "public.json");
    await fs.writeFile(pub, "{}", { mode: 0o644 });
    await atomicWriteFile(pub, '{"a":1}');
    expect((await fs.stat(pub)).mode & 0o777).toBe(0o644);

    const cred = path.join(dir, "credentials.json");
    await fs.writeFile(cred, "{}", { mode: 0o644 });
    await atomicWriteFile(cred, '{"x":1}');
    expect((await fs.stat(cred)).mode & 0o777).toBe(0o600);
  });

  it("atomicCreateFile is exclusive and supports link fallback", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "new.json");
    await atomicCreateFile(file, '{"ok":true}');
    await expect(atomicCreateFile(file, '{"nope":true}')).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}');

    const file2 = path.join(dir, "fallback.json");
    await atomicCreateFile(file2, "{}", { injectLinkError: "EPERM" });
    expect(await fs.readFile(file2, "utf8")).toBe("{}");
  });

  it("serializes 20 concurrent increments", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "counter.json");
    await atomicCreateFile(file, '{"n":0}');

    const tasks = Array.from({ length: 20 }, () =>
      mutateJsonFile(
        file,
        {
          parse: (raw) => JSON.parse(raw) as { n: number },
          serialize: (v) => JSON.stringify(v),
          bootstrap: false,
        },
        (v) => ({ n: v.n + 1 }),
      ),
    );
    await Promise.all(tasks);
    const final = JSON.parse(await fs.readFile(file, "utf8")) as { n: number };
    expect(final.n).toBe(20);
  });

  it("nested same-target lock throws LOCK_REENTRY immediately", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    await fs.writeFile(file, "{}");
    await expect(
      withFileLock(file, async () => withFileLock(file, async () => "nested")),
    ).rejects.toBeInstanceOf(LockReentryError);
  });

  it(
    "aborts rename when lock is compromised",
    async () => {
      const dir = await tempDir();
      dirs.push(dir);
      const file = path.join(dir, "state.json");
      await fs.writeFile(file, "keep");

      await expect(
        withFileLock(
          file,
          async (ctx) => {
            ctx.compromised = true;
            await atomicWriteFile(file, "lost", { lockCtx: ctx });
          },
          { update: 50 },
        ),
      ).rejects.toBeInstanceOf(LockCompromisedError);
      expect(await fs.readFile(file, "utf8")).toBe("keep");
    },
    30_000,
  );

  it("mutateJsonFile respects NO_CHANGE", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    await fs.writeFile(file, '{"a":1}');
    const before = await fs.readFile(file);
    await mutateJsonFile(
      file,
      { parse: (r) => JSON.parse(r), serialize: (v) => JSON.stringify(v), bootstrap: false },
      () => NO_CHANGE,
    );
    expect(await fs.readFile(file)).toEqual(before);
  });
});
