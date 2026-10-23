import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let metadataRuntimePromise: Promise<import("@earendil-works/pi-coding-agent").ModelRuntime> | undefined;
let metadataAuthDir: string | undefined;
let metadataCleanupRegistered = false;

function registerMetadataCleanup(): void {
  if (metadataCleanupRegistered) return;
  metadataCleanupRegistered = true;
  process.once("beforeExit", () => {
    if (metadataAuthDir) void fs.rm(metadataAuthDir, { recursive: true, force: true });
  });
}

/** Builtin model metadata only — never reads ~/.pi agent auth or models.json. */
export function isolatedMetadataRuntime(): Promise<import("@earendil-works/pi-coding-agent").ModelRuntime> {
  if (!metadataRuntimePromise) {
    metadataRuntimePromise = (async () => {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      metadataAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-metadata-auth-"));
      const authPath = path.join(metadataAuthDir, "auth.json");
      await fs.writeFile(authPath, "{}\n", { mode: 0o600 });
      registerMetadataCleanup();
      return ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    })();
  }
  return metadataRuntimePromise;
}
