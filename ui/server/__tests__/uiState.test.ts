import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { readUiState, updateUiState } from "../uiState";

let root: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
});

afterAll(async () => {
  await rmFixtureWorkspace(root);
});

describe("ui-state store", () => {
  it("returns the default state when the file is missing", async () => {
    const state = await readUiState(root);
    expect(state).toEqual({ version: 1, applications: {} });
  });

  it("serializes concurrent updates without lost writes", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `slug-${i}`);
    await Promise.all(
      keys.map((key) =>
        updateUiState(root, (s) => {
          s.applications[key] = { pipelineStatus: "interviewing" };
        }),
      ),
    );
    const state = await readUiState(root);
    expect(Object.keys(state.applications).sort()).toEqual(keys.sort());
    // file on disk matches
    const onDisk = JSON.parse(
      await fs.readFile(path.join(root, "ui", "ui-state.json"), "utf-8"),
    );
    expect(Object.keys(onDisk.applications)).toHaveLength(20);
  });

  it("preserves unknown top-level keys on read and write", async () => {
    const file = path.join(root, "ui", "ui-state.json");
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, applications: {}, experimentalFlag: true }, null, 2),
      "utf-8",
    );
    const state = await readUiState(root);
    expect((state as unknown as Record<string, unknown>).experimentalFlag).toBe(true);
    await updateUiState(root, (s) => {
      s.applications["x"] = { userNotes: "n" };
    });
    const onDisk = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(onDisk.experimentalFlag).toBe(true);
  });

  it("recovers the write queue after a failing mutator", async () => {
    await expect(
      updateUiState(root, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // subsequent writes still work
    await updateUiState(root, (s) => {
      s.applications["after-failure"] = { userNotes: "ok" };
    });
    const state = await readUiState(root);
    expect(state.applications["after-failure"].userNotes).toBe("ok");
  });
});
