import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { createApp } from "../app";
import { HEARTBEAT_MS } from "../routes/events";

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
  // The overview resolves the CAPTCHA env-var override from the env the app is
  // given; the shared fixture must not see the developer's shell.
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

describe("GET /api/overview", () => {
  it("returns counts from real workspace data with invariant relationships", async () => {
    const res = await fetch(`${base}/api/overview`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    // invariants, not hardcoded live counts
    expect(body.applications.total).toBe(body.applications.tracked + body.applications.estimated);
    expect(body.applications.tracked).toBeGreaterThan(0);
    expect(body.applications.estimated).toBeGreaterThan(0);
    expect(body.queue).toBeGreaterThan(0);
    expect(body.discovered).toBeGreaterThan(0);
    expect(body.accounts).toBeGreaterThan(0);
    // 3 since the shared fixture grew a `default` address (helpers.ts) — the
    // key that proves `default` is never flagged an orphan by /api/addresses.
    expect(body.addresses).toBe(3);
    expect(body.lastFullGather).toBe("2026-06-24T21:14:30.367Z");
    expect(body.captchaSolver).toBe("off");
    expect(body.applications.byApplyState.submitted).toBeGreaterThan(0);
    expect(body.applications.byPipelineStatus.submitted).toBeGreaterThan(0);
  });

  it("never leaks passwords in any response", async () => {
    const res = await fetch(`${base}/api/overview`);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

describe("GET /api/runs/current", () => {
  // The same invariant, extended to the route that carries a live agent
  // transcript. This app has no run manager command wired to a fake pi, so it
  // covers the empty case only — the surface that matters, a run that has
  // actually emitted tool payloads, is asserted in runs.test.ts under
  // "secret redaction".
  it("never leaks passwords", async () => {
    const res = await fetch(`${base}/api/runs/current`);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

/**
 * Background-drain an SSE response into a buffer, with a needle waiter. Lifted
 * verbatim out of the change-event test below so the heartbeat and debounce
 * tests can reuse it instead of copying it twice more.
 */
function readStream(res: Response) {
  let buffer = "";
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  const drain = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        notify();
      }
    } catch {
      // aborted
    }
  })();

  const waitFor = async (needle: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${needle}`);
      await Promise.race([
        new Promise<void>((r) => waiters.push(r)),
        new Promise<void>((r) => setTimeout(r, remaining)),
      ]);
    }
  };

  return { drain, waitFor, text: () => buffer };
}

describe("GET /api/events (SSE)", () => {
  it("streams a change event when a watched file changes", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const stream = readStream(res);
    try {
      // server signals when its watcher is armed — then trigger a change
      await stream.waitFor("event: watching", 5000);
      await fs.writeFile(
        path.join(root, "jobs", "queue", "sse-test-job.md"),
        "---\nurl: https://sse.test/job\ncompany: SSE\n---\n",
      );
      await stream.waitFor("sse-test-job.md", 5000);
    } finally {
      controller.abort();
      await stream.drain.catch(() => {});
    }

    const buffer = stream.text();
    // AC #5: the two named events the contract already shipped are still emitted.
    expect(buffer).toContain("event: connected\ndata: {}\n\n");
    expect(buffer).toContain("event: watching\ndata: {}\n\n");

    const m = buffer.match(/data: (\{[^}]*"file"[^}]*\})/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m![1]).file).toContain("sse-test-job.md");
  }, 15_000);
});

describe("GET /api/events heartbeat", () => {
  it("still ships the 25s interval the SSE contract froze", () => {
    expect(HEARTBEAT_MS).toBe(25_000);
  });

  it("emits an observable named ping alongside the unchanged : ping comment", async () => {
    // 25s exceeds this suite's 15s budget, so the interval is injected; 150ms
    // lands two beats well inside it. Its own server: the shared one in
    // beforeAll must keep the shipped interval.
    const hbApp = createApp(root, { security: { enabled: false }, heartbeatMs: 150 });
    const hbServer = await new Promise<Server>((resolve) => {
      const s = hbApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = hbServer.address() as AddressInfo;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      const stream = readStream(res);
      try {
        // ": ping\n\n" and not ": ping" — "event: ping" contains ": ping".
        await stream.waitFor(": ping\n\n", 5000);
        await stream.waitFor("event: ping\ndata: {}\n\n", 5000);
      } finally {
        controller.abort();
        await stream.drain.catch(() => {});
      }
      const buffer = stream.text();
      expect(buffer).toContain(": ping\n\n"); // AC #5: comment preserved byte-for-byte
      expect(buffer).toContain("event: ping\ndata: {}\n\n"); // D2: additive named frame
      expect(buffer).toContain("event: connected\ndata: {}\n\n");
    } finally {
      await new Promise((resolve) => hbServer.close(resolve));
    }
  }, 15_000);
});

/**
 * AC #5 freezes the debounced change events, and Task 1 edits the very function
 * that implements them. The pre-existing test proves one write eventually yields
 * one frame — which a completely undebounced server would also pass. Nothing
 * covered the COALESCING until now.
 */
describe("GET /api/events debounce (AC #5)", () => {
  it("coalesces rapid writes to one path into a single change frame", async () => {
    // The shipped 250ms window is shorter than the jitter between two fsevents
    // notifications for one write, so asserting coalescing against it would be a
    // filesystem-timing race. At 1500ms "all three writes fall in one window" is
    // a fact about the test, not a hope about the OS.
    const dbApp = createApp(root, { security: { enabled: false }, debounceMs: 1500 });
    const dbServer = await new Promise<Server>((resolve) => {
      const s = dbApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = dbServer.address() as AddressInfo;
    const controller = new AbortController();
    const file = path.join(root, "jobs", "queue", "debounce-test-job.md");

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
      });
      const stream = readStream(res);
      try {
        await stream.waitFor("event: watching", 5000);
        await fs.writeFile(file, "---\ncompany: A\n---\n");
        await fs.writeFile(file, "---\ncompany: B\n---\n");
        await fs.writeFile(file, "---\ncompany: C\n---\n");
        await stream.waitFor("debounce-test-job.md", 8000);
        // Let a second full window elapse. If the writes were NOT coalesced, the
        // trailing frames land here and the count below goes above one.
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        controller.abort();
        await stream.drain.catch(() => {});
      }
      const frames = stream.text().match(/debounce-test-job\.md/g) ?? [];
      expect(frames).toHaveLength(1);
    } finally {
      await new Promise((resolve) => dbServer.close(resolve));
    }
  }, 20_000);
});

/**
 * PASSWORD INVARIANTS — the file whose whole subject is this claim.
 *
 * The claim is "no ROUTE returns a password", not "no GET returns a password",
 * and it is only real if the mutation routes are asserted too: the accounts
 * writer hands back a RawCredentialEntry, which CAN carry one, and POST/PATCH/
 * DELETE are password-free only because the route maps it through toAtsAccount
 * first. So this block covers every GET, both mutation directions, and the SSE
 * stream.
 *
 * THE SINGLE DELIBERATE EXCEPTION IS `POST /api/accounts/:host/reveal`
 * (Decision 1). It answers one explicit user action for one account, uncached,
 * never streamed, never logged, and its body has exactly one key. That carve-out
 * is written down here as a named exception so widening it — or adding a second
 * leaking route — requires editing the test that forbids it. The same
 * assertions live in accounts.test.ts (7.26, 7.27): that file proves the routes
 * behave, this one is the file the invariant belongs to, and someone widening
 * the carve-out has to edit both.
 *
 * Hand-maintained per route rather than reflected off the router stack: a stack
 * walk that invented request bodies would be fragile and would silently skip
 * every route it could not construct a call for.
 *
 * THE THREE PROFILE ROUTES ARE HERE AS A STANDING INVARIANT, NOT A FORMALITY.
 * /api/profile, /api/resumes and /api/addresses read profile.md, templates/,
 * resumes/ (names and stat only) and state.json.addresses, and never open
 * credentials.json at all — so a future edit that joins account data into a
 * profile view (an "which ATS account did this resume go to" panel, say) fails
 * here rather than shipping. Their presence also pins the 200: every read route
 * must answer for a workspace with no profile.md rather than throwing.
 */
describe("password invariants", () => {
  const ACME_HOST = "acme.wd5.myworkdayjobs.com";

  function assertNoPassword(text: string, label: string) {
    expect(text, `${label} leaked the sentinel`).not.toContain(SENTINEL_PASSWORD);
    expect(text, `${label} leaked the second password`).not.toContain("hunter2");
    expect(text, `${label} carries a "password" key`).not.toContain('"password"');
  }

  it("no GET route carries a password value or the password key", async () => {
    const routes = [
      "/api/overview",
      "/api/applications",
      "/api/applications/acme-engineering-manager",
      "/api/queue",
      "/api/accounts",
      `/api/accounts/${encodeURIComponent(ACME_HOST)}`,
      "/api/runs/current",
      "/api/profile",
      "/api/resumes",
      "/api/addresses",
    ];
    for (const route of routes) {
      const res = await fetch(`${base}${route}`);
      expect({ route, status: res.status }).toEqual({ route, status: 200 });
      assertNoPassword(await res.text(), `GET ${route}`);
    }
  });

  it("reveal is the one route that returns a password, and it returns nothing else", async () => {
    const res = await fetch(`${base}/api/accounts/${encodeURIComponent(ACME_HOST)}/reveal`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    // EXACTLY one key, so widening the route fails here.
    expect(Object.keys(body)).toEqual(["password"]);
    expect(body.password).toBe(SENTINEL_PASSWORD);
  });

  it("no mutation route carries a password value or the password key", async () => {
    // Its OWN fixture: these three requests write, and the suite's shared
    // workspace backs the overview counts and the SSE tests above it.
    const mutRoot = await makeFixtureWorkspace();
    const mutApp = createApp(mutRoot, { security: { enabled: false } });
    const mutServer = await new Promise<Server>((resolve) => {
      const s = mutApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = mutServer.address() as AddressInfo;
    const mutBase = `http://127.0.0.1:${port}`;
    try {
      const created = await fetch(`${mutBase}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "invariant.example.com",
          username: "u",
          password: "leak-me-on-create",
        }),
      });
      expect(created.status).toBe(201);
      const createdText = await created.text();
      expect(createdText).not.toContain("leak-me-on-create");
      assertNoPassword(createdText, "POST /api/accounts");

      const patched = await fetch(`${mutBase}/api/accounts/invariant.example.com`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "leak-me-on-patch" }),
      });
      expect(patched.status).toBe(200);
      const patchedText = await patched.text();
      expect(patchedText).not.toContain("leak-me-on-patch");
      assertNoPassword(patchedText, "PATCH /api/accounts/:host");

      const removed = await fetch(
        `${mutBase}/api/accounts/${encodeURIComponent(ACME_HOST)}`,
        { method: "DELETE" },
      );
      expect(removed.status).toBe(200);
      const removedText = await removed.text();
      // DELETE is the likeliest leak: the writer captures the raw entry BEFORE
      // removing it and hands it back.
      expect(JSON.parse(removedText).account.hasPassword).toBe(true);
      assertNoPassword(removedText, "DELETE /api/accounts/:host");
    } finally {
      await new Promise((resolve) => mutServer.close(resolve));
      await rmFixtureWorkspace(mutRoot);
    }
  }, 20_000);

  it("a credentials.json change reaches /api/events with no password in the frames", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    const stream = readStream(res);
    try {
      await stream.waitFor("event: watching", 5000);
      const file = path.join(root, "credentials.json");
      const creds = JSON.parse(await fs.readFile(file, "utf-8"));
      creds["sse-probe.example.com"] = {
        username: "sse-probe",
        password: SENTINEL_PASSWORD,
        ats: "other",
        company: "SSE Probe",
      };
      await fs.writeFile(file, JSON.stringify(creds, null, 2));
      await stream.waitFor("credentials.json", 8000);
    } finally {
      controller.abort();
      await stream.drain.catch(() => {});
    }
    assertNoPassword(stream.text(), "GET /api/events");
  }, 20_000);
});
