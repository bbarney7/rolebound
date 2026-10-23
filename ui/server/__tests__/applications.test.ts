import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { createApp } from "../app";
import { getApplication } from "../union";

/**
 * The suite's ONLY mock, and it defaults to the real implementation. The
 * post-write 404 rollback in routes/applications.ts can only be reached by
 * making the row vanish BETWEEN the write and the re-read, which no fixture
 * arrangement can do — the two reads happen inside one request.
 */
vi.mock("../union", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../union")>();
  return { ...actual, getApplication: vi.fn(actual.getApplication) };
});

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

function patch(slug: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/applications/${slug}/pipeline`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readUiStateFile(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, "ui", "ui-state.json"), "utf-8"));
}

describe("GET /api/applications", () => {
  it("returns every union row", async () => {
    const res = await fetch(`${base}/api/applications`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // same invariant union.test.ts pins: 2 tracked + 3 md-only
    expect(body).toHaveLength(5);
    expect(body.map((a: any) => a.slug)).toContain("acme-engineering-manager");
  });

  it("never leaks passwords", async () => {
    const res = await fetch(`${base}/api/applications`);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

describe("GET /api/applications/:slug", () => {
  it("returns the detail payload with the joined ATS account", async () => {
    const res = await fetch(`${base}/api/applications/acme-engineering-manager`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.application.slug).toBe("acme-engineering-manager");
    // uncapped md body, not descriptionExcerpt
    expect(body.body).toContain("Lead the platform team");
    // the app URL host is boards.greenhouse.io and the account host is
    // acme.wd5.myworkdayjobs.com, so this join lands via the company fallback
    expect(body.atsAccount.host).toBe("acme.wd5.myworkdayjobs.com");
    expect(body.atsAccount.hasPassword).toBe(true);
  });

  it("returns nulls for a row with no md file and no account match", async () => {
    const res = await fetch(`${base}/api/applications/inprogress-director`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.body).toBeNull();
    expect(body.bodySource).toBeNull();
    expect(body.ats).toBeNull();
    expect(body.reqId).toBeNull();
    expect(body.atsAccount).toBeNull();
    expect(body.pipelineUpdatedAt).toBeNull();
  });

  it("reports bodySource 'applied' when the applied md exists", async () => {
    const res = await fetch(`${base}/api/applications/acme-engineering-manager`);
    const body = await res.json();
    expect(body.bodySource).toBe("applied");
  });

  // The applier only moves a posting into jobs/applied/ on submit, so a row that
  // is still in_progress/blocked/aborted keeps its JD in jobs/queue/. Reading only
  // `applied` reported "no job description was saved" while the file sat one
  // directory away. One live row (gitlab-…-non-linear-productivity, in_progress)
  // was in exactly this state.
  it("falls back to the queue md for a row that was never submitted", async () => {
    await fs.writeFile(
      path.join(root, "jobs", "queue", "inprogress-director.md"),
      `---\nslug: inprogress-director\ncompany: InProgressCo\n---\n\nATS: Workday\nReq ID: REQ-42\n\nQueued posting body.\n`,
    );
    try {
      const res = await fetch(`${base}/api/applications/inprogress-director`);
      const body = await res.json();
      expect(body.body).toContain("Queued posting body.");
      expect(body.bodySource).toBe("queue");
      expect(body.ats).toBe("Workday");
      expect(body.reqId).toBe("REQ-42");
    } finally {
      await fs.rm(path.join(root, "jobs", "queue", "inprogress-director.md"), { force: true });
    }
  });

  /**
   * Temporarily set a queue_file on the fixture's inprogress-director row.
   * Patching state.json in-test rather than in helpers.ts keeps the shared
   * fixture — and readers.test.ts:23 / union.test.ts:20, which count its
   * entries — untouched.
   */
  async function withQueueFile(value: string, fn: () => Promise<void>) {
    const statePath = path.join(root, "state.json");
    const original = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(original);
    parsed.applications.find((a: any) => a.slug === "inprogress-director").queue_file = value;
    await fs.writeFile(statePath, JSON.stringify(parsed, null, 2));
    try {
      await fn();
    } finally {
      await fs.writeFile(statePath, original);
    }
  }

  // The applier does not always name the queue file after the slug — live
  // state.json has `jobs/queue/0-hackerone-…-austin.md`. Deriving the path from
  // the slug alone would miss the saved posting entirely.
  it("uses the recorded queue_file path when it is not the slug-derived name", async () => {
    const prefixed = path.join(root, "jobs", "queue", "0-inprogress-director.md");
    await fs.writeFile(prefixed, `---\nslug: inprogress-director\n---\n\nPrefixed queue body.\n`);
    try {
      await withQueueFile("jobs/queue/0-inprogress-director.md", async () => {
        const res = await fetch(`${base}/api/applications/inprogress-director`);
        const body = await res.json();
        expect(body.body).toContain("Prefixed queue body.");
        expect(body.bodySource).toBe("queue");
      });
    } finally {
      await fs.rm(prefixed, { force: true });
    }
  });

  // The applier repoints queue_file at jobs/applied/ on submit, and the name
  // there is not always the slug. Labelling that "queue" because it was found
  // via the recorded-path lookup would tell the user a submitted application
  // was never sent — bodySource must name the real directory.
  it("labels a recorded jobs/applied path as 'applied', not 'queue'", async () => {
    const odd = path.join(root, "jobs", "applied", "0-inprogress-director.md");
    await fs.writeFile(odd, `---\nslug: inprogress-director\n---\n\nSubmitted copy.\n`);
    try {
      await withQueueFile("jobs/applied/0-inprogress-director.md", async () => {
        const res = await fetch(`${base}/api/applications/inprogress-director`);
        const body = await res.json();
        expect(body.body).toContain("Submitted copy.");
        expect(body.bodySource).toBe("applied");
      });
    } finally {
      await fs.rm(odd, { force: true });
    }
  });

  /**
   * TEETH: the dir allowlist is the one clause of parseRecordedJobFile that can
   * be proven behaviourally, because it is the only one that changes whether an
   * EXISTING file gets read. Without `JOB_DIRS`, this file is served; with it,
   * the value is rejected and body stays null. Negative control confirmed:
   * deleting the allowlist check fails this test.
   */
  it("will not read a file from a jobs/ subdirectory outside the allowlist", async () => {
    const secretDir = path.join(root, "jobs", "secrets");
    await fs.mkdir(secretDir, { recursive: true });
    await fs.writeFile(path.join(secretDir, "leak.md"), `---\nslug: leak\n---\n\nLEAKED BODY.\n`);
    try {
      await withQueueFile("jobs/secrets/leak.md", async () => {
        const res = await fetch(`${base}/api/applications/inprogress-director`);
        const body = await res.json();
        expect(body.body).toBeNull();
        expect(body.bodySource).toBeNull();
      });
    } finally {
      await fs.rm(secretDir, { recursive: true, force: true });
    }
  });

  /**
   * These assert the OUTCOME (a malformed queue_file is ignored), not which
   * clause rejected it. Stated plainly rather than dressed up: negative controls
   * showed that removing the `jobs/` prefix check or the slug `..` clause fails
   * none of them, because `paths.jobFile` confines every lookup to
   * `<root>/jobs/<dir>/<slug>.md` anyway and a nonexistent file already yields
   * null. Those two clauses are defense-in-depth against a future caller that
   * joins the value differently — the same honest position the plan takes on
   * isSafeSlug's `..` clause. Keep them; do not claim they are proven.
   */
  it.each([
    ["../../../etc/passwd", "wrong segment count"],
    ["jobs/../state.json", "dir outside the allowlist"],
    ["jobs/secrets/x.md", "unknown dir"],
    ["notjobs/queue/x.md", "not rooted at jobs/"],
    ["jobs/queue/...md", "slug containing .."],
    ["jobs/queue/x.txt", "not a .md file"],
    ["/etc/passwd", "absolute path"],
  ])("ignores an unsafe queue_file (%s — %s)", async (value) => {
    await withQueueFile(value, async () => {
      const res = await fetch(`${base}/api/applications/inprogress-director`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.body).toBeNull();
      expect(body.bodySource).toBeNull();
    });
  });

  it("prefers the applied md over the queue md when both exist", async () => {
    await fs.writeFile(
      path.join(root, "jobs", "queue", "acme-engineering-manager.md"),
      `---\nslug: acme-engineering-manager\n---\n\nSTALE QUEUE COPY.\n`,
    );
    try {
      const res = await fetch(`${base}/api/applications/acme-engineering-manager`);
      const body = await res.json();
      expect(body.body).toContain("Lead the platform team");
      expect(body.body).not.toContain("STALE QUEUE COPY");
      expect(body.bodySource).toBe("applied");
    } finally {
      await fs.rm(path.join(root, "jobs", "queue", "acme-engineering-manager.md"), { force: true });
    }
  });

  it("never leaks passwords on the account-joining route", async () => {
    const res = await fetch(`${base}/api/applications/acme-engineering-manager`);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });

  it("404s an unknown slug", async () => {
    const res = await fetch(`${base}/api/applications/no-such-slug`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("application not found");
  });

  it("rejects percent-encoded traversal before any filesystem call", async () => {
    // undici leaves %2f untouched, so the server routes this as ONE segment and
    // Express decodes req.params.slug to "../../../etc/passwd" — the guard is
    // the only thing standing between that and paths.jobFile().
    const res = await fetch(`${base}/api/applications/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid slug");
  });

  it("rejects the fully percent-encoded dot form", async () => {
    const res = await fetch(`${base}/api/applications/%2e%2e%2f%2e%2e%2fstate`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid slug");
  });

  it("rejects a slug with characters outside the allowlist", async () => {
    const res = await fetch(`${base}/api/applications/acme%20manager`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid slug");
  });

  it("serves a contained screenshot for a submitted application", async () => {
    await fs.writeFile(path.join(root, "screenshots", "acme-engineering-manager-confirmation.png"), "pngbytes");
    const res = await fetch(`${base}/api/applications/acme-engineering-manager/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'none'/);
  });

  it("serves safe SVG evidence with CSP and rejects active content", async () => {
    const slug = "svg-safe-app";
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    state.applications.push({
      slug,
      status: "submitted",
      screenshot: "screenshots/svg-safe-app-confirmation.svg",
      company: "SvgCo",
      title: "Svg Role",
    });
    await fs.writeFile(path.join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    await fs.writeFile(
      path.join(root, "screenshots", "svg-safe-app-confirmation.svg"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>ok</text></svg>",
    );
    const safe = await fetch(`${base}/api/applications/${slug}/screenshot`);
    expect(safe.status).toBe(200);
    expect(safe.headers.get("content-type")).toMatch(/svg/);
    expect(safe.headers.get("content-security-policy")).toMatch(/script-src 'none'/);

    await fs.writeFile(
      path.join(root, "screenshots", "svg-safe-app-confirmation.svg"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    );
    expect((await fetch(`${base}/api/applications/${slug}/screenshot`)).status).toBe(404);
  });

  it("rejects screenshot traversal and symlink escapes", async () => {
    const outside = path.join(root, "outside.png");
    await fs.writeFile(outside, "png");
    await fs.symlink(outside, path.join(root, "screenshots", "escape.png"));
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    state.applications.push({
      slug: "escape-app",
      status: "submitted",
      screenshot: "screenshots/escape.png",
      company: "Escape",
      title: "Escape",
    });
    await fs.writeFile(path.join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    expect((await fetch(`${base}/api/applications/escape-app/screenshot`)).status).toBe(404);
    expect((await fetch(`${base}/api/applications/..%2f..%2foutside.png/screenshot`)).status).toBe(400);
  });
});

describe("PATCH /api/applications/:slug/pipeline", () => {
  it("persists an explicit status to ui-state.json", async () => {
    const res = await patch("acme-engineering-manager", { pipelineStatus: "interviewing" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.application.pipelineStatus).toBe("interviewing");
    expect(body.application.pipelineExplicit).toBe(true);
    expect(body.pipelineUpdatedAt).toBeTruthy();

    // Backstop for the async-mutator footgun: an async mutator type-checks and
    // then lands after fs.rename, so the response would look right while the
    // file stayed empty. Assert the FILE, not just the response.
    const onDisk = await readUiStateFile();
    expect(onDisk.applications["acme-engineering-manager"].pipelineStatus).toBe("interviewing");
  });

  it("survives a fresh app instance on the same workspace", async () => {
    const second = createApp(root, { security: { enabled: false } });
    const s2 = await new Promise<Server>((resolve) => {
      const sv = second.listen(0, "127.0.0.1", () => resolve(sv));
    });
    const { port } = s2.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/applications/acme-engineering-manager`);
    const body = await res.json();
    expect(body.application.pipelineStatus).toBe("interviewing");
    await new Promise((resolve) => s2.close(resolve));
  });

  it("clearing reverts to the DERIVED value and deletes the entry", async () => {
    const res = await patch("acme-engineering-manager", { pipelineStatus: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    // not null — acme is applyState "submitted", so union.ts:57 re-derives it
    expect(body.application.pipelineStatus).toBe("submitted");
    expect(body.application.pipelineExplicit).toBe(false);
    expect(body.pipelineUpdatedAt).toBeNull();
    const onDisk = await readUiStateFile();
    expect(onDisk.applications["acme-engineering-manager"]).toBeUndefined();
  });

  it("clearing a non-submitted row reverts to null, not a tombstone", async () => {
    await patch("inprogress-director", { pipelineStatus: "offer" });
    const res = await patch("inprogress-director", { pipelineStatus: null });
    const body = await res.json();
    expect(body.application.pipelineStatus).toBeNull();
    const onDisk = await readUiStateFile();
    expect(onDisk.applications["inprogress-director"]).toBeUndefined();
  });

  it("leaves userNotes untouched on a status-only PATCH, clears it on explicit null (D14)", async () => {
    await patch("acme-engineering-manager", {
      pipelineStatus: "offer",
      userNotes: "verbal offer",
    });
    let body = await (await fetch(`${base}/api/applications/acme-engineering-manager`)).json();
    expect(body.application.userNotes).toBe("verbal offer");

    // D14 — absent means untouched. This is what makes the shipped status
    // editor (which sends only pipelineStatus) safe: without presence-based
    // dispatch this assertion reads null and every status save destroys the note.
    await patch("acme-engineering-manager", { pipelineStatus: "rejected" });
    body = await (await fetch(`${base}/api/applications/acme-engineering-manager`)).json();
    expect(body.application.userNotes).toBe("verbal offer");
    expect(body.application.pipelineStatus).toBe("rejected");

    // ...and the symmetric case: a notes-only PATCH must not disturb the status.
    await patch("acme-engineering-manager", { userNotes: "recruiter call 7/29" });
    body = await (await fetch(`${base}/api/applications/acme-engineering-manager`)).json();
    expect(body.application.pipelineStatus).toBe("rejected");
    expect(body.application.userNotes).toBe("recruiter call 7/29");

    // Explicit null is the documented way to clear.
    await patch("acme-engineering-manager", { userNotes: null });
    body = await (await fetch(`${base}/api/applications/acme-engineering-manager`)).json();
    expect(body.application.userNotes).toBeNull();
    await patch("acme-engineering-manager", { pipelineStatus: null });
  });

  it("400s an invalid status", async () => {
    const res = await patch("acme-engineering-manager", { pipelineStatus: "not-a-status" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid pipelineStatus");
    await expect(readUiStateFile()).resolves.toBeTruthy();
  });

  it("404s an unknown slug", async () => {
    const res = await patch("no-such-slug", { pipelineStatus: "offer" });
    expect(res.status).toBe(404);
  });

  it("rejects traversal on the PATCH route too", async () => {
    const res = await patch("..%2f..%2fstate", { pipelineStatus: "offer" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid slug");
  });

  it("never leaks passwords in the PATCH response", async () => {
    const res = await patch("acme-engineering-manager", { pipelineStatus: "rejected" });
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
    await patch("acme-engineering-manager", { pipelineStatus: null });
  });

  it("rolls the ui-state entry back when the row vanishes mid-request", async () => {
    const real = await getApplication(root, "acme-engineering-manager");
    // Exactly two calls per request: the pre-write existence check, then the
    // post-write re-read. Once-scoped so the surrounding tests keep the real impl.
    vi.mocked(getApplication).mockResolvedValueOnce(real).mockResolvedValueOnce(null);
    const res = await patch("acme-engineering-manager", { pipelineStatus: "offer" });
    expect(res.status).toBe(404);
    const onDisk = await readUiStateFile();
    expect(onDisk.applications["acme-engineering-manager"]).toBeUndefined();
  });
});
