import { TOOL_CARD_KINDS, type ToolCardDetails, type RunEvent } from "../../shared/types";

/**
 * CSI, OSC and two-character escape sequences.
 *
 * Not defensive programming: measured against real pi on 2026-08-27, an
 * extension's `setStatus` text arrives as `\x1b[38;2;R;G;Bm…\x1b[0m` — pi
 * colours the status entry before handing it to the RPC transport. Rendering
 * that verbatim in the browser prints the escape bytes as mojibake.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

/**
 * Cap on any single piece of text that enters the run log. The log holds up to
 * 5000 entries and is replayed in full to every reattaching client, so one
 * `read` of a large file must not become a megabyte on the wire.
 *
 * APPLIED IN redact.ts, NOT HERE. Cutting the text first can cut a secret in
 * half and publish the surviving prefix, so this normalizer hands its full
 * text on and the cap goes on after redaction.
 */
export const MAX_TEXT = 4096;

export function truncate(value: string, max = MAX_TEXT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/**
 * One line in the transcript, so a tool call reads as a sentence, not a blob.
 *
 * APPLIED IN redact.ts, NOT HERE, for the reason MAX_TEXT is: a summary cut to
 * 80 characters first publishes the head of a secret that straddles character
 * 80 — in the one row a collapsed tool call always shows — even though its
 * `args` were redacted. `toolSummary` hands its full line on and `capSummary`
 * runs after redaction.
 */
export const SUMMARY_MAX = 80;

/** The one-line cap, applied at the redaction boundary. */
export function capSummary(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX - 1)}…` : value;
}

/** Collapse any value to one single-line string. */
function excerpt(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      // circular args are not expected over JSONL, but String() cannot throw
      text = String(value);
    }
  }
  return stripAnsi(text).replace(/\s+/g, " ").trim();
}

/**
 * The one line AC 2 asks for: `browser_navigate → <url>`, uncapped — the cap is
 * redact.ts's to apply (SUMMARY_MAX).
 *
 * The named cases are the applier's four most frequent tools, whose interesting
 * argument is not the first one alphabetically. Everything else — and a named
 * tool whose expected key is missing — falls through to the first non-empty
 * string argument, then to a JSON excerpt, so a tool this file has never heard
 * of still gets a readable line instead of an empty one.
 */
export function toolSummary(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  switch (name) {
    case "browser_navigate":
      if (typeof record.url === "string") return excerpt(record.url);
      break;
    case "browser_click":
    case "browser_type":
    case "browser_fill_form":
      if (typeof record.element === "string") return excerpt(record.element);
      break;
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return excerpt(value);
  }
  return excerpt(args);
}

/**
 * A tool result's text parts, joined. The cap is redact.ts's to apply.
 *
 * Non-text parts are named rather than dropped silently: a `browser_take_
 * screenshot` result is an image part, and a transcript line that read as empty
 * would look like a tool that returned nothing at all.
 */
export function toolResultText(result: unknown): string {
  if (result == null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return excerptOfWhole(result);
  const parts = content.map((part) => {
    if (part && typeof part === "object") {
      const shape = part as { type?: unknown; text?: unknown };
      if (typeof shape.text === "string") return shape.text;
      if (typeof shape.type === "string") return `[${shape.type}]`;
    }
    return "[unknown]";
  });
  return stripAnsi(parts.join("\n"));
}

/** JSON of a whole value, uncapped like everything else this file returns. */
function excerptOfWhole(value: unknown): string {
  if (typeof value === "string") return stripAnsi(value);
  try {
    return stripAnsi(JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

/**
 * Raw RPC event → the small vocabulary the browser sees (D4), or null for an
 * event this layer has nothing to say about.
 *
 * LIFECYCLE EVENTS ARE NOT NORMALIZED HERE. `agent_start`, `agent_settled` and
 * `response` drive the status machine and are consumed by the run manager; if
 * they also produced transcript entries the two would have to agree about
 * ordering, and the manager could not decide a transition without also deciding
 * what to render.
 *
 * `message_end` is NOT a text terminator. The terminator for a TEXT BLOCK is
 * `text_end`, which arrives INSIDE `message_update.assistantMessageEvent`
 * (rpc.md:938-957); `message_end` is the whole-message completion event
 * (rpc.md:906-913) and firing a paragraph break on it would merge every text
 * block of a turn into one paragraph. It is read for exactly one thing: an
 * assistant message with `stopReason: "error"`, which becomes an `error` event.
 */
export function normalizeRpcEvent(raw: unknown): RunEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  switch (event.type) {
    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (!sub || typeof sub !== "object") return null;
      const delta = sub as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        return { type: "text", delta: stripAnsi(delta.delta) };
      }
      if (delta.type === "text_end") return { type: "text_end" };
      return null;
    }
    case "message_end": {
      // The ONE thing read from message_end: a turn the provider refused or
      // failed. pi-agent-core folds the stream's `error` sub-event into the
      // final message (`stopReason: "error"`, `errorMessage`) and never
      // forwards it as a message_update, so without this the run just returns
      // to `waiting` with an empty assistant turn and nothing on screen says
      // why — seen on the owner-present check when Anthropic answered OAuth
      // inference with a 400. `aborted` is the user's own cancel; stay quiet.
      const message = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
      if (message?.role !== "assistant" || message.stopReason !== "error") return null;
      const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? stripAnsi(message.errorMessage.trim())
        : "the model returned an error";
      return { type: "error", message: `model error: ${truncate(detail)}` };
    }
    case "tool_execution_start": {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      return {
        type: "tool_start",
        toolCallId: String(event.toolCallId ?? ""),
        name,
        summary: toolSummary(name, event.args),
        args: event.args ?? null,
      };
    }
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: String(event.toolCallId ?? ""),
        isError: event.isError === true,
        result: toolResultText(event.result),
        ...toolEndExtras(event.result),
      };
    case "extension_ui_request":
      return normalizeUiRequest(event);
    default:
      return null;
  }
}

function toolEndExtras(result: unknown): {
  details?: ToolCardDetails;
  handoff?: { kind: "apply" | "apply-next"; slug: string | null };
} {
  const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const extras: {
    details?: ToolCardDetails;
    handoff?: { kind: "apply" | "apply-next"; slug: string | null };
  } = {};
  const card = (details as { card?: unknown }).card;
  if (typeof card === "string" && (TOOL_CARD_KINDS as readonly string[]).includes(card)) {
    extras.details = details as ToolCardDetails;
  }
  const handoff = (details as { handoff?: unknown }).handoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const kind = (handoff as { kind?: unknown }).kind;
    const slug = (handoff as { slug?: unknown }).slug;
    if ((kind === "apply" || kind === "apply-next") && (slug === null || typeof slug === "string")) {
      extras.handoff = { kind, slug };
    }
  }
  return extras;
}

/**
 * The extension UI sub-protocol (rpc.md:1161-1330). The four dialog methods
 * become `ui_request` and MUST be answered or the extension's promise never
 * settles (AC 4); `notify` and `setStatus` are fire-and-forget transcript
 * material; `setWidget`, `setTitle` and `set_editor_text` describe a terminal
 * this client does not have and are dropped.
 */
function normalizeUiRequest(event: Record<string, unknown>): RunEvent | null {
  const id = typeof event.id === "string" ? event.id : "";
  const title = typeof event.title === "string" ? stripAnsi(event.title) : "";
  switch (event.method) {
    case "notify": {
      const type = event.notifyType;
      const level = type === "warning" || type === "error" ? type : "info";
      return {
        type: "notify",
        level,
        message: stripAnsi(String(event.message ?? "")),
      };
    }
    case "setStatus":
      // statusText is `string | undefined`; undefined CLEARS the entry, which
      // reaches the client as an empty line for that key rather than a removal.
      return {
        type: "status_line",
        key: String(event.statusKey ?? ""),
        text: stripAnsi(String(event.statusText ?? "")),
      };
    case "confirm":
      return {
        type: "ui_request",
        id,
        method: "confirm",
        title,
        message: typeof event.message === "string" ? stripAnsi(event.message) : undefined,
      };
    case "select":
      return {
        type: "ui_request",
        id,
        method: "select",
        title,
        options: Array.isArray(event.options)
          ? event.options.filter((o): o is string => typeof o === "string").map(stripAnsi)
          : [],
      };
    case "input":
      return {
        type: "ui_request",
        id,
        method: "input",
        title,
        placeholder: typeof event.placeholder === "string" ? stripAnsi(event.placeholder) : undefined,
      };
    case "editor":
      return {
        type: "ui_request",
        id,
        method: "editor",
        title,
        prefill: typeof event.prefill === "string" ? event.prefill : undefined,
      };
    default:
      return null;
  }
}
