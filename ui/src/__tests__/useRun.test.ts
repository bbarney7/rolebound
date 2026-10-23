import { describe, expect, it } from "vitest";
import { EMPTY_RUN_STATE, foldRunEvent, type RunEntry, type RunFoldState } from "../useRun";
import type { RunEvent, RunLogEntry, RunStatus, RunSummary } from "../../shared/types";

/**
 * The fold only — node environment, like sse.test.ts. The hook around it is
 * fetch, EventSource and React; every ordering rule the transcript depends on
 * lives in the pure function and is asserted here.
 */

function summary(runId: string, status: RunStatus = "running"): RunSummary {
  return {
    runId,
    kind: "apply",
    slug: "zeta-platform-em",
    sessionName: "ui:zeta-platform-em",
    model: "fake/model",
    status,
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: null,
    pid: 4242,
    firstSeq: 1,
    lastSeq: 1,
  };
}

/** Fold a list of events, starting from a given state, ignoring the gap flag. */
function foldAll(events: RunLogEntry[], from: RunFoldState = EMPTY_RUN_STATE): RunFoldState {
  let state = from;
  for (const event of events) {
    const next = foldRunEvent(state, event);
    state = { run: next.run, entries: next.entries, lastSeq: next.lastSeq };
  }
  return state;
}

let seq = 0;
function at(event: RunEvent, override?: number): RunLogEntry {
  seq = override ?? seq + 1;
  return { ...event, seq } as RunLogEntry;
}

function reset() {
  seq = 0;
}

describe("foldRunEvent", () => {
  it("assembles assistant deltas into one paragraph and closes it on text_end", () => {
    reset();
    const state = foldAll([
      at({ type: "text", delta: "Opening " }),
      at({ type: "text", delta: "the " }),
      at({ type: "text", delta: "posting." }),
      at({ type: "text_end" }),
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toEqual({
      kind: "assistant",
      key: "e1",
      text: "Opening the posting.",
      done: true,
    });
  });

  it("starts a new paragraph after a closed one", () => {
    reset();
    const state = foldAll([
      at({ type: "text", delta: "first" }),
      at({ type: "text_end" }),
      at({ type: "text", delta: "second" }),
    ]);
    expect(state.entries.map((e) => (e.kind === "assistant" ? e.text : e.kind))).toEqual([
      "first",
      "second",
    ]);
  });

  it("ignores an entry whose seq was already folded", () => {
    reset();
    const first = foldRunEvent(EMPTY_RUN_STATE, at({ type: "user", message: "hi" }));
    const replayed = foldRunEvent(first, at({ type: "user", message: "hi" }, 1));
    expect(replayed.entries).toHaveLength(1);
    expect(replayed.gap).toBe(false);
    expect(replayed.lastSeq).toBe(1);
  });

  it("flags a gap when a seq is skipped", () => {
    reset();
    const first = foldRunEvent(EMPTY_RUN_STATE, at({ type: "user", message: "hi" }));
    const skipped = foldRunEvent(first, at({ type: "text", delta: "x" }, 9));
    expect(skipped.gap).toBe(true);
    // The entry is still applied — the hook replaces the transcript anyway, and
    // showing something beats showing nothing if the refetch is slow.
    expect(skipped.entries).toHaveLength(2);
  });

  it("does not flag a gap on the first entry a fresh client sees", () => {
    reset();
    // seq is monotonic across runs within a server process, so a client that
    // attaches mid-process legitimately starts at a high number.
    const first = foldRunEvent(EMPTY_RUN_STATE, at({ type: "text", delta: "x" }, 91));
    expect(first.gap).toBe(false);
  });

  it("does not flag a gap when a new run starts", () => {
    reset();
    const previous = foldAll([at({ type: "status", status: "done", run: summary("run-a", "done") })]);
    const next = foldRunEvent(previous, at({ type: "status", status: "starting", run: summary("run-b", "starting") }, 40));
    expect(next.gap).toBe(false);
  });

  it("resets the transcript when the run id changes and keeps it otherwise", () => {
    reset();
    const first = foldAll([
      at({ type: "status", status: "running", run: summary("run-a") }),
      at({ type: "user", message: "apply" }),
      at({ type: "text", delta: "working" }),
    ]);
    expect(first.entries).toHaveLength(2);

    const sameRun = foldRunEvent(first, at({ type: "status", status: "waiting", run: summary("run-a", "waiting") }));
    expect(sameRun.entries).toHaveLength(2);
    expect(sameRun.run?.status).toBe("waiting");

    const newRun = foldRunEvent(sameRun, at({ type: "status", status: "starting", run: summary("run-b", "starting") }));
    expect(newRun.entries).toEqual([]);
    expect(newRun.run?.runId).toBe("run-b");
  });

  it("pairs a tool_end with its start and leaves an unmatched one alone", () => {
    reset();
    const state = foldAll([
      at({ type: "tool_start", toolCallId: "c1", name: "browser_navigate", summary: "https://x.test", args: { url: "https://x.test" } }),
      at({ type: "tool_start", toolCallId: "c2", name: "read", summary: "state.json", args: { path: "state.json" } }),
      at({ type: "tool_end", toolCallId: "c1", isError: false, result: "navigated" }),
      at({ type: "tool_end", toolCallId: "nope", isError: true, result: "orphan" }),
    ]);
    expect(state.entries).toHaveLength(2);
    const [first, second] = state.entries as Extract<RunEntry, { kind: "tool" }>[];
    expect(first).toMatchObject({ toolCallId: "c1", result: "navigated", isError: false });
    expect(second).toMatchObject({ toolCallId: "c2", result: null });
  });

  it("marks a ui_request resolved by id", () => {
    reset();
    const state = foldAll([
      at({ type: "ui_request", id: "d1", method: "confirm", title: "Proceed?", message: "Submit it?" }),
      at({ type: "ui_request", id: "d2", method: "input", title: "Value" }),
      at({ type: "ui_resolved", id: "d1" }),
    ]);
    const requests = state.entries as Extract<RunEntry, { kind: "ui_request" }>[];
    expect(requests[0]).toMatchObject({ id: "d1", resolved: true, method: "confirm" });
    expect(requests[1]).toMatchObject({ id: "d2", resolved: false });
  });

  it("renders notify, status lines, exit and error as their own entries", () => {
    reset();
    const state = foldAll([
      at({ type: "notify", level: "warning", message: "left alone" }),
      at({ type: "status_line", key: "mcp", text: "mcp 0/3 servers" }),
      // A cleared status entry says nothing and must not add a line.
      at({ type: "status_line", key: "mcp", text: "" }),
      at({ type: "exit", code: 0, signal: null }),
      at({ type: "error", message: "boom" }),
    ]);
    expect(state.entries.map((e) => e.kind)).toEqual(["notify", "system", "system", "system"]);
    expect(state.entries[0]).toMatchObject({ level: "warning", text: "left alone" });
    expect(state.entries[1]).toMatchObject({ text: "mcp: mcp 0/3 servers", source:"status_line",severity:"info" });
    expect(state.entries[2]).toMatchObject({ text: "pi exited (code 0)", source:"exit",severity:"info" });
    expect(state.entries[3]).toMatchObject({ text: "error: boom",source:"error",severity:"error" });
  });

  it("does not mutate the state it was given", () => {
    reset();
    const before = foldAll([at({ type: "user", message: "one" })]);
    const snapshot = [...before.entries];
    foldRunEvent(before, at({ type: "user", message: "two" }));
    expect(before.entries).toEqual(snapshot);
  });
});
