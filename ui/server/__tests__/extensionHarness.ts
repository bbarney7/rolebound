import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type HarnessWorkspace = {
  root: string;
  cleanup: () => Promise<void>;
};

/** Temp workspace with copied extensions, templates, and a node_modules symlink. */
export async function createExtensionHarnessWorkspace(): Promise<HarnessWorkspace> {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, "pi-ext-harness-"));

  await fs.cp(path.join(REPO_ROOT, "templates"), path.join(root, "templates"), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, "ui", "shared"), path.join(root, "ui", "shared"), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, "ui", "server"), path.join(root, "ui", "server"), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, ".pi", "extensions"), path.join(root, ".pi", "extensions"), {
    recursive: true,
  });
  await fs.symlink(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"));

  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });

  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function minimalProfileMd(): string {
  return `# Applicant Profile

## Identity

- **Full name:** Jane Doe
- **Email:** jane@example.com
- **Fallback email:** jane.fallback@example.com
`;
}

export type RecordedTool = {
  name: string;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<any>;
};

type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Minimal ExtensionAPI recorder for handler tests. */
export function createRecordingExtensionApi(): {
  pi: ExtensionAPI;
  tools: Map<string, RecordedTool["execute"]>;
  toolParameters: Map<string, unknown>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  sentMessages: string[];
  invokeToolCall: (event: unknown, ctx: unknown) => Promise<unknown>;
  invokeToolResult: (event: unknown, ctx: unknown) => Promise<unknown>;
  invokeSessionShutdown: (event: unknown, ctx: unknown) => Promise<void>;
  invokeEvent: (event: string, payload: unknown, ctx: unknown) => Promise<unknown>;
} {
  const tools = new Map<string, (...args: any[]) => Promise<any>>();
  const toolParameters = new Map<string, unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sentMessages: string[] = [];
  const handlers = new Map<string, Set<ExtensionHandler>>();

  function on(event: string, handler: ExtensionHandler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)?.delete(handler);
  }

  async function invoke(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    const set = handlers.get(event);
    if (!set || set.size === 0) return undefined;
    let merged: unknown;
    for (const handler of set) {
      const result = await handler(payload, ctx);
      if (result === undefined || result === null) continue;
      if (event === "tool_call" && typeof result === "object" && (result as { block?: boolean }).block) {
        return result;
      }
      if (event === "tool_result" && typeof result === "object") {
        merged = { ...(merged as object), ...(result as object) };
      } else {
        merged = result;
      }
    }
    return merged;
  }

  const pi = {
    registerTool(def: RecordedTool) {
      tools.set(def.name, def.execute);
      if (def.parameters !== undefined) toolParameters.set(def.name, def.parameters);
    },
    on,
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def.handler);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    toolParameters,
    commands,
    sentMessages,
    invokeToolCall: (event, ctx) => invoke("tool_call", event, ctx),
    invokeToolResult: (event, ctx) => invoke("tool_result", event, ctx),
    invokeSessionShutdown: async (event, ctx) => {
      await invoke("session_shutdown", event, ctx);
    },
    invokeEvent: (event: string, payload: unknown, ctx: unknown) => invoke(event, payload, ctx),
  };
}

export async function loadJobAccountsExtension(root: string) {
  const mod = await import(path.join(root, ".pi", "extensions", "job-accounts.ts"));
  return mod.default as (pi: ExtensionAPI) => void;
}

export function credentialsPath(root: string): string {
  return path.join(root, "credentials.json");
}
