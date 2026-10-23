import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FIXTURE_LIVE_SHAPED_PROFILE,
  FIXTURE_PROFILE_TEMPLATE,
  makeFixtureWorkspace,
  rmFixtureWorkspace,
} from "./helpers";
import { createApp } from "../app";
import { WATCH_IGNORED } from "../routes/events";
import { profileTempPath } from "../profileWriter";
import { PROFILE_SECTION_IDS } from "../../shared/types";

/**
 * Route and writer coverage. The harness mirrors `queue.test.ts:1-45` and
 * `accounts.test.ts`: one shared `makeFixtureWorkspace()`, `createApp(root)`,
 * `listen(0, "127.0.0.1")`, global `fetch`. No supertest.
 *
 * THE ISOLATION RULE, MECHANICAL AND NON-NEGOTIABLE — it is the round-4 finding
 * from `accounts-view` and it is cheaper to adopt than to rediscover.
 *
 * EVERY CASE THAT MAKES A WRITE THAT LANDS BUILDS ITS OWN FIXTURE, through
 * `ownFixture` below, which stands up its own app and tears the workspace down
 * in a `finally`. Every case is labelled `[shared]` or `[own]`: 35 cases, 16
 * shared and 19 own. If those counts stop matching the list, a case was added
 * without a label. A case that only exercises a 400/404/409 refusal is
 * read-only in effect and may share.
 *
 * Case numbers are the plan's (10.1–10.35) and are kept as labels.
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

const WARN_NO_EMAIL =
  "profile.md `## Identity` has no `- **Email:**` bullet — ATS account creation cannot pick an address.";

interface OwnCtx {
  root: string;
  base: string;
  profile: () => Promise<string>;
}

/** A throwaway workspace + app for one case, torn down whatever happens. */
async function ownFixture(
  run: (ctx: OwnCtx) => Promise<void>,
  prepare?: (root: string) => Promise<void>,
): Promise<void> {
  const ownRoot = await makeFixtureWorkspace();
  try {
    if (prepare) await prepare(ownRoot);
    const app = createApp(ownRoot, { security: { enabled: false } });
    const ownServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = ownServer.address() as AddressInfo;
      await run({
        root: ownRoot,
        base: `http://127.0.0.1:${port}`,
        profile: () => fs.readFile(path.join(ownRoot, "profile.md"), "utf-8"),
      });
    } finally {
      await new Promise((resolve) => ownServer.close(resolve));
    }
  } finally {
    await rmFixtureWorkspace(ownRoot);
  }
}

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  let payload = body;
  if ((method === "PATCH" || method === "PUT") && url.includes("/api/profile/sections/") && body && typeof body === "object") {
    const profileUrl = `${new URL(url).origin}/api/profile`; const current = await (await fetch(profileUrl)).json(); payload = { ...(body as Record<string, unknown>), revision: current.revision };
  }
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

// ── GET ─────────────────────────────────────────────────────────────────────

describe("GET /api/profile", () => {
  it("10.1 [shared] answers 200 with exists:true and the template's single warning", async () => {
    const res = await fetch(`${base}/api/profile`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.templateAvailable).toBe(true);
    // The warnings inversion: the template yields exactly this one.
    expect(body.warnings).toEqual([WARN_NO_EMAIL]);
  });

  it("10.2 [shared] reports all twelve sections present against the template-seeded fixture", async () => {
    const body = await (await fetch(`${base}/api/profile`)).json();
    expect(body.sections.map((s: any) => s.id)).toEqual([...PROFILE_SECTION_IDS]);
    expect(body.sections.every((s: any) => s.present)).toBe(true);
    expect(body.sections.find((s: any) => s.id === "cityRules")).toEqual({
      id: "cityRules",
      heading: "City → Address rules (`address_city_key`)",
      present: true,
      line: 43,
    });
  });

  it("10.3 [own] answers 200 with exists:false and /status's own message when profile.md is absent", async () => {
    await ownFixture(
      async ({ root: r, base: b }) => {
        const res = await fetch(`${b}/api/profile`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.exists).toBe(false);
        expect(body.warnings).toEqual([
          `No profile.md in the workspace (${path.join(r, "profile.md")}). ` +
            "Copy templates/profile.template.md to profile.md and fill it in.",
        ]);
        expect(body.sections.every((s: any) => !s.present && s.heading === null)).toBe(true);
        expect(body.identity).toBeNull();
        expect(body.qaBank).toBeNull();
        expect(body.workHistory).toEqual([]);
        expect(body.templateAvailable).toBe(true);
      },
      (r) => fs.rm(path.join(r, "profile.md")),
    );
  });

  it("10.4 [shared] carries the template's nine identity bullets, italic-only values included", async () => {
    const body = await (await fetch(`${base}/api/profile`)).json();
    expect(body.identity.bullets).toHaveLength(9);
    expect(body.identity.bullets.find((b: any) => b.key === "github")).toEqual({
      key: "github",
      label: "GitHub",
      value: '*(none — skip if optional; if required, leave blank or "N/A")*',
    });
    expect(body.identity.bullets.find((b: any) => b.key === "portfolio / website").value).toContain(
      "*(none",
    );
    // ...and what the agent actually reads is null for both, plus the <FILL IN>s.
    expect(body.identity.parsed.email).toBeNull();
    expect(body.identity.parsed.fullName).toBeNull();
  });

  it("10.5 [shared] hands the Q&A bank both of its ### subsections", async () => {
    const body = await (await fetch(`${base}/api/profile`)).json();
    expect(body.qaBank).toContain("### EEO / self-identification defaults");
    expect(body.qaBank).toContain("### Open-ended question defaults");
    expect(body.qaBank).not.toContain("## Job search preferences");
  });

  it("10.6 [shared] omits `terms` from every city rule", async () => {
    const res = await fetch(`${base}/api/profile`);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.cityRules.length).toBeGreaterThan(0);
    for (const rule of body.cityRules) {
      expect(Object.keys(rule).sort()).toEqual(["city", "key", "state", "zips"]);
    }
    // Re-adding it to the type would fail here rather than shipping the
    // polluted `["seattle", "one of {98101", …]` the three-column table yields.
    expect(JSON.stringify(body.cityRules)).not.toContain("terms");
  });

  it("10.7 [shared] reports 3 raw table rows against 2 usable city rules", async () => {
    const body = await (await fetch(`${base}/api/profile`)).json();
    expect(body.cityRuleTableRows).toBe(3);
    expect(body.cityRules.map((r: any) => r.key)).toEqual(["denver", "chicago"]);
  });

  it("[shared] renders work history read-only from the raw markdown (AC 5)", async () => {
    const body = await (await fetch(`${base}/api/profile`)).json();
    expect(body.workHistory.map((e: any) => e.heading)).toEqual([
      "<Job title> · <Company> · <YYYY-MM> – Present",
      "<Previous job title> · <Company> · <YYYY-MM> – <YYYY-MM>",
    ]);
    expect(body.workHistory[0].lines).toContain("<One-paragraph summary of the role.>");
  });
});

describe("GET /api/resumes", () => {
  it("10.8 [shared] reports the three states the template-seeded fixture can produce", async () => {
    const res = await fetch(`${base}/api/resumes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directoryExists).toBe(true);
    expect(body.files.map((f: any) => [f.name, f.reachability])).toEqual([
      ["default.pdf", "default"],
      ["denver.pdf", "region"],
      ["old.docx", "orphan"],
      ["stale.pdf", "orphan"],
    ]);
    expect(body.ruleGaps).toEqual([{ key: "chicago", expectedFile: "resumes/chicago.pdf" }]);
    // The template ships its resume-path bullet inside an HTML comment, so
    // there is no override here by construction — see 10.35 for the other two.
    expect(body.overrideActive).toBe(false);
    expect(body.overridePath).toBeNull();
    expect(body.files[0].bytes).toBeGreaterThan(0);
    expect(body.files[0].modifiedAt).toMatch(/^\d{4}-/);
  });

  it("10.35 [own] marks a relative override the override and every other .pdf shadowed", async () => {
    await ownFixture(
      async ({ base: b }) => {
        const body = await (await fetch(`${b}/api/resumes`)).json();
        expect(body.overrideActive).toBe(true);
        expect(body.overridePath).toBe("resumes/default.pdf");
        expect(body.overrideExists).toBe(true);
        expect(body.files.map((f: any) => [f.name, f.reachability])).toEqual([
          ["default.pdf", "override"],
          ["denver.pdf", "shadowed"],
          // An override cannot make an unreachable file reachable.
          ["old.docx", "orphan"],
          ["stale.pdf", "shadowed"],
        ]);
      },
      (r) =>
        fs.writeFile(
          path.join(r, "profile.md"),
          FIXTURE_PROFILE_TEMPLATE.replace(
            "<!-- - **Resume path:** `resumes/default.pdf` -->",
            "- **Resume path:** `resumes/default.pdf`",
          ),
        ),
    );
  });

  it("10.9 [own] answers 200 with directoryExists:false when resumes/ is absent", async () => {
    await ownFixture(
      async ({ base: b }) => {
        const res = await fetch(`${b}/api/resumes`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.directoryExists).toBe(false);
        expect(body.files).toEqual([]);
        expect(body.ruleGaps.map((g: any) => g.key)).toEqual(["denver", "chicago"]);
      },
      (r) => fs.rm(path.join(r, "resumes"), { recursive: true }),
    );
  });
});

describe("GET /api/addresses", () => {
  it("10.10 [shared] resolves, pends and orphans — and never orphans `default`", async () => {
    const res = await fetch(`${base}/api/addresses`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stateJsonExists).toBe(true);
    expect(body.stateJsonReadable).toBe(true);
    expect(body.rows.map((r: any) => [r.key, r.ruleState])).toEqual([
      ["denver", "pending"],
      ["chicago", "pending"],
      ["seattle", "orphan"],
      ["tampa", "orphan"],
      ["default", "resolved"],
    ]);
    expect(body.rows[0].zips).toEqual(["80202", "80203", "80206"]);
  });

  it("10.11 [own] answers 200 with stateJsonExists:false when state.json is absent", async () => {
    await ownFixture(
      async ({ base: b }) => {
        const res = await fetch(`${b}/api/addresses`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.stateJsonExists).toBe(false);
        expect(body.stateJsonReadable).toBe(true);
        expect(body.rows.map((r: any) => [r.key, r.ruleState])).toEqual([
          ["denver", "pending"],
          ["chicago", "pending"],
        ]);
      },
      (r) => fs.rm(path.join(r, "state.json")),
    );
  });

  it("10.33 [own] answers 200 for a corrupt state.json, and keeps `[]` readable", async () => {
    await ownFixture(async ({ root: r, base: b }) => {
      const file = path.join(r, "state.json");
      // TWO BODIES FAIL AND ONE DOES NOT, which is the point of testing all three.
      for (const bad of ["{ not json", "null"]) {
        await fs.writeFile(file, bad);
        const res = await fetch(`${b}/api/addresses`);
        expect({ bad, status: res.status }).toEqual({ bad, status: 200 });
        const body = await res.json();
        expect({ bad, exists: body.stateJsonExists, readable: body.stateJsonReadable }).toEqual({
          bad,
          exists: true,
          readable: false,
        });
        expect(body.rows.every((row: any) => row.ruleState === "pending")).toBe(true);
      }
      // `[]` is not a state object under the strict workspace parser.
      await fs.writeFile(file, "[]");
      const res = await fetch(`${b}/api/addresses`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stateJsonReadable).toBe(false);
      expect(body.rows.every((row: any) => row.ruleState === "pending")).toBe(true);
    });
  });
});

// ── PATCH bullets ───────────────────────────────────────────────────────────

const IDENTITY_BULLETS = "/api/profile/sections/identity/bullets";

describe("PATCH /api/profile/sections/:id/bullets", () => {
  it("10.12 [own] clears the warning banner when the Email bullet is filled in", async () => {
    await ownFixture(async ({ base: b }) => {
      const res = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", {
        bullets: { email: "jane@example.com" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The inversion closed — the only end-to-end proof of AC 6.
      expect(body.profile.warnings).toEqual([]);
      expect(body.profile.identity.parsed.email).toBe("jane@example.com");
    });
  });

  it("10.13 [own] changes exactly one line of the file", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const before = await profile();
      const res = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", {
        bullets: { phone: "555-0100" },
      });
      expect(res.status).toBe(200);
      const after = await profile();
      expect(changedLines(before, after)).toEqual([15]);
      expect(after.split("\n")[15]).toBe("- **Phone:** 555-0100");
    });
  });

  it("10.14 [own] leaves the italic bullets, the HTML comment and the four unparsed sections byte-identical", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const before = await profile();
      await send(`${b}${IDENTITY_BULLETS}`, "PATCH", { bullets: { phone: "555-0100" } });
      const after = await profile();
      const strip = (md: string) =>
        md
          .split("\n")
          .filter((l) => !l.startsWith("- **Phone:**"))
          .join("\n");
      // Everything except the one edited line is byte-identical (AC 4).
      expect(strip(after)).toBe(strip(before));
      for (const marker of [
        '- **GitHub:** *(none — skip if optional; if required, leave blank or "N/A")*',
        "<!-- - **Resume path:** `resumes/default.pdf` -->",
        "## Education",
        "## Authorization",
        "## Q&A bank",
        "## Address policy reminder",
      ]) {
        expect(after, marker).toContain(marker);
      }
    });
  });

  it("10.15 [shared] refuses an empty bullets object", async () => {
    const res = await send(`${base}${IDENTITY_BULLETS}`, "PATCH", { bullets: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no fields to update" });
  });

  it("10.16 [shared] refuses a non-string, non-null value and names the field", async () => {
    const res = await send(`${base}${IDENTITY_BULLETS}`, "PATCH", { bullets: { email: 5 } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("bullets");
    expect(body.error).toContain("email");
  });

  it("10.34 [shared] answers JSON, not HTML, for every malformed body shape", async () => {
    // app.ts's only error middleware handles `entity.parse.failed` alone
    // (:53-63); anything uncaught becomes an HTML 500.
    for (const body of [{}, { bullets: null }, { bullets: [] }, []] as unknown[]) {
      const res = await send(`${base}${IDENTITY_BULLETS}`, "PATCH", body);
      const label = JSON.stringify(body);
      expect({ label, status: res.status }).toEqual({ label, status: 400 });
      expect(res.headers.get("content-type")).toContain("application/json");
      expect((await res.json()).field).toBe("bullets");
    }
  });

  it("10.17 [shared] refuses a section id outside the bullet whitelist", async () => {
    for (const id of ["qaBank", "education", "cityRules", "nonsense"]) {
      const res = await send(`${base}/api/profile/sections/${id}/bullets`, "PATCH", {
        bullets: { email: "x@y.z" },
      });
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
      expect(await res.json()).toEqual({ error: "section is not editable", field: "id" });
    }
  });

  it("10.18 [own] answers 409 with no profile.md, and does NOT create one", async () => {
    await ownFixture(
      async ({ root: r, base: b }) => {
        const res = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", {
          bullets: { email: "x@y.z" },
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "profile.md does not exist" });
        // withLock's precondition, asserted rather than assumed: the check runs
        // BEFORE the lock and must not seed the file to make locking work.
        await expect(fs.access(path.join(r, "profile.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      (r) => fs.rm(path.join(r, "profile.md")),
    );
  });

  it("10.19 [own] appends an absent bullet key, and a second identical PATCH is a byte-level no-op", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const first = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", {
        bullets: { Website: "https://example.com" },
      });
      expect(first.status).toBe(200);
      const afterFirst = await profile();
      expect(afterFirst).toContain("- **Pronouns:** <FILL IN>\n- **Website:** https://example.com\n");
      const second = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", {
        bullets: { Website: "https://example.com" },
      });
      expect(second.status).toBe(200);
      expect(await profile()).toBe(afterFirst);
    });
  });
});

// ── PUT body ────────────────────────────────────────────────────────────────

const QA_BODY = "/api/profile/sections/qaBank/body";

describe("PUT /api/profile/sections/:id/body", () => {
  it("10.20 [own] round-trips the Q&A body byte-identically", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const before = await profile();
      const { qaBank } = await (await fetch(`${b}/api/profile`)).json();
      const res = await send(`${b}${QA_BODY}`, "PUT", { body: qaBank });
      expect(res.status).toBe(200);
      expect(await profile()).toBe(before);
    });
  });

  it("10.21 [own] confines a changed body to that one range", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const before = await profile();
      const { qaBank } = await (await fetch(`${b}/api/profile`)).json();
      const next = `${qaBank}\nOne more note.\n`;
      const res = await send(`${b}${QA_BODY}`, "PUT", { body: next });
      expect(res.status).toBe(200);
      const after = await profile();
      const at = before.indexOf(qaBank);
      expect(after.slice(0, at)).toBe(before.slice(0, at));
      expect(after.slice(at + next.length)).toBe(before.slice(at + qaBank.length));
      expect(after).toContain("One more note.");
    });
  });

  it("10.22 [shared] refuses a body carrying a top-level heading, comment-smuggled or not", async () => {
    for (const body of ["\n## Injected\n\ntext\n", "\n<!-- x -->## Injected\n"]) {
      const res = await send(`${base}${QA_BODY}`, "PUT", { body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect((await res.json()).field).toBe("body");
    }
  });

  it("10.23 [own] accepts and WRITES a body containing a ### subsection", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const res = await send(`${b}${QA_BODY}`, "PUT", { body: "\n### Sub\n\nAnswer.\n" });
      expect(res.status).toBe(200);
      const after = await profile();
      expect(after).toContain("## Q&A bank\n\n### Sub\n\nAnswer.\n## Job search preferences");
      expect(after).toContain("## Address policy reminder");
    });
  });

  it("10.24 [shared] refuses bullet-only section ids on the body route", async () => {
    for (const id of ["identity", "searchPreferences"]) {
      const res = await send(`${base}/api/profile/sections/${id}/body`, "PUT", { body: "x\n" });
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
      expect(await res.json()).toEqual({ error: "section is not editable", field: "id" });
    }
  });
});

// ── POST create / add section ───────────────────────────────────────────────

describe("POST /api/profile and /api/profile/sections/:id", () => {
  it("10.25 [own] creates profile.md byte-identical to the template", async () => {
    await ownFixture(
      async ({ base: b, profile }) => {
        const res = await send(`${b}/api/profile`, "POST");
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.profile.exists).toBe(true);
        expect(await profile()).toBe(FIXTURE_PROFILE_TEMPLATE);
      },
      (r) => fs.rm(path.join(r, "profile.md")),
    );
  });

  it("10.26 [own] refuses to create over an existing profile.md and leaves the bytes alone", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const before = await profile();
      const res = await send(`${b}/api/profile`, "POST");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "profile.md already exists" });
      expect(await profile()).toBe(before);
    });
  });

  it("10.27 [own] answers 409 NO_TEMPLATE when templates/ is missing", async () => {
    await ownFixture(
      async ({ base: b }) => {
        const res = await send(`${b}/api/profile`, "POST");
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
          error: "templates/profile.template.md is missing",
        });
      },
      async (r) => {
        await fs.rm(path.join(r, "profile.md"));
        await fs.rm(path.join(r, "templates"), { recursive: true });
      },
    );
  });

  it("10.28 [own] inserts a missing section in template order and touches nothing else", async () => {
    await ownFixture(
      async ({ base: b, profile }) => {
        const before = await profile();
        const res = await send(`${b}/api/profile/sections/searchPreferences`, "POST");
        expect(res.status).toBe(200);
        const after = await profile();
        expect(after.indexOf("## Q&A bank")).toBeLessThan(
          after.indexOf("## Job search preferences"),
        );
        expect(after.indexOf("## Job search preferences")).toBeLessThan(
          after.indexOf("## Address policy reminder"),
        );
        const inserted = after.slice(
          after.indexOf("## Job search preferences"),
          after.indexOf("## Address policy reminder"),
        );
        expect(after.replace(inserted, "")).toBe(before);
      },
      (r) => fs.writeFile(path.join(r, "profile.md"), FIXTURE_LIVE_SHAPED_PROFILE),
    );
  });

  it("10.29 [shared] refuses to add a section that is already present", async () => {
    const res = await send(`${base}/api/profile/sections/qaBank`, "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "section already exists" });
  });

  it("10.30 [shared] refuses POST add when candidateSummary is already present", async () => {
    const res = await send(`${base}/api/profile/sections/candidateSummary`, "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "section already exists" });
  });
});

// ── Atomicity and the watcher ───────────────────────────────────────────────

describe("atomicity", () => {
  it("10.31 [own] leaves no temp file behind, and the name is double-ignored by the watcher", async () => {
    await ownFixture(async ({ root: r, base: b }) => {
      const res = await send(`${b}${IDENTITY_BULLETS}`, "PATCH", { bullets: { phone: "1" } });
      expect(res.status).toBe(200);
      const left = (await fs.readdir(r)).filter((f) => f.startsWith(".profile.") || f.endsWith(".tmp"));
      expect(left).toEqual([]);

      // Asserted against the EXPORTED patterns, not a hand-copied regex, so a
      // change to events.ts surfaces here instead of causing a refresh storm.
      const name = path.basename(profileTempPath(r));
      const rules = WATCH_IGNORED.filter((p): p is RegExp => p instanceof RegExp);
      const matching = rules.filter((rule) => rule.test(name));
      expect(matching).toHaveLength(2);
      // one is the dotfile rule (events.ts:15), the other the .tmp rule (:20)
      expect(matching.some((rule) => rule.test(".dotfile"))).toBe(true);
      expect(matching.some((rule) => rule.test("plain.tmp"))).toBe(true);
    });
  });

  it("10.32 [own] serializes ten concurrent PATCHes so every one lands", async () => {
    // NEGATIVE CONTROL, run once and recorded: replacing `withLock(file, fn)`
    // in mutateProfile with a bare `await fn()` makes this fail — the ten
    // handlers all read the same bytes and the last writer wins.
    const keys = Array.from({ length: 10 }, (_, i) => `Field${String(i + 1).padStart(2, "0")}`);
    const padded = [
      "## Identity",
      "",
      ...keys.map((k) => `- **${k}:** initial`),
      "",
      "## Address policy reminder",
      "",
      ...Array.from({ length: 4000 }, (_, i) => `> padding line ${i} — widening the write window.`),
      "",
    ].join("\n");

    await ownFixture(
      async ({ base: b, profile }) => {
        const results = await Promise.all(
          keys.map((k) =>
            send(`${b}${IDENTITY_BULLETS}`, "PATCH", { bullets: { [k.toLowerCase()]: `set-${k}` } }),
          ),
        );
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        expect(results.filter((r) => r.status === 409)).toHaveLength(9);
        const after = await profile();
        expect(keys.filter((k) => after.includes(`- **${k}:** set-${k}`))).toHaveLength(1);
        expect(after.split("\n").filter((l) => l.startsWith("> padding line"))).toHaveLength(4000);
      },
      (r) => fs.writeFile(path.join(r, "profile.md"), padded),
    );
  }, 30_000);
});


describe("candidate summary body", () => {
  const CANDIDATE_BODY = "/api/profile/sections/candidateSummary/body";

  it("10.36 [own] preserves the HTML comment and writes below it", async () => {
    await ownFixture(async ({ base: b, profile, root: r }) => {
      const revision = (await (await fetch(`${b}/api/profile`)).json()).revision;
      const res = await send(`${b}${CANDIDATE_BODY}`, "PUT", {
        revision,
        body: "Candidate: Jane Doe\n",
      });
      expect(res.status).toBe(200);
      const after = await profile();
      expect(after).toMatch(/<!--[\s\S]*?-->\s*\nCandidate: Jane Doe/);
      const payload = await (await fetch(`${b}/api/profile`)).json();
      expect(payload.markdownBodies.candidateSummary).toBe("Candidate: Jane Doe");
    });
  });

  it("10.37 [own] clearing the editor empties the body below the comment", async () => {
    await ownFixture(async ({ base: b, profile }) => {
      const revision = (await (await fetch(`${b}/api/profile`)).json()).revision;
      await send(`${b}${CANDIDATE_BODY}`, "PUT", { revision, body: "" });
      const after = await profile();
      expect(after).toMatch(/## Candidate summary\n\n<!--[\s\S]*?-->\s*\n## Address policy reminder/);
    });
  });
});
