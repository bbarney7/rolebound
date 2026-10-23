import { describe, expect, it } from "vitest";
import { parseProfile } from "../../../.pi/extensions/lib/profile";
import { FIXTURE_LIVE_SHAPED_PROFILE, FIXTURE_PROFILE_TEMPLATE } from "./helpers";
import {
  countTableRows,
  findSection,
  hasTopLevelHeading,
  indexSections,
  insertSection,
  normalizeHeading,
  readBullets,
  replaceSectionBody,
  setBulletValues,
} from "../profileText";
import { resolveOverridePath } from "../readers/profile";
import { addressRows, resumeReachability, resumeRuleGaps } from "../readers/library";
import type { Address, ProfileCityRuleView, ProfileSectionId } from "../../shared/types";

/**
 * NO FIXTURE WORKSPACE, NO `fs`, NO SERVER — strings in, strings out.
 *
 * `profileText.ts` is the correctness core and it is pure, which is what makes
 * this suite exhaustive and fast. The two library joins are tested here too,
 * for the same reason and with one bonus: constructed inputs can exhibit the
 * `override` and `shadowed` reachability states, which the template-seeded
 * route fixture cannot reach at all (the template ships its resume-path bullet
 * inside an HTML comment).
 *
 * Case numbers are the plan's (9.1–9.39) and are kept as labels so a reviewer
 * can map each assertion back to the spec it exists for.
 */

const TPL = FIXTURE_PROFILE_TEMPLATE;
const LIVE_SHAPED = FIXTURE_LIVE_SHAPED_PROFILE;

/** The four warning strings `parseProfile` can emit, verbatim. */
const WARN_NO_IDENTITY =
  "profile.md has no `## Identity` section — emails and name are unavailable to the extensions.";
const WARN_NO_EMAIL =
  "profile.md `## Identity` has no `- **Email:**` bullet — ATS account creation cannot pick an address.";
const WARN_NO_CITY_RULES =
  "profile.md has no `## City → Address rules` section — only Remote roles will resolve a location.";

const ALL_IDS: ProfileSectionId[] = [
  "identity",
  "resume",
  "resumeRegionRules",
  "cityRules",
  "cityNormalization",
  "workHistory",
  "education",
  "authorization",
  "qaBank",
  "searchPreferences",
  "candidateSummary",
  "addressPolicy",
];

function presentIds(md: string): ProfileSectionId[] {
  return ALL_IDS.filter((id) => findSection(md, id) !== null);
}

/** Delete a whole section (heading through bodyWithSubsections) from `md`. */
function dropSection(md: string, id: ProfileSectionId): string {
  const span = findSection(md, id);
  if (!span) throw new Error(`no ${id} to drop`);
  return md.slice(0, span.headingStart) + md.slice(span.bodyWithSubsectionsEnd);
}

/** The indices of the lines that differ between two strings. */
function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

function okText(result: ReturnType<typeof setBulletValues>): string {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.text;
}

function qaSlice(md: string): string {
  const span = findSection(md, "qaBank");
  if (!span) throw new Error("no qaBank");
  return md.slice(span.bodyStart, span.bodyWithSubsectionsEnd);
}

// ── Locator ─────────────────────────────────────────────────────────────────

describe("indexSections — the locator", () => {
  it("9.1 indexes every ##/### heading in the template with the right level and 1-based line", () => {
    const spans = indexSections(TPL)
      .filter((s) => s.level >= 2)
      .map((s) => [s.level, s.line, s.heading]);
    expect(spans).toEqual([
      [2, 10, "Identity"],
      [2, 22, "Resume"],
      [3, 33, "Resume region rules (`resume_key`)"],
      [2, 43, "City → Address rules (`address_city_key`)"],
      [3, 59, "City normalization rules"],
      [2, 67, "Work history"],
      [3, 69, "<Job title> · <Company> · <YYYY-MM> – Present"],
      [3, 76, "<Previous job title> · <Company> · <YYYY-MM> – <YYYY-MM>"],
      [2, 81, "Education"],
      [2, 86, "Authorization"],
      [2, 92, "Q&A bank"],
      [3, 117, "EEO / self-identification defaults"],
      [3, 128, "Open-ended question defaults"],
      [2, 137, "Job search preferences"],
      [2, 147, "Candidate summary"],
      [2, 172, "Address policy reminder"],
    ]);
    // The H1 preamble is indexed too, and matches no section id.
    expect(indexSections(TPL)[0]).toMatchObject({ level: 1, line: 1, heading: "Applicant Profile" });
  });

  it("9.2 reports the live-shaped profile's three drifted sections absent and the other nine present", () => {
    expect(presentIds(LIVE_SHAPED)).toEqual([
      "identity",
      "resume",
      "cityRules",
      "cityNormalization",
      "workHistory",
      "education",
      "authorization",
      "qaBank",
      "addressPolicy",
    ]);
    for (const id of ["resumeRegionRules", "searchPreferences", "candidateSummary"] as const) {
      expect(findSection(LIVE_SHAPED, id), id).toBeNull();
    }
  });

  it("9.3 normalizes `Q&A bank` to `q a bank` and finds the section", () => {
    expect(normalizeHeading("Q&A bank")).toBe("q a bank");
    expect(findSection(TPL, "qaBank")?.heading).toBe("Q&A bank");
    // The matcher accepts the other spelling too, since the `&` is what collapses.
    expect(findSection("## QA bank\n\ntext\n", "qaBank")).not.toBeNull();
  });

  it("9.4 finds `## Resume` by the exact matcher and does NOT match `### Resume region rules`", () => {
    // Pins profile.ts:245 — the parser's own predicate is `h === "resume"`.
    expect(findSection(TPL, "resume")?.line).toBe(22);
    expect(findSection(TPL, "resumeRegionRules")?.line).toBe(33);
    // A file carrying ONLY the region-rules heading has no `## Resume` at all,
    // which is what a substring matcher would get wrong.
    const rulesOnly = "## Work history\n\n### Resume region rules (`resume_key`)\n\n| a | b |\n";
    expect(findSection(rulesOnly, "resume")).toBeNull();
    expect(findSection(rulesOnly, "resumeRegionRules")).not.toBeNull();
    expect(normalizeHeading("Resume region rules (`resume_key`)")).toBe(
      "resume region rules resumekey",
    );
  });

  it("9.5 finds the city-rules heading through its backticks and its arrow", () => {
    const span = findSection(TPL, "cityRules");
    expect(span?.heading).toBe("City → Address rules (`address_city_key`)");
    // `_` is stripped BEFORE non-alphanumerics collapse, exactly as
    // profile.ts:105-111 does it, so `address_city_key` folds to one token.
    expect(normalizeHeading(span!.heading)).toBe("city address rules addresscitykey");
  });

  it("9.6 reports a heading inside an HTML comment ABSENT, single-line and multi-line", () => {
    expect(findSection("# Doc\n\n<!-- ## Identity -->\n\ntext\n", "identity")).toBeNull();
    expect(findSection("# Doc\n\n<!--\n## Identity\n\n- **Email:** a@b.c\n-->\n", "identity")).toBeNull();
    // and the mask does not eat the rest of the file
    expect(findSection("<!--\n## Identity\n-->\n## Resume\n", "resume")).not.toBeNull();
  });

  it("9.37 finds `<!-- note -->## Resume`, and a trailing comment still normalizes to the bare text", () => {
    // The parser REMOVES comment bytes before splitting, so this is a heading at
    // column 0 to the agent; a same-length spaced mask alone would miss it.
    const leading = "<!-- note -->## Resume\n\nbody\n";
    expect(findSection(leading, "resume")).not.toBeNull();
    expect(findSection(leading, "resume")?.headingStart).toBe(13);

    const trailing = "## Resume <!-- ask first -->\n\nbody\n";
    const span = findSection(trailing, "resume");
    expect(span).not.toBeNull();
    // `heading` keeps the RAW on-disk text; matching uses the comment-removed form.
    expect(span?.heading).toBe("Resume <!-- ask first -->");
    expect(normalizeHeading(span!.heading)).toBe("resume");
  });

  it("9.7 stops `body` at the next heading of any level and `bodyWithSubsections` at same-or-higher", () => {
    const work = findSection(TPL, "workHistory")!;
    const lines = TPL.split("\n");
    // body ends at `### <Job title>` (line 69), bodyWithSubsections at `## Education` (81)
    const offsetOfLine = (n: number) =>
      lines.slice(0, n - 1).reduce((acc, l) => acc + l.length + 1, 0);
    expect(work.bodyEnd).toBe(offsetOfLine(69));
    expect(work.bodyWithSubsectionsEnd).toBe(offsetOfLine(81));
    expect(TPL.slice(work.bodyStart, work.bodyEnd)).not.toContain("### <Job title>");
    expect(TPL.slice(work.bodyStart, work.bodyWithSubsectionsEnd)).toContain("### <Job title>");
  });
});

// ── Bullets ─────────────────────────────────────────────────────────────────

describe("readBullets", () => {
  it("9.8 returns an italic-only value with its raw text intact, which parseBullets drops", () => {
    const bullets = readBullets(TPL, findSection(TPL, "identity")!);
    const github = bullets.find((b) => b.key === "github");
    expect(github).toEqual({
      key: "github",
      label: "GitHub",
      value: '*(none — skip if optional; if required, leave blank or "N/A")*',
    });
    // ...and the parser genuinely does not carry it, which is why this matters.
    expect(Object.values(parseProfile(TPL).identity)).not.toContain(github!.value);
    expect(bullets.map((b) => b.key)).toEqual([
      "full name",
      "preferred name / first name on forms",
      "email",
      "fallback email",
      "phone",
      "linkedin",
      "github",
      "portfolio / website",
      "pronouns",
    ]);
  });

  it("9.9 skips a commented-out bullet", () => {
    // The template's `- **Resume path:**` bullet ships inside an HTML comment.
    expect(readBullets(TPL, findSection(TPL, "resume")!)).toEqual([]);
    expect(parseProfile(TPL).resumePath).toBeNull();
  });

  it("9.10 parses the full-width colon form, inside and outside the bold run", () => {
    const inside = "## Identity\n\n- **Email：** a@b.c\n";
    expect(readBullets(inside, findSection(inside, "identity")!)).toEqual([
      { key: "email", label: "Email", value: "a@b.c" },
    ]);
    const outside = "## Identity\n\n- **Email**： a@b.c\n";
    expect(readBullets(outside, findSection(outside, "identity")!)).toEqual([
      { key: "email", label: "Email", value: "a@b.c" },
    ]);
  });
});

// ── setBulletValues ─────────────────────────────────────────────────────────

describe("setBulletValues", () => {
  it("9.33 keeps a bullet's trailing HTML comment byte-for-byte when its value is set", () => {
    const md = "## Identity\n\n- **Email:** old <!-- ask before changing -->\n- **Phone:** 1\n";
    const out = okText(setBulletValues(md, "identity", { email: "new@example.com" }));
    expect(out).toContain("<!-- ask before changing -->");
    expect(out.split("\n")[2]).toBe("- **Email:** new@example.com<!-- ask before changing -->");
    expect(out.split("\n")[3]).toBe("- **Phone:** 1");
  });

  it("9.11 changes exactly one line when one value is set", () => {
    const out = okText(setBulletValues(TPL, "identity", { email: "jane@example.com" }));
    expect(changedLines(TPL, out)).toEqual([13]); // 0-based; template line 14
    expect(out.split("\n")[13]).toBe("- **Email:** jane@example.com");
    expect(out.length).not.toBe(TPL.length);
  });

  it("9.12 leaves the italic-only bullets byte-identical when a sibling is edited (AC 4)", () => {
    const out = okText(setBulletValues(TPL, "identity", { phone: "555-0100" }));
    const lines = out.split("\n");
    expect(lines[17]).toBe(TPL.split("\n")[17]); // - **GitHub:** *(none — …)*
    expect(lines[18]).toBe(TPL.split("\n")[18]); // - **Portfolio / website:** *(none — …)*
    expect(changedLines(TPL, out)).toEqual([15]);
  });

  it("9.13 writes an empty value for null and does NOT delete the line (Q6)", () => {
    const out = okText(setBulletValues(TPL, "identity", { email: null }));
    expect(out.split("\n")[13]).toBe("- **Email:** ");
    expect(changedLines(TPL, out)).toEqual([13]);
    expect(readBullets(out, findSection(out, "identity")!).map((b) => b.key)).toContain("email");
  });

  it("9.14 appends a bullet after the last one when the key is absent from the section", () => {
    const out = okText(setBulletValues(TPL, "identity", { Website: "https://example.com" }));
    const lines = out.split("\n");
    expect(lines[19]).toBe("- **Pronouns:** <FILL IN>");
    expect(lines[20]).toBe("- **Website:** https://example.com");
    expect(lines[21]).toBe("");
    expect(lines[22]).toBe("## Resume");
    // and the round-trip finds it under the lowercased key
    expect(readBullets(out, findSection(out, "identity")!).at(-1)).toEqual({
      key: "website",
      label: "Website",
      value: "https://example.com",
    });
  });

  it("9.15 answers NO_SECTION and leaves the original string untouched", () => {
    const before = LIVE_SHAPED;
    const result = setBulletValues(before, "searchPreferences", { "target topics": "ai" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("NO_SECTION");
    expect(before).toBe(LIVE_SHAPED);
  });
});

// ── replaceSectionBody ──────────────────────────────────────────────────────

describe("replaceSectionBody", () => {
  it("9.16 round-trips the Q&A body byte-identically (AC 2's core)", () => {
    const out = okText(replaceSectionBody(TPL, "qaBank", qaSlice(TPL)));
    expect(out).toBe(TPL);
    // the slice carries both `###` subsections (Q2)
    expect(qaSlice(TPL)).toContain("### EEO / self-identification defaults");
    expect(qaSlice(TPL)).toContain("### Open-ended question defaults");
  });

  it("9.17 leaves Education, Authorization, Address policy and the HTML comments byte-identical", () => {
    const span = findSection(TPL, "qaBank")!;
    const out = okText(replaceSectionBody(TPL, "qaBank", "\nreplaced.\n"));
    expect(out.slice(0, span.bodyStart)).toBe(TPL.slice(0, span.bodyStart));
    expect(out.slice(out.indexOf("## Job search preferences"))).toBe(
      TPL.slice(span.bodyWithSubsectionsEnd),
    );
    for (const marker of [
      "## Education",
      "## Authorization",
      "## Address policy reminder",
      "<!-- - **Resume path:** `resumes/default.pdf` -->",
      "Everything below this comment, verbatim, is what the gatherer sends",
    ]) {
      expect(out, marker).toContain(marker);
    }
    // the four unparsed sections still parse identically for the agent
    expect(parseProfile(out).warnings).toEqual(parseProfile(TPL).warnings);
  });

  it("9.18 appends exactly one trailing newline, and a second write of the result is a no-op", () => {
    const trimmed = qaSlice(TPL).replace(/\n+$/, "");
    const first = okText(replaceSectionBody(TPL, "qaBank", trimmed));
    expect(qaSlice(first)).toBe(`${trimmed}\n`);
    expect(first).toContain(`${trimmed}\n## Job search preferences`);
    const second = okText(replaceSectionBody(first, "qaBank", qaSlice(first)));
    expect(second).toBe(first);
  });

  it("9.19 rejects a `## ` line as BAD_BODY and accepts a `### ` one", () => {
    const bad = replaceSectionBody(TPL, "qaBank", "\n## Injected\n\ntext\n");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error.code).toBe("BAD_BODY");
    const alsoBad = replaceSectionBody(TPL, "qaBank", "\n# Injected\n");
    expect(alsoBad.ok === false && alsoBad.error.code).toBe("BAD_BODY");
    const good = replaceSectionBody(TPL, "qaBank", "\n### Sub\n\ntext\n");
    expect(good.ok).toBe(true);
    expect(okText(good)).toContain("### Sub");
  });

  it("9.38 rejects `<!-- note -->## Injected`, because the guard runs on the comment-removed line", () => {
    const smuggled = replaceSectionBody(TPL, "qaBank", "\n<!-- note -->## Injected\n");
    expect(smuggled.ok).toBe(false);
    expect(smuggled.ok === false && smuggled.error.code).toBe("BAD_BODY");
    expect(hasTopLevelHeading("<!-- note -->## Injected")).toBe(true);
    expect(hasTopLevelHeading("### Sub")).toBe(false);
    // ...and the parser really would read it as a section, which is the point.
    expect(indexSections("<!-- note -->## Injected\n")).toHaveLength(1);
  });
});

// ── Parity with the parser (the drift guard for normalizeHeading) ───────────

describe("parity between the locator and parseProfile", () => {
  it("9.20 agrees when `## Identity` is removed", () => {
    const md = dropSection(TPL, "identity");
    expect(parseProfile(md).warnings).toContain(WARN_NO_IDENTITY);
    expect(findSection(md, "identity")).toBeNull();
  });

  it("9.21 agrees when `## City → Address rules` is removed", () => {
    const md = dropSection(TPL, "cityRules");
    expect(parseProfile(md).warnings).toContain(WARN_NO_CITY_RULES);
    expect(findSection(md, "cityRules")).toBeNull();
  });

  it("9.22 the unmodified template yields exactly one warning and every section present", () => {
    expect(parseProfile(TPL).warnings).toEqual([WARN_NO_EMAIL]);
    expect(presentIds(TPL)).toEqual(ALL_IDS);
  });

  it("9.23 the live-shaped profile yields ZERO warnings with three sections absent — the inversion", () => {
    expect(parseProfile(LIVE_SHAPED).warnings).toEqual([]);
    expect(presentIds(LIVE_SHAPED)).toHaveLength(9);
  });
});

// ── insertSection ───────────────────────────────────────────────────────────

describe("insertSection", () => {
  it("9.24 places `## Job search preferences` before Address policy and after the Q&A bank", () => {
    const out = okText(insertSection(LIVE_SHAPED, "searchPreferences", TPL));
    expect(out.indexOf("## Q&A bank")).toBeLessThan(out.indexOf("## Job search preferences"));
    expect(out.indexOf("## Job search preferences")).toBeLessThan(
      out.indexOf("## Address policy reminder"),
    );
    expect(parseProfile(out).topics).toEqual([
      "ai",
      "agentic",
      "agent",
      "ml",
      "machine learning",
      "llm",
      "platform",
      "inference",
    ]);
    // every other byte is unchanged
    const at = out.indexOf("## Job search preferences");
    const block = out.slice(at, out.indexOf("## Address policy reminder"));
    expect(out.replace(block, "")).toBe(LIVE_SHAPED);
  });

  it("9.25 appends at EOF when every template successor is absent", () => {
    const md = dropSection(LIVE_SHAPED, "addressPolicy");
    const out = okText(insertSection(md, "candidateSummary", TPL));
    expect(out.startsWith(md)).toBe(true);
    expect(out.slice(md.length).startsWith("## Candidate summary")).toBe(true);
  });

  it("9.26 answers SECTION_EXISTS and leaves the original string untouched", () => {
    const before = TPL;
    const result = insertSection(before, "qaBank", TPL);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("SECTION_EXISTS");
    expect(before).toBe(TPL);
  });

  it("9.34 puts the template's FIRST section above everything else", () => {
    const md = "## Resume\n\nA resume note.\n\n## Work history\n\nStuff.\n";
    const out = okText(insertSection(md, "identity", TPL));
    expect(out.startsWith("## Identity")).toBe(true);
    expect(out.endsWith(md)).toBe(true);
  });

  it("9.35 adds exactly one separating newline when the file has none at EOF", () => {
    const md = "## Identity\n\n- **Email:** a@b.c";
    const out = okText(insertSection(md, "addressPolicy", TPL));
    expect(out).toContain("- **Email:** a@b.c\n## Address policy reminder");
    expect(out).not.toContain("a@b.c\n\n## Address policy reminder");
    expect(out.slice(0, md.length)).toBe(md);
  });

  it("9.36 places by TEMPLATE order even when the file's own order disagrees", () => {
    const md = [
      "## Identity",
      "",
      "- **Email:** a@b.c",
      "",
      "## Candidate summary",
      "",
      "A summary.",
      "",
      "## Q&A bank",
      "",
      "Answers.",
      "",
    ].join("\n");
    const out = okText(insertSection(md, "searchPreferences", TPL));
    // Template successors are Candidate summary then Address policy; Candidate
    // summary is present, so the new section lands before it — and therefore
    // before Q&A, which the file happens to place last. Deliberate.
    expect(out.indexOf("## Job search preferences")).toBeLessThan(
      out.indexOf("## Candidate summary"),
    );
    expect(out.indexOf("## Candidate summary")).toBeLessThan(out.indexOf("## Q&A bank"));
  });
});

// ── countTableRows ──────────────────────────────────────────────────────────

describe("countTableRows", () => {
  it("counts data rows excluding the header and the separator", () => {
    expect(countTableRows(TPL, findSection(TPL, "cityRules")!)).toBe(3);
    expect(parseProfile(TPL).cityRules).toHaveLength(2); // `default` is skipped
    expect(countTableRows(LIVE_SHAPED, findSection(LIVE_SHAPED, "cityRules")!)).toBe(3);
    expect(countTableRows(TPL, findSection(TPL, "identity")!)).toBe(0);
  });
});

// ── Library joins ───────────────────────────────────────────────────────────

const DIR = "/ws/resumes";
const RULES = [{ key: "denver" }, { key: "chicago" }];

describe("resumeReachability", () => {
  it("9.27 produces all five states from constructed inputs", () => {
    // No override: default / region / orphan.
    expect(resumeReachability("default.pdf", RULES, null, DIR)).toBe("default");
    expect(resumeReachability("denver.pdf", RULES, null, DIR)).toBe("region");
    expect(resumeReachability("stale.pdf", RULES, null, DIR)).toBe("orphan");
    // Override inside the directory: override / shadowed. The five states
    // cannot co-exist in one call by construction — an active override IS what
    // makes a would-be `default` shadowed.
    const pinned = `${DIR}/denver.pdf`;
    expect(resumeReachability("denver.pdf", RULES, pinned, DIR)).toBe("override");
    expect(resumeReachability("default.pdf", RULES, pinned, DIR)).toBe("shadowed");
  });

  it("9.28 shadows every .pdf and names no override when the override resolves outside resumes/", () => {
    const outside = "/Users/someone/Downloads/Resume.pdf";
    const names = ["default.pdf", "denver.pdf", "stale.pdf"];
    for (const name of names) {
      expect(resumeReachability(name, RULES, outside, DIR), name).toBe("shadowed");
    }
    expect(names.map((n) => resumeReachability(n, RULES, outside, DIR))).not.toContain("override");
    // The .docx in the same directory is untouched by the override branch.
    expect(resumeReachability("old.docx", RULES, outside, DIR)).toBe("orphan");
  });

  it("9.39 marks a RELATIVE override back into resumes/ as the override, others shadowed", () => {
    const resolved = resolveOverridePath("/ws", "resumes/default.pdf");
    expect(resolved).toBe("/ws/resumes/default.pdf");
    expect(resumeReachability("default.pdf", RULES, resolved, DIR)).toBe("override");
    expect(resumeReachability("denver.pdf", RULES, resolved, DIR)).toBe("shadowed");
    // an absolute override stands as-is
    expect(resolveOverridePath("/ws", "/abs/other.pdf")).toBe("/abs/other.pdf");
  });

  it("9.29 keeps a non-PDF an orphan even with a matching rule and an active override", () => {
    const withOldRule = [...RULES, { key: "old" }];
    expect(resumeReachability("old.docx", withOldRule, null, DIR)).toBe("orphan");
    expect(resumeReachability("old.docx", withOldRule, `${DIR}/old.docx`, DIR)).toBe("orphan");
    // The rule below it is what makes the precedence visible: the .pdf of the
    // same key IS reachable.
    expect(resumeReachability("old.pdf", withOldRule, null, DIR)).toBe("region");
  });

  it("9.30 names `chicago` as a rule gap", () => {
    expect(resumeRuleGaps(["default.pdf", "denver.pdf", "stale.pdf", "old.docx"], RULES)).toEqual([
      { key: "chicago", expectedFile: "resumes/chicago.pdf" },
    ]);
    expect(resumeRuleGaps(["denver.pdf", "chicago.pdf"], RULES)).toEqual([]);
  });
});

describe("addressRows", () => {
  const rules: ProfileCityRuleView[] = [
    { key: "denver", city: "Denver", state: "CO", zips: ["80202"] },
    { key: "chicago", city: "Chicago", state: "IL", zips: ["60601"] },
  ];
  const address = (cityKey: string, city: string, state: string, zip: string): Address => ({
    cityKey,
    street: "1 Main St",
    city,
    state,
    zip,
  });

  it("9.31 resolves, pends and orphans", () => {
    const rows = addressRows(rules, [
      address("denver", "Denver", "CO", "80202"),
      address("tampa", "Tampa", "FL", "33602"),
    ]);
    expect(rows.map((r) => [r.key, r.ruleState])).toEqual([
      ["denver", "resolved"],
      ["chicago", "pending"],
      ["tampa", "orphan"],
    ]);
    expect(rows[0].address?.zip).toBe("80202");
    expect(rows[1].address).toBeNull();
    expect(rows[1].zips).toEqual(["60601"]);
  });

  it("9.32 never flags `default` as an orphan (the profile.ts:271 regression)", () => {
    const rows = addressRows(rules, [address("default", "Denver", "CO", "80202")]);
    const row = rows.find((r) => r.key === "default");
    expect(row?.ruleState).toBe("resolved");
    expect(rows.map((r) => r.ruleState)).not.toContain("orphan");
  });
});
