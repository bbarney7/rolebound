import type { ConnectionView } from "../shared/config";

export const CURSOR_AUTH_BUTTONS = {
  signIn: "Sign in with Cursor",
  import: "Use my existing Cursor login",
  nodeWarning: "Cursor needs Node 24+",
} as const;

export const OAUTH_SIGN_IN_LABELS: Record<string, string> = {
  anthropic: "Sign in with Claude",
  "openai-codex": "Sign in with ChatGPT",
  "github-copilot": "Sign in with GitHub Copilot",
  cursor: "Sign in with Cursor",
};

export function oauthSignInLabel(provider: string): string {
  return OAUTH_SIGN_IN_LABELS[provider] ?? `Sign in with ${provider}`;
}

export function cursorSignInStatusLine(connection: ConnectionView): string | null {
  if (!connection.credential.configured || !connection.expiresAt) return null;
  const expires = new Date(connection.expiresAt);
  const date = expires.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (connection.email) return `Signed in as ${connection.email} · key expires ${date}`;
  return `Signed in · key expires ${date}`;
}

export function cursorNeedsNode24(nodeMajor: number): boolean {
  return nodeMajor < 24;
}

export function providerSignInStatusLine(connection: ConnectionView): string | null {
  if (connection.provider === "cursor") return cursorSignInStatusLine(connection);
  if (!connection.credential.configured || connection.credential.source !== "oauth") return null;
  if (connection.email && connection.expiresAt) {
    const expires = new Date(connection.expiresAt);
    const date = expires.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return `Signed in as ${connection.email} · expires ${date}`;
  }
  if (connection.email) return `Signed in as ${connection.email}`;
  return "Signed in";
}
