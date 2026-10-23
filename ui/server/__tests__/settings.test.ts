import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { createApp } from "../app";
import { readSettingsFile, writeCaptchaSettings } from "../settingsStore";
import { MIN_SECRET_LENGTH } from "../runs/secrets";

/**
 * Same isolation rule as accounts.test.ts: a case that lands a write to
 * settings.json builds its own fixture; read-only and refused-write cases may
 * share the beforeAll one, which has NO settings.json (a fresh clone).
 */

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
  // The settings routes resolve the env-var override from the env the app is
  // given, defaulting to process.env — so a bare createApp(root) here would
  // let a developer's own exported CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY
  // change these tests' verdicts. The shared fixture must not see the
  // developer's shell: an explicit empty env makes this machine answer
  // exactly like CI, whatever is exported in ~/.zshrc.
  const app = createApp(root, { security: { enabled: false }, settings: { env: {} } });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rmFixtureWorkspace(root);
});

function settingsPath(dir: string): string {
  return path.join(dir, "settings.json");
}

describe("settingsStore", () => {
  it("reads a missing file as the defaults", async () => {
    const own = await makeFixtureWorkspace();
    try {
      expect(await readSettingsFile(own)).toEqual({
        raw: {},
        captcha: { provider: "off", api_key: "", max_paid_tasks_per_day: 20 },
        warnings: [],
      });
    } finally {
      await rmFixtureWorkspace(own);
    }
  });

  it("writes the captcha block, preserves unknown keys, and leaves no temp file", async () => {
    const own = await makeFixtureWorkspace();
    try {
      await fs.writeFile(settingsPath(own), JSON.stringify({ future: { keep: true }, captcha: { provider: "off", api_key: "" } }, null, 2));
      const result = await writeCaptchaSettings(own, { provider: "2captcha", api_key: "two-key-9999" });
      expect(result).toEqual({ ok: true });
      const raw = JSON.parse(await fs.readFile(settingsPath(own), "utf-8"));
      expect(raw).toEqual({ future: { keep: true }, captcha: { provider: "2captcha", api_key: "two-key-9999" } });
      const leftovers = (await fs.readdir(own)).filter((f) => f.startsWith(".settings."));
      expect(leftovers).toEqual([]);
    } finally {
      await rmFixtureWorkspace(own);
    }
  });

  it("creates the file when there is none", async () => {
    const own = await makeFixtureWorkspace();
    try {
      expect(await writeCaptchaSettings(own, { provider: "capsolver", api_key: "CAP-abcdefgh" })).toEqual({ ok: true });
      expect(JSON.parse(await fs.readFile(settingsPath(own), "utf-8"))).toEqual({ captcha: { provider: "capsolver", api_key: "CAP-abcdefgh" } });
      expect((await fs.stat(settingsPath(own))).mode & 0o777).toBe(0o600);
    } finally {
      await rmFixtureWorkspace(own);
    }
  });

  it("refuses to write over a corrupt file, as data, with the bytes untouched", async () => {
    const own = await makeFixtureWorkspace();
    try {
      await fs.writeFile(settingsPath(own), "{ nope");
      expect(await writeCaptchaSettings(own, { provider: "off", api_key: "" })).toEqual({
        ok: false,
        error: { code: "PARSE", message: "settings.json is not valid JSON" },
      });
      await fs.writeFile(settingsPath(own), "[]");
      expect(await writeCaptchaSettings(own, { provider: "off", api_key: "" })).toMatchObject({ ok: false, error: { code: "SHAPE" } });
      expect(await fs.readFile(settingsPath(own), "utf-8")).toBe("[]");
    } finally {
      await rmFixtureWorkspace(own);
    }
  });

  it("serializes two first-time saves through the lock so neither is torn", async () => {
    const own = await makeFixtureWorkspace();
    try {
      const inputA: Parameters<typeof writeCaptchaSettings>[1] = { provider: "capsolver", api_key: "CAP-abcdefgh" };
      const inputB: Parameters<typeof writeCaptchaSettings>[1] = { provider: "2captcha", api_key: "two-key-9999" };
      const [resultA, resultB] = await Promise.all([
        writeCaptchaSettings(own, inputA),
        writeCaptchaSettings(own, inputB),
      ]);
      expect(resultA).toEqual({ ok: true });
      expect(resultB).toEqual({ ok: true });
      const raw = JSON.parse(await fs.readFile(settingsPath(own), "utf-8"));
      expect(raw.captcha).toSatisfy((captcha: unknown) => {
        return (
          JSON.stringify(captcha) === JSON.stringify(inputA) || JSON.stringify(captcha) === JSON.stringify(inputB)
        );
      });
      const leftovers = (await fs.readdir(own)).filter((f) => f.startsWith(".settings."));
      expect(leftovers).toEqual([]);
    } finally {
      await rmFixtureWorkspace(own);
    }
  });
});

function put(at: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${at}${route}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function post(at: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${at}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Own fixture + own app, so a case can inject env and a scripted provider fetch. */
async function withOwnApp(
  opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch },
  body: (ctx: { root: string; base: string }) => Promise<void>,
): Promise<void> {
  const ownRoot = await makeFixtureWorkspace();
  const app = createApp(ownRoot, { security: { enabled: false }, settings: { env: opts.env ?? {}, fetch: opts.fetch } });
  const ownServer = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = ownServer.address() as AddressInfo;
  try {
    await body({ root: ownRoot, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => ownServer.close(resolve));
    await rmFixtureWorkspace(ownRoot);
  }
}

describe("GET /api/settings", () => {
  it("[shared fixture] describes a fresh clone: off, no key, both providers with their kinds", async () => {
    const res = await fetch(`${base}/api/settings`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "off", hasApiKey: false, keyHint: null, keySource: "none", warnings: [] });
    expect(body.providers).toEqual([
      { id: "capsolver", label: "CapSolver", envVar: "CAPSOLVER_API_KEY", supports: ["recaptcha_v2", "recaptcha_v3", "turnstile"] },
      { id: "2captcha", label: "2Captcha", envVar: "TWOCAPTCHA_API_KEY", supports: ["hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile"] },
    ]);
  });

  it("[own fixture] shows a file key as a last-four hint and never the key itself", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "2captcha", api_key: "two-key-ABCD" } }));
      const text = await (await fetch(`${b}/api/settings`)).text();
      expect(text).not.toContain("two-key-ABCD");
      expect(JSON.parse(text)).toMatchObject({ provider: "2captcha", hasApiKey: true, keyHint: "…ABCD", keySource: "file", fileHasKey: true });
    });
  });

  it("[own fixture] reports an env key as env with no hint, and a keyless provider with a warning", async () => {
    await withOwnApp({ env: { TWOCAPTCHA_API_KEY: "from-env-1234" } }, async ({ root: r, base: b }) => {
      // The env var only ever supplies the KEY — the file still has to choose
      // the provider, so this case writes one selecting "2captcha" with no
      // key before the env var can take effect.
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "2captcha", api_key: "" } }));
      const body = await (await fetch(`${b}/api/settings`)).json();
      // The env key is EFFECTIVE (hasApiKey) but there is no key stored in
      // the file itself, so fileHasKey stays false and keyHint stays null.
      expect(body).toMatchObject({ provider: "2captcha", hasApiKey: true, keyHint: null, keySource: "env", fileHasKey: false });
    });
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "capsolver", api_key: "" } }));
      const body = await (await fetch(`${b}/api/settings`)).json();
      expect(body).toMatchObject({ provider: "capsolver", hasApiKey: false, keySource: "none" });
      expect(body.warnings[0]).toMatch(/CAPSOLVER_API_KEY/);
    });
  });
});

describe("PUT /api/settings/captcha", () => {
  it("[own fixture] stores a trimmed key with its provider and answers the GET payload", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      const res = await put(b, "/api/settings/captcha", { provider: "2captcha", apiKey: "  two-key-WXYZ\n" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ provider: "2captcha", hasApiKey: true, keyHint: "…WXYZ", keySource: "file" });
      expect(JSON.parse(await fs.readFile(settingsPath(r), "utf-8"))).toEqual({
        captcha: { provider: "2captcha", api_key: "two-key-WXYZ", max_paid_tasks_per_day: 20 },
      });
    });
  });

  it("[own fixture] keeps the key when apiKey is absent and clears it on null or empty", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "2captcha", api_key: "two-key-KEEP" } }));
      expect((await put(b, "/api/settings/captcha", { provider: "capsolver" })).status).toBe(200);
      expect(JSON.parse(await fs.readFile(settingsPath(r), "utf-8")).captcha).toEqual({
        provider: "capsolver",
        api_key: "two-key-KEEP",
        max_paid_tasks_per_day: 20,
      });
      expect((await put(b, "/api/settings/captcha", { provider: "off", apiKey: null })).status).toBe(200);
      expect(JSON.parse(await fs.readFile(settingsPath(r), "utf-8")).captcha).toEqual({
        provider: "off",
        api_key: "",
        max_paid_tasks_per_day: 20,
      });
      expect((await put(b, "/api/settings/captcha", { provider: "off", apiKey: "" })).status).toBe(200);
    });
  });

  it("[shared fixture] refuses a bad provider, a non-string key, a key below the redaction floor, and an oversized key", async () => {
    const cases: Array<[unknown, string]> = [
      [{ provider: "anticaptcha" }, "provider"],
      [{ provider: "2captcha", apiKey: 42 }, "apiKey"],
      [{ provider: "2captcha", apiKey: "a".repeat(MIN_SECRET_LENGTH - 1) }, "apiKey"],
      [{ provider: "2captcha", apiKey: "a".repeat(257) }, "apiKey"],
      [{}, "provider"],
    ];
    for (const [body, field] of cases) {
      const res = await put(base, "/api/settings/captcha", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field });
    }
    await expect(fs.access(settingsPath(root))).rejects.toThrow();
  });

  it("[own fixture] answers 409 with the writer's message on a corrupt file, bytes untouched", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), "{ nope");
      const res = await put(b, "/api/settings/captcha", { provider: "off" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "settings.json is not valid JSON" });
      expect(await fs.readFile(settingsPath(r), "utf-8")).toBe("{ nope");
    });
  });

  it("[own fixture] answers 500, not a silent overwrite, when settings.json cannot be read for a reason other than corruption", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.mkdir(settingsPath(r));
      const res = await put(b, "/api/settings/captcha", { provider: "capsolver" });
      expect(res.status).toBe(500);
      expect((await fs.stat(settingsPath(r))).isDirectory()).toBe(true);
      const leftovers = (await fs.readdir(r)).filter((f) => f.startsWith(".settings."));
      expect(leftovers).toEqual([]);
    });
  });
});

describe("POST /api/settings/captcha/test", () => {
  function balanceFetch(calls: Array<{ url: string; body: any }>, reply: unknown): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  it("[own fixture] tests the stored key by default and returns the balance", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    await withOwnApp({ fetch: balanceFetch(calls, { errorId: 0, balance: 12.5 }) }, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "capsolver", api_key: "CAP-stored-key" } }));
      const res = await post(b, "/api/settings/captcha/test", {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, provider: "capsolver", balance: 12.5 });
      expect(calls).toEqual([{ url: "https://api.capsolver.com/getBalance", body: { clientKey: "CAP-stored-key" } }]);
    });
  });

  it("[own fixture] tests an unsaved pasted key without writing it, and reports a bad key as ok:false", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    await withOwnApp(
      { fetch: balanceFetch(calls, { errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST", errorDescription: "bad" }) },
      async ({ root: r, base: b }) => {
        const res = await post(b, "/api/settings/captcha/test", { provider: "2captcha", apiKey: " pasted-key-0001 " });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ ok: false, provider: "2captcha" });
        expect(body.error).toContain("ERROR_KEY_DOES_NOT_EXIST");
        expect(JSON.stringify(body)).not.toContain("pasted-key-0001");
        expect(calls[0]).toEqual({ url: "https://api.2captcha.com/getBalance", body: { clientKey: "pasted-key-0001" } });
        await expect(fs.access(settingsPath(r))).rejects.toThrow();
      },
    );
  });

  it("[shared fixture] answers 400 when there is nothing to test", async () => {
    const res = await post(base, "/api/settings/captcha/test", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no CAPTCHA key to test: choose a provider and enter a key first" });
    const partial = await post(base, "/api/settings/captcha/test", { apiKey: "key-without-provider" });
    expect(partial.status).toBe(400);
  });
});

describe("GET /api/overview captchaSolver", () => {
  it("[own fixture] names the provider only when a key resolves", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "2captcha", api_key: "" } }));
      expect((await (await fetch(`${b}/api/overview`)).json()).captchaSolver).toBe("off");
      await fs.writeFile(settingsPath(r), JSON.stringify({ captcha: { provider: "2captcha", api_key: "two-key-1234" } }));
      expect((await (await fetch(`${b}/api/overview`)).json()).captchaSolver).toBe("2captcha");
    });
  });

  it("[own fixture] reports off on a corrupt settings.json but 500s when the file cannot be read at all", async () => {
    await withOwnApp({}, async ({ root: r, base: b }) => {
      await fs.writeFile(settingsPath(r), "{ nope");
      const corrupt = await fetch(`${b}/api/overview`);
      expect(corrupt.status).toBe(200);
      expect((await corrupt.json()).captchaSolver).toBe("off");

      await fs.rm(settingsPath(r));
      await fs.mkdir(settingsPath(r));
      const unreadable = await fetch(`${b}/api/overview`);
      expect(unreadable.status).toBe(500);
    });
  });
});
