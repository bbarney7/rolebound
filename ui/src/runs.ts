import { errorMessage } from "./api";
import type {
  RunCurrentPayload,
  RunLogEntry,
  RunStartBody,
  RunSummary,
  RunUiResponseBody,
} from "../shared/types";
import { httpFetch as fetch } from "./http";

/**
 * Every wrapper here reads the error body, the way the queue mutations do
 * (api.ts:44-58) and the four application wrappers deliberately do not. The
 * reason is the same: these routes say something the user cannot otherwise
 * learn. "a run is already active in this workspace", "the queue is empty —
 * nothing to apply to" and "run is still starting" are the whole explanation
 * for a refused click, and `POST /api/runs failed: 409` would make them
 * unreachable.
 */
async function send(route: string, method: string, body?: unknown): Promise<RunSummary> {
  const res = await fetch(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `${method} ${route} failed: ${res.status}`;
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        code?: string;
        retryAfterMs?: number;
        runId?: string;
      };
      if (parsed.error) message = parsed.error;
      if (parsed.code) {
        const wait =
          parsed.code === "RATE_LIMITED" && typeof parsed.retryAfterMs === "number"
            ? ` (retry in about ${Math.ceil(parsed.retryAfterMs / 60_000)} minutes)`
            : "";
        message = `${parsed.code}: ${parsed.error ?? message}${wait}`;
      }
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return res.json() as Promise<RunSummary>;
}

/** Client start body; `continueFrom` forks the prior chat session on the server. */
export type RunStartRequest = RunStartBody & { continueFrom?: string };

export function startRun(body: RunStartRequest): Promise<RunSummary> {
  return send("/api/runs", "POST", body);
}

export async function fetchCurrentRun(): Promise<RunCurrentPayload> {
  const res = await fetch("/api/runs/current");
  if (!res.ok) throw new Error(await errorMessage(res, "GET /api/runs/current"));
  return res.json() as Promise<RunCurrentPayload>;
}

export function replyRun(id: string, message: string): Promise<RunSummary> {
  return send(`/api/runs/${encodeURIComponent(id)}/reply`, "POST", { message });
}

export function respondRunUi(id: string, body: RunUiResponseBody): Promise<RunSummary> {
  return send(`/api/runs/${encodeURIComponent(id)}/ui-response`, "POST", body);
}

export function abortRun(id: string): Promise<RunSummary> {
  return send(`/api/runs/${encodeURIComponent(id)}/abort`, "POST");
}

export function finishRun(id: string): Promise<RunSummary> {
  return send(`/api/runs/${encodeURIComponent(id)}/finish`, "POST");
}

export interface RunStreamHandlers {
  onEvent: (entry: RunLogEntry) => void;
  onError?: () => void;
}

/**
 * A plain `EventSource`, NOT the `sse.ts` driver (D4).
 *
 * `sse.ts` owns the watcher contract: a liveness watchdog keyed to a 25s
 * heartbeat, exponential backoff, and a `watching` readiness frame that means
 * "the workspace scan is done". None of that describes a transcript. What this
 * stream needs instead is replay, and it gets it from `since` plus the browser's
 * own reconnect — the consumer dedupes by `seq` and recovers a gap by
 * refetching `/api/runs/current` (useRun.ts).
 *
 * No DOM global is touched until this is called, so the module still imports
 * under vitest's node environment.
 */
export function attachRunStream(since: number, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(`/api/runs/events?since=${encodeURIComponent(String(since))}`);
  source.addEventListener("run", (event) => {
    try {
      handlers.onEvent(JSON.parse((event as MessageEvent<string>).data) as RunLogEntry);
    } catch {
      // a frame we cannot parse is not worth tearing the stream down for
    }
  });
  if (handlers.onError) {
    // EventSource retries on its own; this is for reporting, not reconnecting.
    source.addEventListener("error", () => handlers.onError?.());
  }
  return () => source.close();
}
