import { readFileSync, statSync } from "node:fs";
import { paths } from "../workspace";
import { normalizeSecrets, SECRET_KEY } from "./redact";
import { CAPTCHA_PROVIDER_IDS, PROVIDER_ENV_VARS } from "../../../.pi/extensions/lib/captcha";
import { ALL_SCRUB_ENV_NAMES } from "../../shared/providerCatalog";

/**
 * Environment variable names whose values may be inherited by a child run and
 * must be redacted if they appear in the transcript. Built from the provider
 * catalog scrub list plus OAuth exports from `scripts/with-secrets.sh`.
 */
const SECRET_ENV: readonly string[] = [
  ...new Set([
    ...ALL_SCRUB_ENV_NAMES,
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    ...CAPTCHA_PROVIDER_IDS.map((id) => PROVIDER_ENV_VARS[id]),
  ]),
];

/**
 * Shorter than this is not a password, and redacting it would eat the transcript.
 *
 * IT IS NOW ENFORCED ON THE WRITE PATH TOO, and that is why it is exported.
 * `POST /api/accounts` and `PATCH /api/accounts/:host` (routes/accounts.ts)
 * refuse a non-empty password shorter than this, because a stored value that
 * `collect` below will not pick up is a value redact.ts cannot protect: the JSON
 * key masking would still catch `"password": "abc"`, but free text like
 * `Password: abc` is only replaced when the value was COLLECTED, so a run would
 * disclose it through /api/runs/current and /api/runs/events. Defined exactly
 * once, here, so the redactor's floor and the routes' refusal cannot drift.
 */
export const MIN_SECRET_LENGTH = 4;

export interface SecretsReader {
  read(): readonly string[];
  addPath(p: string): void;
  removePath(p: string): void;
  isPathUnreadable(p: string): boolean;
  snapshotPath(p: string): void;
  snapshotValues(id: string, values: readonly string[]): void;
  dropSnapshot(p: string): void;
}

/** Wrap a legacy per-event callback while still retaining explicit path snapshots. */
export function asSecretsReader(secrets: SecretsReader | (() => readonly string[])): SecretsReader {
  if (typeof secrets === "function") {
    const snapshots = new Map<string, readonly string[]>();
    const lastSuccessfulByPath = new Map<string, readonly string[]>();
    return {
      read: () => normalizeSecrets([...secrets(), ...snapshots.values()].flat()),
      addPath: () => {},
      removePath: () => {},
      isPathUnreadable: () => false,
      snapshotPath: (p) => snapshots.set(p, readFileSecrets(p, lastSuccessfulByPath)),
      snapshotValues: (id, values) => snapshots.set(id, normalizeSecrets([...values])),
      dropSnapshot: (p) => { snapshots.delete(p); },
    };
  }
  return secrets;
}

/**
 * The values a run's events must never contain, re-read whenever
 * credentials.json or settings.json changes.
 *
 * SYNCHRONOUS ON PURPOSE, both halves of it:
 *
 *   - It is re-checked per event rather than once per run because
 *     `create_account` WRITES A NEW PASSWORD MID-RUN and the tool result that
 *     announces it is the very next thing on the wire. A set captured at
 *     `start()` would not contain it.
 *   - It cannot be a promise because the event pipeline is synchronous:
 *     `handleLine` runs the status machine and emits in one turn, and awaiting
 *     anything in there would let a route's `reply()` observe a status the
 *     child has already moved past. Two `stat`s of small local files per
 *     event is the cheaper side of that trade.
 */
export function createSecretsReader(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretsReader {
  // credentials.json AND settings.json: the CAPTCHA key is a secret the same
  // way a password is, and the Settings view writes it mid-session.
  const baseFiles = [paths.credentials(root), paths.settings(root), `${root}/.pi-jobs/pi-agent/auth.json`];
  const extraPaths = new Set<string>();
  const snapshots = new Map<string, readonly string[]>();
  const lastSuccessfulByPath = new Map<string, readonly string[]>();
  const unreadablePaths = new Set<string>();
  let stamp: string | null = null;
  let cached: string[] = [];

  const filesForRead = (): string[] => [...baseFiles, ...extraPaths];
  const refresh = (): readonly string[] => {
    const files = filesForRead();
    const next = files.map(stampOf).join("|");
    if (next !== stamp) {
      stamp = next;
      const envNames = envNamesFromSettings(root);
      cached = normalizeSecrets([
        ...files.flatMap((file) => readFileSecrets(file, lastSuccessfulByPath, unreadablePaths)),
        ...readEnvSecrets(env, envNames),
      ]);
    }
    return snapshots.size
      ? normalizeSecrets([...cached, ...snapshots.values()].flat())
      : cached;
  };

  return {
    read: refresh,
    addPath(p: string) {
      if (!p.trim()) return;
      extraPaths.add(p);
      stamp = null;
    },
    removePath(p: string) {
      extraPaths.delete(p);
      lastSuccessfulByPath.delete(p);
      unreadablePaths.delete(p);
      stamp = null;
    },
    isPathUnreadable(p: string) {
      // Parse the active run credential file for every child-output boundary.
      // The general cache is keyed by inode/timestamps/size, but fail-closed
      // output must not depend on filesystem timestamp granularity.
      readFileSecrets(p, lastSuccessfulByPath, unreadablePaths);
      stamp = null;
      return unreadablePaths.has(p);
    },
    snapshotPath(p: string) {
      snapshots.set(p, readFileSecrets(p, lastSuccessfulByPath, unreadablePaths));
    },
    snapshotValues(id: string, values: readonly string[]) {
      snapshots.set(id, normalizeSecrets([...values]));
    },
    dropSnapshot(p: string) {
      snapshots.delete(p);
    },
  };
}

function envNamesFromSettings(root: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.settings(root), "utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const connections = (parsed as { connections?: unknown }).connections;
  if (!Array.isArray(connections)) return [];
  const names: string[] = [];
  for (const item of connections) {
    if (!item || typeof item !== "object") continue;
    const envKeyName = (item as { envKeyName?: unknown }).envKeyName;
    if (typeof envKeyName === "string" && envKeyName.trim()) names.push(envKeyName.trim());
  }
  return names;
}

/**
 * CTIME AND INODE, not just mtime and size. A password swapped for one the
 * same length by a writer that restores the mtime — an editor, a sync tool, a
 * `cp -p` of a backup — moves neither of those, and a secret this reader never
 * learns is a secret it never redacts. ctime moves on every write there is; the
 * inode catches a replaced file whose ctime happens to match. A missing file
 * is a fresh workspace, and stamps as "none".
 */
function stampOf(file: string): string {
  try {
    const stats = statSync(file);
    return `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch {
    return "none";
  }
}

/**
 * Every secret-looking string in a JSON file, whatever nests it.
 *
 * Atomic writers normally leave a complete old or new file, but the per-run
 * auth store belongs to the child and may be truncated when it crashes. Keep
 * the last complete generation for each path and add values recoverable from
 * malformed bytes so neither generation can reach the terminal error event.
 */
function readFileSecrets(
  file: string,
  lastSuccessfulByPath: Map<string, readonly string[]>,
  unreadablePaths?: Set<string>,
): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    unreadablePaths?.add(file);
    return [...(lastSuccessfulByPath.get(file) ?? [])];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    unreadablePaths?.add(file);
    return normalizeSecrets([
      ...(lastSuccessfulByPath.get(file) ?? []),
      ...extractMalformedFileSecrets(raw),
    ]);
  }
  unreadablePaths?.delete(file);
  const found = new Set<string>();
  collect(parsed, found);
  const secrets = [...found];
  lastSuccessfulByPath.set(file, secrets);
  return secrets;
}

/** Conservative recovery for a truncated JSON credential store. */
function extractMalformedFileSecrets(raw: string): string[] {
  const found = new Set<string>();

  // Decode complete JSON string values even if a later byte was truncated.
  for (const match of raw.matchAll(/"(?:key|access|refresh)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const value: unknown = JSON.parse(`"${match[1]}"`);
      if (typeof value === "string" && value.length > 0) found.add(value);
    } catch {
      // The token-looking scan below can still recover an incomplete value.
    }
  }

  // Catch a token whose JSON string itself was cut off before its closing quote.
  for (const match of raw.matchAll(/\b(?:sk-[A-Za-z0-9._~+/=-]{4,}|(?:[A-Za-z0-9]+-)*oat[A-Za-z0-9._~+/=-]{4,})/gi)) {
    found.add(match[0]);
  }

  return [...found];
}

/** Values under a secret-named key — redact.ts's list, so the two agree. */
function collect(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "api_key" && typeof record.key === "string" && record.key.length >= MIN_SECRET_LENGTH) {
    found.add(record.key);
  }
  if (record.type === "oauth") {
    if (typeof record.access === "string" && record.access.length >= MIN_SECRET_LENGTH) {
      found.add(record.access);
    }
    if (typeof record.refresh === "string" && record.refresh.length >= MIN_SECRET_LENGTH) {
      found.add(record.refresh);
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      if (SECRET_KEY.test(key) && item.length >= MIN_SECRET_LENGTH) found.add(item);
    } else {
      collect(item, found);
    }
  }
}

function readEnvSecrets(env: NodeJS.ProcessEnv, extraNames: readonly string[]): string[] {
  const values: string[] = [];
  const names = new Set([...SECRET_ENV, ...extraNames]);
  for (const name of names) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) values.push(value);
  }
  return values;
}
