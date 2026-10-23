import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedPopulatedDemoWorkspace } from "../../../scripts/demo-seed.mjs";
import { DEMO_CONNECTION_ID } from "../../shared/demo";
import { readApplicationSettings } from "../applicationConfigStore";
import { computeReadiness } from "../readiness";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("demo seed", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("writes settings that parse and yields applyReady readiness", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-demo-seed-"));
    await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
    await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
    await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
    await fs.mkdir(path.join(root, "resumes"), { recursive: true });
    seedPopulatedDemoWorkspace(root, codeRoot);

    const settings = await readApplicationSettings(root);
    expect(settings.data.connections).toHaveLength(1);
    expect(settings.data.connections[0]?.id).toBe(DEMO_CONNECTION_ID);
    expect(settings.data.agent?.connectionId).toBe(DEMO_CONNECTION_ID);
    const { DEMO_CONNECTION_ID: seededId } = await import("../../../scripts/demo-constants.mjs");
    expect(seededId).toBe(DEMO_CONNECTION_ID);

    const readiness = await computeReadiness(root);
    expect(readiness.applyReady).toBe(true);
    expect(readiness.steps.find((step) => step.id === "readiness")?.complete).toBe(true);
  });
});
