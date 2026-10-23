import type {
  Application,
  ApplicationDetailPayload,
  DiscoveredItem,
  Overview,
  PipelineUpdateBody,
  QueueCreateBody,
  QueueItem,
  QueueMutationResult,
  QueuePromoteBody,
  InstructionsPayload,
  InstructionsUpdateBody,
} from "../shared/types";
import type {
  DiscoveryDetailPayload,
  DiscoveryListPayload,
  DiscoveryListQuery,
  TargetsPayload,
  TargetsUpdateBody,
} from "../shared/discovery";
import { httpFetch as fetch } from "./http";

export async function fetchOverview(): Promise<Overview> {
  const res = await fetch("/api/overview");
  if (!res.ok) throw new Error(`GET /api/overview failed: ${res.status}`);
  return res.json() as Promise<Overview>;
}

export async function fetchApplications(): Promise<Application[]> {
  const res = await fetch("/api/applications");
  if (!res.ok) throw new Error(`GET /api/applications failed: ${res.status}`);
  return res.json() as Promise<Application[]>;
}

export async function fetchApplication(slug: string): Promise<ApplicationDetailPayload> {
  const res = await fetch(`/api/applications/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`GET /api/applications/:slug failed: ${res.status}`);
  return res.json() as Promise<ApplicationDetailPayload>;
}

export async function updateApplicationPipeline(
  slug: string,
  body: PipelineUpdateBody,
): Promise<ApplicationDetailPayload> {
  const res = await fetch(`/api/applications/${encodeURIComponent(slug)}/pipeline`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH /api/applications/:slug/pipeline failed: ${res.status}`);
  return res.json() as Promise<ApplicationDetailPayload>;
}

/**
 * The queue mutation wrappers read the error body; the four application
 * wrappers above deliberately do not. Exported because the run wrappers
 * (runs.ts) make the same trade for the same reason.
 *
 * The difference is that these routes say something the user cannot otherwise
 * learn. A 409 from promote names the two files left behind by a partial move
 * and tells them to resolve it by hand; a 400 names the field that was
 * rejected and why. Throwing `POST /api/queue/promote failed: 409` would make
 * the server's sentence unreachable — the endpoint would be describing a
 * recovery nobody can read.
 *
 * Falls back to the bare status line whenever the body is missing, empty, not
 * JSON, or carries no `error` key, so a proxy's HTML error page cannot end up
 * rendered as the message.
 */
export async function errorMessage(res: Response, route: string): Promise<string> {
  const fallback = `${route} failed: ${res.status}`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export async function fetchQueue(): Promise<QueueItem[]> {
  const res = await fetch("/api/queue");
  if (!res.ok) throw new Error(`GET /api/queue failed: ${res.status}`);
  return res.json() as Promise<QueueItem[]>;
}

export async function fetchDiscovered(q: string, limit = 50): Promise<DiscoveredItem[]> {
  const res = await fetch(
    `/api/queue/discovered?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`,
  );
  if (!res.ok) throw new Error(`GET /api/queue/discovered failed: ${res.status}`);
  return res.json() as Promise<DiscoveredItem[]>;
}

export async function addQueueItem(body: QueueCreateBody): Promise<QueueMutationResult> {
  const res = await fetch("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "POST /api/queue"));
  return res.json() as Promise<QueueMutationResult>;
}

export async function promoteQueueItem(body: QueuePromoteBody): Promise<QueueMutationResult> {
  const res = await fetch("/api/queue/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "POST /api/queue/promote"));
  return res.json() as Promise<QueueMutationResult>;
}

export async function removeQueueItem(slug: string): Promise<QueueMutationResult> {
  const res = await fetch(`/api/queue/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res, "DELETE /api/queue/:slug"));
  return res.json() as Promise<QueueMutationResult>;
}

function discoveryQuery(query: DiscoveryListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.source) params.set("source", query.source);
  if (query.scored) params.set("scored", query.scored);
  if (query.dismissed) params.set("dismissed", query.dismissed);
  if (query.sort) params.set("sort", query.sort);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

export async function fetchDiscoveries(query: DiscoveryListQuery = {}): Promise<DiscoveryListPayload> {
  const res = await fetch(`/api/discoveries${discoveryQuery(query)}`);
  if (!res.ok) throw new Error(`GET /api/discoveries failed: ${res.status}`);
  return res.json() as Promise<DiscoveryListPayload>;
}

export async function fetchDiscoveryDetail(slug: string): Promise<DiscoveryDetailPayload> {
  const res = await fetch(`/api/discoveries/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`GET /api/discoveries/:slug failed: ${res.status}`);
  return res.json() as Promise<DiscoveryDetailPayload>;
}

export async function dismissDiscovery(slug: string): Promise<void> {
  const res = await fetch(`/api/discoveries/${encodeURIComponent(slug)}/dismiss`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res, "POST /api/discoveries/:slug/dismiss"));
}

export async function restoreDiscovery(slug: string): Promise<void> {
  const res = await fetch(`/api/discoveries/${encodeURIComponent(slug)}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res, "POST /api/discoveries/:slug/restore"));
}

export async function fetchTargets(): Promise<TargetsPayload> {
  const res = await fetch("/api/targets");
  if (!res.ok) throw new Error(`GET /api/targets failed: ${res.status}`);
  return res.json() as Promise<TargetsPayload>;
}

export async function fetchInstructions(): Promise<InstructionsPayload> {
  const res = await fetch("/api/instructions");
  if (!res.ok) throw new Error(`GET /api/instructions failed: ${res.status}`);
  return res.json() as Promise<InstructionsPayload>;
}

export async function updateInstructions(body: InstructionsUpdateBody): Promise<InstructionsPayload> {
  const res = await fetch("/api/instructions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "PUT /api/instructions"));
  return res.json() as Promise<InstructionsPayload>;
}

export async function updateTargets(body: TargetsUpdateBody): Promise<TargetsPayload> {
  const res = await fetch("/api/targets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "PUT /api/targets"));
  return res.json() as Promise<TargetsPayload>;
}
