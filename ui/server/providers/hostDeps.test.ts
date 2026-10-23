import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProductionProviderHostDeps } from "./hostDeps";

const previousProbeFlag = process.env.PI_JOBS_E2E_PROBES;
const previousGhProbeFlag = process.env.PI_JOBS_E2E_GH_PROBE;
const previousNodeMajor = process.env.PI_JOBS_E2E_NODE_MAJOR;

afterEach(() => {
  if (previousProbeFlag === undefined) delete process.env.PI_JOBS_E2E_PROBES;
  else process.env.PI_JOBS_E2E_PROBES = previousProbeFlag;
  if (previousGhProbeFlag === undefined) delete process.env.PI_JOBS_E2E_GH_PROBE;
  else process.env.PI_JOBS_E2E_GH_PROBE = previousGhProbeFlag;
  if (previousNodeMajor === undefined) delete process.env.PI_JOBS_E2E_NODE_MAJOR;
  else process.env.PI_JOBS_E2E_NODE_MAJOR = previousNodeMajor;
});

describe("buildProductionProviderHostDeps", () => {
  it("ignores e2e environment switches and runs the production command probes", async () => {
    process.env.PI_JOBS_E2E_PROBES = "1";
    process.env.PI_JOBS_E2E_GH_PROBE = "present";
    process.env.PI_JOBS_E2E_NODE_MAJOR = "999";
    const runCommand = vi.fn(async (command: string) => ({ exitCode: command === "security" ? 0 : 7 }));

    const deps = buildProductionProviderHostDeps({ platform: "darwin", runCommand });

    expect(deps.nodeMajor).toBe(Number(process.versions.node.split(".")[0]));
    await expect(deps.keychainProbe("Claude Code-credentials")).resolves.toBe("present");
    await expect(deps.ghProbe()).resolves.toEqual({ exitCode: 7 });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      2000,
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["auth", "status", "-h", "github.com"],
      3000,
    );
  });
});
