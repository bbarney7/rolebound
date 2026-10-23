const COLD_START_ERROR = "OpenAI Codex OAuth is only available in Node.js environments";

/** pi-ai 1.0.4 starts its crypto import without awaiting it. Its first browser
 * login can reach createState before that import settles. This exact failure
 * occurs before a callback listener, auth URL, or token exchange is created.
 * Retry only that initialization failure, once; never retry auth/network errors. */
export async function withCodexOAuthStartup<T>(provider: string, signal: AbortSignal, login: (attempt: 0 | 1) => Promise<T>): Promise<T> {
  try {
    return await login(0);
  } catch (error) {
    if (provider !== "openai-codex" || !(error instanceof Error) || error.message !== COLD_START_ERROR) throw error;
    await import("node:crypto");
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    return login(1);
  }
}
