import { describe, expect, it } from "vitest";
import { overviewResourceLoadFlags } from "../overviewLoadState";
import type { Overview } from "../../shared/types";

const healthyOverview: Overview = {
  applications: {
    total: 2,
    tracked: 1,
    estimated: 1,
    byApplyState: { submitted: 1, in_progress: 0, failed: 0 },
    byPipelineStatus: { submitted: 1, interviewing: 0, rejected: 0, offer: 0, unknown: 0 },
  },
  accounts: 1,
  addresses: 1,
  queue: 1,
  discovered: 1,
  lastFullGather: null,
  captchaSolver: "off",
  corrupt: [],
};

describe("overviewResourceLoadFlags", () => {
  it("marks applications and accounts loaded when corrupt files are reported", () => {
    const overview: Overview = {
      ...healthyOverview,
      applications: null,
      accounts: null,
      corrupt: ["state.json", "credentials.json"],
    };
    const flags = overviewResourceLoadFlags(overview, 0, 0);
    expect(flags.overviewLoaded).toBe(true);
    expect(flags.applicationsLoaded).toBe(true);
    expect(flags.accountsLoaded).toBe(true);
  });

  it("stays unloaded until overview arrives", () => {
    const flags = overviewResourceLoadFlags(null, 5, 3);
    expect(flags.overviewLoaded).toBe(false);
    expect(flags.applicationsLoaded).toBe(false);
    expect(flags.accountsLoaded).toBe(false);
  });
});
