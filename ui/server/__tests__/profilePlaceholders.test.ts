import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../../../.pi/extensions/lib/profile";
import {
  PROFILE_PLACEHOLDER_CATALOG,
  analyzeProfilePlaceholders,
  hasExplicitCandidateSummaryBody,
  scoringBlockedByPlaceholders,
  sectionsContainingPlaceholders,
  targetsArePlaceholderOnly,
  textContainsProfilePlaceholder,
} from "../../shared/profilePlaceholders";
import { FIXTURE_LIVE_SHAPED_PROFILE, FIXTURE_PROFILE_TEMPLATE } from "./helpers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const templateMd = readFileSync(path.join(repoRoot, "templates", "profile.template.md"), "utf8");

describe("profile placeholder catalog", () => {
  it("matches every template token in templates/profile.template.md", () => {
    const stripped = templateMd.replace(/<!--[\s\S]*?-->/g, "");
    const tokens = [...new Set([...stripped.matchAll(/<[^>]+>/g)].map((m) => m[0].replace(/\s+/g, " ")))].filter(
      (token) => token !== "<address_city_key>" && token !== "<resume_key>",
    );
    const catalogTokens = new Set(PROFILE_PLACEHOLDER_CATALOG.map((row) => row.token.replace(/\s+/g, " ")));
    for (const token of tokens) {
      expect(catalogTokens.has(token), `missing catalog row for ${token}`).toBe(true);
    }
  });

  for (const row of PROFILE_PLACEHOLDER_CATALOG) {
    it(`detects ${row.token} in ${row.section}`, () => {
      expect(textContainsProfilePlaceholder(row.token)).toBe(true);
    });
  }
});

describe("analyzeProfilePlaceholders", () => {
  it("blocks scoring on work-history placeholders when the candidate summary body is empty", () => {
    const md = `## Identity

- **Full name:** Jane Doe
- **Email:** jane@example.com

## Work history

### <Job title> · <Company> · <YYYY-MM> – Present

## Candidate summary

<!--
guidance only
-->

`;
    const { scoreSections } = analyzeProfilePlaceholders(md);
    expect(scoreSections).toContain("workHistory");
    expect(scoringBlockedByPlaceholders(md)).toMatch(/PROFILE_PLACEHOLDERS/);
  });

  it("does not score-block work history when an explicit candidate summary is present", () => {
    const md = FIXTURE_PROFILE_TEMPLATE.replace(
      "Candidate: <FILL IN name>",
      "Candidate: Jane Doe",
    ).replace(/<FILL IN[^>]*>/g, "filled");
    expect(hasExplicitCandidateSummaryBody(md)).toBe(true);
    const { scoreSections } = analyzeProfilePlaceholders(md);
    expect(scoreSections).not.toContain("workHistory");
  });
});

describe("parseProfile candidate summary fallback", () => {
  it("composes summary from identity and work history when the section body is cleared", () => {
    const md = `# Applicant Profile

## Identity

- **Full name:** Jane Doe
- **Email:** jane@example.com

## Work history

### Staff Engineer · Acme · 2020-01 – Present

Built platforms.

## Candidate summary

<!--
guidance
-->

`;
    const parsed = parseProfile(md);
    expect(parsed.identity.fullName).toBe("Jane Doe");
    expect(parsed.candidateSummary).toContain("Jane Doe");
    expect(parsed.candidateSummary).toContain("Staff Engineer");
    expect(sectionsContainingPlaceholders(md)).toEqual([]);
  });
});

describe("targetsArePlaceholderOnly", () => {
  it("is true only for example-co slugs", () => {
    expect(targetsArePlaceholderOnly([{ slug: "example-co" }, { slug: "example-co" }])).toBe(true);
    expect(targetsArePlaceholderOnly([{ slug: "acme-co" }])).toBe(false);
  });
});
