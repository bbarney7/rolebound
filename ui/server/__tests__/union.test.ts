import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixtureWorkspace, rmFixtureWorkspace } from "./helpers";
import { getApplication, listApplications } from "../union";
import { updateUiState } from "../uiState";

let root: string;

beforeAll(async () => {
  root = await makeFixtureWorkspace();
});

afterAll(async () => {
  await rmFixtureWorkspace(root);
});

describe("history union", () => {
  it("unions state.json and applied md files by slug", async () => {
    const apps = await listApplications(root);
    // 2 tracked + 3 md-only = 5
    expect(apps).toHaveLength(5);
    expect(apps.filter((a) => a.estimated)).toHaveLength(3);
    expect(apps.filter((a) => !a.estimated)).toHaveLength(2);
  });

  it("merges on collision: state authoritative, md supplies posting metadata", async () => {
    const apps = await listApplications(root);
    const acme = apps.find((a) => a.slug === "acme-engineering-manager")!;
    // state.json fields win
    expect(acme.location).toBe("Seattle, WA");
    expect(acme.submittedAt).toBe("2026-07-22T17:05:00.000Z");
    expect(acme.addressUsed?.zip).toBe("98101");
    // md supplies posting metadata
    expect(acme.jobFilePath).toContain("jobs/applied/acme-engineering-manager.md");
    expect(acme.descriptionExcerpt).toContain("Lead the platform team");
    expect(acme.source).toBe("greenhouse"); // from md (state infers it too)
    expect(acme.estimated).toBe(false);
  });

  it("synthesizes md-only entries with the provenance chain", async () => {
    const apps = await listApplications(root);
    // submitted_at frontmatter wins over mtime
    const beta = apps.find((a) => a.slug === "beta-director-data")!;
    expect(beta.estimated).toBe(true);
    expect(beta.applyState).toBe("submitted");
    expect(beta.submittedAt).toBe("2026-07-09T00:14:14.000Z");
    expect(beta.screenshot).toBe("screenshots/beta-director-data-confirmation.png");
    // applied_at when no submitted_at
    const gamma = apps.find((a) => a.slug === "gamma-head-of-ai")!;
    expect(gamma.submittedAt).toBe("2026-06-20T21:41:00.000Z");
    // mtime fallback when neither
    const delta = apps.find((a) => a.slug === "delta-senior-em")!;
    expect(delta.submittedAt).toBeTruthy();
    expect(new Date(delta.submittedAt!).getTime()).toBeGreaterThan(0);
  });

  it("derives pipelineStatus: submitted for submitted, null otherwise", async () => {
    const apps = await listApplications(root);
    const acme = apps.find((a) => a.slug === "acme-engineering-manager")!;
    expect(acme.pipelineStatus).toBe("submitted");
    expect(acme.pipelineExplicit).toBe(false);
    const inprog = apps.find((a) => a.slug === "inprogress-director")!;
    expect(inprog.pipelineStatus).toBeNull();
  });

  it("ui-state overlay wins over derivation and carries notes", async () => {
    await updateUiState(root, (s) => {
      s.applications["acme-engineering-manager"] = {
        pipelineStatus: "interviewing",
        userNotes: "recruiter call scheduled",
        pipelineUpdatedAt: "2026-07-23T00:00:00Z",
      };
    });
    const apps = await listApplications(root);
    const acme = apps.find((a) => a.slug === "acme-engineering-manager")!;
    expect(acme.pipelineStatus).toBe("interviewing");
    expect(acme.pipelineExplicit).toBe(true);
    expect(acme.userNotes).toBe("recruiter call scheduled");
  });

  it("sorts newest submitted first", async () => {
    const apps = await listApplications(root);
    const dates = apps.map((a) => a.submittedAt ?? "");
    const sorted = [...dates].sort((x, y) => y.localeCompare(x));
    expect(dates).toEqual(sorted);
    // delta's synthesized date is its mtime (fixture creation = now), so it may
    // lead; among entries with real dates, acme (2026-07-22) precedes beta (07-09)
    // and gamma (06-20)
    const idx = (slug: string) => apps.findIndex((a) => a.slug === slug);
    expect(idx("acme-engineering-manager")).toBeLessThan(idx("beta-director-data"));
    expect(idx("beta-director-data")).toBeLessThan(idx("gamma-head-of-ai"));
  });

  // The anti-drift proof for D10: getApplication reads 3 files instead of 70+,
  // so it necessarily re-implements listApplications' construction order. This
  // makes any divergence a test failure instead of a production surprise.
  it("getApplication deep-equals the listApplications entry for every slug", async () => {
    const apps = await listApplications(root);
    expect(apps.length).toBeGreaterThan(0);
    for (const expected of apps) {
      const actual = await getApplication(root, expected.slug);
      expect(actual).toEqual(expected);
    }
  });

  it("getApplication returns null for a slug in neither source", async () => {
    expect(await getApplication(root, "no-such-slug")).toBeNull();
  });
});

/**
 * The main fixture has neither a slug-less state entry nor a duplicate slug, so
 * the two fidelity details D10 calls out — coalescing to "unknown" and
 * last-duplicate-wins — would otherwise be untested. This builds a throwaway
 * root containing exactly those two shapes.
 */
describe("getApplication slug-matching fidelity", () => {
  let edge: string;

  beforeAll(async () => {
    const tmp = await fs.realpath(os.tmpdir());
    edge = await fs.mkdtemp(path.join(tmp, "pi-jobs-ui-edge-"));
    await fs.mkdir(path.join(edge, "jobs", "applied"), { recursive: true });
    await fs.writeFile(
      path.join(edge, "state.json"),
      JSON.stringify({
        applications: [
          { status: "submitted", company: "NoSlug", url: "https://x.test/1" },
          { slug: "dupe", status: "submitted", company: "First", url: "https://x.test/2" },
          { slug: "dupe", status: "aborted", company: "Second", url: "https://x.test/3" },
        ],
        addresses: {},
        last_updated: "2026-07-22T19:00:00.000Z",
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(edge, { recursive: true, force: true });
  });

  it("coalesces a missing slug to 'unknown', exactly as the Map key does", async () => {
    const apps = await listApplications(edge);
    const fromList = apps.find((a) => a.slug === "unknown")!;
    expect(fromList).toBeDefined();
    expect(await getApplication(edge, "unknown")).toEqual(fromList);
  });

  it("keeps the LAST duplicate, exactly as bySlug.set does", async () => {
    const apps = await listApplications(edge);
    const fromList = apps.find((a) => a.slug === "dupe")!;
    expect(fromList.company).toBe("Second");
    expect(await getApplication(edge, "dupe")).toEqual(fromList);
  });
});
