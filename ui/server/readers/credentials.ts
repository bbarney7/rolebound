import { promises as fs } from "node:fs";
import { paths } from "../workspace";
import type { ATSAccount, RawCredentialEntry, RawCredentials } from "../../shared/types";
import {
  CredentialsShapeError,
  parseCredentialsText,
} from "../../../.pi/extensions/lib/workspace-files";

export { CredentialsShapeError, parseCredentialsText };

/**
 * Read credentials.json as TEXT and parse it through the one shared rule.
 */
export async function readRawCredentials(root: string): Promise<RawCredentials> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.credentials(root), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return Object.create(null) as RawCredentials;
    throw err;
  }
  return parseCredentialsText(raw);
}

export function toAtsAccount(host: string, entry: RawCredentialEntry): ATSAccount {
  const c = entry;
  return {
    host,
    username: c.username ?? null,
    emailUsed: c.email_used ?? null,
    ats: c.ats ?? null,
    company: c.company ?? null,
    createdAt: c.created_at ?? null,
    lastUsedAt: c.last_used_at ?? null,
    lastLoginStatus: c.last_login_status ?? null,
    notes: c.notes ?? null,
    hasPassword: typeof c.password === "string" && c.password.length > 0,
  };
}

export async function readAccounts(root: string): Promise<ATSAccount[]> {
  const raw = await readRawCredentials(root);
  return Object.entries(raw)
    .map(([host, c]) => toAtsAccount(host, c))
    .sort((a, b) => a.host.localeCompare(b.host));
}
