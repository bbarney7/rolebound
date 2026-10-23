import path from "node:path";
import {
  CredentialsShapeError,
  parseCredentialsText,
  WORKSPACE_FILES,
} from "./workspace-files";
import {
  mutateJsonFile,
  NO_CHANGE,
  readJsonFile,
  WorkspaceFileError,
} from "./durable-store";
import { wsPath } from "./workspace";
import type { RawCredentialEntry, RawCredentials } from "../../../ui/shared/types";

const CREDENTIALS_FILE = wsPath(WORKSPACE_FILES.credentials);
const BOOTSTRAP_BYTES = "{}";
const SERIALIZE = (value: RawCredentials) => JSON.stringify(value, null, 2);

export function corruptFileRecoveryMessage(file: string): string {
  const base = path.basename(file);
  return (
    `${base} is corrupt or unreadable and was not modified. ` +
    `Recover with: npm run restore -- --backup <id>, or move ${base} aside and copy templates/${base}.`
  );
}

export function findAccount(
  creds: RawCredentials,
  host: string,
  company: string,
): { key: string; entry: RawCredentialEntry } | null {
  if (host && Object.hasOwn(creds, host)) {
    return { key: host, entry: creds[host] };
  }

  const companyLower = company.toLowerCase();
  for (const [key, entry] of Object.entries(creds)) {
    if (entry.company?.toLowerCase() === companyLower) {
      return { key, entry };
    }
  }

  return null;
}

export async function readAccountsFile(
  file: string = CREDENTIALS_FILE,
): Promise<RawCredentials> {
  const read = await readJsonFile(file, parseCredentialsText);
  if (read.state === "missing") {
    return Object.create(null) as RawCredentials;
  }
  return read.value;
}

export type MutateAccountsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkspaceFileError | CredentialsShapeError };

export async function mutateAccounts(
  fn: (creds: RawCredentials) => RawCredentials | typeof NO_CHANGE,
  file: string = CREDENTIALS_FILE,
): Promise<MutateAccountsResult<RawCredentials>> {
  try {
    const value = await mutateJsonFile(
      file,
      {
        parse: parseCredentialsText,
        serialize: SERIALIZE,
        bootstrapBytes: BOOTSTRAP_BYTES,
        mode: 0o600,
      },
      (creds) => {
        const next: RawCredentials = Object.assign(Object.create(null), creds);
        const out = fn(next);
        if (out === NO_CHANGE) return NO_CHANGE;
        return out;
      },
    );
    return { ok: true, value };
  } catch (err) {
    if (err instanceof WorkspaceFileError || err instanceof CredentialsShapeError) {
      return { ok: false, error: err };
    }
    throw err;
  }
}

export { NO_CHANGE };
