import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePath(
  input: string,
  options: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean; homeDir?: string } = {},
): string {
  let normalized = input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  const home = options.homeDir ?? homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/")) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

/** Pi-equivalent `resolveToCwd` from path-utils (strip `@`, Unicode spaces, `~`, resolve against cwd). */
export function resolveToCwd(filePath: string, cwd: string, homeDir?: string): string {
  const normalized = normalizePath(filePath, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
    homeDir,
  });
  const normalizedBaseDir = normalizePath(cwd);
  return isAbsolute(normalized)
    ? nodeResolvePath(normalized)
    : nodeResolvePath(normalizedBaseDir, normalized);
}
