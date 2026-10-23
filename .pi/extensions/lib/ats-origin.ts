const ENV = "PI_JOBS_ATS_FIXTURE_ORIGIN";

const GREENHOUSE_API = "https://boards-api.greenhouse.io";
const ASHBY_API = "https://api.ashbyhq.com";
const LEVER_API = "https://api.lever.co";

/**
 * Test-only loopback origin from PI_JOBS_ATS_FIXTURE_ORIGIN. Throws on any non-canonical value.
 */
export function resolveAtsFixtureOrigin(): string | null {
  const raw = process.env[ENV];
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ${ENV}: not a URL`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`Invalid ${ENV}: only http loopback origins are allowed`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid ${ENV}: credentials are not allowed`);
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error(`Invalid ${ENV}: path is not allowed`);
  }
  if (url.search || url.hash) {
    throw new Error(`Invalid ${ENV}: query or fragment is not allowed`);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`Invalid ${ENV}: host must be 127.0.0.1 or localhost`);
  }
  if (!url.port || !/^\d+$/.test(url.port)) {
    throw new Error(`Invalid ${ENV}: port is required`);
  }
  return `http://${url.hostname}:${url.port}`;
}

function fixtureOriginOrThrow(): string {
  const origin = resolveAtsFixtureOrigin();
  if (!origin) throw new Error(`${ENV} is not set`);
  return origin;
}

function rewriteApiUrl(defaultUrl: string, origin: string | null): string {
  if (!origin) return defaultUrl;
  const parsed = new URL(defaultUrl);
  const fixture = new URL(origin);
  return `${fixture.origin}${parsed.pathname}${parsed.search}`;
}

export function greenhouseBoardJobsUrl(slug: string): string {
  return rewriteApiUrl(`${GREENHOUSE_API}/v1/boards/${slug}/jobs?content=true`, resolveAtsFixtureOrigin());
}

export function greenhouseJobQuestionsUrl(board: string, jobId: string): string {
  return rewriteApiUrl(
    `${GREENHOUSE_API}/v1/boards/${board}/jobs/${jobId}?questions=true`,
    resolveAtsFixtureOrigin(),
  );
}

export function ashbyBoardUrl(slug: string): string {
  return rewriteApiUrl(`${ASHBY_API}/posting-api/job-board/${slug}`, resolveAtsFixtureOrigin());
}

export function leverBoardUrl(slug: string): string {
  return rewriteApiUrl(`${LEVER_API}/v0/postings/${slug}?mode=json`, resolveAtsFixtureOrigin());
}

export function atsFetchInit(): RequestInit {
  return resolveAtsFixtureOrigin() ? { redirect: "error" } : {};
}

/** Shared fetch helper for gatherer ATS JSON (fixture mode uses redirect: error). */
export async function fetchAtsJson(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers, ...atsFetchInit() });
}
