import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { withLock } from "./lock";
import { paths } from "./workspace";
import { ConfigValidationError, migrateSettings, sanitizeSettings, validateSettings, type SettingsEnvelope, type SettingsView } from "../shared/config";
import { parseSettingsText } from "../../.pi/extensions/lib/captcha";

export class ConfigRevisionConflictError extends Error { code = "REVISION_CONFLICT" as const; }

async function ensureFile(file: string) { try { const handle = await fs.open(file, "wx", 0o600); await handle.writeFile("{}\n"); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
async function readRaw(file: string): Promise<{ bytes: Buffer; raw: Record<string, unknown> }> {
  let bytes: Buffer;
  try { const info = await fs.lstat(file); if (info.isSymbolicLink()) throw new ConfigValidationError("settings.json must not be a symlink"); bytes = await fs.readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.from("{}\n"), raw: {} }; throw error; }
  const parsed = parseSettingsText(bytes.toString("utf8"));
  if (parsed.warnings.length) throw new ConfigValidationError(parsed.warnings.join("; "));
  return { bytes, raw: parsed.raw };
}
export function revisionOf(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
async function atomicWrite(file: string, value: Record<string, unknown>) {
  const temporary = path.join(path.dirname(file), `.settings-v2.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function readApplicationSettings(root: string): Promise<SettingsEnvelope<SettingsView>> {
  const file = paths.settings(root); const { bytes, raw } = await readRaw(file); const { settings } = migrateSettings(raw);
  return { data: sanitizeSettings(settings), revision: revisionOf(bytes) };
}

export async function writeApplicationSettings(root: string, next: unknown, expectedRevision: string): Promise<SettingsEnvelope<SettingsView>> {
  const file = paths.settings(root); await fs.mkdir(path.dirname(file), { recursive: true }); await ensureFile(file);
  return withLock(file, async () => {
    const { bytes, raw } = await readRaw(file); migrateSettings(raw); const current = revisionOf(bytes);
    if (current !== expectedRevision) throw new ConfigRevisionConflictError("settings changed; reload and retry");
    const settings = validateSettings(next);
    const preserved = {
      ...raw,
      schemaVersion: 2,
      connections: settings.connections,
      agent: settings.agent,
      chat: settings.chat,
      scoring: settings.scoring,
      captcha: raw.captcha ?? { provider: "off", api_key: "" },
    };
    await atomicWrite(file, preserved);
    const written = Buffer.from(`${JSON.stringify(preserved, null, 2)}\n`);
    const persisted = migrateSettings(preserved).settings;
    return { data: sanitizeSettings(persisted), revision: revisionOf(written) };
  });
}
