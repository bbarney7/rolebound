import { expect, test } from "@playwright/test";
import {
  generateFillScript,
  generateOtpScript,
  generateSubmitScript,
  type OtpResult,
  type SubmitResult,
} from "../../.pi/extensions/lib/adapters/greenhouse/scripts.ts";
import {
  boardUrl,
  close,
  createAtsFixtureServer,
  listen,
} from "./fixtures/ats/server.mjs";

const JOB = "1234567";

test.describe.configure({ mode: "serial" });

test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440-light", "submission-boundary runs once on desktop");
});

async function runGenerated<T>(page: import("@playwright/test").Page, src: string): Promise<T> {
  const fn = new Function(`return ${src}`)() as (p: typeof page) => Promise<T>;
  return fn(page);
}

async function submitCount(base: string, scenario: string): Promise<number> {
  const res = await fetch(`${base}/counts?scenario=${encodeURIComponent(scenario)}`);
  const body = (await res.json()) as { count: number };
  return body.count;
}

test.describe("Greenhouse submit/OTP scripts on ATS fixtures", () => {
  let fixture: ReturnType<typeof createAtsFixtureServer>;
  let base: string;

  test.beforeAll(async () => {
    fixture = createAtsFixtureServer();
    await listen(fixture.server);
    const port = (fixture.server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    await close(fixture.server);
  });

  test.beforeEach(async () => {
    await fetch(`${base}/reset`, { method: "POST" });
  });

  test("success maps to submitted with exactly one POST /submit", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "success"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("submitted");
    expect(await submitCount(base, "success")).toBe(1);
  });

  test("validation errors after click with zero extra submits beyond the first", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "validation"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("validation_errors");
    expect(await submitCount(base, "validation")).toBe(1);
  });

  test("otp_required then OTP script completes with two submits total", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "otp"));
    const first = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(first.state).toBe("otp_required");
    expect(await submitCount(base, "otp")).toBe(1);
    const second = await runGenerated<OtpResult>(page, generateOtpScript("ABCD1234", JOB));
    expect(second.state).toBe("submitted");
    expect(await submitCount(base, "otp")).toBe(2);
  });

  test("CAPTCHA on load yields captcha with zero submits", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "captcha"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("captcha");
    expect(await submitCount(base, "captcha")).toBe(0);
  });

  test("unknown after click with one submit", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "unknown"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("unknown");
    expect(await submitCount(base, "unknown")).toBe(1);
  });

  test("already confirmed returns submitted without clicking", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "already-confirmed"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("submitted");
    expect(result.detail).toContain("already confirmed");
    expect(await submitCount(base, "already-confirmed")).toBe(0);
  });

  test("wrong page returns error without submit", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, "/boards/fixture/jobs/9999999", "wrong-page"));
    const result = await runGenerated<SubmitResult>(page, generateSubmitScript(JOB));
    expect(result.state).toBe("error");
    expect(String(result.detail)).toMatch(/wrong page/i);
    expect(await submitCount(base, "wrong-page")).toBe(0);
  });

  test("fill script never POSTs /submit", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, `/boards/fixture/jobs/${JOB}`, "success"));
    const fill = generateFillScript([], "", JOB);
    await runGenerated(page, fill);
    expect(await submitCount(base, "success")).toBe(0);
  });
});

test.describe("generic submit controls", () => {
  let fixture: ReturnType<typeof createAtsFixtureServer>;
  let base: string;

  test.beforeAll(async () => {
    fixture = createAtsFixtureServer();
    await listen(fixture.server);
    const port = (fixture.server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    await close(fixture.server);
  });

  test.beforeEach(async () => {
    await fetch(`${base}/reset`, { method: "POST" });
  });

  test("button submit increments generic-button count once", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, "/generic/button", ""));
    await page.getByRole("button", { name: "Apply now" }).click();
    await expect(page.getByText("Generic submitted")).toBeVisible();
    expect(await submitCount(base, "generic-button")).toBe(1);
  });

  test("Enter key submit increments generic-enter count once", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, "/generic/enter", ""));
    await page.locator('input[name="field"]').press("Enter");
    await expect(page.getByText("Generic submitted")).toBeVisible();
    expect(await submitCount(base, "generic-enter")).toBe(1);
  });

  test("form.requestSubmit increments generic-js-submit count once", async ({ page }) => {
    await page.goto(boardUrl(fixture.server, "/generic/js-submit", ""));
    await page.getByRole("button", { name: "Apply now" }).click();
    await page.waitForTimeout(200);
    expect(await submitCount(base, "generic-js-submit")).toBe(1);
  });
});
