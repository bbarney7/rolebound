import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../../.pi/extensions/lib/durable-store";
import { paths } from "./workspace";
import type { UiState } from "../shared/types";

const DEFAULT_STATE: UiState = { version: 1, applications: {} };

/** In-process write serialization (atomic rename alone loses concurrent RMW). */
let writeQueue: Promise<unknown> = Promise.resolve();

/** Fresh read on every call — the file is tiny; no cache, no staleness. */
export async function readUiState(root: string): Promise<UiState> {
  try {
    const raw = JSON.parse(await fs.readFile(paths.uiState(root), "utf-8")) as Record<string, unknown>;
    return {
      ...raw,
      version: typeof raw.version === "number" ? raw.version : 1,
      applications: (raw.applications as UiState["applications"]) ?? {},
    } as UiState;
  } catch (err: any) {
    if (err?.code === "ENOENT") return structuredClone(DEFAULT_STATE);
    throw err;
  }
}

/**
 * The single write path for ui-state.json. Reads inside the serialized section,
 * applies the mutator, writes a unique temp file, then atomically renames.
 */
export function updateUiState(
  root: string,
  mutator: (state: UiState) => void,
): Promise<UiState> {
  const run = writeQueue.then(async () => {
    const state = await readUiState(root);
    mutator(state);
    const file = paths.uiState(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await fs.stat(file).catch(() => null))) {
      await fs.writeFile(file, JSON.stringify(DEFAULT_STATE, null, 2));
    }
    await atomicWriteFile(file, JSON.stringify(state, null, 2));
    return state;
  });
  // Keep the queue alive across failures without swallowing the caller's error.
  writeQueue = run.catch(() => {});
  return run;
}
