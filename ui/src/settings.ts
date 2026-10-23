import type {
  CaptchaProviderChoice,
  CaptchaSettingsPayload,
  CaptchaSettingsUpdateBody,
  CaptchaTestBody,
  CaptchaTestResponse,
} from "../shared/types";
import type { ConnectionCreate, ConnectionList, ConnectionSelectionsUpdate } from "../shared/providers";
import type { ReadinessPayload } from "../shared/types";
import { errorMessage } from "./api";
import { requestError } from "./accounts";
import { httpFetch as fetch } from "./http";

/**
 * `fetchCaptchaSettings` and `testCaptchaKey` read the error body via the
 * bare `errorMessage` ladder — a 400 from `/test` never carries `field`
 * (`server/routes/settings.ts:155`), so there is nothing for a field-aware
 * parse to extract. `updateCaptchaSettings` is different: `PUT
 * /api/settings/captcha`'s 400s name the rejected control (`field:
 * "provider" | "apiKey"`), so it reuses `accounts.ts`'s `requestError`
 * rather than `errorMessage`, the same way the accounts and queue mutation
 * wrappers do for their own field-carrying 400s.
 */
export async function fetchCaptchaSettings(): Promise<CaptchaSettingsPayload> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`GET /api/settings failed: ${res.status}`);
  return res.json() as Promise<CaptchaSettingsPayload>;
}

/** Mirrors `AccountRequestError` (`accounts.ts`) — same shape, named for this module's callers. */
export type CaptchaRequestError = Error & { field?: string };

export async function updateCaptchaSettings(body: CaptchaSettingsUpdateBody): Promise<CaptchaSettingsPayload> {
  const res = await fetch("/api/settings/captcha", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await requestError(res, "PUT /api/settings/captcha");
  return res.json() as Promise<CaptchaSettingsPayload>;
}

export async function testCaptchaKey(body: CaptchaTestBody): Promise<CaptchaTestResponse> {
  const res = await fetch("/api/settings/captcha/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "POST /api/settings/captcha/test"));
  return res.json() as Promise<CaptchaTestResponse>;
}
export async function fetchReadiness(): Promise<ReadinessPayload> {
  const res = await fetch("/api/readiness");
  if (!res.ok) throw new Error(`GET /api/readiness failed: ${res.status}`);
  return res.json() as Promise<ReadinessPayload>;
}

export async function recordSupervisedAcknowledgement(): Promise<ReadinessPayload> {
  const res = await fetch("/api/readiness/acknowledgement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgement: "ACKNOWLEDGE" }),
  });
  if (!res.ok) throw await requestError(res, "POST /api/readiness/acknowledgement");
  return res.json() as Promise<ReadinessPayload>;
}
export async function fetchConnections(): Promise<ConnectionList> { const res = await fetch("/api/connections"); if (!res.ok) throw new Error(`GET /api/connections failed: ${res.status}`); return res.json() as Promise<ConnectionList>; }
export async function createConnection(input: ConnectionCreate, expectedRevision: string): Promise<ConnectionList> { const res = await fetch("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, expectedRevision }) }); if (!res.ok) throw await requestError(res, "POST /api/connections"); return res.json() as Promise<ConnectionList>; }
export async function updateSelections(body: ConnectionSelectionsUpdate): Promise<ConnectionList> { const res = await fetch("/api/connections/selections", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw await requestError(res, "PUT /api/connections/selections"); return res.json() as Promise<ConnectionList>; }
export async function testModelConnection(id: string): Promise<{ ok: boolean; code?: string; models?: Array<{ id: string }> }> { const res = await fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST" }); if (!res.ok) throw await requestError(res, "POST /api/connections/:id/test"); return res.json(); }
export async function deleteModelConnection(id: string, expectedRevision: string): Promise<ConnectionList> { const res = await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision }) }); if (!res.ok) throw await requestError(res, "DELETE /api/connections/:id"); return res.json() as Promise<ConnectionList>; }
export async function fetchModelCatalog(id: string): Promise<Array<{ id: string }>> { const res = await fetch(`/api/connections/${encodeURIComponent(id)}/models`); if (!res.ok) throw await requestError(res, "GET /api/connections/:id/models"); return ((await res.json()) as { models: Array<{ id: string }> }).models; }

// ── Pure helpers (covered by src/__tests__/settings.test.ts) ──

export function providerLabel(p: CaptchaSettingsPayload, id: CaptchaProviderChoice): string {
  if (id === "off") return "Off";
  return p.providers.find((x) => x.id === id)?.label ?? id;
}

/** The overview tile's text; falls back to the raw id before settings load. */
export function solverLabel(p: CaptchaSettingsPayload | null, solver: CaptchaProviderChoice): string {
  if (!p) return solver === "off" ? "Off" : solver;
  return providerLabel(p, solver);
}

/** Where the key came from. The key itself never reaches the client. */
export function keyStatusLine(p: CaptchaSettingsPayload): string {
  // A stored file key with the provider off: it's inert, but not gone — say
  // so rather than the plain "No key set" a keyless off would get.
  if (p.fileHasKey && p.provider === "off") {
    return `Key stored in settings.json${p.keyHint ? ` (${p.keyHint})` : ""} — not used while the provider is Off`;
  }
  if (!p.hasApiKey) return "No key set";
  if (p.keySource === "env" && p.provider !== "off") {
    const envVar = p.providers.find((x) => x.id === p.provider)?.envVar ?? "the environment";
    return `Key from ${envVar} (overrides settings.json)`;
  }
  return `Key set in settings.json${p.keyHint ? ` (${p.keyHint})` : ""}`;
}

/** Lever is hCaptcha; a provider that cannot solve it will not unblock those runs. */
export function hcaptchaNote(p: CaptchaSettingsPayload, id: CaptchaProviderChoice): string | null {
  if (id === "off") return null;
  const spec = p.providers.find((x) => x.id === id);
  if (!spec || spec.supports.includes("hcaptcha")) return null;
  const others = p.providers.filter((x) => x.supports.includes("hcaptcha")).map((x) => x.label);
  return `${spec.label} cannot solve hCaptcha (used by Lever)${others.length ? ` — use ${others.join(" or ")} for those` : ""}.`;
}
