import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ashbyBoardUrl,
  atsFetchInit,
  fetchAtsJson,
  greenhouseBoardJobsUrl,
  greenhouseJobQuestionsUrl,
  leverBoardUrl,
  resolveAtsFixtureOrigin,
} from "./ats-origin";

const ENV = "PI_JOBS_ATS_FIXTURE_ORIGIN";

describe("resolveAtsFixtureOrigin", () => {
  const prior = process.env[ENV];

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV];
    else process.env[ENV] = prior;
  });

  it("treats only undefined as unset", () => {
    delete process.env[ENV];
    expect(resolveAtsFixtureOrigin()).toBeNull();
    process.env[ENV] = "";
    expect(() => resolveAtsFixtureOrigin()).toThrow(/PI_JOBS_ATS_FIXTURE_ORIGIN/);
    process.env[ENV] = "   ";
    expect(() => resolveAtsFixtureOrigin()).toThrow(/PI_JOBS_ATS_FIXTURE_ORIGIN/);
  });

  it("accepts loopback origins with a port", () => {
    process.env[ENV] = "http://127.0.0.1:14901";
    expect(resolveAtsFixtureOrigin()).toBe("http://127.0.0.1:14901");
    process.env[ENV] = "http://localhost:14902/";
    expect(resolveAtsFixtureOrigin()).toBe("http://localhost:14902");
  });

  it("rejects unsafe or non-canonical origins", () => {
    const reject = [
      "https://evil",
      "http://10.0.0.1:1",
      "http://127.0.0.1.evil.com:1",
      "http://user@127.0.0.1:1",
      "http://127.0.0.1:1/extra",
      "http://127.0.0.1:1?x=1",
      "http://127.0.0.1:1#frag",
      "file:///tmp/x",
    ];
    for (const value of reject) {
      process.env[ENV] = value;
      expect(() => resolveAtsFixtureOrigin()).toThrow(/PI_JOBS_ATS_FIXTURE_ORIGIN/);
    }
  });

  it("uses redirect error in fixture mode and fails on external redirects", async () => {
    let redirectTargetHits = 0;
    const target = http.createServer((_req, res) => {
      redirectTargetHits += 1;
      res.writeHead(200);
      res.end("nope");
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(0, "127.0.0.1", () => resolve());
    });
    const targetPort = (target.address() as { port: number }).port;

    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` });
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      redirector.once("error", reject);
      redirector.listen(0, "127.0.0.1", () => resolve());
    });
    const originPort = (redirector.address() as { port: number }).port;
    process.env[ENV] = `http://127.0.0.1:${originPort}`;

    expect(atsFetchInit()).toEqual({ redirect: "error" });
    const url = greenhouseBoardJobsUrl("fictional-greenhouse");
    await expect(fetchAtsJson(url)).rejects.toThrow();
    expect(redirectTargetHits).toBe(0);

    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
});

describe("ATS URL builders", () => {
  const prior = process.env[ENV];

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV];
    else process.env[ENV] = prior;
  });

  it("keeps production hosts when unset", () => {
    delete process.env[ENV];
    expect(greenhouseBoardJobsUrl("acme")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
    expect(greenhouseJobQuestionsUrl("acme", "123")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123?questions=true",
    );
    expect(ashbyBoardUrl("acme")).toBe("https://api.ashbyhq.com/posting-api/job-board/acme");
    expect(leverBoardUrl("acme")).toBe("https://api.lever.co/v0/postings/acme?mode=json");
    expect(atsFetchInit()).toEqual({});
  });

  it("rewrites to the fixture origin when set", () => {
    process.env[ENV] = "http://127.0.0.1:14999";
    expect(greenhouseBoardJobsUrl("fictional-greenhouse")).toBe(
      "http://127.0.0.1:14999/v1/boards/fictional-greenhouse/jobs?content=true",
    );
    expect(ashbyBoardUrl("fictional-ashby")).toBe(
      "http://127.0.0.1:14999/posting-api/job-board/fictional-ashby",
    );
    expect(leverBoardUrl("fictional-lever")).toBe(
      "http://127.0.0.1:14999/v0/postings/fictional-lever?mode=json",
    );
  });
});
