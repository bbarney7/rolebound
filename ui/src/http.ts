let csrfToken: string | null = null;
let loading: Promise<string> | null = null;
async function token(): Promise<string> {
  if (csrfToken) return csrfToken;
  loading ??= fetch("/api/session").then(async response => { if (!response.ok) throw new Error(`GET /api/session failed: ${response.status}`); const body = await response.json() as { csrfToken?: string }; if (!body.csrfToken) throw new Error("session did not provide a CSRF token"); csrfToken = body.csrfToken; return body.csrfToken; }).finally(() => { loading = null; });
  return loading;
}
export function invalidateHttpSession() { csrfToken = null; }
export async function httpFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase(); const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-Pi-Jobs-CSRF", await token());
  const response = await fetch(input, { ...init, headers });
  if (response.status === 403) invalidateHttpSession();
  return response;
}
