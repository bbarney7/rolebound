import { capSummary, truncate } from "./normalize";
import type { RunEvent, ToolCardDetails } from "../../shared/types";

/**
 * The names of keys whose VALUE is a secret wherever it appears — in a tool's
 * arguments, in a JSON blob a tool printed, anywhere.
 *
 * ONE SOURCE STRING, because three things read it: the substring test below,
 * the JSON-pair pattern under that, and secrets.ts's classifier for
 * credentials.json. A name added to one of those and not the others is a hole.
 * Non-capturing groups only — JSON_SECRET_PAIR numbers its own.
 *
 * Matched as a substring, so `new_password`, `apiKey`, `access_token` and
 * `set-cookie` are all caught by the same expression.
 *
 * BARE `session` IS DELIBERATELY ABSENT. The run's own summary carries a
 * `sessionName` and a tool that prints a `sessionFile` path is not printing a
 * credential; only the session values that ARE credentials — `session_id`,
 * `sessionKey`, and `session_token` via `token` — are named.
 */
const SECRET_KEY_SOURCE =
  "pass(?:word|phrase)?|passwd|pwd|secret|token|credential|api[_-]?key|" +
  "authorization|bearer|cookie|session_?(?:id|token|key)";

/** The substring test, shared with secrets.ts so the two cannot drift. */
export const SECRET_KEY = new RegExp(SECRET_KEY_SOURCE, "i");

export const REDACTED = "[redacted]";

/**
 * `"password": "…"` inside a STRING — a tool result is text by the time it
 * reaches here (`toolResultText` joins the content parts), so a JSON blob a
 * tool printed is no longer walkable as an object. The key group is bounded by
 * quotes so it cannot run across a whole object, and the value group consumes
 * escapes so a password containing `\"` does not end the match early.
 */
const JSON_SECRET_PAIR = new RegExp(
  `"([A-Za-z0-9_.-]*(?:${SECRET_KEY_SOURCE})[A-Za-z0-9_.-]*)"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);

/**
 * The shape `redactText` needs a secrets list in: longest first, deduplicated,
 * empties dropped.
 *
 * LENGTH ORDER IS NOT COSMETIC. Replacement is literal and sequential, so with
 * `["abc", "abcdef"]` the short value goes first and `token=abcdef` comes out
 * `token=[redacted]def` — the tail of the longer secret, published. Longest
 * first cannot do that: once a value is gone, nothing shorter of it is left to
 * match around the marker.
 *
 * The empty string is dropped because `split("")` would explode the text into
 * characters and rejoin it with a marker between every one of them.
 *
 * `createSecretsReader` calls this when its cache refreshes, so the sort costs
 * one credentials.json change rather than one event; `redactText` redoes it
 * defensively for a list that reached it from anywhere else.
 */
export function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a known secret VALUE, then mask any `"key": "…"`
 * pair whose key names a secret.
 *
 * Literal replacement is `split`/`join` rather than a RegExp: a generated
 * password is full of `!@#$%^&*`, and escaping it into a pattern to then
 * replace it is a step that can only go wrong.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  // Nothing to order below two entries, and the guard keeps the sort off the
  // common path; the `secret &&` below is what a one-entry list still needs.
  for (const secret of secrets.length > 1 ? normalizeSecrets(secrets) : secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out.replace(JSON_SECRET_PAIR, `"$1"$2"${REDACTED}"`);
}

/**
 * How much of the assistant's text cannot be emitted yet.
 *
 * pi splits a text block into `text_delta` chunks at any offset it likes, so a
 * literal match on one delta cannot see `SENTINEL-` in one chunk and
 * `do-not-leak` in the next: both halves would go out in plaintext. The fix is
 * a SUFFIX HOLDBACK — whatever trailing part of the stream could still turn out
 * to be the start of a secret is kept back until the next delta says whether it
 * does.
 *
 * `keep` is the longest suffix of `combined` that is a PROPER prefix of some
 * secret (`1 ≤ length < secret.length`). Proper because a suffix that is a
 * whole secret is not a partial match — it is a hit `redactText` must be
 * allowed to see. A complete secret can therefore never END inside the holdback
 * without also STARTING in it, which is what makes the emit that carries a
 * secret's last character carry all of it.
 *
 * The caller owns the holdback string (one per assistant text block) and must
 * flush it at `text_end` — see `RunManager.emit`.
 */
export function splitHoldback(
  combined: string,
  secrets: readonly string[],
): { emit: string; holdback: string } {
  let keep = 0;
  for (const secret of secrets) {
    // Longest first, so the first hit for this secret is its best one.
    for (let length = Math.min(secret.length - 1, combined.length); length > keep; length -= 1) {
      if (combined.endsWith(secret.slice(0, length))) {
        keep = length;
        break;
      }
    }
  }
  if (keep === 0) return { emit: combined, holdback: "" };
  return { emit: combined.slice(0, combined.length - keep), holdback: combined.slice(-keep) };
}

/**
 * The same treatment for structured data (a tool's `args`), where the key is
 * still a key: the value of a secret-named key is dropped outright rather than
 * matched, and every remaining string still goes through `redactText` — a
 * password typed into a form arrives as `browser_type`'s `text`, under a key
 * that names nothing.
 */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

/** Keep extracted documents from becoming megabytes in the replay log. */
function capCardValue(value: unknown): unknown {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.map(capCardValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capCardValue(item)]));
  return value;
}

/**
 * The redaction boundary (D4: raw payloads never reach the browser).
 *
 * This runs on every event on its way into the run log, which is the last
 * point where one function still sees ALL of them — the log is what `/current`
 * returns and what `/events` streams, so an event that is clean here is clean
 * on both surfaces and in every later replay. Redacting in the route instead
 * would leave the plaintext sitting in the server's log for whatever reads it
 * next.
 *
 * What actually carries secrets: `create_account` and `get_account` print the
 * password into their result text (`.pi/extensions/job-accounts.ts`), and
 * Playwright's `browser_type` / `browser_fill_form` carry it in their args when
 * the agent fills a login form.
 *
 * A `text` event reaching here has already been through `splitHoldback`, so a
 * value pi split across two `text_delta` chunks arrives whole in the delta that
 * completes it, and this sees it as a literal.
 *
 * TRUNCATION IS APPLIED HERE, AFTER REDACTION, and on the same fields the
 * normalizer used to cap — `MAX_TEXT` for a body of text, `SUMMARY_MAX` for a
 * tool's one-line summary. Cutting first — a 5000-character tool result whose
 * password straddles the 4096th character, an 80-character summary whose
 * password straddles the 80th — leaves the first half of that password in the
 * transcript. A cap is a display budget; it must never be the thing that
 * decides how much of a secret survives.
 *
 * `secrets` is a getter so an event that cannot carry one (a status change, an
 * exit code) costs no stat of credentials.json.
 */
export function redactEvent(event: RunEvent, secrets: () => readonly string[]): RunEvent {
  switch (event.type) {
    case "tool_start": {
      const list = secrets();
      return {
        ...event,
        // Capped after redacting, like every other field here: the collapsed
        // tool row is one line of 80 characters, and a secret straddling the
        // 80th used to leave its head in it while `args` came out clean.
        summary: capSummary(redactText(event.summary, list)),
        args: redactValue(event.args, list),
      };
    }
    case "tool_end": {
      const list = secrets();
      return { ...event, result: truncate(redactText(event.result, list)),
        ...(event.details === undefined ? {} : { details: capCardValue(redactValue(event.details, list)) as ToolCardDetails }) };
    }
    case "text":
      return { ...event, delta: truncate(redactText(event.delta, secrets())) };
    // `notify` is whatever an extension chose to say, and gets the same cap.
    case "notify":
      return { ...event, message: truncate(redactText(event.message, secrets())) };
    // `user` is the operator's own reply box and `error` is the stderr tail of
    // a failed exit, already bounded by STDERR_TAIL. Neither came through the
    // normalizer, so neither was ever capped.
    case "user":
    case "error":
      return { ...event, message: redactText(event.message, secrets()) };
    case "status_line":
      return { ...event, text: truncate(redactText(event.text, secrets())) };
    case "ui_request": {
      const list = secrets();
      return {
        ...event,
        title: redactText(event.title, list),
        message: event.message === undefined ? undefined : redactText(event.message, list),
        options: event.options?.map((option) => redactText(option, list)),
        placeholder:
          event.placeholder === undefined ? undefined : redactText(event.placeholder, list),
        prefill: event.prefill === undefined ? undefined : redactText(event.prefill, list),
      };
    }
    default:
      return event;
  }
}
