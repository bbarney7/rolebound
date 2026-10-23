import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function holdPause(root: string, token: string): Promise<never> {
  const dir = path.join(root, ".cross-test", "pause");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, token), String(process.pid), "utf8");
  await new Promise<void>(() => {});
  throw new Error("pause holder exited unexpectedly");
}

function pauseHook(root: string, token: string) {
  return () => holdPause(root, token);
}

async function loadExtension(root: string, name: "job-accounts" | "job-applier" | "job-gatherer") {
  const mod = await import(path.join(root, ".pi", "extensions", `${name}.ts`));
  const tools = new Map<string, (...args: any[]) => Promise<any>>();
  const pi = {
    registerTool(def: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.set(def.name, def.execute);
    },
    on() {},
    registerCommand() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  (mod.default as (pi: ExtensionAPI) => void)(pi);
  return tools;
}

async function main() {
  const root = process.argv[2];
  const specPath = process.argv[3];
  if (!root || !specPath) {
    console.error("usage: crossProcessChild <root> <spec.json>");
    process.exit(2);
  }
  process.chdir(root);
  const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as Record<string, unknown>;
  const op = String(spec.op);
  const pauseToken = typeof spec.pauseToken === "string" ? spec.pauseToken : "pause";

  try {
    if (op === "create_account") {
      const tools = await loadExtension(root, "job-accounts");
      const create = tools.get("create_account");
      if (!create) throw new Error("create_account missing");
      await create("x", {
        host: spec.host,
        company: spec.company ?? `Co ${spec.host}`,
        ats: spec.ats ?? "other",
      });
      return;
    }

    if (op === "update_account") {
      const tools = await loadExtension(root, "job-accounts");
      const update = tools.get("update_account");
      if (!update) throw new Error("update_account missing");
      await update("x", { host: spec.host, notes: spec.notes ?? "updated-by-extension" });
      return;
    }

    if (op === "update_application_state") {
      const tools = await loadExtension(root, "job-applier");
      const update = tools.get("update_application_state");
      if (!update) throw new Error("update_application_state missing");
      await update("x", spec.params ?? {});
      return;
    }

    if (op === "generate_address") {
      const tools = await loadExtension(root, "job-applier");
      const gen = tools.get("generate_address");
      if (!gen) throw new Error("generate_address missing");
      await gen("x", spec.params ?? {});
      return;
    }

    if (op === "promote_discovered") {
      const { promoteDiscovered } = await import(path.join(root, ".pi", "extensions", "lib", "gather-store.ts"));
      const pause = spec.pause as string | undefined;
      const hooks =
        pause === "afterLink"
          ? { afterLink: pauseHook(root, pauseToken) }
          : pause === "beforeUnlink"
            ? { beforeUnlink: pauseHook(root, pauseToken) }
            : undefined;
      await promoteDiscovered(String(spec.slug), hooks);
      return;
    }

    if (op === "reject_discovered") {
      const { rejectDiscovered } = await import(path.join(root, ".pi", "extensions", "lib", "gather-store.ts"));
      const pause = spec.pause as string | undefined;
      const hooks =
        pause === "afterRejectPending"
          ? { afterRejectPending: pauseHook(root, pauseToken) }
          : pause === "beforeUnlink"
            ? { beforeUnlink: pauseHook(root, pauseToken) }
            : undefined;
      await rejectDiscovered(String(spec.slug), String(spec.reason ?? "test reject"), hooks);
      return;
    }

    if (op === "complete_application") {
      const { completeApplication } = await import(path.join(root, ".pi", "extensions", "lib", "applications.ts"));
      const pause = spec.pause as string | undefined;
      const hooks: Record<string, () => Promise<never>> = {};
      if (pause === "afterLink") hooks.afterLink = pauseHook(root, pauseToken);
      if (pause === "beforeUnlink") hooks.beforeUnlink = pauseHook(root, pauseToken);
      if (pause === "afterMoveBeforeRepoint") hooks.afterMoveBeforeRepoint = pauseHook(root, pauseToken);
      await completeApplication(String(spec.slug), { root, testHooks: hooks });
      return;
    }

    if (op === "gather_merge") {
      const { persistGatherMerge } = await import(path.join(root, ".pi", "extensions", "lib", "gather-store.ts"));
      const snapshot = spec.snapshot as Record<string, unknown>;
      const proposed = spec.proposed as Record<string, unknown>;
      const companies = (spec.companies as string[]) ?? [];
      const pause = spec.pause as string | undefined;
      await persistGatherMerge(snapshot as any, proposed as any, companies, {
        beforeMerge: pause === "beforeMerge" ? pauseHook(root, pauseToken) : undefined,
      });
      return;
    }

    if (op === "hold_state_lock") {
      const { withFileLock } = await import(path.join(root, ".pi", "extensions", "lib", "durable-store.ts"));
      const stateFile = path.join(root, "state.json");
      await withFileLock(
        stateFile,
        async () => {
          await holdPause(root, pauseToken);
        },
        { lockRetries: 0 },
      );
      return;
    }

    if (op === "reserve_captcha_spend") {
      const { reservePaidTask } = await import(path.join(root, ".pi", "extensions", "lib", "captcha-spend.ts"));
      const settingsPath = path.join(root, "settings.json");
      const res = await reservePaidTask(root, Number(spec.now ?? Date.now()), {
        slug: String(spec.slug),
        provider: String(spec.provider ?? "2captcha"),
        settingsPath,
      });
      if (!res.ok && res.cap === "corrupt") process.exit(1);
      return;
    }

    if (op === "credentials_write_pause") {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
      const { withFileLock, atomicWriteFile } = await import(
        path.join(root, ".pi", "extensions", "lib", "durable-store.ts"),
      );
      const { parseCredentialsText } = await import(path.join(repoRoot, "ui", "server", "readers", "credentials.ts"));
      const credsPath = path.join(root, "credentials.json");
      await withFileLock(
        credsPath,
        async () => {
          const parsed = parseCredentialsText(await fs.readFile(credsPath, "utf8"));
          const host = String(spec.host);
          parsed[host] = {
            host,
            username: "dash",
            ats: "other",
            company: "Dash Co",
            created_at: new Date().toISOString(),
            last_used_at: new Date().toISOString(),
          };
          await atomicWriteFile(credsPath, JSON.stringify(parsed, null, 2), {
            mode: 0o600,
            testHooks: { afterTempWrite: pauseHook(root, pauseToken) },
          });
        },
        { lockRetries: 0 },
      );
      return;
    }

    throw new Error(`unknown op: ${op}`);
  } catch (err: any) {
    if (err?.message?.includes?.("pause")) throw err;
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
