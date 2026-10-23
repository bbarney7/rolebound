import { describe, expect, it } from "vitest";
import { matchesApplicationFilter } from "../applicationFilters";
import { searchRouteCounts } from "../chat/SearchRail";
import type { Overview } from "../../shared/types";
describe("search counts and application filters", () => {
  it("opens exactly the states counted by each attention/activity row", () => {
    const states = ["in_progress","queued","paused_for_user","blocked","submitted","blocked","failed"];
    const byApplyState = Object.fromEntries([...new Set(states)].map(s => [s,states.filter(v => v===s).length]));
    const counts = searchRouteCounts({applications:{byApplyState}} as Overview);
    for (const [count,filter] of [["applying","active"],["waiting","waiting"],["attention","attention"],["sent","submitted"]] as const) expect(states.filter(s => matchesApplicationFilter(s,filter))).toHaveLength(counts[count]);
    expect(matchesApplicationFilter("blocked","in_progress")).toBe(false);
    expect(matchesApplicationFilter("failed","failed")).toBe(true);
    expect(matchesApplicationFilter("failed","all")).toBe(true);
  });
});
