import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import matter from "gray-matter";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { createApp } from "../app";
import { readJobFile } from "../readers/jobFiles";
import { createQueueFile } from "../queueWriter";

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

function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function queuePath(slug: string): string {
  return path.join(root, "jobs", "queue", `${slug}.md`);
}

async function queueFilenames(): Promise<string[]> {
  return (await fs.readdir(path.join(root, "jobs", "queue"))).filter((f) => f.endsWith(".md"));
}

/** Remove any file this test created, whether or not the assertion passed. */
async function cleanupQueue(...slugs: string[]): Promise<void> {
  for (const slug of slugs) await fs.rm(queuePath(slug), { force: true });
}

const VALID_BODY = {
  url: "https://acme.example/jobs/777",
  company: "Acme Robotics",
  title: "Engineering Manager, Platform",
  location: "Seattle, WA",
};

describe("GET /api/queue", () => {
  it("returns the queue with positions and the AC1 fields", async () => {
    const res = await fetch(`${base}/api/queue`);
    expect(res.ok).toBe(true);
    const queue = await res.json();
    expect(queue.map((q: any) => q.slug)).toEqual(["alpha-ai-director", "zeta-platform-em"]);
    expect(queue.map((q: any) => q.position)).toEqual([0, 1]);
    expect(queue[0].url).toBe("https://alpha.wd5.myworkdayjobs.com/job/2");
    expect(queue[0].company).toBe("Alpha");
    expect(queue[0].title).toBe("AI Director");
    expect(queue[0].ats).toBe("workday");
    expect(queue[0].llmScore).toBe(4);
    expect(Number.isNaN(Date.parse(queue[0].queuedAt))).toBe(false);
    // Workspace-relative, never the absolute path. The second assertion is the
    // teeth: `root` is an absolute mkdtemp path, so a regression to the
    // reader's absolute filePath fails here loudly.
    expect(queue[0].filePath).toBe("jobs/queue/alpha-ai-director.md");
    expect(queue[0].filePath).not.toContain(root);
  });

  /**
   * TEETH for the whole AC4 claim. "-" is 0x2D and "." is 0x2E, so
   * acme-engineer-finops.md sorts BEFORE acme-engineer.md as a filename and
   * AFTER it as a bare slug. 195 of 195 such pairs across the 1008 live slugs
   * disagree, but the three live queue files contain none — so this
   * constructed pair is the only thing that can prove the fix. The expected
   * order is derived at run time from the applier's own expression rather than
   * hardcoded. Negative control: dropping listQueue's re-sort fails this.
   */
  it("orders identically to the applier's readdir().filter().sort()", async () => {
    await fs.writeFile(
      queuePath("acme-engineer"),
      "---\nurl: https://acme.example/1\ncompany: Acme\ntitle: Engineer\nlocation: Remote\n---\n",
    );
    await fs.writeFile(
      queuePath("acme-engineer-finops"),
      "---\nurl: https://acme.example/2\ncompany: Acme\ntitle: Engineer, FinOps\nlocation: Remote\n---\n",
    );
    try {
      const applierOrder = (await queueFilenames()).sort().map((f) => f.replace(/\.md$/, ""));
      const queue = await (await fetch(`${base}/api/queue`)).json();
      expect(queue.map((q: any) => q.slug)).toEqual(applierOrder);
      expect(queue.map((q: any) => q.position)).toEqual(applierOrder.map((_, i) => i));
      const acme = queue
        .map((q: any) => q.slug)
        .filter((s: string) => s.startsWith("acme-engineer"));
      expect(acme).toEqual(["acme-engineer-finops", "acme-engineer"]);
    } finally {
      await cleanupQueue("acme-engineer", "acme-engineer-finops");
    }
  });

  /**
   * jobs/queue/render-engineering-manager-platform.md is invalid YAML in the
   * LIVE workspace right now — `location: Remote: United States`, an unquoted
   * colon. gray-matter throws on the whole file; only the tolerant line parser
   * can serve it. If this ever regresses, a real pending job disappears from
   * the UI.
   */
  it("serves a file whose frontmatter is invalid YAML", async () => {
    await fs.writeFile(
      queuePath("render-em-platform"),
      "---\nurl: https://jobs.ashbyhq.com/render/abc\ncompany: Render\ntitle: Engineering Manager, Platform \nlocation: Remote: United States\nsource: ashby\n---\nATS: ashby\n",
    );
    try {
      // `{}` opts out of gray-matter's input-string memo. It caches BEFORE it
      // parses (index.js:35-47), so a throwing parse leaves an entry whose
      // `data` is {} and every later call on the same string returns that
      // instead of throwing. Without the second argument this assertion is
      // order-dependent, and worse, it would poison the cache for the reader.
      expect(() => matter(`---\nlocation: Remote: United States\n---\n`, {})).toThrow();
      const queue = await (await fetch(`${base}/api/queue`)).json();
      const row = queue.find((q: any) => q.slug === "render-em-platform");
      expect(row).toBeTruthy();
      expect(row.company).toBe("Render");
      expect(row.location).toBe("Remote: United States");
      expect(row.location).not.toContain('"');
      expect(row.ats).toBe("ashby");
    } finally {
      await cleanupQueue("render-em-platform");
    }
  });

  it("renders a 0-prefixed queue file, first, exactly as the applier sees it", async () => {
    await fs.writeFile(
      queuePath("0-urgent-role"),
      "---\nurl: https://urgent.example/1\ncompany: Urgent\ntitle: Director\nlocation: Remote\n---\n",
    );
    try {
      const queue = await (await fetch(`${base}/api/queue`)).json();
      expect(queue[0].slug).toBe("0-urgent-role");
      expect(queue[0].position).toBe(0);
    } finally {
      await cleanupQueue("0-urgent-role");
    }
  });

  it("never leaks passwords", async () => {
    const text = await (await fetch(`${base}/api/queue`)).text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

describe("POST /api/queue", () => {
  it("writes the gatherer's exact byte shape and returns 201 with the re-listed queue", async () => {
    try {
      const res = await post("/api/queue", { ...VALID_BODY, source: "linkedin" });
      expect(res.status).toBe(201);
      const result = await res.json();
      const slug = result.item.slug;
      // Verified by running deriveSlug directly before this assertion was
      // written, per the plan's OPEN QUESTION.
      expect(slug).toBe("acme-robotics-engineering-manager-platform");

      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toBe(
        "---\n" +
          "url: https://acme.example/jobs/777\n" +
          "company: Acme Robotics\n" +
          "title: Engineering Manager, Platform\n" +
          "location: Seattle, WA\n" +
          "source: linkedin\n" +
          "---\n",
      );
      // exactly one trailing LF, and no blank line after the closing ---
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.endsWith("\n\n")).toBe(false);
      expect(raw).not.toContain("---\n\n");

      // the response carries the re-derived queue, not the request body
      expect(result.queue.some((q: any) => q.slug === slug)).toBe(true);
      expect(result.item.position).toBe(result.queue.findIndex((q: any) => q.slug === slug));
      expect(result.warning).toBeNull();
    } finally {
      await cleanupQueue("acme-robotics-engineering-manager-platform");
    }
  });

  /**
   * The round trip that is actually GUARANTEED (D19's AMENDED block). The old
   * version of this test asserted on `matter(raw)` directly — a claim the plan
   * withdrew, because a value with an unquoted colon makes the whole file
   * strict-invalid by design, and 9 live files are already in that state.
   *
   * What holds for EVERY accepted value is the tolerant round trip:
   * readJobFile runs matter() first and falls back to the line parser on
   * throw (jobFiles.ts:89-97), which is the exact code path the API serves
   * from. That is the guarantee, and it is the one worth testing.
   */
  it("round-trips through the tolerant parser, which is the path the API serves", async () => {
    const slug = "roundtrip-role";
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug, ats: "greenhouse" });
      expect(res.status).toBe(201);

      const record = await readJobFile(root, "queue", slug);
      expect(record!.url).toBe(VALID_BODY.url);
      expect(record!.company).toBe(VALID_BODY.company);
      expect(record!.title).toBe(VALID_BODY.title);
      expect(record!.location).toBe(VALID_BODY.location);
      expect(record!.ats).toBe("greenhouse");

      // ...and the same values come back over the wire, which is what the
      // user actually sees.
      const queue = await (await fetch(`${base}/api/queue`)).json();
      const row = queue.find((q: any) => q.slug === slug);
      expect(row.company).toBe(VALID_BODY.company);
      expect(row.title).toBe(VALID_BODY.title);
      expect(row.location).toBe(VALID_BODY.location);
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * TEETH for D19's BEHAVIOURAL validator. Every value below passes the
   * newline/control-character check and is then SILENTLY REINTERPRETED by
   * gray-matter — measured in-session against the pinned 4.0.3. The
   * `#`-comment case is the serious one: a company literally named
   * `Acme # 1 Robotics` would be written correctly to disk and read back as
   * `Acme` by any strict consumer, with no error anywhere.
   *
   * Fourteen cases, and the reason there are fourteen rather than a
   * hand-written token list is that every token list attempted in this plan
   * was wrong in BOTH directions — see the acceptance table below, which
   * contains five values a token list rejected and that are in fact fine.
   *
   * Negative control: delete the `isSafeFrontmatterValue` call from
   * checkFrontmatterValue and every one of these fourteen returns 201.
   */
  it.each([
    "Acme # 1 Robotics", // everything from `#` onward is destroyed
    "true", // becomes a boolean
    "12345", // becomes a number
    "null", // the value is destroyed
    "[]", // becomes an array
    "{}", // becomes an object
    "0x10", // becomes 16
    "0123", // becomes 83 — octal
    "+12", // becomes 12
    "1_000", // becomes 1000
    "2026-08-05", // becomes a Date
    '"quoted"', // quotes stripped
    "~", // becomes null
    "&ref", // becomes null (YAML anchor)
  ])(
    "400s a company gray-matter would reinterpret (%s), without touching the filesystem",
    async (company) => {
      const before = (await queueFilenames()).sort();
      const res = await post("/api/queue", {
        ...VALID_BODY,
        slug: "reinterpret-probe",
        company,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("would be reinterpreted");
      expect((await queueFilenames()).sort()).toEqual(before);
    },
  );

  /**
   * The other direction, and the reason the validator is behavioural rather
   * than a token list. Four of these — `yes`, `no`, `on`, `off` — and
   * `-37signals` were REJECTED by the token list this replaced, and all five
   * are plain strings to gray-matter 4.0.3. Rejecting a real company name is
   * as much a bug as accepting a destroyed one.
   *
   * Each case asserts three things: 201, the value written UNQUOTED into the
   * bytes, and the value read back identically through the tolerant path.
   */
  it.each([
    "37signals",
    "Senior Engineer?",
    "O'Reilly",
    "VP — Platform",
    "San Francisco, CA",
    "C++ Engineer",
    "Data & AI",
    "yes",
    "no",
    "on",
    "off",
    "-37signals",
  ])("201s a company that stays a string (%s), unquoted and identical on read-back", async (company) => {
    const slug = "accept-probe";
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug, company });
      expect(res.status).toBe(201);

      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toContain(`company: ${company}\n`);
      expect(raw).not.toContain(`company: "`);
      expect(raw).not.toContain("company: '");

      const record = await readJobFile(root, "queue", slug);
      expect(record!.company).toBe(company);
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * The one value that trims rather than reinterprets. gray-matter strips
   * trailing whitespace from a plain scalar, so probing the RAW string would
   * 400 this — and this exact shape is live in the workspace right now
   * (`title: Senior Engineering Manager, Wikimedia Enterprise ` in
   * jobs/queue/wikimedia-wikimedia-enterprise.md:4). The probe runs on
   * value.trim() precisely so that this is a 201.
   *
   * Negative control: change `isSafeFrontmatterValue(value.trim())` to
   * `isSafeFrontmatterValue(value)` and this test returns 400.
   */
  it("201s a title with trailing whitespace, and writes it trimmed", async () => {
    const slug = "trailing-space-role";
    try {
      const res = await post("/api/queue", {
        ...VALID_BODY,
        slug,
        title: "Engineering Manager, Platform ",
      });
      expect(res.status).toBe(201);
      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toContain("title: Engineering Manager, Platform\n");
      expect(raw).not.toContain("title: Engineering Manager, Platform \n");
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * A blank optional field is ABSENT, not a value. `{ source: "" }` is what an
   * untouched optional <input> actually submits, and probing "" serializes
   * `k: `, which matter() reads back as null rather than a string — so without
   * the blank-skip in the route's optional loop the very first real form
   * submission 400s.
   *
   * Negative control: delete the `supplied.trim() === ""` skip in the route's
   * optional loop and this test fails with a 400 naming `source`.
   */
  it("201s blank optional fields and writes no line for any of them", async () => {
    const slug = "blank-optionals";
    try {
      const res = await post("/api/queue", {
        ...VALID_BODY,
        slug,
        source: "",
        resumeKey: "   ",
        addressCityKey: "",
        ats: "\t",
      });
      expect(res.status).toBe(201);
      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).not.toContain("source:");
      expect(raw).not.toContain("resume_key:");
      expect(raw).not.toContain("address_city_key:");
      expect(raw).not.toContain("ATS:");
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * createQueueFile is a real last line of defence, not one that only works
   * when the router pre-cleans. Called DIRECTLY with untrimmed input it must
   * still normalize, so that the value the probe validated and the value the
   * serializer emits are the same string.
   */
  it("normalizes untrimmed input when createQueueFile is called directly", async () => {
    const slug = "direct-writer";
    try {
      const result = await createQueueFile(root, {
        url: VALID_BODY.url,
        company: "Acme  ",
        title: VALID_BODY.title,
        location: VALID_BODY.location,
        source: "  ",
        slug,
      });
      expect(result.ok).toBe(true);
      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toContain("company: Acme\n");
      expect(raw).not.toContain("company: Acme  \n");
      expect(raw).not.toContain("source:");
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * D37, part 1. `__proto__` does not parse as a URL at all, `javascript:`
   * and `ftp:` parse but are not http(s), and the field is rendered as an
   * <a href> in the queue list. The 400 must land before any filesystem call.
   *
   * All four reach the URL guard rather than tripping an earlier check —
   * each is a plain string to gray-matter and each is non-blank, so
   * requireFields and checkFrontmatterValue both pass them. That is what makes
   * the asserted error message meaningful.
   */
  it.each(["__proto__", "javascript:alert(1)", "ftp://x.example/y", "not a url"])(
    "400s a url that is not http(s) (%s), without touching the filesystem",
    async (url) => {
      const before = (await queueFilenames()).sort();
      const res = await post("/api/queue", { ...VALID_BODY, slug: "bad-url-probe", url });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("url must be an http(s) URL");
      expect((await queueFilenames()).sort()).toEqual(before);
    },
  );

  /**
   * TEETH for the "validate, don't quote" rule. gray-matter.stringify would
   * have emitted `location: 'Remote: United States'`, and the tolerant parser
   * does NOT strip quotes (jobFiles.ts:67) — so the quoted form would round-
   * trip into the displayed value as a literal, on the exact shape that is
   * live in jobs/queue/ right now. Negative control: swapping the serializer
   * for gray-matter.stringify fails the `not.toContain` assertions.
   */
  it("emits a colon-bearing value unquoted, and still serves it", async () => {
    const slug = "colon-role";
    try {
      const res = await post("/api/queue", {
        ...VALID_BODY,
        slug,
        location: "Remote: United States",
      });
      expect(res.status).toBe(201);

      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toContain("location: Remote: United States\n");
      expect(raw).not.toContain(`location: "`);
      expect(raw).not.toContain("location: '");
      // Strict YAML now fails on this file — as it does on the live one.
      // `{}` bypasses gray-matter's memo (see the note in the invalid-YAML
      // test above): a bare `matter(raw)` here would cache a poisoned empty
      // entry for this exact content, and readJobFile below — which parses the
      // same bytes — would then get {} back instead of throwing, skip its
      // tolerant fallback, and report every field as null.
      expect(() => matter(raw, {})).toThrow();
      // ...and the tolerant path still serves the true value
      const record = await readJobFile(root, "queue", slug);
      expect(record!.location).toBe("Remote: United States");

      const queue = await (await fetch(`${base}/api/queue`)).json();
      expect(queue.find((q: any) => q.slug === slug).location).toBe("Remote: United States");
    } finally {
      await cleanupQueue(slug);
    }
  });

  it("writes the advisory overrides under the gatherer's snake_case keys", async () => {
    const slug = "advisory-role";
    try {
      await post("/api/queue", {
        ...VALID_BODY,
        slug,
        resumeKey: "seattle",
        addressCityKey: "seattle",
      });
      const raw = await fs.readFile(queuePath(slug), "utf-8");
      expect(raw).toContain("resume_key: seattle\n");
      expect(raw).toContain("address_city_key: seattle\n");
      const queue = await (await fetch(`${base}/api/queue`)).json();
      const row = queue.find((q: any) => q.slug === slug);
      expect(row.resumeKey).toBe("seattle");
      expect(row.addressCityKey).toBe("seattle");
    } finally {
      await cleanupQueue(slug);
    }
  });

  /**
   * TEETH: the 400 must land BEFORE any filesystem call. A queue file missing
   * a required key halts the applier (CLAUDE.md:35), so a handler that wrote
   * first and validated second would stall the pipeline. Asserting the
   * directory is unchanged is what proves the ordering.
   */
  it.each(["url", "company", "title", "location"])(
    "400s a body missing %s, without touching the filesystem",
    async (missing) => {
      const before = (await queueFilenames()).sort();
      const body: Record<string, string> = { ...VALID_BODY };
      delete body[missing];
      const res = await post("/api/queue", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(`${missing} is required`);
      expect((await queueFilenames()).sort()).toEqual(before);
    },
  );

  it("400s an embedded newline, without touching the filesystem", async () => {
    const before = (await queueFilenames()).sort();
    const res = await post("/api/queue", {
      ...VALID_BODY,
      location: "Seattle, WA\n---\nurl: https://evil.example/pwned",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("must not contain newlines");
    expect((await queueFilenames()).sort()).toEqual(before);
  });

  /**
   * TEETH for the "wx" flag. fs.writeFile without it would silently replace a
   * queued job with a different posting. No auto-suffix either: two files for
   * one posting means /apply-next applies twice.
   */
  it("409s a slug collision and leaves the existing file byte-identical", async () => {
    const slug = "collide-role";
    try {
      expect((await post("/api/queue", { ...VALID_BODY, slug })).status).toBe(201);
      const original = await fs.readFile(queuePath(slug), "utf-8");

      const res = await post("/api/queue", {
        ...VALID_BODY,
        slug,
        company: "Different Co",
        url: "https://different.example/1",
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(`queue slug already exists: ${slug}`);
      expect(await fs.readFile(queuePath(slug), "utf-8")).toBe(original);
    } finally {
      await cleanupQueue(slug);
    }
  });

  it("400s a slug that cannot be used as a filename", async () => {
    const before = (await queueFilenames()).sort();
    const res = await post("/api/queue", { ...VALID_BODY, slug: "../escape" });
    expect(res.status).toBe(400);
    expect((await queueFilenames()).sort()).toEqual(before);
  });

  it("never leaks passwords", async () => {
    const slug = "sentinel-create";
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug });
      const text = await res.text();
      expect(text).not.toContain(SENTINEL_PASSWORD);
      expect(text).not.toContain('"password"');
    } finally {
      await cleanupQueue(slug);
    }
  });
});

describe("POST /api/queue/promote", () => {
  async function withDiscovered(
    slug: string,
    contents: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const file = path.join(root, "jobs", "discovered", `${slug}.md`);
    await fs.writeFile(file, contents);
    try {
      await fn();
    } finally {
      await fs.rm(file, { force: true });
      await cleanupQueue(slug);
    }
  }

  it("moves the file into the queue byte-for-byte and marks seen_urls by URL", async () => {
    const slug = "promo-role";
    const contents =
      "---\nurl: https://promo.example/jobs/5\ncompany: PromoCo\ntitle: Staff Engineer\nlocation: Remote\nsource: greenhouse\nmatch: strong\ndiscovered_at: 2026-07-01T00:00:00.000Z\n---\nATS: greenhouse\n";
    await withDiscovered(slug, contents, async () => {
      const res = await post("/api/queue/promote", { slug });
      expect(res.status).toBe(201);
      const result = await res.json();
      expect(result.item.slug).toBe(slug);
      expect(result.queue.some((q: any) => q.slug === slug)).toBe(true);
      expect(result.warning).toBeNull();

      // the file MOVED, contents untouched
      expect(await fs.readFile(queuePath(slug), "utf-8")).toBe(contents);
      await expect(
        fs.access(path.join(root, "jobs", "discovered", `${slug}.md`)),
      ).rejects.toThrow();

      // keyed by URL, not by a re-derived slug
      const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf-8"));
      expect(gather.seen_urls["https://promo.example/jobs/5"].decision).toBe("promoted");
    });
  });

  /**
   * TEETH for fs.link over fs.rename. rename SILENTLY CLOBBERS — verified —
   * and that is the gatherer's live bug at job-gatherer.ts:1046. Both files
   * must survive a collision, so nothing is consumed and nothing is lost.
   */
  it("409s a promote onto an existing queue slug, consuming nothing", async () => {
    const slug = "clash-role";
    const queued = "---\nurl: https://clash.example/queued\ncompany: Queued\n---\n";
    const discovered = "---\nurl: https://clash.example/discovered\ncompany: Discovered\n---\n";
    await fs.writeFile(queuePath(slug), queued);
    await withDiscovered(slug, discovered, async () => {
      const res = await post("/api/queue/promote", { slug });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(`queue slug already exists: ${slug}`);
      expect(await fs.readFile(queuePath(slug), "utf-8")).toBe(queued);
      expect(
        await fs.readFile(path.join(root, "jobs", "discovered", `${slug}.md`), "utf-8"),
      ).toBe(discovered);
    });
  });

  it("404s an unknown discovered slug", async () => {
    const res = await post("/api/queue/promote", { slug: "no-such-discovered" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("discovered file not found");
  });

  it("400s a traversal slug in the body", async () => {
    const res = await post("/api/queue/promote", { slug: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid slug");
  });

  it("never leaks passwords", async () => {
    const res = await post("/api/queue/promote", { slug: "no-such-discovered" });
    const text = await res.text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

describe("DELETE /api/queue/:slug", () => {
  /**
   * The read-before-unlink is the whole point: delete is an irreversible
   * fs.unlink with no undo, so the response is the user's only record of
   * what was destroyed.
   *
   * The claim is D34's narrowed one and this test asserts no more than it:
   * `item` is what the path held immediately before the unlink. It is NOT
   * asserted to prove which inode was removed — a replacement can still land
   * between the writer's final lstat and its unlink, and the case we can
   * detect is answered with a 409 rather than a deletion.
   *
   * Negative control: unlinking before reading makes `item` null and fails
   * the identity assertions.
   */
  it("returns the record read before the unlink and removes the file", async () => {
    const slug = "doomed-role";
    await fs.writeFile(
      queuePath(slug),
      "---\nurl: https://doomed.example/9\ncompany: DoomedCo\ntitle: Principal Engineer\nlocation: Austin, TX\n---\n",
    );
    const before = await (await fetch(`${base}/api/queue`)).json();
    const expectedPosition = before.findIndex((q: any) => q.slug === slug);

    const res = await fetch(`${base}/api/queue/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.item.slug).toBe(slug);
    expect(result.item.url).toBe("https://doomed.example/9");
    expect(result.item.company).toBe("DoomedCo");
    expect(result.item.title).toBe("Principal Engineer");
    // Projected by toQueueItem, so the full QueueItem contract holds on a
    // row that no longer exists — including the relative path.
    expect(result.item.filePath).toBe(`jobs/queue/${slug}.md`);
    expect(Number.isNaN(Date.parse(result.item.queuedAt))).toBe(false);
    // `position` is the index the file held in the PRE-delete listing, which
    // is the only listing it ever had an index in.
    expect(result.item.position).toBe(expectedPosition);
    // the removed row is NOT in the re-listed queue
    expect(result.queue.some((q: any) => q.slug === slug)).toBe(false);
    await expect(fs.access(queuePath(slug))).rejects.toThrow();
  });

  it("404s a slug that is not in the queue, and unlinks nothing", async () => {
    const before = (await queueFilenames()).sort();
    const res = await fetch(`${base}/api/queue/no-such-queued`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("queue item not found");
    expect((await queueFilenames()).sort()).toEqual(before);
  });

  /**
   * The RAW form is normalized away by undici and never reaches the handler,
   * so the encoded forms are the only ones that actually exercise the guard —
   * the same reasoning applications.test.ts:262-264 records.
   */
  it.each(["..%2f..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2fstate", "acme%20manager"])(
    "400s a traversal or out-of-allowlist slug (%s)",
    async (encoded) => {
      const before = (await queueFilenames()).sort();
      const res = await fetch(`${base}/api/queue/${encoded}`, { method: "DELETE" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid slug");
      expect((await queueFilenames()).sort()).toEqual(before);
    },
  );

  it("leaves gather_state.json untouched", async () => {
    const slug = "delete-no-gather";
    await fs.writeFile(queuePath(slug), "---\nurl: https://dng.example/1\ncompany: DNG\n---\n");
    const file = path.join(root, "gather_state.json");
    const before = await fs.readFile(file, "utf-8");
    const res = await fetch(`${base}/api/queue/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await fs.readFile(file, "utf-8")).toBe(before);
  });

  it("never leaks passwords", async () => {
    const slug = "sentinel-delete";
    await fs.writeFile(queuePath(slug), "---\nurl: https://sd.example/1\ncompany: SD\n---\n");
    const text = await (await fetch(`${base}/api/queue/${slug}`, { method: "DELETE" })).text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

/**
 * D36. express.json() rejects a malformed body BEFORE any router runs, so no
 * route handler can answer it. Without the narrow middleware in app.ts this is
 * Express 5's default handler: 400 with `content-type: text/html` and an HTML
 * document body — which contradicts D30/R14's "every expected failure returns
 * JSON" and makes Task 13's HTML-body check point at a bug that does not exist.
 */
describe("malformed JSON bodies", () => {
  /**
   * Negative control: delete the middleware from app.ts and the
   * content-type assertion fails with `text/html; charset=utf-8`.
   */
  it.each(["/api/queue", "/api/queue/promote"])(
    "answers a malformed body on %s with 400 and a JSON body",
    async (route) => {
      const before = (await queueFilenames()).sort();
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Deliberately NOT JSON.stringify'd — this is the raw broken text a
        // hand-rolled client or a truncated request would send.
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "invalid JSON body" });
      expect((await queueFilenames()).sort()).toEqual(before);
    },
  );

  /**
   * TEETH for the "narrow" in D36. R14 rejects a GENERAL error handler
   * because it would change behaviour for three shipped routes. This asserts
   * the narrowness two ways: a valid JSON body still reaches the handler and
   * gets the handler's own 400, and an unrelated thrown error still travels
   * the existing next(err) path to Express's default HTML handler.
   *
   * The error route is registered on a SEPARATE app and server so the shared
   * harness above is untouched. Registering it after createApp() returns
   * puts it after the middleware in the stack, which is exactly where a
   * router sits — so this reproduces the real dispatch order rather than
   * approximating it.
   */
  it("leaves the existing next(err) path completely unchanged", async () => {
    const app = createApp(root, { security: { enabled: false } });
    app.get("/__unrelated-error", (_req, _res, next) => {
      // A SyntaxError specifically: `instanceof SyntaxError` would have been
      // the tempting discriminator, and this is the value that proves why
      // `type === "entity.parse.failed"` was chosen instead.
      next(new SyntaxError("unrelated failure"));
    });
    let server2: Server;
    await new Promise<void>((resolve) => {
      server2 = app.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const { port } = server2!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/__unrelated-error`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("text/html");
      const text = await res.text();
      expect(text).not.toContain("invalid JSON body");

      // ...and a well-formed body still gets the ROUTER's own JSON 400,
      // not the middleware's.
      const ok = await fetch(`http://127.0.0.1:${port}/api/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: "NoUrl Co" }),
      });
      expect(ok.status).toBe(400);
      expect(await ok.json()).toEqual({ error: "url is required" });
    } finally {
      await new Promise((resolve) => server2!.close(resolve));
    }
  });
});

describe("GET /api/queue/discovered", () => {
  it("returns discovered rows, filtered and capped", async () => {
    const all = await (await fetch(`${base}/api/queue/discovered`)).json();
    expect(all.some((d: any) => d.slug === "omega-staff-eng")).toBe(true);
    expect(all[0].descriptionExcerpt).toBeUndefined();

    const filtered = await (await fetch(`${base}/api/queue/discovered?q=omega`)).json();
    expect(filtered.map((d: any) => d.slug)).toEqual(["omega-staff-eng"]);

    const none = await (await fetch(`${base}/api/queue/discovered?q=zzzznomatch`)).json();
    expect(none).toEqual([]);

    const capped = await (await fetch(`${base}/api/queue/discovered?limit=0`)).json();
    // limit=0 is not a positive integer, so the default applies rather than
    // returning an empty list
    expect(capped.length).toBeGreaterThan(0);
  });

  it("never leaks passwords", async () => {
    const text = await (await fetch(`${base}/api/queue/discovered`)).text();
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect(text).not.toContain('"password"');
  });
});

describe("gather_state.json degradation", () => {
  /**
   * TEETH for the best-effort rule. The queue file operation is the user's
   * intent; the seen_urls entry is a dedup hint. If the hint fails after the
   * file already exists, returning 500 would invite a retry that then 409s on
   * the file the first attempt created. The warning is the honest outcome —
   * and the corrupt file must come back byte-identical, because feeding a
   * leniently-repaired document to JSON.stringify would permanently delete the
   * tail of a 322 KB agent-owned file.
   */
  it("still 201s with a warning when gather_state.json is corrupt, and does not rewrite it", async () => {
    const slug = "degrade-role";
    const file = path.join(root, "gather_state.json");
    const original = await fs.readFile(file, "utf-8");
    const corrupt = `${original}\n}`;
    await fs.writeFile(file, corrupt);
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug });
      expect(res.status).toBe(201);
      const result = await res.json();
      expect(result.warning).toContain("not valid JSON");
      expect(result.queue.some((q: any) => q.slug === slug)).toBe(true);
      // the file the user asked for exists...
      await expect(fs.access(queuePath(slug))).resolves.toBeUndefined();
      // ...and the file we do not own was not touched
      expect(await fs.readFile(file, "utf-8")).toBe(corrupt);
    } finally {
      await fs.writeFile(file, original);
      await cleanupQueue(slug);
    }
  });

  it("upserts seen_urls on a successful create, preserving unknown keys", async () => {
    const slug = "upsert-role";
    const file = path.join(root, "gather_state.json");
    const original = await fs.readFile(file, "utf-8");
    const seeded = JSON.parse(original);
    seeded.seen_urls[VALID_BODY.url] = {
      first_seen: "2020-01-01T00:00:00.000Z",
      source: "greenhouse",
      company: "OldName",
      title: "Old Title",
      decision: "discovered-manual",
      reject_reason: "kept for the record",
    };
    await fs.writeFile(file, JSON.stringify(seeded, null, 2));
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug });
      expect(res.status).toBe(201);
      expect((await res.json()).warning).toBeNull();
      const entry = JSON.parse(await fs.readFile(file, "utf-8")).seen_urls[VALID_BODY.url];
      expect(entry.decision).toBe("promoted");
      expect(entry.first_seen).toBe("2020-01-01T00:00:00.000Z");
      expect(entry.reject_reason).toBe("kept for the record");
    } finally {
      await fs.writeFile(file, original);
      await cleanupQueue(slug);
    }
  });
});

/**
 * The promote-race suite. Added after an external code review pointed out that
 * the uncontended promote tests above would ALL still pass with the source
 * identity checks deleted — they never contend, so they pin nothing.
 *
 * These force the interleaving with a spy on fs.link and fs.lstat, because the
 * window being defended sits between two syscalls and cannot be hit by timing.
 * Each asserts the same thing: when the source is swapped underneath us, the
 * replacement is STILL ON DISK afterwards. That is the whole guarantee — not
 * that the move succeeds, but that nothing we never inspected gets deleted.
 */
describe("POST /api/queue/promote — source-identity races", () => {
  const SLUG = "race-fixture-role";

  async function seedDiscovered(body: string): Promise<string> {
    const p = path.join(root, "jobs", "discovered", `${SLUG}.md`);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return p;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(root, "jobs", "discovered", `${SLUG}.md`), { force: true });
    await cleanupQueue(SLUG);
  });

  it("does not move a replacement swapped in between the lstat and the link", async () => {
    const src = await seedDiscovered(
      `---\nurl: https://acme.example/race/original\ncompany: Original\ntitle: Original Role\nlocation: Remote\n---\noriginal body\n`,
    );

    // Swap the source for a DIFFERENT inode after the pre-link lstat has run
    // but before link() sees the path.
    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from: any, to: any) => {
      await fs.rm(src, { force: true });
      await fs.writeFile(
        src,
        `---\nurl: https://acme.example/race/replacement\ncompany: Replacement\ntitle: Replacement Role\nlocation: Remote\n---\nreplacement body\n`,
      );
      return realLink(from, to);
    });

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(409);

    // The replacement must still be there. Without the post-link identity
    // check, promote unlinks this path and destroys a posting nobody read.
    const after = await fs.readFile(src, "utf-8");
    expect(after).toContain("Replacement");
  });

  it("does not delete a replacement swapped in between the link and the unlink", async () => {
    const src = await seedDiscovered(
      `---\nurl: https://acme.example/race/original2\ncompany: Original2\ntitle: Original Role\nlocation: Remote\n---\noriginal body\n`,
    );

    // Let the link succeed on the real inode, then swap the source after the
    // post-link destination check but before the pre-unlink source re-check.
    const realLstat = fs.lstat.bind(fs);
    let seen = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (p: any, options?: any) => {
      const result = await realLstat(p, options);
      seen += 1;
      // seen === 2 is the POST-LINK destination check (seen === 1 is the
      // pre-link destination-directory guard). Swapping here lands between it
      // and the pre-unlink source re-check, which is the window under test.
      if (seen === 2) {
        await fs.rm(src, { force: true });
        await fs.writeFile(
          src,
          `---\nurl: https://acme.example/race/replacement2\ncompany: Replacement2\ntitle: Replacement Role\nlocation: Remote\n---\nreplacement body\n`,
        );
      }
      return result;
    });

    const res = await post("/api/queue/promote", { slug: SLUG });
    // 409, specifically. Accepting 200/201 here would let the test pass on an
    // implementation that noticed nothing and simply declined to unlink, which
    // is not the contract — PARTIAL_CONFLICT is.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no longer the file that was read");

    // The replacement was never inspected by this request and must survive.
    const after = await fs.readFile(src, "utf-8").catch(() => null);
    expect(after).not.toBeNull();
    expect(after).toContain("Replacement2");
    // And the partial state is real: the queue file exists too, and the
    // response said so rather than silently deleting one side.
    expect(await fs.readFile(queuePath(SLUG), "utf-8")).toContain("Original2");
  });

  it("refuses to promote a discovered file whose url is not http(s)", async () => {
    const src = await seedDiscovered(
      `---\nurl: data:text/html,<script>alert(1)</script>\ncompany: Hostile\ntitle: Hostile Role\nlocation: Remote\n---\nbody\n`,
    );

    const before = await queueFilenames();
    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not http(s)");

    // Nothing moved, and the discovered file is untouched.
    expect(await queueFilenames()).toEqual(before);
    expect(await fs.readFile(src, "utf-8")).toContain("Hostile");
  });
});

describe("gather_state.json shape validation", () => {
  it("refuses a valid-JSON but non-object gather_state and leaves the bytes untouched", async () => {
    const file = path.join(root, "gather_state.json");
    const original = await fs.readFile(file, "utf-8");
    const slug = "shape-guard-role";
    // `[]` parses cleanly. Assigning .seen_urls onto an array is dropped by
    // JSON.stringify, so without the shape check the upsert reports success
    // and durably records nothing.
    // NONCANONICAL on purpose: "[]" would serialize back to "[]" even in the
    // broken implementation, so a bytes-unchanged assertion on it proves
    // nothing. "[ ]" survives only if the file is genuinely never rewritten.
    await fs.writeFile(file, "[ ]");
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug });
      expect(res.status).toBe(201);
      const payload = await res.json();
      // The queue file IS written — the dedup hint is best-effort by design.
      expect(payload.item.slug).toBe(slug);
      expect(payload.warning).toContain("not a JSON object");
      // And the file was not rewritten into some other shape.
      expect(await fs.readFile(file, "utf-8")).toBe("[ ]");
    } finally {
      await fs.writeFile(file, original);
      await cleanupQueue(slug);
    }
  });

  it("refuses a seen_urls that is valid JSON but not an object", async () => {
    const file = path.join(root, "gather_state.json");
    const original = await fs.readFile(file, "utf-8");
    const slug = "shape-guard-seen-role";
    const body = JSON.stringify({ seen_urls: [], per_company: {} }, null, 2);
    await fs.writeFile(file, body);
    try {
      const res = await post("/api/queue", { ...VALID_BODY, slug });
      expect(res.status).toBe(201);
      const payload = await res.json();
      expect(payload.item.slug).toBe(slug);
      expect(payload.warning).toContain("seen_urls is not a JSON object");
      // An array seen_urls must not be silently replaced by our fresh map.
      expect(await fs.readFile(file, "utf-8")).toBe(body);
    } finally {
      await fs.writeFile(file, original);
      await cleanupQueue(slug);
    }
  });
});

/**
 * The EXDEV fallback. link() cannot fail with EXDEV inside one workspace, so
 * this forces it — otherwise the branch ships untested, which is exactly how it
 * came to be missing both identity checks the link path had.
 */
describe("POST /api/queue/promote — EXDEV copy fallback", () => {
  const SLUG = "exdev-fixture-role";

  async function seedDiscovered(url: string, company: string): Promise<string> {
    const p = path.join(root, "jobs", "discovered", `${SLUG}.md`);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(
      p,
      `---\nurl: ${url}\ncompany: ${company}\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
    );
    return p;
  }

  function forceExdev(): void {
    vi.spyOn(fs, "link").mockImplementation(async () => {
      const e: NodeJS.ErrnoException = new Error("cross-device link not permitted");
      e.code = "EXDEV";
      throw e;
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(root, "jobs", "discovered", `${SLUG}.md`), { force: true });
    await cleanupQueue(SLUG);
  });

  it("copies and removes the source when nothing contends", async () => {
    const src = await seedDiscovered("https://acme.example/exdev/ok", "ExdevOk");
    forceExdev();

    const res = await post("/api/queue/promote", { slug: SLUG });
    // 201 — promote creates a queue file, same as POST / does (queue.ts:277,344).
    expect(res.status).toBe(201);
    expect(await fs.readFile(queuePath(SLUG), "utf-8")).toContain("ExdevOk");
    await expect(fs.readFile(src, "utf-8")).rejects.toThrow();
  });

  it("does not delete a replacement swapped in after the copy", async () => {
    const src = await seedDiscovered("https://acme.example/exdev/orig", "ExdevOriginal");
    forceExdev();

    // Swap the source after copyFile has read it, before the pre-unlink check.
    const realCopy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from: any, to: any, mode?: any) => {
      const out = await realCopy(from, to, mode);
      await fs.rm(src, { force: true });
      await fs.writeFile(
        src,
        `---\nurl: https://acme.example/exdev/replacement\ncompany: ExdevReplacement\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
      );
      return out;
    });

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("copied");

    // The replacement must survive — this is the defect the link path had
    // fixed and the copy path did not.
    expect(await fs.readFile(src, "utf-8")).toContain("ExdevReplacement");
  });

  it("maps a COPYFILE_EXCL collision to 409, not a 500", async () => {
    await seedDiscovered("https://acme.example/exdev/collide", "ExdevCollide");
    // Occupy the destination so COPYFILE_EXCL must fail.
    await fs.writeFile(queuePath(SLUG), "---\ncompany: Incumbent\n---\nbody\n");
    forceExdev();

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(409);
    // And the incumbent is untouched.
    expect(await fs.readFile(queuePath(SLUG), "utf-8")).toContain("Incumbent");
  });

  it("refuses a non-http(s) url on the copy path too", async () => {
    const src = await seedDiscovered("data:text/html,<script>1</script>", "ExdevHostile");
    forceExdev();

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(400);
    expect(await fs.readFile(src, "utf-8")).toContain("ExdevHostile");
  });
});

/**
 * The delete-replacement race. DELETE is the one irreversible operation here,
 * and without this the CHANGED branch ships unexercised.
 */
describe("DELETE /api/queue/:slug — identity race", () => {
  const SLUG = "delete-race-role";

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupQueue(SLUG);
  });

  it("returns 409 and deletes nothing when the file is replaced mid-request", async () => {
    const p = queuePath(SLUG);
    await fs.writeFile(p, "---\ncompany: Original\n---\noriginal\n");

    // Swap the file for a different inode after the read, before the final
    // identity check and unlink.
    const realLstat = fs.lstat.bind(fs);
    let seen = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (target: any, options?: any) => {
      const result = await realLstat(target, options);
      seen += 1;
      if (seen === 1) {
        await fs.rm(p, { force: true });
        await fs.writeFile(p, "---\ncompany: Replacement\n---\nreplacement\n");
      }
      return result;
    });

    const res = await fetch(`${base}/api/queue/${SLUG}`, { method: "DELETE" });
    expect(res.status).toBe(409);

    // The replacement is still on disk — nothing was deleted.
    expect(await fs.readFile(p, "utf-8")).toContain("Replacement");
  });
});

/**
 * The read-vs-identity binding. This is the race round 3 found: the file was
 * read and its url validated, then a REPLACEMENT was installed, and only then
 * was the identity captured — so every later identity check agreed with itself
 * about the wrong file and promoted it with a 201.
 *
 * Forced by swapping the file during the open() that reads it. If the record
 * and the identity ever come from different reads again, this promotes a
 * `data:` url into the queue and the assertions below fail.
 */
describe("POST /api/queue/promote — the validated record is the moved inode", () => {
  const SLUG = "bind-fixture-role";

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(root, "jobs", "discovered", `${SLUG}.md`), { force: true });
    await cleanupQueue(SLUG);
  });

  it("never promotes a replacement that was swapped in around the read", async () => {
    const src = path.join(root, "jobs", "discovered", `${SLUG}.md`);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(
      src,
      `---\nurl: https://acme.example/bind/original\ncompany: BindOriginal\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
    );

    // Replace the file with a hostile one the moment it is opened for reading.
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (p: any, flags?: any) => {
      const handle = await realOpen(p, flags);
      if (!swapped) {
        swapped = true;
        await fs.rm(src, { force: true });
        await fs.writeFile(
          src,
          `---\nurl: data:text/html,<script>1</script>\ncompany: BindHostile\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
        );
      }
      return handle;
    });

    const res = await post("/api/queue/promote", { slug: SLUG });

    // The injection MUST have happened, or this test proves nothing — a
    // pathname-read implementation would never trigger the spy and would sail
    // through with a benign 201.
    expect(swapped).toBe(true);

    // The replacement is detected and reported. 409, not 201: the request did
    // not do what it was asked to do.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("changed while it was being promoted");

    // NOTHING was deleted — that is the guarantee. Both paths still exist, and
    // the user is told to resolve them by hand. We deliberately do NOT unlink
    // the queue file: link() succeeding proves only that dst was absent at link
    // time, so a mismatch cannot distinguish "we linked a replacement source"
    // from "another writer replaced our destination", and one of those readings
    // makes unlinking data loss.
    expect(await fs.readFile(src, "utf-8")).toContain("BindHostile");
    expect(await fs.readFile(queuePath(SLUG), "utf-8")).toBeTruthy();
  });
});

/**
 * The EXDEV non-http test in the suite above is VACUOUS for the copy path —
 * validation returns 400 before fs.link can throw EXDEV, so copyFile never
 * runs. Round 3 called that out. This reaches the copy path with a url that is
 * valid at validation time and hostile afterwards, which is the only way a
 * `data:` url can arrive at copyFile at all.
 */
describe("POST /api/queue/promote — EXDEV copy does not import hostile bytes", () => {
  const SLUG = "exdev-bind-role";

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(root, "jobs", "discovered", `${SLUG}.md`), { force: true });
    await cleanupQueue(SLUG);
  });

  it("refuses to leave a queue file whose source changed under the copy", async () => {
    const src = path.join(root, "jobs", "discovered", `${SLUG}.md`);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(
      src,
      `---\nurl: https://acme.example/exdev/bind\ncompany: ExdevBindOriginal\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
    );

    vi.spyOn(fs, "link").mockImplementation(async () => {
      const e: NodeJS.ErrnoException = new Error("cross-device link not permitted");
      e.code = "EXDEV";
      throw e;
    });

    // Swap the source AFTER copyFile has read it. The pre-unlink source check
    // must notice and refuse to unlink.
    const realCopy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from: any, to: any, mode?: any) => {
      const out = await realCopy(from, to, mode);
      await fs.rm(src, { force: true });
      await fs.writeFile(
        src,
        `---\nurl: data:text/html,<script>1</script>\ncompany: ExdevBindHostile\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
      );
      return out;
    });

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(409);

    // The hostile replacement survives (we refused to unlink it) and the queue
    // file holds the validated bytes, not the hostile ones.
    expect(await fs.readFile(src, "utf-8")).toContain("ExdevBindHostile");
    const queued = await fs.readFile(queuePath(SLUG), "utf-8");
    expect(queued).toContain("ExdevBindOriginal");
    expect(queued).not.toContain("data:text/html");
  });
});

/**
 * The destination-replacement case, and the reason promote must never unlink
 * `dst` on an identity mismatch.
 *
 * The gatherer promotes with a clobbering `fs.rename` (R3), so a foreign file
 * can land on our destination between our `link` and our check. From a pathname
 * API that is INDISTINGUISHABLE from "we linked a replacement source" — both
 * show an inode at `dst` that is not `srcId`. One of those readings makes
 * unlinking data loss, so we unlink nothing. This test pins the file that would
 * be destroyed if that ever changes.
 */
describe("POST /api/queue/promote — a foreign file at the destination survives", () => {
  const SLUG = "dst-replace-role";

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(root, "jobs", "discovered", `${SLUG}.md`), { force: true });
    await cleanupQueue(SLUG);
  });

  it("does not delete a queue file another writer put there after our link", async () => {
    const src = path.join(root, "jobs", "discovered", `${SLUG}.md`);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(
      src,
      `---\nurl: https://acme.example/dst/original\ncompany: DstOriginal\ntitle: Some Role\nlocation: Remote\n---\nbody\n`,
    );

    // Let our link succeed, then clobber the destination the way the gatherer
    // does — a different inode entirely, belonging to someone else.
    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from: any, to: any) => {
      const out = await realLink(from, to);
      await fs.rm(queuePath(SLUG), { force: true });
      await fs.writeFile(
        queuePath(SLUG),
        `---\nurl: https://other.example/theirs\ncompany: SomeoneElse\ntitle: Their Role\nlocation: Remote\n---\ntheir body\n`,
      );
      return out;
    });

    const res = await post("/api/queue/promote", { slug: SLUG });
    expect(res.status).toBe(409);

    // THE ASSERTION THAT MATTERS: their file is still there. If promote ever
    // unlinks on this mismatch, this is the data it destroys.
    expect(await fs.readFile(queuePath(SLUG), "utf-8")).toContain("SomeoneElse");
    // And ours was not removed from discovered either.
    expect(await fs.readFile(src, "utf-8")).toContain("DstOriginal");
  });
});
