import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace, SENTINEL_PASSWORD } from "./helpers";
import { readState, normalizeStateApplication, inferSourceFromUrl } from "../readers/stateJson";
import { listJobFiles, listQueue, normalizeJobFile } from "../readers/jobFiles";
import { readAccounts } from "../readers/credentials";
import { lenientParseFirstDocument, readGatherStateSummary } from "../readers/gatherState";

let root: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
});

afterAll(async () => {
  await rmFixtureWorkspace(root);
});

describe("stateJson reader", () => {
  it("parses applications + addresses, normalizes last_updated", async () => {
    const state = await readState(root);
    expect(state.applications).toHaveLength(2);
    // 3 since the shared fixture grew a `default` address (helpers.ts).
    expect(state.addresses).toHaveLength(3);
    expect(state.addresses.map((a) => a.cityKey).sort()).toEqual([
      "default",
      "seattle",
      "tampa",
    ]);
    expect(state.lastUpdated).toBe("2026-07-22T19:00:00.000Z");
  });

  it("normalizeStateApplication tolerates null/missing attempt fields", async () => {
    const state = await readState(root);
    const app = normalizeStateApplication(state.applications[0], state.lastUpdated);
    expect(app.slug).toBe("acme-engineering-manager");
    expect(app.applyState).toBe("submitted");
    expect(app.location).toBe("Seattle, WA");
    expect(app.addressUsed?.city).toBe("Seattle");
    expect(app.attempts[0].endedAt).toBeNull();
    expect(app.attempts[0].notes).toBeNull();
    expect(app.attempts[1].notes).toContain("Greenhouse");
    expect(app.estimated).toBe(false);
    expect(app.lastUpdated).toBe("2026-07-22T19:00:00.000Z");
  });

  it("maps unknown apply states to queued", async () => {
    const state = await readState(root);
    const weird = { ...state.applications[0], status: "something-new" };
    expect(normalizeStateApplication(weird, null).applyState).toBe("queued");
  });

  it("infers source from URL host", () => {
    expect(inferSourceFromUrl("https://job-boards.greenhouse.io/x/jobs/1")).toBe("greenhouse");
    expect(inferSourceFromUrl("https://jobs.ashbyhq.com/x/abc")).toBe("ashby");
    expect(inferSourceFromUrl("https://acme.wd5.myworkdayjobs.com/job/1")).toBe("workday");
    expect(inferSourceFromUrl("https://careers-x.icims.com/jobs/1")).toBe("icims");
    expect(inferSourceFromUrl("not a url")).toBeNull();
    expect(inferSourceFromUrl(null)).toBeNull();
  });
});

describe("jobFiles reader", () => {
  it("lists applied files sorted by slug", async () => {
    const files = await listJobFiles(root, "applied");
    expect(files.map((f) => f.slug)).toEqual([
      "acme-engineering-manager",
      "beta-director-data",
      "delta-senior-em",
      "gamma-head-of-ai",
    ]);
  });

  it("normalizes location ?? location_raw and date frontmatter", async () => {
    const files = await listJobFiles(root, "applied");
    const beta = files.find((f) => f.slug === "beta-director-data")!;
    expect(beta.location).toBe("Remote, United States"); // from location_raw
    expect(beta.submittedAt).toBe("2026-07-09T00:14:14.000Z");
    expect(beta.resume).toBe("/abs/jane-doe-resume.pdf");
    const gamma = files.find((f) => f.slug === "gamma-head-of-ai")!;
    expect(gamma.appliedAt).toBe("2026-06-20T21:41:00.000Z");
  });

  it("degrades instead of crashing on invalid YAML frontmatter", async () => {
    // seen in the live workspace: unquoted colon in a scalar value
    const bad = `---\nurl: https://bad.example/job/1\ncompany: BadCo\nlocation: Remote - US: Select locations\nllm_score: 4\n---\nATS: workday\nbody text\n`;
    const rec = normalizeJobFile(
      "bad-file",
      "applied",
      "/tmp/bad.md",
      bad,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-02T00:00:00Z"),
    );
    expect(rec.company).toBe("BadCo");
    expect(rec.location).toBe("Remote - US: Select locations");
    expect(rec.llmScore).toBe(4);
    expect(rec.ats).toBe("workday");
    expect(rec.body).toContain("body text");
  });

  it("handles files with no frontmatter at all", async () => {
    const rec = normalizeJobFile(
      "bare",
      "queue",
      "/tmp/bare.md",
      "just a body",
      new Date(),
      new Date(),
    );
    expect(rec.company).toBeNull();
    expect(rec.body).toBe("just a body");
  });

  it("parses ATS/Req ID body lines and queue positions are sorted", async () => {
    const queue = await listQueue(root);
    expect(queue.map((q) => q.slug)).toEqual(["alpha-ai-director", "zeta-platform-em"]);
    expect(queue[0].position).toBe(0);
    expect(queue[0].ats).toBe("workday");
    expect(queue[1].ats).toBe("greenhouse");
    expect(queue[1].reqId).toBe("9");
    expect(queue[0].llmScore).toBe(4);
  });

  /**
   * The whole point of listQueue's re-sort, and the ONLY thing that proves it
   * does anything. The live queue contains no prefix pair, so on real data the
   * broken and the fixed ordering are identical — this constructs the case that
   * distinguishes them.
   *
   * "acme-engineer" is a prefix of "acme-engineer-finops". Sorting the bare
   * slugs puts "acme-engineer" first; sorting the filenames the applier
   * actually sorts puts "acme-engineer-finops.md" first, because "-" (0x2D)
   * sorts before "." (0x2E). The applier takes mdFiles[0], so this is the
   * difference between the UI naming the right next job and the wrong one.
   */
  it("orders a prefix pair the way the applier does, not by bare slug", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-order-"));
    try {
      const dir = path.join(tmp, "jobs", "queue");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "acme-engineer.md"), "---\ncompany: A\n---\n");
      await fs.writeFile(path.join(dir, "acme-engineer-finops.md"), "---\ncompany: B\n---\n");

      const queue = await listQueue(tmp);
      const slugs = queue.map((q) => q.slug);

      // What the applier itself would compute, derived rather than hardcoded.
      const applierOrder = (await fs.readdir(dir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => f.slice(0, -3));

      expect(slugs).toEqual(applierOrder);
      expect(slugs).toEqual(["acme-engineer-finops", "acme-engineer"]);
      // And it is NOT bare-slug order — if this ever matches, the re-sort is gone.
      expect(slugs).not.toEqual([...slugs].sort());
      expect(queue.map((q) => q.position)).toEqual([0, 1]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips a file that vanishes between readdir and read", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-vanish-"));
    try {
      const dir = path.join(tmp, "jobs", "queue");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "stays.md"), "---\ncompany: Stays\n---\n");
      // A dangling symlink is a name readdir reports and open() answers with
      // ENOENT — the same observable the applier's mid-listing rename produces,
      // without needing to interleave anything.
      await fs.symlink(path.join(dir, "nowhere.md"), path.join(dir, "gone.md"));

      const queue = await listQueue(tmp);
      expect(queue.map((q) => q.slug)).toEqual(["stays"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("still throws on a non-ENOENT read failure", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jobs-eisdir-"));
    try {
      const dir = path.join(tmp, "jobs", "queue");
      await fs.mkdir(dir, { recursive: true });
      // A DIRECTORY named *.md: readdir lists it, readFile answers EISDIR.
      // Tolerating that too would turn a real fault into a silently short list.
      await fs.mkdir(path.join(dir, "adir.md"));

      await expect(listQueue(tmp)).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("queuedAt is the file ctime and filePath is workspace-relative", async () => {
    const queue = await listQueue(root);
    const stat = await fs.stat(path.join(root, "jobs", "queue", `${queue[0].slug}.md`));
    expect(queue[0].queuedAt).toBe(stat.ctime.toISOString());
    expect(queue[0].filePath).toBe(`jobs/queue/${queue[0].slug}.md`);
    // Never the server's absolute layout.
    expect(queue[0].filePath.startsWith("/")).toBe(false);
    expect(queue[0].filePath).not.toContain(root);
  });
});

describe("credentials reader", () => {
  it("never serializes the sentinel password", async () => {
    const accounts = await readAccounts(root);
    expect(accounts).toHaveLength(2);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain(SENTINEL_PASSWORD);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain('"password"');
    const acme = accounts.find((a) => a.host === "acme.wd5.myworkdayjobs.com")!;
    expect(acme.hasPassword).toBe(true);
    expect(acme.emailUsed).toBe("applicant+acme@example.com");
  });
});

describe("gatherState reader", () => {
  it("parses a valid file strictly", async () => {
    const summary = await readGatherStateSummary(root);
    expect(summary.seenUrlCount).toBe(1);
    expect(summary.perCompanyCount).toBe(1);
    expect(summary.lastFullGather).toBe("2026-06-24T21:14:30.367Z");
    expect(summary.autoPromote).toBe(false);
  });

  it("lenient parse tolerates trailing garbage (the trailing-brace incident)", () => {
    const valid = JSON.stringify({ seen_urls: { a: {}, b: {} }, auto_promote: false });
    const parsed = lenientParseFirstDocument(`${valid}\n}`) as any;
    expect(Object.keys(parsed.seen_urls)).toHaveLength(2);
  });

  it("lenient parse returns null for total garbage", () => {
    expect(lenientParseFirstDocument("not json at all")).toBeNull();
  });
});
