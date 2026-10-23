import { createHash } from "node:crypto";
import type { Connection, ConnectionOrigin, ConnectionOriginKind } from "../../shared/config";
import { ProviderServiceError } from "./providerErrors";

const MAX_ACCOUNT_LENGTH = 200;
const ORIGIN_ACCOUNT_PREFIX_LENGTH = 150;
const ORIGIN_ACCOUNT_DIGEST_LENGTH = 12;
const MAX_LABEL_LENGTH = 80;
// Suffixes are allocated through " 999". Reserve that space before a
// collision so adding the suffix can never invalidate the connection.
const MAX_UNIQUENESS_SUFFIX_LENGTH = 4;
const MAX_LABEL_BASE_LENGTH = MAX_LABEL_LENGTH - MAX_UNIQUENESS_SUFFIX_LENGTH;

function truncate(value: string, maxLength: number): string {
  return value.slice(0, Math.max(0, maxLength)).trimEnd();
}

export function normalizeConnectionAccount(account?: string): string | undefined {
  const trimmed = account?.trim();
  return trimmed ? trimmed.slice(0, MAX_ACCOUNT_LENGTH) : undefined;
}

export function normalizeConnectionOriginAccount(account?: string): string | undefined {
  const trimmed = account?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_ACCOUNT_LENGTH) return trimmed;
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, ORIGIN_ACCOUNT_DIGEST_LENGTH);
  return `${trimmed.slice(0, ORIGIN_ACCOUNT_PREFIX_LENGTH)}#${digest}`;
}

export function connectionOrigin(
  kind: ConnectionOriginKind,
  account?: string,
): ConnectionOrigin {
  const normalizedAccount = normalizeConnectionOriginAccount(account);
  return {
    kind,
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
  };
}

function accountAwareLabel(name: string, account?: string): string {
  const normalizedName = name.trim();
  const normalizedAccount = normalizeConnectionAccount(account);
  if (!normalizedAccount) return truncate(normalizedName, MAX_LABEL_BASE_LENGTH);
  const separator = " · ";
  const accountLength = MAX_LABEL_BASE_LENGTH - normalizedName.length - separator.length;
  if (accountLength <= 0) return truncate(normalizedName, MAX_LABEL_BASE_LENGTH);
  return `${normalizedName}${separator}${truncate(normalizedAccount, accountLength)}`;
}

export function uniqueConnectionLabel(
  name: string,
  account: string | undefined,
  existing: readonly Connection[],
): string {
  const base = accountAwareLabel(name, account);
  const labels = new Set(existing.map((connection) => connection.label.toLowerCase()));
  if (!labels.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${truncate(base, MAX_LABEL_LENGTH - suffix.length)}${suffix}`;
    if (!labels.has(candidate.toLowerCase())) return candidate;
  }
  throw new ProviderServiceError("CONFIG_INVALID", "could not allocate a unique connection label");
}
