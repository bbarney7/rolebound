import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { createApp } from "../app";
import { createAccountEntry } from "../accountsWriter";
import { withLock } from "../lock";
import { createSecretsReader, MIN_SECRET_LENGTH } from "../runs/secrets";
import { redactText } from "../runs/redact";

/**
 * THE ISOLATION RULE, and it is mechanical — no case-by-case judgement.
 *
 * Every case that mutates credentials.json builds its OWN fixture. Only cases
 * that make no successful write may share the beforeAll fixture. Each case below
 * is labelled [shared fixture] or [own fixture] accordingly: 9 shared, 29 own.
 * If those counts stop matching the case list, a case was added without a label.
 *
 * "Mutates" means a write that LANDS: a case that only exercises 400/404/409
 * refusals is read-only in effect and may share. Five shared cases (7.10, 7.14,
 * 7.19, 7.25, 7.32) do call a mutation verb and are shared precisely because
 * every request in them is refused with no write; 7.25 and 7.32 assert the file
 * is byte-identical afterwards, which is the proof rather than the assumption.
 *
 * The rule exists because a literal reading of an earlier case list was
 * order-dependent: 7.18 DELETEs the host 7.27 later expects to delete, and 7.13
 * replaces the password 7.24 later calls "the old one". Both disappear under
 * one own fixture per mutating case.
 */

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
  const app = createApp(root, { security: { enabled: false } });
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

const ACME = "acme.wd5.myworkdayjobs.com";
const BETA = "careers-beta.icims.com";

/**
 * The two inputs that actually trip hostParam's bound, shared by 7.7 and 7.32 so
 * the four routes are exercised on the identical pair. The control-character one
 * is built with fromCharCode rather than an escape so no invisible byte lands in
 * this source file; encodeURIComponent turns it into `a%01b`, which the recorded
 * Express probe confirms reaches the handler with the raw character intact
 * rather than being rejected upstream.
 */
const BAD_HOST_PARAMS = ["a".repeat(300), `a${String.fromCharCode(1)}b`];

function credPath(dir: string): string {
  return path.join(dir, "credentials.json");
}

function readRawText(dir: string): Promise<string> {
  return fs.readFile(credPath(dir), "utf-8");
}

async function readRawJson(dir: string): Promise<Record<string, any>> {
  return JSON.parse(await readRawText(dir));
}

function accountUrl(at: string, host: string, suffix = ""): string {
  return `${at}/api/accounts/${encodeURIComponent(host)}${suffix}`;
}

function post(at: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${at}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(at: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${at}${route}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(at: string, route: string): Promise<Response> {
  return fetch(`${at}${route}`, { method: "DELETE" });
}

/**
 * An own-fixture case: a fresh workspace and its own createApp + listen(0) for
 * the duration, torn down in a finally so a failed assertion still cleans up
 * (the shape gatherState.test.ts:231-259 uses).
 */
async function withOwnFixture(
  body: (ctx: { root: string; base: string }) => Promise<void>,
): Promise<void> {
  const ownRoot = await makeFixtureWorkspace();
  const app = createApp(ownRoot, { security: { enabled: false } });
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

/**
 * Every kind of unusable credentials.json, with the message the WRITER names it
 * with. Shared by 7.4 (reads answer 500) and 7.20 (mutations answer 409, bytes
 * unchanged) — one file, two answers, and this pair of cases is what makes that
 * deliberate rather than accidental.
 */
type CorruptFile = { label: string; text: string; message: string };

const NOT_JSON = "credentials.json is not valid JSON";
const NOT_OBJECT = "credentials.json is not a JSON object";

const CORRUPT_FILES: CorruptFile[] = [
  { label: "bad syntax", text: "{ nope", message: NOT_JSON },
  { label: "bad root []", text: "[]", message: NOT_OBJECT },
  { label: "bad root null", text: "null", message: NOT_OBJECT },
  { label: "bad root 42", text: "42", message: NOT_OBJECT },
  { label: "bad root string", text: '"nope"', message: NOT_OBJECT },
  {
    label: "bad entry value null",
    text: '{"good":{"username":"u"},"bad":null}',
    message: 'credentials.json entry for "bad" is not a JSON object',
  },
  {
    label: "bad entry value array",
    text: '{"good":{"username":"u"},"bad":["a"]}',
    message: 'credentials.json entry for "bad" is not a JSON object',
  },
  {
    label: "bad entry value string",
    text: '{"good":{"username":"u"},"bad":"hunter2"}',
    message: 'credentials.json entry for "bad" is not a JSON object',
  },
  {
    label: "bad known field: username object",
    text: '{"good":{"username":{"password":"nested-secret"}}}',
    message: 'credentials.json entry for "good" has an invalid "username": expected a string or null',
  },
  {
    label: "bad known field: username array",
    text: '{"good":{"username":["u"]}}',
    message: 'credentials.json entry for "good" has an invalid "username": expected a string or null',
  },
  {
    label: "bad known field: username number",
    text: '{"good":{"username":42}}',
    message: 'credentials.json entry for "good" has an invalid "username": expected a string or null',
  },
  {
    // The same shape one field over, so the guard is provably a loop over the
    // nine known fields and not a special case for `username`.
    label: "bad known field: notes object",
    text: '{"good":{"notes":{"password":"nested-secret"}}}',
    message: 'credentials.json entry for "good" has an invalid "notes": expected a string or null',
  },
];

describe("GET /api/accounts", () => {
  it("[7.1][shared fixture] lists both entries in AC 2's order with passwords stripped", async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((a: any) => a.host)).toEqual([ACME, BETA]);
    // careers-beta.icims.com has NO last_used_at (helpers.ts:179-186), so it is
    // the null case byLastUsedThenHost must put last. A comparator that throws
    // on null, or sorts nulls first, fails here rather than in a screenshot.
    expect(body[1].lastUsedAt).toBeNull();
    expect(body[0].lastUsedAt).toBe("2026-07-22T17:05:00Z");
    expect(body.every((a: any) => a.hasPassword === true)).toBe(true);
    expect(body.every((a: any) => !Object.hasOwn(a, "password"))).toBe(true);
    expect(body[0].company).toBe("Acme");
    expect(body[0].lastLoginStatus).toBe("success");
  });

  it("[7.2][shared fixture] never leaks a password value or the password key", async () => {
    const text = await (await fetch(`${base}/api/accounts`)).text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain('"password"');
  });

  it("[7.3][own fixture] tolerates a missing credentials.json", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      await fs.rm(credPath(r));
      const list = await fetch(`${b}/api/accounts`);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([]);
      const overview = await fetch(`${b}/api/overview`);
      expect(overview.status).toBe(200);
      expect((await overview.json()).accounts).toBe(0);
    });
  });

  it("[7.3b][own fixture] treats an empty or whitespace-only credentials file as corrupt", async () => {
    for (const text of ["", "   \n"]) {
      await withOwnFixture(async ({ root: r, base: b }) => {
        await fs.writeFile(credPath(r), text);
        const list = await fetch(`${b}/api/accounts`);
        expect({ text, status: list.status }).toEqual({ text, status: 500 });
        const overview = await fetch(`${b}/api/overview`);
        expect({ text, status: overview.status }).toEqual({ text, status: 200 });
        const body = await overview.json();
        expect(body.accounts).toBeNull();
        expect(body.corrupt).toContain("credentials.json");
      });
    }
  }, 30_000);

  it("[7.4][own fixture] answers 500 on every read route for every kind of corrupt file", async () => {
    // Status ONLY: app.ts has no trailing error handler (:91), so an unhandled
    // next(err) reaches Express 5's default handler and the body is text/html.
    // A test asserting a JSON error body here fails for the wrong reason.
    // Read with 7.20, which pins the other half — 409 on a mutation — and with
    // 7.3b, which pins the one shape that is genuinely empty rather than
    // malformed.
    for (const row of CORRUPT_FILES) {
      await withOwnFixture(async ({ root: r, base: b }) => {
        await fs.writeFile(credPath(r), row.text);
        const routes = [
          `${b}/api/accounts`,
          // a host that IS in the file — the whole file is refused, not the entry
          accountUrl(b, "good"),
          accountUrl(b, "good", "/reveal"),
          `${b}/api/overview`,
        ];
        for (const url of routes) {
          const res = url.endsWith("/reveal")
            ? await fetch(url, { method: "POST" })
            : await fetch(url);
          const expectedStatus = url.endsWith("/api/overview") ? 200 : 500;
          expect({ row: row.label, url: url.slice(b.length), status: res.status }).toEqual({
            row: row.label,
            url: url.slice(b.length),
            status: expectedStatus,
          });
        }
      });
    }
  }, 60_000);
});

describe("GET /api/accounts/:host", () => {
  it("[7.5][shared fixture] returns the account plus the applications findAccount resolves to it", async () => {
    const res = await fetch(accountUrl(base, ACME));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.host).toBe(ACME);
    // Linked by findAccount's COMPANY fallback — no application URL has this host.
    expect(body.applications.map((a: any) => a.slug)).toEqual(["acme-engineering-manager"]);
  });

  it("[7.6][own fixture] mirrors both resolution rules: exact host beats the company fallback", async () => {
    await withOwnFixture(async ({ base: b }) => {
      const created = await post(b, "/api/accounts", {
        host: "boards.greenhouse.io",
        username: "u",
        company: "Unrelated",
      });
      expect(created.status).toBe(201);

      const byHost = await (await fetch(accountUrl(b, "boards.greenhouse.io"))).json();
      expect(byHost.applications.map((a: any) => a.slug)).toContain("acme-engineering-manager");

      const byCompany = await (await fetch(accountUrl(b, ACME))).json();
      expect(byCompany.applications.map((a: any) => a.slug)).not.toContain(
        "acme-engineering-manager",
      );
    });
  });

  it("[7.7][shared fixture] answers 404 for a key that is not in the file and 400 only for hostParam's bound", async () => {
    // Under Decision 2 these are 404s, not 400s: they decode to strings that are
    // simply not keys in the file, so the own-property lookup answers 404. Safe
    // because the host is only ever an object key — it never reaches the
    // filesystem; paths.credentials(root) is a fixed path.
    for (const key of ["nope.example.com", "https://x.com", "../../etc/passwd"]) {
      const res = await fetch(accountUrl(base, key));
      expect({ key, status: res.status }).toEqual({ key, status: 404 });
      expect(await res.json()).toEqual({ error: "account not found" });
    }
    // The 400 branch is reached only by hostParam's sanity guard, so exercise it
    // with what actually trips it.
    for (const key of BAD_HOST_PARAMS) {
      const res = await fetch(accountUrl(base, key));
      expect({ key: JSON.stringify(key.slice(0, 12)), status: res.status }).toEqual({
        key: JSON.stringify(key.slice(0, 12)),
        status: 400,
      });
      expect(await res.json()).toEqual({ error: "invalid host" });
    }
  });
});

describe("POST /api/accounts/:host/reveal", () => {
  it("[7.8][own fixture] returns exactly the password, and 404s for both missing cases", async () => {
    await withOwnFixture(async ({ base: b }) => {
      const res = await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["password"]);
      expect(body.password).toBe(SENTINEL_PASSWORD);

      const missing = await fetch(accountUrl(b, "nope.example.com", "/reveal"), { method: "POST" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "account not found" });

      expect((await post(b, "/api/accounts", { host: "nopass.example.com", username: "u" })).status)
        .toBe(201);
      const noPassword = await fetch(accountUrl(b, "nopass.example.com", "/reveal"), {
        method: "POST",
      });
      expect(noPassword.status).toBe(404);
      expect(await noPassword.json()).toEqual({ error: "no password on file" });
    });
  });
});

describe("POST /api/accounts", () => {
  it("[7.9][own fixture] creates an entry with matching timestamps and the host field", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const before = Date.now();
      const res = await post(b, "/api/accounts", {
        host: "new.example.com",
        username: "someone@example.com",
        emailUsed: "someone@example.com",
        ats: "greenhouse",
        company: "New Co",
        notes: "typed by hand",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.account.host).toBe("new.example.com");
      expect(body.accounts.map((a: any) => a.host)).toContain("new.example.com");

      const list = await (await fetch(`${b}/api/accounts`)).json();
      expect(list.map((a: any) => a.host)).toContain("new.example.com");

      const raw = await readRawJson(r);
      const entry = raw["new.example.com"];
      expect(entry.host).toBe("new.example.com");
      expect(entry.created_at).toBe(entry.last_used_at);
      const stamped = Date.parse(entry.created_at);
      expect(Number.isNaN(stamped)).toBe(false);
      expect(stamped).toBeGreaterThanOrEqual(before - 5_000);
      expect(stamped).toBeLessThanOrEqual(Date.now() + 5_000);
    });
  });

  it("[7.10][shared fixture] refuses a duplicate host and every malformed field", async () => {
    const duplicate = await post(base, "/api/accounts", { host: ACME, username: "u" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe(`account already exists: ${ACME}`);

    const badHosts = [
      "https://x.com/y",
      "a.com:443",
      "HOST WITH SPACE",
      "../etc",
      "",
      "exämple.com",
    ];
    for (const host of badHosts) {
      const res = await post(base, "/api/accounts", { host, username: "u" });
      const body = await res.json();
      expect({ host, status: res.status, field: body.field }).toEqual({
        host,
        status: 400,
        field: "host",
      });
    }

    const missingHost = await post(base, "/api/accounts", { username: "u" });
    expect(missingHost.status).toBe(400);
    expect(await missingHost.json()).toEqual({ error: "host is required", field: "host" });

    const missingUser = await post(base, "/api/accounts", { host: "ok.example.com" });
    expect(missingUser.status).toBe(400);
    expect(await missingUser.json()).toEqual({ error: "username is required", field: "username" });

    const badAts = await post(base, "/api/accounts", {
      host: "ok.example.com",
      username: "u",
      ats: "notanats",
    });
    expect(badAts.status).toBe(400);
    expect(await badAts.json()).toEqual({
      error:
        "ats must be one of: workday, greenhouse, lever, ashby, icims, smartrecruiters, bamboohr, other",
      field: "ats",
    });

    const longNotes = await post(base, "/api/accounts", {
      host: "ok.example.com",
      username: "u",
      notes: "n".repeat(5000),
    });
    expect(longNotes.status).toBe(400);
    expect(await longNotes.json()).toEqual({
      error: "notes must be 4000 characters or fewer",
      field: "notes",
    });

    // Nothing above may have landed.
    const list = await (await fetch(`${base}/api/accounts`)).json();
    expect(list.map((a: any) => a.host)).toEqual([ACME, BETA]);
  });

  it("[7.11][own fixture] creates credentials.json when it does not exist (the wx seed path)", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      await fs.rm(credPath(r));
      const res = await post(b, "/api/accounts", { host: "fresh.example.com", username: "u" });
      expect(res.status).toBe(201);
      const raw = await readRawJson(r);
      expect(Object.keys(raw)).toEqual(["fresh.example.com"]);
    });
  });
});

describe("PATCH /api/accounts/:host", () => {
  it("[7.12][own fixture] updates each of the seven fields, and null removes a key", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const url = accountUrl(b, ACME);
      const detail = async () => (await (await fetch(url)).json()).account;

      expect((await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { username: "u2" })).status)
        .toBe(200);
      expect((await detail()).username).toBe("u2");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { emailUsed: "e2@example.com" });
      expect((await detail()).emailUsed).toBe("e2@example.com");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { ats: "lever" });
      expect((await detail()).ats).toBe("lever");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { company: "Acme Two" });
      expect((await detail()).company).toBe("Acme Two");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { notes: "replaced" });
      expect((await detail()).notes).toBe("replaced");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { lastLoginStatus: "failed" });
      expect((await detail()).lastLoginStatus).toBe("failed");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { password: "second-secret" });
      expect((await detail()).hasPassword).toBe(true);

      // last_used_at is the agent's; editing a note is not a login.
      expect((await readRawJson(r))[ACME].last_used_at).toBe("2026-07-22T17:05:00Z");

      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { lastLoginStatus: null });
      await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { notes: null });
      const raw = await readRawJson(r);
      expect(Object.hasOwn(raw[ACME], "last_login_status")).toBe(false);
      expect(Object.hasOwn(raw[ACME], "notes")).toBe(false);
    });
  });

  it("[7.13][own fixture] replaces the password without echoing either value", async () => {
    // Its own fixture is what keeps 7.24's "old password" well defined: on a
    // shared fixture this case would have replaced it first.
    await withOwnFixture(async ({ base: b }) => {
      const res = await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, {
        password: "rotated-value",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SENTINEL_PASSWORD);
      expect(text).not.toContain("rotated-value");

      const detail = await (await fetch(accountUrl(b, ACME))).json();
      expect(detail.account.hasPassword).toBe(true);

      const revealed = await (
        await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" })
      ).json();
      expect(revealed.password).toBe("rotated-value");
    });
  });

  it("[7.14][shared fixture] refuses an unknown host, an empty body and a bad enum", async () => {
    const unknown = await patch(base, "/api/accounts/nope.example.com", { company: "X" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "account not found" });

    const empty = await patch(base, `/api/accounts/${encodeURIComponent(ACME)}`, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "no fields to update" });

    const badAts = await patch(base, `/api/accounts/${encodeURIComponent(ACME)}`, {
      ats: "notanats",
    });
    expect(badAts.status).toBe(400);
    expect((await badAts.json()).field).toBe("ats");

    const badStatus = await patch(base, `/api/accounts/${encodeURIComponent(ACME)}`, {
      lastLoginStatus: "nope",
    });
    expect(badStatus.status).toBe(400);
    expect(await badStatus.json()).toEqual({
      error: "lastLoginStatus must be one of: success, failed, pending",
      field: "lastLoginStatus",
    });
  });

  it("[7.15][own fixture] preserves unknown fields of every JSON type and every untouched entry", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const raw = await readRawJson(r);
      const extras = {
        custom_str: "keep me",
        custom_num: 7,
        custom_bool: true,
        custom_null: null,
        custom_arr: ["a", 1],
        custom_obj: { nested: { deep: "value" } },
      };
      Object.assign(raw[ACME], extras);
      raw["third.example.com"] = { username: "third", ats: "other", company: "Third" };
      await fs.writeFile(credPath(r), JSON.stringify(raw, null, 2));
      const thirdBefore = JSON.stringify(raw["third.example.com"]);

      // The POSITIVE half: only the nine KNOWN fields are type-checked, so an
      // unknown field of any type must not make the file unreadable. A validator
      // that rejected what it did not recognize would fail here, and it must.
      const list = await fetch(`${b}/api/accounts`);
      expect(list.status).toBe(200);
      expect((await list.json()).map((a: any) => a.host)).toContain(ACME);

      const res = await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, {
        company: "Acme Renamed",
      });
      expect(res.status).toBe(200);

      const after = await readRawJson(r);
      for (const [key, value] of Object.entries(extras)) {
        expect({ key, value: after[ACME][key] }).toEqual({ key, value });
      }
      expect(after[ACME].company).toBe("Acme Renamed");
      expect(JSON.stringify(after["third.example.com"])).toBe(thirdBefore);
      expect(Object.keys(after).sort()).toEqual([ACME, BETA, "third.example.com"].sort());
    });
  });
});

describe("the atomic write", () => {
  it("[7.16][own fixture] leaves no temp file and the extension's own formatting, on success and on failure", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      expect((await post(b, "/api/accounts", { host: "atomic.example.com", username: "u" })).status)
        .toBe(201);

      const entries = await fs.readdir(r);
      expect(entries.filter((f) => /^\.credentials\..*\.tmp$/.test(f))).toEqual([]);

      const bytes = await readRawText(r);
      // 2-space indent, no trailing newline — byte-identical to job-accounts.ts:66
      expect(bytes).toBe(JSON.stringify(JSON.parse(bytes), null, 2));

      // AND THE SAME MUST HOLD AFTER A FAILED WRITE. Without the cleanup in the
      // writer's catch, every failure leaves an orphan behind, and the orphans
      // accumulate invisibly because WATCH_IGNORED hides them from the stream too.
      const spy = vi
        .spyOn(fs, "rename")
        .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "EXDEV" }));
      try {
        const failed = await post(b, "/api/accounts", { host: "failed.example.com", username: "u" });
        expect(failed.status).toBe(500);
      } finally {
        spy.mockRestore();
      }

      const afterFailure = await fs.readdir(r);
      expect(afterFailure.filter((f) => /^\.credentials\..*\.tmp$/.test(f))).toEqual([]);
      expect(await readRawText(r)).toBe(bytes);
    });
  }, 30_000);

  it("[7.17][own fixture] serializes concurrent creates without lost writes", async () => {
    /**
     * Negative control the implementer runs ONCE and records: temporarily
     * replace `withLock(file, fn)` in accountsWriter.ts with a bare `await fn()`;
     * this test must fail with fewer than 10 new entries. RUN AND RECORDED: with
     * the lock removed only 2 of the 10 creates survived (204 keys on disk
     * instead of 212) and this case failed; the lock was then restored.
     */
    await withOwnFixture(async ({ root: r, base: b }) => {
      const padded = await readRawJson(r);
      for (let i = 0; i < 200; i++) {
        padded[`pad${i}.example.com`] = {
          username: `pad${i}`,
          ats: "other",
          company: `Pad ${i}`,
          created_at: "2026-01-01T00:00:00.000Z",
          last_used_at: "2026-01-01T00:00:00.000Z",
        };
      }
      await fs.writeFile(credPath(r), JSON.stringify(padded, null, 2));

      const hosts = Array.from({ length: 10 }, (_, i) => `race${i}.example.com`);
      const results = await Promise.all(
        hosts.map((host) => post(b, "/api/accounts", { host, username: host })),
      );
      expect(results.map((res) => res.status)).toEqual(hosts.map(() => 201));

      const after = await readRawJson(r);
      for (const host of hosts) expect(Object.hasOwn(after, host)).toBe(true);
      for (let i = 0; i < 200; i++) expect(Object.hasOwn(after, `pad${i}.example.com`)).toBe(true);
      expect(Object.keys(after).length).toBe(2 + 200 + 10);
    });
  }, 20_000);
});

describe("DELETE /api/accounts/:host", () => {
  it("[7.18][own fixture] removes the entry, returns it, and 404s the second time", async () => {
    // Its own fixture is what lets 7.27 delete the same host and still find it.
    await withOwnFixture(async ({ root: r, base: b }) => {
      const res = await del(b, `/api/accounts/${encodeURIComponent(ACME)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.account.host).toBe(ACME);
      expect(body.accounts.map((a: any) => a.host)).toEqual([BETA]);

      const raw = await readRawJson(r);
      expect(Object.keys(raw)).toEqual([BETA]);

      const again = await del(b, `/api/accounts/${encodeURIComponent(ACME)}`);
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: "account not found" });
    });
  });
});

describe("corrupt input, on the wire and on disk", () => {
  it("[7.19][shared fixture] answers 400 for a malformed request body on both routes that take one", async () => {
    // Identical bytes, different file, different answer: "{ nope" in the REQUEST
    // is a 400 from express.json()'s parser (app.ts:52-62); "{ nope" in
    // credentials.json is a 409 PARSE from the writer (7.20).
    for (const [method, route] of [
      ["POST", "/api/accounts"],
      ["PATCH", `/api/accounts/${encodeURIComponent(ACME)}`],
    ] as const) {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{ nope",
      });
      expect({ method, status: res.status }).toEqual({ method, status: 400 });
      expect(await res.json()).toEqual({ error: "invalid JSON body" });
    }
  });

  it("[7.20][own fixture] answers 409 on every mutation for every kind of corrupt file, bytes unchanged", async () => {
    for (const row of CORRUPT_FILES) {
      await withOwnFixture(async ({ root: r, base: b }) => {
        await fs.writeFile(credPath(r), row.text);

        const attempts: Array<[string, () => Promise<Response>]> = [
          ["POST", () => post(b, "/api/accounts", { host: "brand.example.com", username: "u" })],
          ["PATCH", () => patch(b, "/api/accounts/good", { company: "X" })],
          ["DELETE", () => del(b, "/api/accounts/good")],
        ];

        for (const [verb, run] of attempts) {
          const res = await run();
          const body = await res.json();
          expect({ row: row.label, verb, status: res.status, error: body.error }).toEqual({
            row: row.label,
            verb,
            status: 409,
            error: row.message,
          });
          // A refusal that had already mutated the map would be the silent-write
          // failure in a new costume.
          expect(await readRawText(r)).toBe(row.text);
        }
      });
    }
  }, 60_000);
});

describe("Decision 2 — the stored key is the key", () => {
  it("[7.21][own fixture] keeps non-canonical stored keys fully manageable", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      // encodeURIComponent("acme.example.com:8443") escapes the ":" and Express
      // decodes it back, so the handler sees the literal key.
      const keys = ["acme.example.com:8443", "MixedCase.Example.COM"];
      const seeded: Record<string, unknown> = {};
      for (const key of keys) {
        seeded[key] = {
          username: `${key}-user`,
          password: `${key}-secret`,
          email_used: `${key}@example.com`,
          ats: "workday",
          company: "Odd Key Co",
          created_at: "2026-01-01T00:00:00Z",
          last_used_at: "2026-01-02T00:00:00Z",
        };
      }
      await fs.writeFile(credPath(r), JSON.stringify(seeded, null, 2));

      const listed = await (await fetch(`${b}/api/accounts`)).json();
      expect(listed.map((a: any) => a.host).sort()).toEqual([...keys].sort());

      for (const key of keys) {
        const detail = await fetch(accountUrl(b, key));
        expect({ key, status: detail.status }).toEqual({ key, status: 200 });
        expect((await detail.json()).account.host).toBe(key);

        const edited = await patch(b, `/api/accounts/${encodeURIComponent(key)}`, {
          company: "Renamed",
        });
        expect({ key, status: edited.status }).toEqual({ key, status: 200 });
        const reread = await (await fetch(accountUrl(b, key))).json();
        expect(reread.account.company).toBe("Renamed");

        const revealed = await fetch(accountUrl(b, key, "/reveal"), { method: "POST" });
        expect({ key, status: revealed.status }).toEqual({ key, status: 200 });
        expect((await revealed.json()).password).toBe(`${key}-secret`);

        const removed = await del(b, `/api/accounts/${encodeURIComponent(key)}`);
        expect({ key, status: removed.status }).toEqual({ key, status: 200 });
        const again = await del(b, `/api/accounts/${encodeURIComponent(key)}`);
        expect({ key, status: again.status }).toEqual({ key, status: 404 });
      }

      // The create path stays strict while the lookup path stays permissive, and
      // that asymmetry IS Decision 2. The two strings fail differently, and both
      // failures are the create path refusing to mint a non-canonical key:
      //
      //   - "acme.example.com:8443" carries a port, which normalizeHost rejects
      //     outright — 400 { field: "host" }.
      //   - "MixedCase.Example.COM" normalizes cleanly to "mixedcase.example.com"
      //     (the lowercasing is load-bearing: it is exactly what the extension's
      //     `new URL(...).host` would have produced), so it reaches the writer,
      //     whose in-lock fold sees the stored variant and answers 409 naming it.
      //     A 400 here would require normalizeHost to reject uppercase, which
      //     would defeat the whole point of folding a typed host to the agent's key.
      await fs.writeFile(credPath(r), JSON.stringify(seeded, null, 2));
      const port = await post(b, "/api/accounts", {
        host: "acme.example.com:8443",
        username: "u",
      });
      expect(port.status).toBe(400);
      expect((await port.json()).field).toBe("host");

      const mixed = await post(b, "/api/accounts", { host: "MixedCase.Example.COM", username: "u" });
      expect(mixed.status).toBe(409);
      expect((await mixed.json()).error).toBe("account already exists: MixedCase.Example.COM");
    });
  }, 30_000);

  it("[7.22][own fixture] treats prototype-named keys as data, not behaviour", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const keys = ["constructor", "__proto__"];
      // Object.create(null) IN THE TEST TOO, and for the same reason the writer
      // needs one: `plain["__proto__"] = entry` invokes Object.prototype's
      // __proto__ setter, creates no own property, and JSON.stringify then emits
      // a file that never had the key. Seeding through a plain object literal
      // silently produced a one-entry fixture and made this case fail on its own
      // setup rather than on the behaviour it is about.
      const seeded: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        seeded[key] = {
          username: `${key}-user`,
          password: `${key}-secret`,
          ats: "other",
          company: "Proto Co",
          created_at: "2026-01-01T00:00:00Z",
          last_used_at: "2026-01-02T00:00:00Z",
        };
      }
      await fs.writeFile(credPath(r), JSON.stringify(seeded, null, 2));

      const listed = await (await fetch(`${b}/api/accounts`)).json();
      expect(listed.map((a: any) => a.host).sort()).toEqual([...keys].sort());
      expect(listed).toHaveLength(2);

      // A `next[host]` truthiness check would 409 here against the INHERITED
      // Object.prototype.constructor, so this is the assertion that fails if the
      // null-prototype copy is ever dropped.
      const created = await post(b, "/api/accounts", { host: "new.example.com", username: "u" });
      expect(created.status).toBe(201);

      const afterCreate = await readRawJson(r);
      for (const key of keys) {
        expect(Object.hasOwn(afterCreate, key)).toBe(true);
        expect(afterCreate[key].username).toBe(`${key}-user`);
        expect(afterCreate[key].password).toBe(`${key}-secret`);
      }

      for (const key of keys) {
        const detail = await fetch(accountUrl(b, key));
        expect({ key, status: detail.status }).toEqual({ key, status: 200 });

        const edited = await patch(b, `/api/accounts/${encodeURIComponent(key)}`, {
          company: "Renamed",
        });
        expect({ key, status: edited.status }).toEqual({ key, status: 200 });

        const revealed = await fetch(accountUrl(b, key, "/reveal"), { method: "POST" });
        expect({ key, status: revealed.status }).toEqual({ key, status: 200 });
        expect((await revealed.json()).password).toBe(`${key}-secret`);
      }

      for (const key of keys) {
        const removed = await del(b, `/api/accounts/${encodeURIComponent(key)}`);
        expect({ key, status: removed.status }).toEqual({ key, status: 200 });
      }
      expect(Object.keys(await readRawJson(r))).toEqual(["new.example.com"]);

      // the blunt containment check
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });
  }, 30_000);

  it("[7.23][own fixture] refuses a case-variant create through the route, for every variant shape", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const entry = {
        username: "u",
        password: "variant-secret",
        ats: "other",
        company: "Variant Co",
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: "2026-01-02T00:00:00Z",
      };

      for (const stored of ["Acme.COM", "acme.com."]) {
        await fs.writeFile(credPath(r), JSON.stringify({ [stored]: entry }, null, 2));
        const res = await post(b, "/api/accounts", { host: "acme.com", username: "u" });
        expect({ stored, status: res.status }).toEqual({ stored, status: 409 });
        // the EXISTING key verbatim, not the normalized candidate
        expect((await res.json()).error).toBe(`account already exists: ${stored}`);
        // exactly one key proves the refusal prevented the duplicate rather than
        // a later write cleaning it up
        expect(Object.keys(await readRawJson(r))).toEqual([stored]);
      }

      // WHAT THIS LAST PART DOES AND DOES NOT PROVE. It writes the variant after
      // the request's url and init are BUILT, which is not after the request is
      // SENT: the write still happens before `fetch`, so a hypothetical
      // route-level pre-flight scan would read the file with the variant already
      // in it and answer 409 too, and this would stay green. Building a
      // RequestInit is not a seam. It is kept because it is a real end-to-end
      // refusal from a file the route did not start out with, but the guarantee
      // "the fold lives INSIDE THE LOCK" is pinned by 7.36 (the writer alone,
      // no route) and 7.37 (the variant lands while the test holds the lock, so
      // the route provably cannot have read the file yet).
      await fs.writeFile(credPath(r), JSON.stringify({}, null, 2));
      const url = `${b}/api/accounts`;
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "acme.com", username: "u" }),
      };
      await fs.writeFile(credPath(r), JSON.stringify({ "Acme.COM": entry }, null, 2));
      const raced = await fetch(url, init);
      expect(raced.status).toBe(409);
      expect((await raced.json()).error).toBe("account already exists: Acme.COM");
      expect(Object.keys(await readRawJson(r))).toEqual(["Acme.COM"]);
    });
  });

  it("[7.36][own fixture] the writer itself refuses a case-variant create, with no route involved", async () => {
    // WHERE THE GUARANTEE ACTUALLY LIVES. Every case above goes through the
    // route, so the most any of them can say is "the create was refused" — none
    // can say WHICH layer refused it. This calls createAccountEntry directly, so
    // the fold in accountsWriter.ts is the only code that could produce this
    // result. Move that fold up into a route pre-flight and this case fails
    // whatever the routes do.
    const r = await makeFixtureWorkspace();
    try {
      for (const stored of ["Acme.COM", "acme.com."]) {
        await fs.writeFile(
          credPath(r),
          JSON.stringify({ [stored]: { username: "u", ats: "other" } }, null, 2),
        );
        const result = await createAccountEntry(r, "acme.com", { username: "u", ats: "other" });
        expect({ stored, ok: result.ok }).toEqual({ stored, ok: false });
        // the EXISTING key verbatim, and the CONFLICT code that separates a
        // variant from a plain EEXIST
        expect(result.ok ? null : result.error).toEqual({
          code: "CONFLICT",
          message: `account already exists: ${stored}`,
        });
        // refused means nothing was written
        expect(Object.keys(await readRawJson(r))).toEqual([stored]);
      }
    } finally {
      await rmFixtureWorkspace(r);
    }
  });

  it("[7.37][own fixture] catches a variant that lands after the request is in the server, ahead of the locked read", async () => {
    // THE SEAM 7.23 CANNOT BUILD, and it needs no hook in the application: the
    // TEST takes the writer's own lock first. createAccountEntry's ONLY read of
    // credentials.json is inside that lock (accountsWriter.ts mutateCredentials),
    // so for as long as the test holds it a correct writer cannot have read
    // anything, and whatever is written before the release is exactly what the
    // fold sees. The `request` listener is on the test's own http.Server, so the
    // variant provably lands after the request reached the server rather than
    // before it was sent.
    //
    // THE SETTLE DELAY IS THE DETECTOR, not decoration. An implementation that
    // read and folded BEFORE taking the lock — a route pre-flight, or a
    // pre-lock read in the writer — completes that read in the first few
    // milliseconds, over the empty map, finds no conflict, then queues behind
    // this lock and writes `acme.com` alongside `Acme.COM` when it gets in. The
    // 200ms is far longer than that read and far shorter than withLock's ~2.8s
    // retry budget (lock.ts:12), so such a build fails the 409 and the
    // single-key assertions below every time.
    const r = await makeFixtureWorkspace();
    const app = createApp(r, { security: { enabled: false } });
    const ownServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = ownServer.address() as AddressInfo;
    const b = `http://127.0.0.1:${port}`;
    let arrived!: () => void;
    const inTheServer = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    ownServer.on("request", () => arrived());

    try {
      await fs.writeFile(credPath(r), JSON.stringify({}, null, 2));
      let pending: Promise<Response> | null = null;

      await withLock(credPath(r), async () => {
        pending = post(b, "/api/accounts", { host: "acme.com", username: "u" });
        await inTheServer;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await fs.writeFile(
          credPath(r),
          JSON.stringify({ "Acme.COM": { username: "u", ats: "other" } }, null, 2),
        );
      });

      const raced = await pending!;
      expect(raced.status).toBe(409);
      expect((await raced.json()).error).toBe("account already exists: Acme.COM");
      expect(Object.keys(await readRawJson(r))).toEqual(["Acme.COM"]);
    } finally {
      await new Promise((resolve) => ownServer.close(resolve));
      await rmFixtureWorkspace(r);
    }
  });
});

describe("password semantics", () => {
  it("[7.24][own fixture] PATCH has three password states and refuses the fourth", async () => {
    await withOwnFixture(async ({ base: b }) => {
      const route = `/api/accounts/${encodeURIComponent(ACME)}`;

      const empty = await patch(b, route, { password: "" });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({
        error: "password must not be empty (send null to remove it)",
        field: "password",
      });
      // the rejected request changed nothing — and because this case has its own
      // fixture, "the old password" is unambiguously the fixture's sentinel
      const stillThere = await (
        await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" })
      ).json();
      expect(stillThere.password).toBe(SENTINEL_PASSWORD);

      expect((await patch(b, route, { password: null })).status).toBe(200);
      const cleared = await (await fetch(accountUrl(b, ACME))).json();
      expect(cleared.account.hasPassword).toBe(false);
      const gone = await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" });
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: "no password on file" });

      expect((await patch(b, route, { password: "new-value" })).status).toBe(200);
      const restored = await (
        await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" })
      ).json();
      expect(restored.password).toBe("new-value");
    });
  });

  it("[7.25][shared fixture] PATCH enforces the same length limits as POST", async () => {
    const before = await readRawText(root);
    const route = `/api/accounts/${encodeURIComponent(ACME)}`;

    const longNotes = await patch(base, route, { notes: "n".repeat(5000) });
    expect(longNotes.status).toBe(400);
    expect(await longNotes.json()).toEqual({
      error: "notes must be 4000 characters or fewer",
      field: "notes",
    });

    const longCompany = await patch(base, route, { company: "c".repeat(600) });
    expect(longCompany.status).toBe(400);
    expect(await longCompany.json()).toEqual({
      error: "company must be 512 characters or fewer",
      field: "company",
    });

    // a rejected PATCH is provably a no-op, not a partial write
    expect(await readRawText(root)).toBe(before);
  });

  it("[7.30][own fixture] stores a password byte-for-byte, spaces and all", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const created = await post(b, "/api/accounts", {
        host: "spaced.example.com",
        username: "u",
        password: "  spaced  ",
      });
      expect(created.status).toBe(201);
      const revealed = await (
        await fetch(accountUrl(b, "spaced.example.com", "/reveal"), { method: "POST" })
      ).json();
      expect(revealed.password).toBe("  spaced  ");
      expect((await readRawJson(r))["spaced.example.com"].password).toBe("  spaced  ");

      const patched = await patch(b, "/api/accounts/spaced.example.com", {
        password: "  patched  ",
      });
      expect(patched.status).toBe(200);
      const again = await (
        await fetch(accountUrl(b, "spaced.example.com", "/reveal"), { method: "POST" })
      ).json();
      expect(again.password).toBe("  patched  ");
      expect((await readRawJson(r))["spaced.example.com"].password).toBe("  patched  ");
    });
  });

  /**
   * The body both write routes answer a sub-floor password with. Built from
   * runs/secrets.ts's own constant, exactly as the routes build it, so this case
   * cannot keep passing while the two numbers drift apart.
   */
  const TOO_SHORT = {
    error: `password must be at least ${MIN_SECRET_LENGTH} characters — shorter values cannot be redacted from run transcripts`,
    field: "password",
  };

  it("[7.34][own fixture] refuses a password the run redactor could not collect, on POST and PATCH", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const short = await post(b, "/api/accounts", {
        host: "short.example.com",
        username: "u",
        password: "abc",
      });
      expect(short.status).toBe(400);
      expect(await short.json()).toEqual(TOO_SHORT);
      // refused outright, not half-created
      expect(Object.hasOwn(await readRawJson(r), "short.example.com")).toBe(false);

      // "" IS NOT THIS ERROR. On create it still means "no password recorded":
      // the key is omitted, and a value that was never stored is not a value the
      // redactor can miss.
      const blank = await post(b, "/api/accounts", {
        host: "blank.example.com",
        username: "u",
        password: "",
      });
      expect(blank.status).toBe(201);
      expect(Object.hasOwn((await readRawJson(r))["blank.example.com"], "password")).toBe(false);

      // three spaces are three CHARACTERS: the floor counts the value as sent,
      // the same untrimmed value the storage rule would have written
      const spaces = await post(b, "/api/accounts", {
        host: "spaces.example.com",
        username: "u",
        password: "   ",
      });
      expect(spaces.status).toBe(400);
      expect(await spaces.json()).toEqual(TOO_SHORT);

      // exactly at the floor is accepted and comes back byte-for-byte
      const atFloor = await post(b, "/api/accounts", {
        host: "floor.example.com",
        username: "u",
        password: "abcd",
      });
      expect(atFloor.status).toBe(201);
      const floorRevealed = await (
        await fetch(accountUrl(b, "floor.example.com", "/reveal"), { method: "POST" })
      ).json();
      expect(floorRevealed.password).toBe("abcd");

      // PATCH refuses the same value, and the stored password is untouched —
      // proved through the one route that returns it
      const patched = await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, {
        password: "abc",
      });
      expect(patched.status).toBe(400);
      expect(await patched.json()).toEqual(TOO_SHORT);
      const stillThere = await (
        await fetch(accountUrl(b, ACME, "/reveal"), { method: "POST" })
      ).json();
      expect(stillThere.password).toBe(SENTINEL_PASSWORD);
    });
  });

  it("[7.35][own fixture] every password the routes accept is one createSecretsReader collects", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      // 7.34's REASON, asserted against the redactor itself rather than restated.
      // A value at the floor, written through PATCH mid-run, lands in the set
      // redactText replaces literally — so free text like `Password: ab12`, which
      // the JSON key masking cannot see, is still redacted. A value below the
      // floor would not be in that set at all, which is why the routes refuse it.
      const read = createSecretsReader(r, {});
      expect(read.read()).toContain(SENTINEL_PASSWORD);

      const route = `/api/accounts/${encodeURIComponent(ACME)}`;
      expect((await patch(b, route, { password: "ab12" })).status).toBe(200);

      expect(read.read()).toContain("ab12");
      expect(redactText("Password: ab12", read.read())).toBe("Password: [redacted]");
    });
  });
});

describe("the mutation responses are password-free", () => {
  it("[7.26][own fixture] POST and PATCH", async () => {
    await withOwnFixture(async ({ base: b }) => {
      const created = await post(b, "/api/accounts", {
        host: "leaky.example.com",
        username: "u",
        password: "leak-me-on-create",
      });
      expect(created.status).toBe(201);
      const createdText = await created.text();
      for (const needle of [
        "leak-me-on-create",
        SENTINEL_PASSWORD,
        "hunter2",
        '"password"',
      ]) {
        expect(createdText).not.toContain(needle);
      }

      const patched = await patch(b, "/api/accounts/leaky.example.com", {
        password: "leak-me-on-patch",
      });
      expect(patched.status).toBe(200);
      const patchedText = await patched.text();
      for (const needle of [
        "leak-me-on-patch",
        SENTINEL_PASSWORD,
        "hunter2",
        '"password"',
      ]) {
        expect(patchedText).not.toContain(needle);
      }
    });
  });

  it("[7.27][own fixture] DELETE", async () => {
    // The route where a leak is most likely: deleteAccountEntry captures the raw
    // entry BEFORE removing it and hands it back as `entry`. Reachable at 200
    // because this case deletes from its OWN copy of the fixture.
    await withOwnFixture(async ({ base: b }) => {
      const res = await del(b, `/api/accounts/${encodeURIComponent(ACME)}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SENTINEL_PASSWORD);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain('"password"');
      const body = JSON.parse(text);
      expect(body.account.hasPassword).toBe(true);
      expect(Object.hasOwn(body.account, "password")).toBe(false);
    });
  });
});

describe("a missing or empty credentials.json on the write paths", () => {
  it("[7.28][own fixture] PATCH and DELETE answer 404 JSON, not a 500, when the file is gone", async () => {
    // Without the pre-lock existence check, withLock rejects ENOENT, next(err)
    // reaches Express's default handler, and the answer is a 500 with an HTML
    // body — so assert the status AND the JSON body, not merely "not 200".
    await withOwnFixture(async ({ root: r, base: b }) => {
      await fs.rm(credPath(r));
      const patched = await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, { company: "X" });
      expect(patched.status).toBe(404);
      expect(await patched.json()).toEqual({ error: "account not found" });

      const removed = await del(b, `/api/accounts/${encodeURIComponent(ACME)}`);
      expect(removed.status).toBe(404);
      expect(await removed.json()).toEqual({ error: "account not found" });
    });
  });

  it("[7.29][own fixture] a create refuses an empty file; PATCH and DELETE 404 out of one", async () => {
    for (const text of ["", "   \n"]) {
      await withOwnFixture(async ({ root: r, base: b }) => {
        await fs.writeFile(credPath(r), text);
        const created = await post(b, "/api/accounts", { host: "onto.example.com", username: "u" });
        expect({ text, status: created.status }).toEqual({ text, status: 409 });
      });
    }

    await withOwnFixture(async ({ root: r, base: b }) => {
      await fs.writeFile(credPath(r), "{}");
      const patched = await patch(b, "/api/accounts/any.example.com", { company: "X" });
      expect(patched.status).toBe(404);
      const removed = await del(b, "/api/accounts/any.example.com");
      expect(removed.status).toBe(404);
    });
  }, 30_000);
});

describe("nothing quietly rewrites a stored value", () => {
  it("[7.31][own fixture] an unrecognized enum survives a PATCH of another field", async () => {
    await withOwnFixture(async ({ root: r, base: b }) => {
      const raw = await readRawJson(r);
      raw[ACME].ats = "greenhouse-eu";
      raw[ACME].last_login_status = "expired";
      await fs.writeFile(credPath(r), JSON.stringify(raw, null, 2));

      // readAccounts surfaces both as-is: ATSAccount.ats/.lastLoginStatus are
      // `string | null`, deliberately not narrowed to the write-side enums.
      const detail = await (await fetch(accountUrl(b, ACME))).json();
      expect(detail.account.ats).toBe("greenhouse-eu");
      expect(detail.account.lastLoginStatus).toBe("expired");

      const res = await patch(b, `/api/accounts/${encodeURIComponent(ACME)}`, {
        company: "Only This",
      });
      expect(res.status).toBe(200);

      const after = await readRawJson(r);
      expect(after[ACME].ats).toBe("greenhouse-eu");
      expect(after[ACME].last_login_status).toBe("expired");
      expect(after[ACME].company).toBe("Only This");
    });
  });
});

describe("hostParam is wired to every route that has one", () => {
  it("[7.32][shared fixture] answers 400 invalid host from PATCH, DELETE and reveal, and 400 from Express for a malformed escape", async () => {
    // Until this case only GET /:host was tested through hostParam (7.7) — a
    // hostParam call dropped from PATCH, DELETE or reveal would have passed the
    // whole suite.
    const before = await readRawText(root);
    for (const key of BAD_HOST_PARAMS) {
      const encoded = encodeURIComponent(key);
      const label = key.slice(0, 12);

      // a VALID body, so the rejection is provably the host and not the body
      const patched = await patch(base, `/api/accounts/${encoded}`, { company: "X" });
      expect({ label, status: patched.status }).toEqual({ label, status: 400 });
      expect(await patched.json()).toEqual({ error: "invalid host" });

      const removed = await del(base, `/api/accounts/${encoded}`);
      expect({ label, status: removed.status }).toEqual({ label, status: 400 });
      expect(await removed.json()).toEqual({ error: "invalid host" });

      const revealed = await fetch(`${base}/api/accounts/${encoded}/reveal`, { method: "POST" });
      expect({ label, status: revealed.status }).toEqual({ label, status: 400 });
      expect(await revealed.json()).toEqual({ error: "invalid host" });
    }
    // a 400 must be a no-op: the guard runs before the writer is ever called
    expect(await readRawText(root)).toBe(before);

    // PLUS THE BRANCH EXPRESS OWNS RATHER THAN THE ROUTE. A malformed
    // percent-escape throws a URIError in decodeParam inside router/lib/layer.js
    // and never reaches the handler, so hostParam needs no percent-decoding
    // logic. Status only — the body is Express's HTML.
    const malformed = await fetch(`${base}/api/accounts/%E0%A4%A`);
    expect(malformed.status).toBe(400);
  });
});

describe("a malformed known field cannot leak a password key into a plain GET", () => {
  /**
   * Cases 7.4 and 7.20 cover the STATUSES for every malformed-field shape; this
   * case exists on its own because the failure it guards is a DISCLOSURE, and a
   * disclosure needs an assertion about the response BODY, not its status code.
   *
   * Before the known-field guard, this exact file produced a 200 whose body was,
   * verbatim:
   *
   *   [{"host":"good","username":{"password":"nested-secret"},"emailUsed":null,
   *     "ats":null,"company":null,"createdAt":null,"lastUsedAt":null,
   *     "lastLoginStatus":null,"notes":null,"hasPassword":false}]
   *
   * — a literal "password" key and its value in the one response AC 4 and the
   * plan both describe as password-free BY CONSTRUCTION. The suite's other leak
   * assertions (7.2, 7.26, 7.27, api.test.ts) could never have caught it,
   * because they run against fixtures that are well-formed by construction; this
   * is the one case that writes the malformed file on purpose.
   */
  it("[7.33][own fixture] refuses the file and quotes neither the key nor the value", async () => {
    for (const field of ["username", "notes"]) {
      await withOwnFixture(async ({ root: r, base: b }) => {
        const text = `{"good":{"${field}":{"password":"nested-secret"}}}`;
        await fs.writeFile(credPath(r), text);

        const assertClean = async (label: string, res: Response, status: number) => {
          const body = await res.text();
          expect({ field, label, status: res.status }).toEqual({ field, label, status });
          expect(body).not.toContain("password");
          expect(body).not.toContain("nested-secret");
        };

        await assertClean("GET /", await fetch(`${b}/api/accounts`), 500);
        await assertClean("GET /:host", await fetch(accountUrl(b, "good")), 500);
        await assertClean(
          "reveal",
          await fetch(accountUrl(b, "good", "/reveal"), { method: "POST" }),
          500,
        );
        await assertClean(
          "POST /",
          await post(b, "/api/accounts", { host: "brand.example.com", username: "u" }),
          409,
        );
        await assertClean(
          "PATCH /:host",
          await patch(b, "/api/accounts/good", { company: "X" }),
          409,
        );
        await assertClean("DELETE /:host", await del(b, "/api/accounts/good"), 409);

        expect(await readRawText(r)).toBe(text);
      });
    }
  }, 30_000);
});
