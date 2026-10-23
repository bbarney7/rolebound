import { describe, expect, it } from "vitest";
import { parseRoute, pathForRoute } from "../router";

describe("route contract", () => {
  it("parses exact top-level paths", () => {
    expect(parseRoute("/").view).toBe("chat");
    expect(parseRoute("/today").view).toBe("overview");
    expect(parseRoute("/discover").view).toBe("discover");
    expect(parseRoute("/instructions").view).toBe("instructions");
    expect(parseRoute("/settings/accounts").view).toBe("accounts");
    expect(parseRoute("/runs/current").view).toBe("chat");
  });
  it("keeps application and account selection in the URL", () => {
    expect(parseRoute("/applications/fern-field?q=design&status=submitted")).toMatchObject({ view: "applications", slug: "fern-field", search: "design", status: "submitted" });
    expect(parseRoute("/settings/accounts/greenhouse")).toMatchObject({ view: "accounts", accountHost: "greenhouse" });
  });
  it("returns a visible not-found route for near misses", () => {
    expect(parseRoute("/profile-anything").view).toBe("not-found");
    expect(parseRoute("/applications/a/b").view).toBe("not-found");
    expect(parseRoute("/applications/%2e%2e%2fprivate").view).toBe("not-found");
  });
  it("round trips filter state", () => {
    expect(pathForRoute({ view: "chat", tab: "", search: "", status: "all", applyState: "all", from: "", to: "" })).toBe("/");
    expect(pathForRoute({ view: "overview", tab: "", search: "", status: "all", applyState: "all", from: "", to: "" })).toBe("/today");
    expect(pathForRoute({ view: "applications", slug: "fern-field", tab: "", search: "design", status: "submitted", applyState: "paused_for_user", from: "2026-09-01", to: "2026-09-12" })).toBe("/applications/fern-field?q=design&status=submitted&apply=paused_for_user&from=2026-09-01&to=2026-09-12");
    expect(parseRoute("/profile?tab=resumes").tab).toBe("resumes");
  });
});
