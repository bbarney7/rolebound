import type { AdoptResult, DetectedLogin } from "../shared/providers";
import { requestError } from "./accounts";
import { httpFetch as fetch } from "./http";

export type { DetectedLogin, AdoptResult };

export type LoginStatus = "pending" | "succeeded" | "cancelled" | "failed" | "interrupted";

export type LoginSession = {
  status: LoginStatus;
  authUrl?: string;
  deviceCode?: { userCode: string; verificationUri: string; expiresAt: string };
  prompt?: {
    id: string;
    type: string;
    message: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string }>;
  };
  info?: string;
  error?: { code: string; message: string };
};

export async function fetchDetectedLogins(): Promise<DetectedLogin[]> {
  const res = await fetch("/api/providers/detected");
  if (!res.ok) throw await requestError(res, "GET /api/providers/detected");
  return res.json() as Promise<DetectedLogin[]>;
}

export async function adoptLogin(detectionId: string): Promise<AdoptResult> {
  const res = await fetch("/api/providers/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ detectionId }),
  });
  if (!res.ok) throw await requestError(res, "POST /api/providers/adopt");
  return res.json() as Promise<AdoptResult>;
}

export async function startProviderLogin(body: {
  provider: string;
  detectionId?: string;
  enterpriseDomain?: string;
}): Promise<{ connectionId: string; session: LoginSession }> {
  const res = await fetch("/api/providers/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await requestError(res, "POST /api/providers/login");
  return res.json() as Promise<{ connectionId: string; session: LoginSession }>;
}

export async function startLogin(
  connectionId: string,
  options?: { enterpriseDomain?: string; mode?: "import" },
): Promise<LoginSession & { warnings?: string[] }> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw await requestError(res, "POST /api/connections/:id/login");
  return res.json() as Promise<LoginSession & { warnings?: string[] }>;
}

export async function fetchLogin(connectionId: string): Promise<LoginSession> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/login`);
  if (!res.ok) throw await requestError(res, "GET /api/connections/:id/login");
  return res.json() as Promise<LoginSession>;
}

export async function answerLogin(connectionId: string, promptId: string, value: string): Promise<LoginSession> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/login/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ promptId, value }),
  });
  if (!res.ok) throw await requestError(res, "POST /api/connections/:id/login/answer");
  return res.json() as Promise<LoginSession>;
}

export async function cancelLogin(connectionId: string): Promise<LoginSession> {
  const res = await fetch(`/api/connections/${encodeURIComponent(connectionId)}/login`, { method: "DELETE" });
  if (!res.ok) throw await requestError(res, "DELETE /api/connections/:id/login");
  return res.json() as Promise<LoginSession>;
}
