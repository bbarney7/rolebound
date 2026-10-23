import { afterEach, describe, expect, it, vi } from "vitest";
import { httpFetch, invalidateHttpSession } from "./http";

describe("http session", () => {
  afterEach(() => { vi.unstubAllGlobals(); invalidateHttpSession(); });
  it("caches the session token and invalidates it after a 403", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init]);
      if (String(input) === "/api/session") return new Response(JSON.stringify({ csrfToken: "session-one" }), { status: 200 });
      return new Response("{}", { status: calls.length === 3 ? 403 : 200 });
    }));
    await httpFetch("/api/accounts", { method: "POST" });
    await httpFetch("/api/accounts", { method: "POST" });
    expect(calls.filter(([url]) => url === "/api/session")).toHaveLength(1);
    expect(new Headers(calls[1][1]?.headers).get("X-Pi-Jobs-CSRF")).toBe("session-one");
    expect(new Headers(calls[2][1]?.headers).get("X-Pi-Jobs-CSRF")).toBe("session-one");
    await httpFetch("/api/accounts", { method: "POST" });
    await httpFetch("/api/accounts", { method: "POST" });
    expect(calls.filter(([url]) => url === "/api/session")).toHaveLength(2);
  });
  it("does not replay a rejected mutation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/session"
      ? new Response(JSON.stringify({ csrfToken: "session" }), { status: 200 })
      : new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await httpFetch("/api/runs", { method: "POST", body: "{}" })).status).toBe(403);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/runs")).toHaveLength(1);
  });
});
