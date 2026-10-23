import { describe, expect, it } from "vitest";
import { createLineSplitter } from "../runs/jsonl";
import {
  normalizeRpcEvent,
  stripAnsi,
  toolResultText,
  toolSummary,
  truncate,
} from "../runs/normalize";

function collect(chunks: (string | Buffer)[], { end = true } = {}): string[] {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  for (const chunk of chunks) {
    splitter.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  if (end) splitter.end();
  return lines;
}

describe("createLineSplitter", () => {
  it("joins a record split across chunks", () => {
    expect(collect(['{"type":"agen', 't_start"}\n'])).toEqual(['{"type":"agent_start"}']);
  });

  it("emits nothing until the newline arrives", () => {
    expect(collect(['{"type":"agent_start"}'], { end: false })).toEqual([]);
  });

  it("strips one trailing carriage return", () => {
    expect(collect(['{"a":1}\r\n{"b":2}\r\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps U+2028 and U+2029 inside a string as one record", () => {
    // The whole reason this is not Node readline: both are valid inside a JSON
    // string, and readline would split here and destroy the record.
    const record = JSON.stringify({ message: "line\u2028break\u2029here" });
    expect(record).toContain("\u2028");
    const lines = collect([`${record}\n`]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe("line\u2028break\u2029here");
  });

  it("flushes a final unterminated record on end()", () => {
    expect(collect(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("drops empty records rather than passing them to JSON.parse", () => {
    expect(collect(['{"a":1}\n\n\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const buf = Buffer.from(JSON.stringify({ s: "é→π" }) + "\n", "utf8");
    const lines = collect([buf.subarray(0, 12), buf.subarray(12)]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).s).toBe("é→π");
  });

  it("ignores pushes after end()", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.end();
    splitter.push(Buffer.from('{"a":1}\n'));
    expect(lines).toEqual([]);
  });
});

describe("stripAnsi", () => {
  it("removes the truecolor sequences real pi wraps setStatus text in", () => {
    expect(stripAnsi("\u001b[38;2;1;2;3mmcp\u001b[0m")).toBe("mcp");
  });

  it("leaves ordinary text alone", () => {
    expect(stripAnsi("mcp 0/3 servers")).toBe("mcp 0/3 servers");
  });
});

describe("truncate", () => {
  it("passes short text through unchanged", () => {
    expect(truncate("short")).toBe("short");
  });

  it("caps long text and says how much it dropped", () => {
    const out = truncate("x".repeat(5000));
    expect(out.startsWith("x".repeat(4096))).toBe(true);
    expect(out).toContain("truncated 904 chars");
  });
});

describe("toolSummary", () => {
  it("names the url for browser_navigate", () => {
    expect(toolSummary("browser_navigate", { url: "https://example.com/jobs/1" })).toBe(
      "https://example.com/jobs/1",
    );
  });

  it("names the element for browser_click", () => {
    expect(toolSummary("browser_click", { element: "Submit button", ref: "e12" })).toBe(
      "Submit button",
    );
  });

  it("names the element for browser_type", () => {
    expect(toolSummary("browser_type", { element: "First name", text: "Jane" })).toBe("First name");
  });

  it("names the element for browser_fill_form", () => {
    expect(toolSummary("browser_fill_form", { element: "Application form", fields: [] })).toBe(
      "Application form",
    );
  });

  it("falls back to the first string argument for an unknown tool", () => {
    expect(toolSummary("read", { path: "state.json", limit: 20 })).toBe("state.json");
  });

  it("falls back to a JSON excerpt when no argument is a string", () => {
    expect(toolSummary("mystery", { a: 1, b: false })).toBe('{"a":1,"b":false}');
  });

  it("collapses to one line but does not cap it — redact.ts caps after redacting", () => {
    const url = `https://x.test/${"a".repeat(200)}`;
    expect(toolSummary("browser_navigate", { url })).toBe(url);
    expect(toolSummary("read", { path: " state\n  .json " })).toBe("state .json");
  });
});

describe("toolResultText", () => {
  it("joins text parts", () => {
    expect(
      toolResultText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }),
    ).toBe("one\ntwo");
  });

  it("names non-text parts instead of dropping them", () => {
    expect(
      toolResultText({ content: [{ type: "text", text: "shot" }, { type: "image", data: "…" }] }),
    ).toBe("shot\n[image]");
  });

  it("returns empty string for a missing result", () => {
    expect(toolResultText(null)).toBe("");
  });
});

describe("normalizeRpcEvent", () => {
  it("turns a text_delta into a text event", () => {
    expect(
      normalizeRpcEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
      }),
    ).toEqual({ type: "text", delta: "Hello" });
  });

  it("turns the message_update text_end sub-event into text_end", () => {
    expect(
      normalizeRpcEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
      }),
    ).toEqual({ type: "text_end" });
  });

  it("turns a message_end whose assistant message stopped with error into an error event", () => {
    expect(
      normalizeRpcEvent({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 {\"type\":\"error\"}" },
      }),
    ).toEqual({ type: "error", message: "model error: 400 {\"type\":\"error\"}" });
  });

  it("falls back to a generic message when the errored turn carries none", () => {
    expect(
      normalizeRpcEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }),
    ).toEqual({ type: "error", message: "model error: the model returned an error" });
  });

  it("stays silent on an aborted turn — that is the user's own cancel", () => {
    expect(
      normalizeRpcEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } }),
    ).toBeNull();
  });

  it("ignores a completed message_end and a tool-result message_end", () => {
    expect(normalizeRpcEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } })).toBeNull();
    expect(normalizeRpcEvent({ type: "message_end", message: { role: "toolResult", content: [], stopReason: "error" } })).toBeNull();
  });

  it("ignores a bare message_end — it is not the text-block terminator", () => {
    expect(normalizeRpcEvent({ type: "message_end", message: {} })).toBeNull();
  });

  it("ignores the lifecycle events the run manager owns", () => {
    expect(normalizeRpcEvent({ type: "agent_start" })).toBeNull();
    expect(normalizeRpcEvent({ type: "agent_settled" })).toBeNull();
    expect(normalizeRpcEvent({ type: "response", command: "prompt", success: true })).toBeNull();
  });

  it("summarizes a tool start", () => {
    expect(
      normalizeRpcEvent({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "browser_navigate",
        args: { url: "https://zeta.com/jobs/9" },
      }),
    ).toEqual({
      type: "tool_start",
      toolCallId: "call_1",
      name: "browser_navigate",
      summary: "https://zeta.com/jobs/9",
      args: { url: "https://zeta.com/jobs/9" },
    });
  });

  it("carries isError and the result text on a tool end", () => {
    expect(
      normalizeRpcEvent({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "browser_navigate",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      }),
    ).toEqual({ type: "tool_end", toolCallId: "call_1", isError: false, result: "ok" });
  });

  it("defaults an omitted notifyType to info", () => {
    expect(
      normalizeRpcEvent({
        type: "extension_ui_request",
        id: "u1",
        method: "notify",
        message: "Job applier extension loaded",
      }),
    ).toEqual({ type: "notify", level: "info", message: "Job applier extension loaded" });
  });

  it("keeps warning and error notify levels", () => {
    expect(
      normalizeRpcEvent({
        type: "extension_ui_request",
        id: "u2",
        method: "notify",
        message: "nope",
        notifyType: "warning",
      }),
    ).toMatchObject({ level: "warning" });
  });

  it("strips ANSI out of a setStatus line", () => {
    expect(
      normalizeRpcEvent({
        type: "extension_ui_request",
        id: "u3",
        method: "setStatus",
        statusKey: "mcp",
        statusText: "\u001b[38;2;1;2;3mmcp 0/3 servers\u001b[0m",
      }),
    ).toEqual({ type: "status_line", key: "mcp", text: "mcp 0/3 servers" });
  });

  it("maps the four dialog methods to ui_request", () => {
    const base = { type: "extension_ui_request", id: "u4" };
    expect(normalizeRpcEvent({ ...base, method: "confirm", title: "Sure?", message: "really" })).toEqual({
      type: "ui_request",
      id: "u4",
      method: "confirm",
      title: "Sure?",
      message: "really",
    });
    expect(normalizeRpcEvent({ ...base, method: "select", title: "Pick", options: ["a", "b"] })).toEqual({
      type: "ui_request",
      id: "u4",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
    });
    expect(normalizeRpcEvent({ ...base, method: "input", title: "Value", placeholder: "type" })).toEqual({
      type: "ui_request",
      id: "u4",
      method: "input",
      title: "Value",
      placeholder: "type",
    });
    expect(normalizeRpcEvent({ ...base, method: "editor", title: "Edit", prefill: "a\nb" })).toEqual({
      type: "ui_request",
      id: "u4",
      method: "editor",
      title: "Edit",
      prefill: "a\nb",
    });
  });

  it("drops the TUI-only fire-and-forget methods", () => {
    const base = { type: "extension_ui_request", id: "u5" };
    expect(normalizeRpcEvent({ ...base, method: "setWidget", widgetKey: "k", widgetLines: [] })).toBeNull();
    expect(normalizeRpcEvent({ ...base, method: "setTitle", title: "pi" })).toBeNull();
    expect(normalizeRpcEvent({ ...base, method: "set_editor_text", text: "x" })).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(normalizeRpcEvent(null)).toBeNull();
    expect(normalizeRpcEvent("agent_start")).toBeNull();
  });
});
