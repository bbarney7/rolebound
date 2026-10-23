import { useCallback, useEffect, useRef, useState } from "react";
import {
  abortRun,
  attachRunStream,
  fetchCurrentRun,
  finishRun,
  replyRun,
  respondRunUi,
  startRun,
  type RunStartRequest,
} from "./runs";
import type {
  RunLogEntry,
  RunSummary,
  RunUiResponseBody,
  ToolCardDetails,
} from "../shared/types";

/**
 * The transcript model. One entry per thing worth showing, which is NOT one
 * entry per event: a paragraph of assistant text arrives as dozens of deltas
 * and a tool call arrives as a start and an end.
 */
export type RunEntry =
  | { kind: "user"; key: string; text: string }
  /** `done` is false while deltas are still arriving — the panel renders it live. */
  | { kind: "assistant"; key: string; text: string; done: boolean }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      name: string;
      summary: string;
      args: unknown;
      /** null until the matching tool_end lands */
      result: string | null;
      isError: boolean;
      /** the tool's structured card payload, when its tool_end carried one */
      details?: ToolCardDetails;
    }
  | { kind: "notify"; key: string; level: "info" | "warning" | "error"; text: string }
  | {
      kind: "ui_request";
      key: string;
      id: string;
      method: "confirm" | "select" | "input" | "editor";
      title: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      resolved: boolean;
    }
  /** exit, error, and an extension's status line — ambient, not conversation */
  | { kind: "system"; key: string; text: string; source?: "status_line" | "exit" | "error"; severity?: "info" | "error" };

export interface RunFoldState {
  run: RunSummary | null;
  entries: RunEntry[];
  lastSeq: number;
}

export interface RunFoldResult extends RunFoldState {
  /**
   * The log skipped entries this client never saw: either the server's bounded
   * log dropped them, or an EventSource reconnect replayed from a `since` the
   * log no longer holds. The transcript cannot be repaired by appending — the
   * hook refetches the snapshot instead.
   */
  gap: boolean;
}

export const EMPTY_RUN_STATE: RunFoldState = { run: null, entries: [], lastSeq: 0 };

/**
 * Pure, and deliberately so: every ordering rule the transcript depends on is
 * testable without a DOM, a fetch or a timer.
 */
export function foldRunEvent(state: RunFoldState, entry: RunLogEntry): RunFoldResult {
  // EventSource reconnects replay from the ORIGINAL `since`, so duplicates are
  // routine rather than exceptional.
  if (entry.seq <= state.lastSeq) return { ...state, gap: false };

  const isNewRun = entry.type === "status" && entry.run.runId !== state.run?.runId;
  // `lastSeq === 0` is a client with no baseline, not a client that lost
  // entries: seq is monotonic across runs within a server process, so a first
  // event at seq 91 is ordinary and must not trigger a resync.
  const gap = !isNewRun && state.lastSeq > 0 && entry.seq > state.lastSeq + 1;

  const base = isNewRun ? [] : state.entries;
  return {
    run: entry.type === "status" ? entry.run : state.run,
    entries: applyEntry(base, entry),
    lastSeq: entry.seq,
    gap,
  };
}

function applyEntry(entries: RunEntry[], entry: RunLogEntry): RunEntry[] {
  const key = `e${entry.seq}`;
  switch (entry.type) {
    case "status":
      // The header renders status; a line per transition would be noise.
      return entries;
    case "user":
      return [...entries, { kind: "user", key, text: entry.message }];
    case "text": {
      const last = entries[entries.length - 1];
      if (last && last.kind === "assistant" && !last.done) {
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text: last.text + entry.delta };
        return updated;
      }
      return [...entries, { kind: "assistant", key, text: entry.delta, done: false }];
    }
    case "text_end": {
      const last = entries[entries.length - 1];
      if (!last || last.kind !== "assistant" || last.done) return entries;
      const updated = [...entries];
      updated[updated.length - 1] = { ...last, done: true };
      return updated;
    }
    case "tool_start":
      return [
        ...entries,
        {
          kind: "tool",
          key,
          toolCallId: entry.toolCallId,
          name: entry.name,
          summary: entry.summary,
          args: entry.args,
          result: null,
          isError: false,
        },
      ];
    case "tool_end": {
      const index = lastIndex(
        entries,
        (e) => e.kind === "tool" && e.toolCallId === entry.toolCallId && e.result === null,
      );
      // An unmatched end means its start was never seen — which only happens
      // after a gap, and a gap is repaired by replacing the whole transcript.
      if (index < 0) return entries;
      const updated = [...entries];
      updated[index] = {
        ...(updated[index] as Extract<RunEntry, { kind: "tool" }>),
        result: entry.result,
        isError: entry.isError,
        ...(entry.details ? { details: entry.details } : {}),
      };
      return updated;
    }
    case "notify":
      return [...entries, { kind: "notify", key, level: entry.level, text: entry.message }];
    case "status_line":
      // An empty statusText CLEARS the entry rather than saying something.
      if (!entry.text) return entries;
      return [...entries, { kind: "system", key, source: "status_line", severity: "info", text: `${entry.key}: ${entry.text}` }];
    case "ui_request":
      return [
        ...entries,
        {
          kind: "ui_request",
          key,
          id: entry.id,
          method: entry.method,
          title: entry.title,
          message: entry.message,
          options: entry.options,
          placeholder: entry.placeholder,
          prefill: entry.prefill,
          resolved: false,
        },
      ];
    case "ui_resolved": {
      const index = lastIndex(entries, (e) => e.kind === "ui_request" && e.id === entry.id && !e.resolved);
      if (index < 0) return entries;
      const updated = [...entries];
      updated[index] = { ...(updated[index] as Extract<RunEntry, { kind: "ui_request" }>), resolved: true };
      return updated;
    }
    case "exit":
      return [
        ...entries,
        {
          kind: "system",
          key,
          source: "exit",
          severity: entry.code === 0 && !entry.signal ? "info" : "error",
          text: `pi exited (code ${entry.code ?? "—"}${entry.signal ? `, ${entry.signal}` : ""})`,
        },
      ];
    case "error":
      return [...entries, { kind: "system", key, source: "error", severity: "error", text: `error: ${entry.message}` }];
  }
}

function lastIndex(entries: RunEntry[], predicate: (entry: RunEntry) => boolean): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (predicate(entries[i])) return i;
  }
  return -1;
}

export interface UseRun {
  run: RunSummary | null;
  entries: RunEntry[];
  busy: boolean;
  error: string | null;
  draft: string;
  setDraft: (value: string) => void;
  /** Resolves to the new run, or null when the server refused (see `error`). */
  start: (body: RunStartRequest) => Promise<RunSummary | null>;
  /** Resolves false when the server refused the reply (see `error`). */
  reply: (message: string) => Promise<boolean>;
  respondUi: (body: RunUiResponseBody) => Promise<void>;
  abort: () => Promise<void>;
  /** Resolves false when the server refused to end the run. */
  finish: () => Promise<boolean>;
}

export function useRun(): UseRun {
  const [state, setState] = useState<RunFoldState>(EMPTY_RUN_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // The fold reads from here, not from `state`: two events can arrive in one
  // tick, and a React state read would fold the second onto the pre-first value.
  const stateRef = useRef<RunFoldState>(EMPTY_RUN_STATE);
  const detachRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  // Breaks the attach ↔ sync cycle: attaching needs a resync handler, and
  // resyncing needs to re-attach.
  const syncRef = useRef<() => Promise<void>>(async () => {});

  const attach = useCallback((since: number) => {
    detachRef.current?.();
    detachRef.current = attachRunStream(since, {
      onEvent: (entry) => {
        if (!mountedRef.current) return;
        const next = foldRunEvent(stateRef.current, entry);
        stateRef.current = { run: next.run, entries: next.entries, lastSeq: next.lastSeq };
        setState(stateRef.current);
        if (next.gap) void syncRef.current();
      },
    });
  }, []);

  /** Replace the transcript from the server's snapshot and reattach after it. */
  const sync = useCallback(async () => {
    detachRef.current?.();
    detachRef.current = null;
    try {
      const payload = await fetchCurrentRun();
      if (!mountedRef.current) return;
      let next: RunFoldState = { ...EMPTY_RUN_STATE, run: payload.run };
      for (const entry of payload.events) {
        const folded = foldRunEvent(next, entry);
        next = { run: folded.run, entries: folded.entries, lastSeq: folded.lastSeq };
      }
      // The snapshot's own summary wins: the log may hold no status event at
      // all if the bounded log dropped it.
      next = { ...next, run: payload.run };
      stateRef.current = next;
      setState(next);
      attach(next.lastSeq);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [attach]);

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    mountedRef.current = true;
    void sync();
    return () => {
      mountedRef.current = false;
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [sync]);

  /**
   * Every action reports its own failure and resolves anyway. A rejected
   * promise here would be an unhandled rejection at every call site, and the
   * server's sentence is already on screen in `error`.
   */
  const act = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const start = useCallback(
    async (body: RunStartRequest) => {
      const run = await act(() => startRun(body));
      // A start replaces the transcript wholesale, so take the snapshot rather
      // than waiting for the stream to say so.
      if (run) {
        setDraft("");
        await sync();
      }
      return run;
    },
    [act, sync],
  );

  const runId = state.run?.runId ?? null;
  const reply = useCallback(
    async (message: string) => {
      if (!runId) return false;
      return (await act(() => replyRun(runId, message))) !== null;
    },
    [act, runId],
  );
  const respondUi = useCallback(
    async (body: RunUiResponseBody) => {
      if (runId) await act(() => respondRunUi(runId, body));
    },
    [act, runId],
  );
  const abort = useCallback(async () => {
    if (runId) await act(() => abortRun(runId));
  }, [act, runId]);
  const finish = useCallback(async () => {
    if (!runId) return false;
    return (await act(() => finishRun(runId))) !== null;
  }, [act, runId]);

  return { run: state.run, entries: state.entries, busy, error, draft, setDraft, start, reply, respondUi, abort, finish };
}
