import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeSlug, paths } from "./workspace";
import { withLock } from "./lock";
import { WorkspaceFileError } from "../../.pi/extensions/lib/durable-store";
import { CredentialsShapeError, parseCredentialsText } from "./readers/credentials";
import type { RawCredentialEntry, RawCredentials } from "../shared/types";

/** Total length and per-label length from the DNS name syntax. */
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** A scheme, port, path, credential or percent-escape means this is a URL, not a host. */
const HOST_FORBIDDEN = /[\s/\\?#@:%\u0000-\u001f\u007f]/;

/** Lowercase LDH labels only — the shape `new URL(...).host` produces. */
const HOST_LABELS = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The CREATE-side normalizer, and POST /api/accounts is the only caller.
 *
 * Only create mints a new key, and only a newly minted key has to be canonical.
 * The lookup routes (GET/PATCH/DELETE /:host, reveal) deliberately do NOT call
 * this — they address the stored key verbatim, because credentials.json keys are
 * whatever the extension or a human wrote. In particular this rejects the
 * host:port form EVEN THOUGH the extension can produce one: extractHost
 * (.pi/extensions/job-accounts.ts:73) returns `new URL(url).host`, which includes
 * a port. That asymmetry is deliberate — an account the UI creates should be a
 * bare hostname, while a port-bearing key already on disk stays fully manageable.
 *
 * THE LOWERCASING IS LOAD-BEARING. WHATWG `new URL(...).host` lowercases its
 * output, so every key the extension has ever written is already lowercase;
 * folding a typed `Acme.COM` down to `acme.com` produces exactly the key the
 * agent would have produced for the same site, instead of a second entry the
 * agent will never find. The property enforced here is "no scheme, port, path,
 * query, fragment, credentials or percent-escapes" — not "the input was already
 * lowercase". Case VARIANTS that already exist on disk are handled separately,
 * by the in-lock fold in createAccountEntry.
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let candidate = input.trim().toLowerCase();
  if (candidate === "") return null;
  if (HOST_FORBIDDEN.test(candidate)) return null;
  // one optional trailing "." — the root-label form
  if (candidate.endsWith(".")) candidate = candidate.slice(0, -1);
  if (candidate === "") return null;

  // The identity check is what rejects unicode: WHATWG punycodes it, so
  // `hostname !== candidate`. Deliberate — the extension keys on the literal
  // host string it read from the browser.
  try {
    const url = new URL(`https://${candidate}`);
    if (
      url.hostname !== candidate ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }

  if (candidate.length > MAX_HOST_LENGTH) return null;
  if (!HOST_LABELS.test(candidate)) return null;
  if (candidate.split(".").some((label) => label.length > MAX_LABEL_LENGTH)) return null;
  // The host never touches the filesystem, but the path-safety floor is free and
  // stops ".." reaching a key.
  if (!isSafeSlug(candidate)) return null;
  return candidate;
}

/**
 * EEXIST, CONFLICT, SHAPE and PARSE are ALL FOUR 409 at the route, and are
 * deliberately separate codes: a 409 the user cannot act on is a dead end, and
 * the four ask for four different repairs. EEXIST means the exact key is already
 * in the file; CONFLICT means a case-variant of it is; SHAPE means something the
 * writer was handed is not the shape it must be (in practice the file — a bad
 * root, a bad entry value, or a bad known field inside an entry); PARSE means the
 * file's bytes are not JSON at all. Every SHAPE and PARSE result carries the
 * message that describes its own cause, and the route never substitutes a
 * generic one.
 */
export type AccountWriteError = {
  code: "EEXIST" | "CONFLICT" | "NOT_FOUND" | "SHAPE" | "PARSE";
  message: string;
};

/**
 * `entry` is a RawCredentialEntry, which CAN carry `password` — and no route may
 * serialize it. It exists so the delete response can be built from the entry the
 * writer saw under the lock; every route that answers with it maps it through
 * toAtsAccount first.
 */
export type AccountWriteResult =
  | { ok: true; entry: RawCredentialEntry }
  | { ok: false; error: AccountWriteError };

export type CreateAccountFields = {
  username: string;
  password?: string;
  emailUsed?: string;
  ats: string;
  company?: string;
  notes?: string;
};

/** Raw (snake_case) keys a PATCH may set; null means "delete the key". */
export type UpdateAccountChanges = Partial<
  Record<
    | "username"
    | "password"
    | "email_used"
    | "ats"
    | "company"
    | "notes"
    | "last_login_status",
    string | null
  >
>;

/**
 * The bound updateAccountEntry and deleteAccountEntry apply to the key they are
 * handed — identical to the route's own `hostParam` guard. It is a BOUND, not a
 * validation: it never rewrites the key it accepts. Unreachable through the
 * routes, which have already applied it; it exists so a future non-route caller
 * cannot slip past it.
 */
function isBoundedHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host !== "" &&
    host.length <= MAX_HOST_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(host)
  );
}

/** Case/whitespace/trailing-dot fold, for the create-side variant scan only. */
function fold(key: string): string {
  const trimmed = key.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Write the map atomically.
 *
 * The temp path is dot-prefixed AND .tmp-suffixed so WATCH_IGNORED double-ignores
 * it (events.ts:15 dotfiles, :20 *.tmp) and only the rename fires an SSE frame.
 * PID + time + random so two processes cannot collide on the name.
 *
 * 2-space indent and NO trailing newline — byte-identical to the extension's own
 * writeCredentials (.pi/extensions/job-accounts.ts:66), so alternating writes do
 * not produce a whole-file diff.
 *
 * The catch is what stops a failed write or rename — ENOSPC, EXDEV, a permission
 * change mid-flight — from leaving a `.credentials.*.tmp` orphan behind for every
 * attempt; `{ force: true }` makes the cleanup a silent no-op when the temp file
 * was never created, so it can never mask the real failure. The original error is
 * rethrown unchanged, so the route still answers 500 rather than swallowing it.
 */
async function writeCredentials(file: string, next: RawCredentials): Promise<void> {
  const { atomicWriteFile } = await import("../../.pi/extensions/lib/durable-store");
  await atomicWriteFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}

type Mutation = (next: RawCredentials) => AccountWriteResult;

/**
 * The shared read-modify-write recipe: lock, read INSIDE the lock through the
 * SAME helper the readers use, copy, mutate, write atomically.
 *
 * Reading through parseCredentialsText rather than a second JSON.parse is what
 * keeps the read path and the write path from ever disagreeing about what a file
 * means — a raw JSON.parse here would throw a SyntaxError on a zero-byte file and
 * 500 exactly the create the empty-file case is supposed to make succeed.
 *
 * Both corrupt-file failures are caught here and returned as DATA, with the
 * bytes untouched: app.ts has no trailing error handler, so letting either out
 * would give the user's save button Express's HTML 500, which a form can only
 * render as a bare status line. A mutation that cannot proceed because the file
 * is unreadable is exactly the case where the reason has to reach the form.
 */
async function mutateCredentials(root: string, mutate: Mutation): Promise<AccountWriteResult> {
  const file = paths.credentials(root);
  return withLock(file, async () => {
    let parsed: RawCredentials;
    try {
      parsed = parseCredentialsText(await fs.readFile(file, "utf-8"));
    } catch (err) {
      if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
        return { ok: false, error: { code: "PARSE", message: err.message } };
      }
      if (err instanceof CredentialsShapeError) {
        return { ok: false, error: { code: "SHAPE", message: err.message } };
      }
      if (err instanceof SyntaxError) {
        return { ok: false, error: { code: "PARSE", message: "credentials.json is not valid JSON" } };
      }
      throw err;
    }

    // A COPY, and it is defensive rather than load-bearing: parseCredentialsText
    // already returns a null-prototype map, so dropping this line would leave the
    // writer correct today. It stays because the writer must not mutate a map it
    // was handed — the steps below delete keys and assign new ones, and doing
    // that to a read helper's return value is a side effect on someone else's
    // value, harmless only because that helper happens to build a fresh object
    // per call. Object.assign(Object.create(null), parsed) is also the cheapest
    // copy that preserves both key order and the null prototype.
    //
    // The null prototype itself is not decoration: credentials.json is
    // hand-editable and a host can be "constructor", "toString" or "__proto__".
    // Against a plain `{ ...parsed }`, `next["constructor"]` reads an INHERITED
    // function and reports a false hit, and `next["__proto__"] = entry` goes
    // through the prototype setter instead of the map. JSON.parse creates
    // `__proto__` as an own DATA property, so such a key arriving from a hand
    // edit is data, not pollution — the null-prototype map plus Object.hasOwn is
    // what keeps it inert while still letting the user see and delete it.
    const next: RawCredentials = Object.assign(Object.create(null), parsed);

    const outcome = mutate(next);
    if (!outcome.ok) return outcome;

    // Assigning an existing key in place preserves its position and a new key
    // appends, so the diff against the extension's output stays minimal.
    await writeCredentials(file, next);
    return outcome;
  });
}

/**
 * Create one entry, keyed by a canonical host.
 *
 * `host` arrives already normalized by the route; this re-normalizes anyway as a
 * last line of defence and returns SHAPE if it disagrees (the posture
 * queueWriter.ts:253-259 documents). This is the ONLY writer that normalizes.
 */
export async function createAccountEntry(
  root: string,
  host: string,
  fields: CreateAccountFields,
): Promise<AccountWriteResult> {
  const normalized = normalizeHost(host);
  if (normalized === null || normalized !== host) {
    return { ok: false, error: { code: "SHAPE", message: `invalid host: ${host}` } };
  }

  // withFileLock requires the target to exist — proper-lockfile canonicalizes with
  // fs.realpath first, so locking a missing path rejects ENOENT.
  // "{}" is exactly JSON.stringify({}, null, 2), so the seed matches the
  // extension's bytes. "wx" fails when the file already exists, so the seed never
  // touches an existing file — INCLUDING an existing empty one. That is not a
  // hole: the seed is skipped, the lock is taken on the file that is there, and
  // the empty-text rule inside the lock turns its zero bytes into {}. Missing
  // file and empty file both end at "create into {}", by two different routes.
  try {
    await fs.writeFile(paths.credentials(root), "{}", { flag: "wx" });
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }

  return mutateCredentials(root, (next) => {
    // Ownership is the only question being asked, and truthiness answers a
    // different one: for a key named "constructor" or "toString" a truthiness
    // test reads an inherited function and reports a false hit.
    if (Object.hasOwn(next, normalized)) {
      return {
        ok: false,
        error: { code: "EEXIST", message: `account already exists: ${normalized}` },
      };
    }

    // THE CASE-VARIANT FOLD, and this is where the authority for it lives. An
    // exact-key check is blind to a variant, so a variant written by a hand edit
    // or by the extension AFTER any pre-flight scan and BEFORE the lock was taken
    // would be invisible to it and the shadow entry would be created. The only
    // place it can be closed is between the locked read and the write, where the
    // map being checked is the map about to be written — which is why the route
    // deliberately keeps no pre-flight copy of this scan.
    const candidate = fold(normalized);
    for (const key of Object.keys(next)) {
      if (fold(key) === candidate) {
        // The EXISTING key verbatim, so the user can find the row that is
        // actually in the file instead of hunting for a string that is not.
        return {
          ok: false,
          error: { code: "CONFLICT", message: `account already exists: ${key}` },
        };
      }
    }

    const now = new Date().toISOString();
    const entry: RawCredentialEntry = {
      host: normalized,
      username: fields.username,
      ...(fields.password !== undefined ? { password: fields.password } : {}),
      ...(fields.emailUsed !== undefined ? { email_used: fields.emailUsed } : {}),
      ats: fields.ats,
      ...(fields.company !== undefined ? { company: fields.company } : {}),
      ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
      created_at: now,
      last_used_at: now,
    };
    // A plain own-property write for EVERY host string including "__proto__",
    // because `next` has a null prototype.
    next[normalized] = entry;
    return { ok: true, entry };
  });
}

/**
 * Check the file's absence BEFORE locking and answer NOT_FOUND.
 *
 * They must not seed — creating a file so they can then report NOT_FOUND out of
 * it is pointless work — and they must never let withLock be the thing that
 * discovers the absence, because proper-lockfile's ENOENT rejection propagates as
 * a throw and the route then answers 500 where the honest answer is 404. The
 * check is advisory: if the file disappears between it and the lock, withLock
 * still rejects and the route still 500s, which is the correct answer for a file
 * deleted mid-request.
 */
async function credentialsFileMissing(root: string): Promise<boolean> {
  try {
    await fs.access(paths.credentials(root));
    return false;
  } catch (err: any) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }
}

const NOT_FOUND_ERROR: AccountWriteError = { code: "NOT_FOUND", message: "account not found" };
const BAD_KEY_ERROR: AccountWriteError = { code: "SHAPE", message: "invalid host" };

/**
 * Update one entry, addressing the stored key VERBATIM.
 *
 * No normalization, no trim, no case fold, no trailing-dot strip: update
 * addresses a key that already exists and must be able to name it exactly as
 * stored. A re-normalizing update would reject `acme.example.com:8443`,
 * `MixedCase.Example.COM`, a key carrying a scheme and slashes, and `__proto__` —
 * precisely the keys this route exists to manage.
 */
export async function updateAccountEntry(
  root: string,
  host: string,
  changes: UpdateAccountChanges,
): Promise<AccountWriteResult> {
  if (!isBoundedHost(host)) return { ok: false, error: BAD_KEY_ERROR };
  if (await credentialsFileMissing(root)) return { ok: false, error: NOT_FOUND_ERROR };

  return mutateCredentials(root, (next) => {
    // No fold here — a near-miss is a plain 404, never a redirect to a
    // similar-looking key.
    if (!Object.hasOwn(next, host)) return { ok: false, error: NOT_FOUND_ERROR };

    const entry: RawCredentialEntry = { ...next[host] };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete entry[key];
      else entry[key] = value;
    }
    next[host] = entry;
    return { ok: true, entry };
  });
}

/** Remove one entry, addressing the stored key VERBATIM — see updateAccountEntry. */
export async function deleteAccountEntry(root: string, host: string): Promise<AccountWriteResult> {
  if (!isBoundedHost(host)) return { ok: false, error: BAD_KEY_ERROR };
  if (await credentialsFileMissing(root)) return { ok: false, error: NOT_FOUND_ERROR };

  return mutateCredentials(root, (next) => {
    if (!Object.hasOwn(next, host)) return { ok: false, error: NOT_FOUND_ERROR };
    const entry = next[host];
    delete next[host];
    return { ok: true, entry };
  });
}
