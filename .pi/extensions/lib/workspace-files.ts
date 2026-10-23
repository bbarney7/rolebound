import path from "node:path";
import { WorkspaceFileError } from "./durable-store";
import type { RawCredentials } from "../../../ui/shared/types";

export const WORKSPACE_FILES = {
  credentials: "credentials.json",
  state: "state.json",
  gatherState: "gather_state.json",
  settings: "settings.json",
  profile: "profile.md",
  instructions: "instructions.md",
  targets: "targets.md",
  appliedTracker: "APPLIED.md",
  captchaSpend: ".pi-jobs/captcha-spend.json",
} as const;

const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !slug.includes("..");
}

const JOB_DIRS = ["queue", "applied", "discovered"] as const;
export type JobDir = (typeof JOB_DIRS)[number];

export function parseRecordedJobFile(recorded: string): { dir: JobDir; slug: string } | null {
  const parts = recorded.split("/");
  if (parts.length !== 3) return null;
  const [jobs, dir, filename] = parts;
  if (jobs !== "jobs") return null;
  if (!(JOB_DIRS as readonly string[]).includes(dir)) return null;
  if (!filename.endsWith(".md")) return null;
  const slug = filename.slice(0, -".md".length);
  if (!isSafeSlug(slug)) return null;
  return { dir: dir as JobDir, slug };
}

/** Values agents may persist in state.json `queue_file`. */
export function isValidQueueFileRecord(recorded: string): boolean {
  const parsed = parseRecordedJobFile(recorded);
  return parsed !== null && (parsed.dir === "queue" || parsed.dir === "applied");
}

export type ResolvedApplicationQueueSource =
  | { kind: "queue"; relative: string; absolute: string }
  | { kind: "already_applied"; appliedRelative: string; appliedAbsolute: string }
  | { kind: "fallback_queue"; relative: string; absolute: string; ignoredRecord?: string };

/** Resolve queue completion source paths; never returns paths outside jobs/queue or jobs/applied. */
export function resolveApplicationQueueSource(
  root: string,
  slug: string,
  queueFile: unknown,
): ResolvedApplicationQueueSource {
  const appliedRelative = `jobs/applied/${slug}.md`;
  const appliedAbsolute = path.join(root, "jobs", "applied", `${slug}.md`);
  const fallbackRelative = `jobs/queue/${slug}.md`;
  const fallbackAbsolute = path.join(root, "jobs", "queue", `${slug}.md`);

  const recorded = typeof queueFile === "string" ? queueFile.trim() : "";
  if (!recorded) {
    return { kind: "fallback_queue", relative: fallbackRelative, absolute: fallbackAbsolute };
  }

  const parsed = parseRecordedJobFile(recorded);
  if (!parsed) {
    return {
      kind: "fallback_queue",
      relative: fallbackRelative,
      absolute: fallbackAbsolute,
      ignoredRecord: recorded,
    };
  }

  if (parsed.dir === "applied") {
    return { kind: "already_applied", appliedRelative, appliedAbsolute };
  }

  if (parsed.dir === "queue") {
    return { kind: "queue", relative: recorded, absolute: path.join(root, ...recorded.split("/")) };
  }

  return {
    kind: "fallback_queue",
    relative: fallbackRelative,
    absolute: fallbackAbsolute,
    ignoredRecord: recorded,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const KNOWN_ENTRY_FIELDS = [
  "username",
  "password",
  "email_used",
  "ats",
  "company",
  "created_at",
  "last_used_at",
  "last_login_status",
  "notes",
] as const;

export class CredentialsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsShapeError";
  }
}

export function parseCredentialsText(raw: string): RawCredentials {
  if (raw.trim() === "") {
    throw new WorkspaceFileError("CORRUPT", "credentials.json", "credentials.json is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceFileError("CORRUPT", "credentials.json", "credentials.json is not valid JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new CredentialsShapeError("credentials.json is not a JSON object");
  }

  for (const [host, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) {
      throw new CredentialsShapeError(`credentials.json entry for "${host}" is not a JSON object`);
    }
    for (const field of KNOWN_ENTRY_FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || typeof value === "string") continue;
      throw new CredentialsShapeError(
        `credentials.json entry for "${host}" has an invalid "${field}": expected a string or null`,
      );
    }
  }

  return Object.assign(Object.create(null), parsed) as RawCredentials;
}

export type ParsedStateJson = {
  applications: unknown[];
  addresses: Record<string, unknown>;
  last_updated?: unknown;
  [key: string]: unknown;
};

export function parseStateText(raw: string): ParsedStateJson {
  if (raw.trim() === "") {
    throw new WorkspaceFileError("CORRUPT", "state.json", "state.json is empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceFileError("CORRUPT", "state.json", "state.json is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new WorkspaceFileError("CORRUPT", "state.json", "state.json is not a JSON object");
  }
  const apps = parsed.applications;
  if (apps !== undefined && apps !== null && !Array.isArray(apps)) {
    throw new WorkspaceFileError("CORRUPT", "state.json", "state.json applications must be an array");
  }
  const addresses = parsed.addresses;
  if (addresses !== undefined && addresses !== null && !isPlainObject(addresses)) {
    throw new WorkspaceFileError("CORRUPT", "state.json", "state.json addresses must be an object");
  }
  return {
    ...parsed,
    applications: apps ?? [],
    addresses: (addresses as Record<string, unknown>) ?? {},
  };
}

export type ParsedGatherState = {
  seen_urls: Record<string, unknown>;
  per_company: Record<string, unknown>;
  last_full_gather?: unknown;
  auto_promote?: unknown;
  [key: string]: unknown;
};

export function parseGatherStateText(raw: string): ParsedGatherState {
  if (raw.trim() === "") {
    throw new WorkspaceFileError("CORRUPT", "gather_state.json", "gather_state.json is empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceFileError("CORRUPT", "gather_state.json", "gather_state.json is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new WorkspaceFileError("CORRUPT", "gather_state.json", "gather_state.json is not a JSON object");
  }
  const seen = parsed.seen_urls;
  if (seen !== undefined && seen !== null && !isPlainObject(seen)) {
    throw new WorkspaceFileError("CORRUPT", "gather_state.json", "gather_state.json seen_urls is not a JSON object");
  }
  const perCompany = parsed.per_company;
  if (perCompany !== undefined && perCompany !== null && !isPlainObject(perCompany)) {
    throw new WorkspaceFileError("CORRUPT", "gather_state.json", "gather_state.json per_company must be an object");
  }
  return {
    ...parsed,
    seen_urls: (seen as Record<string, unknown>) ?? {},
    per_company: (perCompany as Record<string, unknown>) ?? {},
  };
}

export function workspaceFilePath(root: string, key: keyof typeof WORKSPACE_FILES): string {
  return path.join(root, WORKSPACE_FILES[key]);
}

/** D4 lock target for each tracked workspace file (contract + restore). */
export type WorkspaceFileLockSpec =
  | { kind: "file"; helper: "withFileLock"; lockRelativePath: string }
  | { kind: "sidecar"; helper: "withTargetsLock"; lockRelativePath: string }
  | { kind: "derived"; helper: "none"; lockRelativePath: null };

const FILE_LOCK_RELATIVE: Record<keyof typeof WORKSPACE_FILES, WorkspaceFileLockSpec> = {
  credentials: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.credentials },
  state: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.state },
  gatherState: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.gatherState },
  settings: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.settings },
  profile: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.profile },
  instructions: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.instructions },
  targets: { kind: "sidecar", helper: "withTargetsLock", lockRelativePath: "targets.md.lock" },
  appliedTracker: { kind: "derived", helper: "none", lockRelativePath: null },
  captchaSpend: { kind: "file", helper: "withFileLock", lockRelativePath: WORKSPACE_FILES.captchaSpend },
};

export function workspaceFileLockSpec(key: keyof typeof WORKSPACE_FILES): WorkspaceFileLockSpec {
  return FILE_LOCK_RELATIVE[key];
}

export function workspaceFileLockTarget(root: string, key: keyof typeof WORKSPACE_FILES): string | null {
  const spec = FILE_LOCK_RELATIVE[key];
  if (spec.lockRelativePath === null) return null;
  return path.join(root, spec.lockRelativePath);
}
