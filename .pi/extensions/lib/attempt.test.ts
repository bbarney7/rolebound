/**
 * `resolveAttempt` (lib/attempt.ts) normalises the two shapes
 * `update_application_state` (job-applier.ts) accepts for recording an
 * attempt. AC 7 logged that the model has been sending flat
 * `attempt_outcome`/`attempt_notes` instead of the documented nested
 * `attempt` object, which the tool silently ignored: 7 of 49 submitted
 * applications show an empty `attempts[]`.
 *
 * `resolveAttempt` lives in its own `lib/` module, not inline in
 * job-applier.ts, so this test can import it without pulling job-applier.ts
 * itself into the type-checked program (job-applier.ts sits outside
 * tsconfig.json's `include` list and is not otherwise type-checked; a direct
 * import here would drag in its two pre-existing, unrelated `tsc` errors —
 * see task-6-report.md). It also sidesteps the tool handler entirely:
 * exercising it directly would mean either wiring up a fake `ExtensionAPI`
 * (this extension does far more at factory time than `ats-adapters.ts` does,
 * e.g. Gmail/CAPTCHA/tracker plumbing) or letting `readState`/`writeState`
 * touch this worktree's real `state.json`, since `WORKSPACE` is derived from
 * the module's own file location and cannot be overridden in-process. Neither
 * is worth it for ten lines of normalisation logic, so this tests the pure
 * function directly instead — this file itself lives under `lib/`, not at the
 * extensions top level, because pi loads every top-level `*.ts` in
 * `.pi/extensions/` as an extension (see `ats-adapters.offpath.test.ts`'s
 * header for the same note).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAttempt } from "./attempt";

describe("resolveAttempt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalises flat attempt_outcome + attempt_notes into a nested attempt, defaulting started_at to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));

    const attempt = resolveAttempt({ attempt_outcome: "submitted", attempt_notes: "auto-filled, no verification" });

    expect(attempt).toEqual({
      started_at: "2026-09-04T12:00:00.000Z",
      outcome: "submitted",
      notes: "auto-filled, no verification",
    });
  });

  it("normalises attempt_outcome alone, with no notes key when attempt_notes is absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));

    const attempt = resolveAttempt({ attempt_outcome: "blocked" });

    expect(attempt).toEqual({ started_at: "2026-09-04T12:00:00.000Z", outcome: "blocked" });
  });

  it("passes a nested attempt object through unchanged", () => {
    const nested = { started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:05:00.000Z", outcome: "aborted", notes: "captcha" };

    expect(resolveAttempt({ attempt: nested })).toBe(nested);
  });

  it("prefers the nested attempt over the flat pair when both are supplied", () => {
    const nested = { started_at: "2026-01-01T00:00:00.000Z", outcome: "aborted" };

    const attempt = resolveAttempt({ attempt: nested, attempt_outcome: "submitted", attempt_notes: "ignored" });

    expect(attempt).toBe(nested);
    expect(attempt).not.toMatchObject({ outcome: "submitted" });
  });

  it("ignores attempt_notes on its own — an attempt without an outcome is not an attempt", () => {
    expect(resolveAttempt({ attempt_notes: "started filling the form" })).toBeUndefined();
  });

  it("returns undefined when neither shape is supplied", () => {
    expect(resolveAttempt({})).toBeUndefined();
  });
});
