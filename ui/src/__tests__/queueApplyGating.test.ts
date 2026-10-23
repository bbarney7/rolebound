import { describe, expect, it } from "vitest";

/** Mirrors `App.tsx` QueueList `applyDisabled`. */
function applyNowDisabled(runActive: boolean, applyReady: boolean | undefined): boolean {
  return runActive || !applyReady;
}

describe("Queue Apply now gating", () => {
  it("is disabled while a run is active", () => {
    expect(applyNowDisabled(true, true)).toBe(true);
  });

  it("is disabled without readiness", () => {
    expect(applyNowDisabled(false, false)).toBe(true);
    expect(applyNowDisabled(false, undefined)).toBe(true);
  });

  it("is enabled when ready and idle", () => {
    expect(applyNowDisabled(false, true)).toBe(false);
  });
});
