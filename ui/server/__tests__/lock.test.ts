import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { withLock } from "../lock";

let root: string;
let target: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
  target = path.join(root, "counter.log");
  await fs.writeFile(target, "");
});

afterAll(async () => {
  await rmFixtureWorkspace(root);
});

describe("withLock", () => {
  it("serializes concurrent read-modify-writes", async () => {
    const writers = Array.from({ length: 10 }, (_, i) =>
      withLock(target, async () => {
        const current = await fs.readFile(target, "utf-8");
        // small delay to widen any race window
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        await fs.writeFile(target, `${current}${i}\n`);
      }),
    );
    await Promise.all(writers);
    const lines = (await fs.readFile(target, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(10);
    expect(new Set(lines).size).toBe(10);
  });

  it("propagates fn errors and releases the lock", async () => {
    await expect(
      withLock(target, async () => {
        throw new Error("inside");
      }),
    ).rejects.toThrow("inside");
    // lock was released — a new lock is acquired immediately
    await withLock(target, async () => {
      await fs.appendFile(target, "after\n");
    });
    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("after");
  });
});
