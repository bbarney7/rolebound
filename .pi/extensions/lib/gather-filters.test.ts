import { describe, expect, it } from "vitest";
import { emptyProfile } from "./profile";
import { filterRulesFromProfile, matchJob } from "./gather-filters";

describe("gather filters", () => {
  it("honors non-engineering target roles from profile preferences", () => {
    const profile = {
      ...emptyProfile(""),
      targetRoles: ["product designer", "design systems"],
      topics: ["ux", "product"],
      targetLocations: ["remote", "united states"],
      cityRules: [],
    };
    const rules = filterRulesFromProfile(profile);
    const hit = matchJob("Staff Product Designer", "UX and product design systems for fintech.", "Remote US", rules);
    expect(hit.pass).toBe(true);
    expect(hit.roleHit).toBe("product designer");
  });

  it("rejects engineering-only defaults when role does not match", () => {
    const rules = filterRulesFromProfile({
      ...emptyProfile(""),
      topics: ["ai"],
      cityRules: [{ key: "default", city: "Remote", state: "", terms: ["remote"], zips: [] }],
    });
    const skip = matchJob("Staff Product Designer", "Design systems role with ai tooling.", "Remote", rules);
    expect(skip.pass).toBe(false);
    expect(skip.match).toBe("skip");
  });

  it("keeps engineering director matches with default heuristics", () => {
    const rules = filterRulesFromProfile({
      ...emptyProfile(""),
      topics: ["ai"],
      cityRules: [{ key: "default", city: "Remote", state: "", terms: ["remote"], zips: [] }],
    });
    const hit = matchJob("Director of AI Engineering", "Build agentic ai platform.", "Remote", rules);
    expect(hit.pass).toBe(true);
    expect(hit.roleHit).toBe("director of engineering");
  });
});
