import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CONNECTION_ID } from "../shared/demo";
import type { PreparedRun } from "./runConfig";
import type { RunManagerOptions } from "./runs/runManager";

const DEMO_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "demoFakePi.mjs");

export function demoFakePiPath(): string {
  return DEMO_RUNNER;
}

/** Demo runs never spawn real pi or materialize provider credentials. */
export async function prepareDemoRun(_root: string, _runId: string, _sessionName: string): Promise<PreparedRun> {
  return {
    command: process.execPath,
    args: [DEMO_RUNNER],
    env: {
      PI_JOBS_DEMO: "1",
      NO_EXTERNAL_CALLS: "1",
    },
    model: "demo/fake",
    snapshot: {
      connectionId: DEMO_CONNECTION_ID,
      provider: "openai-compatible",
      modelId: "demo-model",
      credentialSource: "none",
      capturedAt: new Date().toISOString(),
      settingsRevision: "demo",
    },
    cleanup: async () => {},
  };
}

export function demoRunManagerOptions(root: string): Partial<RunManagerOptions> {
  return {
    command: process.execPath,
    args: () => [demoFakePiPath()],
    model: "demo/fake",
    idleGraceMs: 500,
    prepare: (runId, sessionName) => prepareDemoRun(root, runId, sessionName),
    env: {
      PI_JOBS_DEMO: "1",
      NO_EXTERNAL_CALLS: "1",
    },
  };
}
