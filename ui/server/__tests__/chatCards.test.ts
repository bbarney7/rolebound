import { describe, expect, it } from "vitest";
import { normalizeRpcEvent } from "../runs/normalize";
import { maskUnreadableChildEvent } from "../runs/runManager";
import { redactEvent } from "../runs/redact";

describe("tool card events", () => {
  it("passes card details through normalization and recursive redaction", () => {
    const event = normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "t", result: {
      content: [{ type: "text", text: "Saved" }],
      details: { card: "application", company: "private-value", nested: { password: "unknown", rows: [{ note: "private-value" }] } },
    } });
    expect(event?.type).toBe("tool_end");
    const scrubbed = redactEvent(event!, () => ["private-value"]);
    expect(scrubbed).toMatchObject({ details: { card: "application", company: "[redacted]", nested: { password: "[redacted]", rows: [{ note: "[redacted]" }] } } });
    expect(JSON.stringify(scrubbed)).not.toContain("private-value");
  });
  it("keeps old tool results identical and rejects invalid card discriminators", () => {
    for (const details of [undefined, { token: "x" }, { card: "unknown" }, []]) {
      expect(normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "t", result: { content: [{ type: "text", text: "Old" }], details } })).toEqual({ type: "tool_end", toolCallId: "t", isError: false, result: "Old" });
    }
  });
});

it("suppresses card payloads when run credentials become unreadable", () => {
  const event = maskUnreadableChildEvent({ type: "tool_end", toolCallId: "t", isError: false, result: "private", details: { card: "connection", value: "private" } });
  expect(event).toMatchObject({ result: "[redacted: run credential file unreadable]", details: undefined });
  expect(JSON.stringify(event)).not.toContain("private");
});

it("caps large card strings after redacting secrets that straddle the boundary", () => {
  const secret = "SENTINEL-private-value";
  const event = redactEvent({ type: "tool_end", toolCallId: "t", isError: false, result: "Saved", details: { card: "profile-diff", after: "x".repeat(4090) + secret + "x".repeat(4096) } }, () => [secret]);
  expect(event.type).toBe("tool_end");
  if (event.type !== "tool_end") throw new Error("wrong event");
  expect(String(event.details?.after)).toContain("[truncated");
  expect(String(event.details?.after).length).toBeLessThan(4200);
  expect(String(event.details?.after)).not.toContain("SENTINEL");
});
