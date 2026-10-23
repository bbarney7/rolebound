import { spawn } from "node:child_process";
import os from "node:os";

export type KeychainProbeResult = "present" | "absent";

export type ProviderHostDeps = {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeMajor?: number;
  keychainProbe: (service: string) => Promise<KeychainProbeResult>;
  ghProbe: () => Promise<{ exitCode: number }>;
};

export type ProviderRuntime = {
  env: NodeJS.ProcessEnv;
  nodeMajor: number;
};

export function providerRuntimeFromHost(host: ProviderHostDeps): ProviderRuntime {
  return {
    env: host.env,
    nodeMajor: host.nodeMajor ?? (Number(process.versions.node.split(".")[0]) || 0),
  };
}

export type ProviderCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number }>;

function runWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

async function productionKeychainProbe(
  service: string,
  platform: NodeJS.Platform,
  runCommand: ProviderCommandRunner,
): Promise<KeychainProbeResult> {
  if (platform !== "darwin") return "absent";
  const { exitCode } = await runCommand("security", ["find-generic-password", "-s", service], 2000);
  return exitCode === 0 ? "present" : "absent";
}

async function productionGhProbe(runCommand: ProviderCommandRunner): Promise<{ exitCode: number }> {
  return runCommand("gh", ["auth", "status", "-h", "github.com"], 3000);
}

export function buildProductionProviderHostDeps(options: {
  platform?: NodeJS.Platform;
  runCommand?: ProviderCommandRunner;
} = {}): ProviderHostDeps {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runWithTimeout;
  return {
    home: os.homedir(),
    env: process.env,
    platform,
    nodeMajor: Number(process.versions.node.split(".")[0]) || 0,
    keychainProbe: (service) => productionKeychainProbe(service, platform, runCommand),
    ghProbe: () => productionGhProbe(runCommand),
  };
}
