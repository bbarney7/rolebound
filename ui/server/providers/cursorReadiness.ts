import type { Connection } from "../../shared/config";

/** Production Cursor API host; imported credentials may use a custom backend. */
export const CURSOR_PRODUCTION_BACKEND = "https://api2.cursor.sh";

export function cursorCredentialExpiryReadiness(
  connection: Connection,
  nowMs: number,
): { blockers: Array<{ code: string; message: string; href: string }>; warnings: Array<{ code: string; message: string; href: string }> } {
  const blockers: Array<{ code: string; message: string; href: string }> = [];
  const warnings: Array<{ code: string; message: string; href: string }> = [];
  if (connection.provider !== "cursor" || !connection.expiresAt) return { blockers, warnings };
  const expiresMs = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiresMs)) return { blockers, warnings };
  const fix = { href: "/settings" };
  if (expiresMs <= nowMs) {
    blockers.push({
      code: "CREDENTIAL_EXPIRED",
      message: "Sign in with Cursor again",
      ...fix,
    });
  } else if (expiresMs <= nowMs + 14 * 24 * 60 * 60 * 1000) {
    warnings.push({
      code: "CURSOR_LOGIN_EXPIRING",
      message: "Sign in with Cursor again",
      ...fix,
    });
  }
  return { blockers, warnings };
}
