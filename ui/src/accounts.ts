import {
  LOGIN_STATUSES,
  type AccountCreateBody,
  type AccountDetailPayload,
  type AccountMutationResult,
  type AccountRevealResponse,
  type AccountUpdateBody,
  type ATSAccount,
  type LoginStatus,
} from "../shared/types";
import type { Tone } from "./Stamp";
import { httpFetch as fetch } from "./http";

/**
 * A mutation failure that names the control the form should mark invalid.
 *
 * The accounts routes answer a validation failure with `{ error, field }`, and a
 * plain `errorMessage` collapses the body to a string — losing `field` between
 * the wrapper and the form that needs it. Owning the shape here means tasks 12
 * and 13 can narrow a caught `unknown` without redeclaring it.
 */
export type AccountRequestError = Error & { field?: string };

/**
 * `errorMessage`'s fallback ladder, reproduced rather than called — and that is
 * forced by the code, not preferred. `errorMessage` consumes the response
 * itself (`api.ts:63`, `const text = await res.text()`), and a `Response` body
 * can be read only once, so a helper that delegated to it would have nothing
 * left to parse `field` out of. The alternatives — `res.clone()`, or reading the
 * text first and reimplementing the ladder over the string — both cost more than
 * the ladder itself.
 *
 * Behaviour matches `api.ts:60-73` exactly: `parsed.error` when it is a string,
 * otherwise the bare status line, so a proxy's HTML error page cannot end up
 * rendered as the message. `field` is carried alongside as the one thing
 * `errorMessage` cannot express.
 *
 * Exported: `settings.ts` reuses it verbatim for `PUT /api/settings/captcha`,
 * whose 400s carry the same `{ error, field }` shape (`field` is `"provider"`
 * or `"apiKey"`). Nothing here is account-specific — it is a generic
 * HTTP+JSON error-with-field parser that happened to be written first for
 * accounts.
 */
export async function requestError(res: Response, route: string): Promise<AccountRequestError> {
  const fallback = `${route} failed: ${res.status}`;
  let message = fallback;
  let field: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const body = parsed as { error?: unknown; field?: unknown };
        if (typeof body.error === "string") message = body.error;
        if (typeof body.field === "string") field = body.field;
      }
    }
  } catch {
    // a body that is missing, empty or not JSON keeps the bare status line
  }
  return Object.assign(new Error(message), field !== undefined ? { field } : {});
}

/**
 * The GETs throw the bare status line and the mutations read the body — the
 * same rule `api.ts:44-58` records, which is not "mutations read the body"
 * (`updateApplicationPipeline` is a mutation that does not) but "routes whose
 * error text the user cannot otherwise learn do". Every accounts mutation
 * qualifies: `account already exists: Acme.COM` names a key the user has to go
 * look at, and a 400 names the rejected field. A 404 from a GET says nothing
 * the URL does not.
 *
 * Every host goes through `encodeURIComponent`, which is what makes the
 * port-bearing and hand-edited keys of Decision 2 addressable from the client
 * at all.
 */
export async function fetchAccounts(): Promise<ATSAccount[]> {
  const res = await fetch("/api/accounts");
  if (!res.ok) throw new Error(`GET /api/accounts failed: ${res.status}`);
  return res.json() as Promise<ATSAccount[]>;
}

export async function fetchAccount(host: string): Promise<AccountDetailPayload> {
  const res = await fetch(`/api/accounts/${encodeURIComponent(host)}`);
  if (!res.ok) throw new Error(`GET /api/accounts/:host failed: ${res.status}`);
  return res.json() as Promise<AccountDetailPayload>;
}

export async function createAccount(body: AccountCreateBody): Promise<AccountMutationResult> {
  const res = await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await requestError(res, "POST /api/accounts");
  return res.json() as Promise<AccountMutationResult>;
}

export async function updateAccount(
  host: string,
  body: AccountUpdateBody,
): Promise<AccountMutationResult> {
  const res = await fetch(`/api/accounts/${encodeURIComponent(host)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await requestError(res, "PATCH /api/accounts/:host");
  return res.json() as Promise<AccountMutationResult>;
}

export async function deleteAccount(host: string): Promise<AccountMutationResult> {
  const res = await fetch(`/api/accounts/${encodeURIComponent(host)}`, { method: "DELETE" });
  if (!res.ok) throw await requestError(res, "DELETE /api/accounts/:host");
  return res.json() as Promise<AccountMutationResult>;
}

/**
 * The one route that returns a password (Decision 1). It is grouped with the
 * mutations here even though the server classifies it as a read, because the
 * two groupings answer different questions: the server's is "does this route
 * write, and therefore owe a JSON refusal?", this one's is "does this route say
 * something the user cannot otherwise learn?" — and `no password on file` is
 * exactly such a sentence. Its HTML 500 on a corrupt file falls through
 * `requestError`'s ladder to the bare status line, which is the right rendering
 * for a body that is not JSON.
 *
 * The returned value is a secret: the caller keeps it in short-lived component
 * state and nowhere else.
 */
export async function revealPassword(host: string): Promise<string> {
  const res = await fetch(`/api/accounts/${encodeURIComponent(host)}/reveal`, { method: "POST" });
  if (!res.ok) throw await requestError(res, "POST /api/accounts/:host/reveal");
  const body = (await res.json()) as AccountRevealResponse;
  return body.password;
}

/** Case-insensitive substring over the four fields the list shows; blank matches everything. */
export function filterAccounts(accounts: ATSAccount[], query: string): ATSAccount[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return accounts;
  return accounts.filter((a) =>
    `${a.host} ${a.company ?? ""} ${a.emailUsed ?? ""} ${a.username ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

/** `ATSAccount.lastLoginStatus` is a free string on disk; only known values get a mapped tone. */
export function isLoginStatus(value: string | null): value is LoginStatus {
  return value !== null && (LOGIN_STATUSES as readonly string[]).includes(value);
}

/**
 * AC 2's mapping. Shaped like `Stamp.tsx`'s `applyStateTone`, but it MUST carry
 * a default: `lastLoginStatus` is `string | null` and the reader deliberately
 * surfaces whatever a hand-edited `credentials.json` holds, so exhaustiveness is
 * not available here.
 */
export function loginStatusTone(status: string | null): Tone {
  if (!isLoginStatus(status)) return "neutral";
  switch (status) {
    case "success":
      return "good";
    case "failed":
      return "crit";
    case "pending":
      return "warn";
    default:
      return "neutral";
  }
}

/** The stored value as written, so an off-list status stays visible rather than being hidden. */
export function loginStatusLabel(status: string | null): string {
  return status ?? "unknown";
}

/**
 * Hostname-shaped, with an optional port. Groups 1-3 are the label shapes;
 * group 4 is the `:port` tail, range-checked below rather than by a cleverer
 * pattern.
 */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?(?::(\d{1,5}))?$/i;

/**
 * `https://<host>` when the key is safe to hand the browser as an href, `null`
 * otherwise.
 *
 * This is NOT a second copy of the server's `normalizeHost` and must not be
 * written as one. Its only job is refusing a string that must never become an
 * href, and it has to keep rendering links for keys that already exist on disk
 * — which, under Decision 2, include `MixedCase.Example.COM` and
 * `acme.example.com:8443`. So it is case-insensitive, it accepts a port, and it
 * returns the host's ORIGINAL casing so the link target and the displayed key
 * read the same.
 *
 * A `new URL()` round-trip is deliberately not used: `new URL("https://a.com:443").host`
 * is `"a.com"` (the default port is dropped) and `new URL("https://HOST.COM").host`
 * is `"host.com"`, so an identity check would reject two strings that are
 * perfectly good links. This is the client-side twin of `QueueList.tsx`'s local
 * `isHttpUrl` guard: React sanitizes only `javascript:`, and `credentials.json`
 * is hand-editable.
 */
export function accountUrl(host: string): string | null {
  if (host.length > 253) return null;
  const match = HOST_PATTERN.exec(host);
  if (!match) return null;
  const port = match[4];
  if (port !== undefined) {
    // `\d{1,5}` accepts `:99999` and `:0`, and neither is a port. Stated once,
    // numerically, in the form anyone can check against the spec.
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
  }
  const name = port === undefined ? host : host.slice(0, host.length - port.length - 1);
  if (name.replace(/\.$/, "").split(".").some((label) => label.length > 63)) return null;
  return `https://${host}`;
}
