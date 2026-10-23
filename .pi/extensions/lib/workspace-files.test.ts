import { describe, expect, it } from "vitest";
import { WorkspaceFileError } from "./durable-store";
import path from "node:path";
import {
  isSafeSlug,
  isValidQueueFileRecord,
  parseCredentialsText,
  parseGatherStateText,
  parseRecordedJobFile,
  parseStateText,
  resolveApplicationQueueSource,
} from "./workspace-files";

describe("workspace-files parsers", () => {
  it("parseCredentialsText keeps unknown keys and null-prototype map", () => {
    const raw = JSON.stringify({
      "ats.example.com": { username: "u", extra: 1 },
    });
    const parsed = parseCredentialsText(raw);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect((parsed["ats.example.com"] as Record<string, unknown>).extra).toBe(1);
  });

  it("parseCredentialsText rejects empty, array root, and bad entry", () => {
    for (const text of ["", "   "]) {
      expect(() => parseCredentialsText(text)).toThrow(WorkspaceFileError);
    }
    expect(() => parseCredentialsText("[]")).toThrow();
    expect(() => parseCredentialsText("null")).toThrow();
    expect(() => parseCredentialsText('{"x": null}')).toThrow();
  });

  it("parseStateText tolerates null applications and addresses", () => {
    const v = parseStateText('{"applications": null, "addresses": null, "extra": 1}');
    expect(v.applications).toEqual([]);
    expect(v.addresses).toEqual({});
    expect(v.extra).toBe(1);
  });

  it("parseStateText rejects empty and wrong nested types", () => {
    expect(() => parseStateText("")).toThrow(WorkspaceFileError);
    expect(() => parseStateText('{"applications": {}}')).toThrow(WorkspaceFileError);
    expect(() => parseStateText('{"addresses": []}')).toThrow(WorkspaceFileError);
  });

  it("parseGatherStateText rejects empty and wrong seen_urls", () => {
    expect(() => parseGatherStateText("")).toThrow(WorkspaceFileError);
    expect(() => parseGatherStateText('{"seen_urls": []}')).toThrow(WorkspaceFileError);
    const ok = parseGatherStateText('{"seen_urls": {"u": {}}, "keep": true}');
    expect(ok.keep).toBe(true);
  });

  it("isSafeSlug rejects traversal", () => {
    expect(isSafeSlug("good-slug")).toBe(true);
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("a/b")).toBe(false);
  });

  it("parseRecordedJobFile accepts queue prefix names", () => {
    expect(parseRecordedJobFile("jobs/queue/0-acme.md")).toEqual({ dir: "queue", slug: "0-acme" });
    expect(parseRecordedJobFile("../applied/x.md")).toBeNull();
  });

  it("resolveApplicationQueueSource rejects traversal and arbitrary paths", () => {
    const root = "/ws";
    for (const bad of ["credentials.json", "/etc/passwd", "jobs/queue/../applied/x.md", "jobs/other/x.md"]) {
      const r = resolveApplicationQueueSource(root, "slug", bad);
      expect(r.kind).toBe("fallback_queue");
      if (r.kind === "fallback_queue") {
        expect(r.absolute).toBe(path.join(root, "jobs", "queue", "slug.md"));
        expect(r.ignoredRecord).toBe(bad);
      }
    }
  });

  it("isValidQueueFileRecord allows only jobs queue and applied paths", () => {
    expect(isValidQueueFileRecord("jobs/queue/0-a.md")).toBe(true);
    expect(isValidQueueFileRecord("jobs/applied/a.md")).toBe(true);
    expect(isValidQueueFileRecord("credentials.json")).toBe(false);
    expect(isValidQueueFileRecord("jobs/discovered/a.md")).toBe(false);
  });
});
