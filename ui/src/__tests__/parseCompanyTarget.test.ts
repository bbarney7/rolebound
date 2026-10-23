import { describe, expect, it } from "vitest";
import {
  PARSE_COMPANY_TARGET_ERROR,
  entriesToTargetText,
  parseCompanyTargetInput,
  parseTargetTextToEntries,
} from "../parseCompanyTarget";

describe("parseCompanyTargetInput", () => {
  it("accepts source:slug lines", () => {
    expect(parseCompanyTargetInput("greenhouse:acme")).toEqual({
      ok: true,
      entry: { source: "greenhouse", slug: "acme" },
    });
  });

  it("parses greenhouse board URLs", () => {
    expect(parseCompanyTargetInput("https://boards.greenhouse.io/acme/jobs/123")).toEqual({
      ok: true,
      entry: { source: "greenhouse", slug: "acme" },
    });
    expect(parseCompanyTargetInput("job-boards.greenhouse.io/acme")).toEqual({
      ok: true,
      entry: { source: "greenhouse", slug: "acme" },
    });
  });

  it("parses ashby and lever URLs without a scheme", () => {
    expect(parseCompanyTargetInput("jobs.ashbyhq.com/acme?ref=1")).toEqual({
      ok: true,
      entry: { source: "ashby", slug: "acme" },
    });
    expect(parseCompanyTargetInput("jobs.lever.co/acme")).toEqual({
      ok: true,
      entry: { source: "lever", slug: "acme" },
    });
  });

  it("rejects unknown hosts and empty input", () => {
    expect(parseCompanyTargetInput("")).toEqual({ ok: false, error: PARSE_COMPANY_TARGET_ERROR });
    expect(parseCompanyTargetInput("https://example.com/acme")).toEqual({
      ok: false,
      error: PARSE_COMPANY_TARGET_ERROR,
    });
  });
});

describe("target text helpers", () => {
  it("round-trips entries through text", () => {
    const entries = [
      { source: "lever" as const, slug: "acme" },
      { source: "ashby" as const, slug: "beta" },
    ];
    expect(parseTargetTextToEntries(entriesToTargetText(entries))).toEqual(entries);
  });
});
