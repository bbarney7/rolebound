import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileIdentity } from "./job-files";
import { reconcileAtRunStart, reconcileWorkspace } from "./reconcile";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-reconcile-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "discovered"), { recursive: true });
  await fs.writeFile(
    path.join(root, "state.json"),
    JSON.stringify({ applications: [], addresses: {} }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "gather_state.json"),
    JSON.stringify({ seen_urls: {}, per_company: {} }, null, 2),
    "utf8",
  );
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("reconcileWorkspace fixture matrix", () => {
  it("R1: duplicate discovered+queue same bytes removes discovered and marks promoted", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r1";
    const body = `url: ${url}\n`;
    await fs.writeFile(path.join(root, "jobs", "discovered", "a.md"), body, "utf8");
    await fs.writeFile(path.join(root, "jobs", "queue", "a.md"), body, "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R1"] });
    expect(findings.some((f) => f.row === "R1" && f.applied)).toBe(true);
    await expect(fs.stat(path.join(root, "jobs", "discovered", "a.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url].decision).toBe("promoted");
    const second = await reconcileWorkspace(root, { apply: true, rows: ["R1"] });
    expect(second.filter((f) => f.row === "R1" && f.applied)).toHaveLength(0);
  });

  it("R1: skips when queue content changes before the gather lock", async () => {
    const root = await tempRoot();
    const body = "url: https://ex.test/r1-skip\n";
    const dPath = path.join(root, "jobs", "discovered", "a.md");
    const qPath = path.join(root, "jobs", "queue", "a.md");
    await fs.writeFile(dPath, body, "utf8");
    await fs.writeFile(qPath, body, "utf8");
    const readFile = fs.readFile.bind(fs);
    let flipped = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (target, ...rest) => {
      const buf = await readFile(target, ...rest);
      if (!flipped && String(target) === qPath) {
        flipped = true;
        await fs.writeFile(qPath, `${body}changed\n`, "utf8");
      }
      return buf;
    });
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R1"] });
    vi.restoreAllMocks();
    expect(findings.some((f) => f.row === "R1" && f.skipped)).toBe(true);
    await expect(fs.stat(dPath)).resolves.toBeDefined();
  });

  it("R2: name conflict in discovered+queue leaves both files", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "jobs", "discovered", "a.md"), "url: https://a\nv1\n", "utf8");
    await fs.writeFile(path.join(root, "jobs", "queue", "a.md"), "url: https://a\nv2\n", "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R1", "R2"] });
    expect(findings.some((f) => f.row === "R2")).toBe(true);
    expect(findings.some((f) => f.row === "R2" && f.applied)).toBe(false);
    await expect(fs.stat(path.join(root, "jobs", "discovered", "a.md"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "jobs", "queue", "a.md"))).resolves.toBeDefined();
  });

  it("R3: queue file without promoted seen_urls entry upserts promoted", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r3";
    await fs.writeFile(path.join(root, "jobs", "queue", "q.md"), `url: ${url}\n`, "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R3"] });
    expect(findings.some((f) => f.row === "R3" && f.applied)).toBe(true);
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url].decision).toBe("promoted");
  });

  it("R4: finishes reject_pending when discovered file matches full identity", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r4";
    const discPath = path.join(root, "jobs", "discovered", "d.md");
    await fs.writeFile(discPath, `url: ${url}\n`, "utf8");
    const id = fileIdentity(await fs.stat(discPath, { bigint: true }));
    await fs.writeFile(
      path.join(root, "gather_state.json"),
      JSON.stringify(
        {
          seen_urls: {
            [url]: { decision: "rejected", reject_pending: { identity: id, at: "t" } },
          },
          per_company: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R4"] });
    expect(findings.some((f) => f.row === "R4" && f.applied)).toBe(true);
    await expect(fs.stat(discPath)).rejects.toMatchObject({ code: "ENOENT" });
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url].reject_pending).toBeUndefined();
  });

  it("NH1: rejected without reject_pending leaves rediscovered file alone", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/nh1";
    await fs.writeFile(path.join(root, "jobs", "discovered", "d.md"), `url: ${url}\n`, "utf8");
    await fs.writeFile(
      path.join(root, "gather_state.json"),
      JSON.stringify({ seen_urls: { [url]: { decision: "rejected", first_seen: "t" } }, per_company: {} }, null, 2),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R4"] });
    expect(findings.some((f) => f.row === "R4" && !f.applied)).toBe(true);
    await expect(fs.stat(path.join(root, "jobs", "discovered", "d.md"))).resolves.toBeDefined();
  });

  it("R4: recycled dev/ino with different full identity leaves file alone", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r4-recycle";
    const discPath = path.join(root, "jobs", "discovered", "d.md");
    await fs.writeFile(discPath, `url: ${url}\n`, "utf8");
    const real = fileIdentity(await fs.stat(discPath, { bigint: true }));
    const stale = { ...real, mtimeNs: "1", size: "999" };
    await fs.writeFile(
      path.join(root, "gather_state.json"),
      JSON.stringify(
        {
          seen_urls: {
            [url]: { decision: "rejected", reject_pending: { identity: stale, at: "t" } },
          },
          per_company: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R4"] });
    expect(findings.some((f) => f.row === "R4" && f.message.includes("identity mismatch"))).toBe(true);
    await expect(fs.stat(discPath)).resolves.toBeDefined();
  });

  it("R4b: clears reject_pending when discovered file is gone", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r4b";
    const id = fileIdentity(await fs.stat(path.join(root, "gather_state.json"), { bigint: true }));
    await fs.writeFile(
      path.join(root, "gather_state.json"),
      JSON.stringify(
        {
          seen_urls: {
            [url]: { decision: "rejected", reject_pending: { identity: id, at: "t" } },
          },
          per_company: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R4b"] });
    expect(findings.some((f) => f.row === "R4b" && f.applied)).toBe(true);
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url].reject_pending).toBeUndefined();
  });

  it("R5: completes interrupted submission from queue to applied", async () => {
    const root = await tempRoot();
    const slug = "role-r5";
    const url = "https://ex.test/r5";
    const body = `url: ${url}\n`;
    await fs.writeFile(path.join(root, "jobs", "queue", `${slug}.md`), body, "utf8");
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [{ slug, status: "submitted", queue_file: `jobs/queue/${slug}.md`, url }],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R5"] });
    expect(findings.some((f) => f.row === "R5" && f.applied)).toBe(true);
    await expect(fs.stat(path.join(root, "jobs", "applied", `${slug}.md`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "jobs", "queue", `${slug}.md`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("R6: submitted app with queue_file under applied does not delete applied file", async () => {
    const root = await tempRoot();
    const slug = "acme-eng";
    const body = "url: https://ex.test/applied-only\n";
    const appliedPath = path.join(root, "jobs", "applied", `${slug}.md`);
    await fs.writeFile(appliedPath, body, "utf8");
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [
            {
              slug,
              status: "submitted",
              queue_file: `jobs/applied/${slug}.md`,
              url: "https://ex.test/applied-only",
            },
          ],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    await reconcileAtRunStart(root);
    await expect(fs.stat(appliedPath)).resolves.toBeDefined();
    expect(await fs.readFile(appliedPath, "utf8")).toBe(body);
  });

  it("R6: queue_file pointing at applied prefix reports without deleting", async () => {
    const root = await tempRoot();
    const slug = "role-y";
    const body = "url: https://ex.test/prefix\n";
    await fs.writeFile(path.join(root, "jobs", "applied", `0-${slug}.md`), body, "utf8");
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [
            {
              slug,
              status: "submitted",
              queue_file: `jobs/applied/0-${slug}.md`,
              url: "https://ex.test/prefix",
            },
          ],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R6", "R7"] });
    expect(findings.some((f) => f.row === "R7")).toBe(true);
    await expect(fs.stat(path.join(root, "jobs", "applied", `0-${slug}.md`))).resolves.toBeDefined();
  });

  it("R6: removes duplicate queue copy hard-linked to applied for submitted app", async () => {
    const root = await tempRoot();
    const slug = "role-x";
    const body = "url: https://ex.test/r6\n";
    const queuePath = path.join(root, "jobs", "queue", `0-${slug}.md`);
    const appliedPath = path.join(root, "jobs", "applied", `${slug}.md`);
    await fs.writeFile(queuePath, body, "utf8");
    await fs.link(queuePath, appliedPath);
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [
            {
              slug,
              status: "submitted",
              queue_file: `jobs/queue/0-${slug}.md`,
              url: "https://ex.test/r6",
            },
          ],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R6"] });
    expect(findings.some((f) => f.row === "R6" && f.applied)).toBe(true);
    expect(await fs.stat(queuePath).catch(() => null)).toBeNull();
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(state.applications[0].queue_file).toBe(`jobs/applied/${slug}.md`);
  });

  it("R7: repoints queue_file when file only exists under applied", async () => {
    const root = await tempRoot();
    const slug = "role-r7";
    const url = "https://ex.test/r7";
    const body = `url: ${url}\n`;
    await fs.writeFile(path.join(root, "jobs", "applied", `${slug}.md`), body, "utf8");
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [
            {
              slug,
              status: "submitted",
              queue_file: `jobs/queue/${slug}.md`,
              url,
            },
          ],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R7"] });
    expect(findings.some((f) => f.row === "R7" && f.applied)).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(state.applications[0].queue_file).toBe(`jobs/applied/${slug}.md`);
  });

  it("R8: applied file without submitted state is report-only", async () => {
    const root = await tempRoot();
    const slug = "orphan-applied";
    await fs.writeFile(path.join(root, "jobs", "applied", `${slug}.md`), "url: https://ex.test/r8\n", "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R8"] });
    expect(findings.some((f) => f.row === "R8")).toBe(true);
    expect(findings.some((f) => f.row === "R8" && f.applied)).toBe(false);
    await expect(fs.stat(path.join(root, "jobs", "applied", `${slug}.md`))).resolves.toBeDefined();
  });

  it("R9: regenerates stale APPLIED.md from state.json", async () => {
    const root = await tempRoot();
    const slug = "tracked";
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          applications: [{ slug, status: "submitted", company: "Co", title: "Eng", url: "https://ex.test/r9" }],
          addresses: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(root, "APPLIED.md"), "# stale\n", "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R9"] });
    expect(findings.some((f) => f.row === "R9" && f.applied)).toBe(true);
    const tracker = await fs.readFile(path.join(root, "APPLIED.md"), "utf8");
    expect(tracker).toContain("Eng");
    expect(tracker).not.toBe("# stale\n");
  });

  it("R10: records discovered file missing from seen_urls", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r10";
    await fs.writeFile(path.join(root, "jobs", "discovered", "miss.md"), `url: ${url}\n`, "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R10"] });
    expect(findings.some((f) => f.row === "R10" && f.applied)).toBe(true);
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url].decision).toBe("discovered");
  });

  it("R11: corrupt state aborts without changing files", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "", "utf8");
    const before = await fs.readFile(path.join(root, "state.json"));
    const findings = await reconcileWorkspace(root, { apply: true });
    expect(findings.some((f) => f.row === "R11")).toBe(true);
    expect(findings.some((f) => f.applied)).toBe(false);
    expect(await fs.readFile(path.join(root, "state.json"))).toEqual(before);
  });

  it("R12: removes stale temp files matching workspace patterns", async () => {
    const root = await tempRoot();
    const stale = path.join(root, ".state.json.999.old.tmp");
    await fs.writeFile(stale, "x", "utf8");
    const past = Date.now() - 11 * 60 * 1000;
    await fs.utimes(stale, past / 1000, past / 1000);
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R12"] });
    expect(findings.some((f) => f.row === "R12" && f.applied)).toBe(true);
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("run-start reconcile skips busy lock without waiting", async () => {
    const root = await tempRoot();
    const body = "url: https://ex.test/r1\n";
    await fs.writeFile(path.join(root, "jobs", "discovered", "a.md"), body, "utf8");
    await fs.writeFile(path.join(root, "jobs", "queue", "a.md"), body, "utf8");
    const gatherPath = path.join(root, "gather_state.json");
    await fs.mkdir(`${gatherPath}.lock`);
    const started = Date.now();
    const findings = await reconcileAtRunStart(root);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(findings.some((f) => f.row === "R1" && f.skipped)).toBe(true);
    await fs.rm(`${gatherPath}.lock`, { recursive: true, force: true });
  });

  it("corrupt gather_state with duplicate discovered+queue does not throw", async () => {
    const root = await tempRoot();
    const body = "url: https://ex.test/beta\n";
    await fs.writeFile(path.join(root, "jobs", "discovered", "beta.md"), body, "utf8");
    await fs.writeFile(path.join(root, "jobs", "queue", "beta.md"), body, "utf8");
    await fs.writeFile(path.join(root, "gather_state.json"), "not json", "utf8");
    const findings = await reconcileAtRunStart(root);
    expect(findings.some((f) => f.row === "R11")).toBe(true);
    await expect(fs.stat(path.join(root, "jobs", "discovered", "beta.md"))).resolves.toBeDefined();
  });

  it("R12 does not scan .browser-data for stale temps", async () => {
    const root = await tempRoot();
    const browserDir = path.join(root, ".browser-data");
    await fs.mkdir(browserDir, { recursive: true });
    const stale = path.join(browserDir, ".profile.old.tmp");
    await fs.writeFile(stale, "x", "utf8");
    const past = Date.now() - 11 * 60 * 1000;
    await fs.utimes(stale, past / 1000, past / 1000);
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R12"] });
    // The browser profile is out of scope, so nothing is found and nothing is reported.
    expect(findings.some((f) => f.row === "R12")).toBe(false);
    await expect(fs.stat(stale)).resolves.toBeDefined();
  });

  it("R13 records observed submission and R5 completes in one pass", async () => {
    const root = await tempRoot();
    const slug = "obs-role";
    await fs.mkdir(path.join(root, ".pi-jobs", "observed"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".pi-jobs", "observed", `${slug}.json`),
      JSON.stringify({
        slug,
        state: "submitted",
        source: "greenhouse_submit_script",
        at: "2026-06-01T12:00:00.000Z",
        runId: "run-1",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        applications: [{ slug, status: "in_progress", queue_file: `jobs/queue/${slug}.md` }],
        addresses: {},
      }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "jobs", "queue", `${slug}.md`), "url: https://ex.test/o\n", "utf8");
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R13", "R5"] });
    expect(findings.some((f) => f.row === "R13" && f.applied)).toBe(true);
    expect(findings.some((f) => f.row === "R5" && f.applied)).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("submitted");
    expect(state.applications[0].queue_file).toBe(`jobs/applied/${slug}.md`);
  });

  it("R13 ignores observation older than reopened_at", async () => {
    const root = await tempRoot();
    const slug = "reopened-role";
    await fs.mkdir(path.join(root, ".pi-jobs", "observed"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".pi-jobs", "observed", `${slug}.json`),
      JSON.stringify({
        slug,
        state: "submitted",
        source: "greenhouse_submit_script",
        at: "2026-06-01T10:00:00.000Z",
        runId: "run-1",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        applications: [
          {
            slug,
            status: "in_progress",
            reopened_at: "2026-06-01T12:00:00.000Z",
          },
        ],
        addresses: {},
      }),
      "utf8",
    );
    const findings = await reconcileWorkspace(root, { apply: true, rows: ["R13"] });
    expect(findings.some((f) => f.row === "R13" && f.message.includes("reopened_at"))).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(state.applications[0].status).toBe("in_progress");
  });

  it("run-start applies only R1 R13 R5 R6 R7 R12 rows", async () => {
    const root = await tempRoot();
    const url = "https://ex.test/r10";
    await fs.writeFile(path.join(root, "jobs", "discovered", "miss.md"), `url: ${url}\n`, "utf8");
    const findings = await reconcileAtRunStart(root);
    const rows = new Set(findings.map((f) => f.row));
    for (const r of rows) {
      expect(["R1", "R13", "R5", "R6", "R7", "R12"]).toContain(r);
    }
    const gather = JSON.parse(await fs.readFile(path.join(root, "gather_state.json"), "utf8"));
    expect(gather.seen_urls[url]).toBeUndefined();
  });
});
