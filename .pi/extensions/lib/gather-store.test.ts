import { describe, expect, it } from "vitest";
import { mergeGatherResults, upsertSeenUrlCore, type SeenEntry } from "./gather-store";
import type { ParsedGatherState } from "./workspace-files";

describe("gather-store", () => {
  it("mergeGatherResults keeps concurrent promoted decisions", () => {
    const snapshot: Record<string, SeenEntry> = {
      "https://a": { decision: "discovered", first_seen: "1" },
    };
    const current: ParsedGatherState = {
      seen_urls: {
        "https://a": { decision: "promoted", first_seen: "1", extra: "kept" },
      },
      per_company: {},
    };
    const proposed: ParsedGatherState = {
      seen_urls: {
        "https://a": { decision: "discovered", first_seen: "2" },
      },
      per_company: { acme: { matched_count: 1 } },
      last_full_gather: "now",
    };
    const merged = mergeGatherResults(current, snapshot, proposed, ["acme"]);
    expect((merged.seen_urls as Record<string, SeenEntry>)["https://a"].decision).toBe("promoted");
    expect((merged.seen_urls as Record<string, SeenEntry>)["https://a"].extra).toBe("kept");
    expect(merged.per_company.acme).toEqual({ matched_count: 1 });
  });

  it("re-discovery of rejected becomes discovered when snapshot matches", () => {
    const snapshot: Record<string, SeenEntry> = {
      "https://b": { decision: "rejected", first_seen: "1" },
    };
    const current = { seen_urls: { ...snapshot }, per_company: {} };
    const proposed: ParsedGatherState = {
      seen_urls: { "https://b": { decision: "discovered", first_seen: "2" } },
      per_company: {},
    };
    const merged = mergeGatherResults(current, snapshot, proposed, []);
    expect((merged.seen_urls as Record<string, SeenEntry>)["https://b"].decision).toBe("discovered");
  });

  it("upsertSeenUrlCore preserves unknown keys", () => {
    const seen: Record<string, SeenEntry> = {
      u: { decision: "discovered-manual", first_seen: "t" },
    };
    upsertSeenUrlCore(seen, "u", { decision: "promoted" });
    expect(seen.u.decision).toBe("promoted");
    expect(seen.u.first_seen).toBe("t");
  });
});
