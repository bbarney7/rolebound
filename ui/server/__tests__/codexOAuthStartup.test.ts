import { describe, it, expect, vi } from "vitest";
import { withCodexOAuthStartup } from "../providers/codexOAuthStartup";
const cold = () => new Error("OpenAI Codex OAuth is only available in Node.js environments");
describe("Codex OAuth startup", () => {
  it("recovers once from the crypto initialization race", async () => {
    const login = vi.fn().mockRejectedValueOnce(cold()).mockResolvedValueOnce("ready");
    expect(await withCodexOAuthStartup("openai-codex", new AbortController().signal, login)).toBe("ready");
    expect(login).toHaveBeenCalledTimes(2);
  });
  it("does not retry real auth errors or another provider", async () => {
    for (const [provider, error] of [["openai-codex", new Error("invalid grant")], ["anthropic", cold()]] as const) {
      const login = vi.fn().mockRejectedValue(error);
      await expect(withCodexOAuthStartup(provider, new AbortController().signal, login)).rejects.toBe(error);
      expect(login).toHaveBeenCalledTimes(1);
    }
  });
  it("does not restart a cancelled session", async () => {
    const controller = new AbortController();
    const login = vi.fn(async () => { controller.abort(); throw cold(); });
    await expect(withCodexOAuthStartup("openai-codex", controller.signal, login)).rejects.toMatchObject({name:"AbortError"});
    expect(login).toHaveBeenCalledTimes(1);
  });
  it("does not loop if initialization still fails", async () => {
    const login = vi.fn().mockRejectedValue(cold());
    await expect(withCodexOAuthStartup("openai-codex", new AbortController().signal, login)).rejects.toThrow("only available");
    expect(login).toHaveBeenCalledTimes(2);
  });
});
