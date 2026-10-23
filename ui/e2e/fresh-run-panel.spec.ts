import { watchStopMarker } from "./fresh-web-server.mjs";
import {
  addLoopbackConnection,
  fillBlockingProfileSections,
  uploadDefaultResume,
} from "./fresh-profile-helpers";
import { expect, test } from "./fresh-fixture";
import { clickUiRequestConfirm, closeWorkspaceDrawer, openView, submitUiRequestInput } from "./test-helpers";

const APPLY_SLUG = "fresh-apply-role";
const clickTool = {
  name: "mcp__job_playwright__browser_click",
  arguments: { element: "Submit application", ref: "e1" },
};

async function prepareApplyReady(
  page: import("@playwright/test").Page,
  fresh: Awaited<ReturnType<typeof import("./fresh-web-server.mjs").startFreshWorkspace>>,
) {
  await addLoopbackConnection(page, fresh.modelOrigin);
  await fillBlockingProfileSections(page);
  await uploadDefaultResume(page);
  await fresh.seedAcknowledgedState();
  await fresh.seedApplyQueue(APPLY_SLUG);
}

test.describe("fresh run panel — OTP", () => {
  test.use({
    freshOpts: {
      withSubmissionFixture: true,
      scriptedSteps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "otp", message: "Enter the emailed code" } } },
        { tool: clickTool },
        { text: "done" },
      ],
    },
  });

  test("OTP entry reaches the model and the run completes", async ({ page, fresh }) => {
    test.setTimeout(180_000);
    await prepareApplyReady(page, fresh);
    await fresh.resetFixtureSubmitCount();

    await openView(page, "queue");
    await page.getByRole("button", { name: /Apply now/i }).click();
    await closeWorkspaceDrawer(page);

    const otp = "87654321";
    await submitUiRequestInput(page, "Enter verification code", otp);

    await expect.poll(async () => {
      const reqs = await fresh.readScriptedRequests();
      const bodies = reqs.map((r: { body?: string }) => r.body ?? "").join("\n");
      return bodies.includes(otp);
    }, { timeout: 60_000 }).toBe(true);

    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return "";
      const body = (await res.json()) as { run?: { status: string } | null };
      return body.run?.status ?? "";
    }, { timeout: 90_000 }).toMatch(/done|waiting/);

    expect(await fresh.readFixtureSubmitCount()).toBeGreaterThanOrEqual(1);
  });
});

test.describe("fresh run panel — CAPTCHA pause", () => {
  test.use({
    freshOpts: {
      withSubmissionFixture: true,
      withCaptchaProbe: true,
      scriptedSteps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "captcha", message: "Complete the widget" } } },
        { holdUntilReleased: true, text: "after captcha" },
        { tool: clickTool },
        { text: "done" },
      ],
    },
  });

  test("manual CAPTCHA with provider off sends no paid requests and resumes after Yes", async ({ page, fresh }) => {
    test.setTimeout(180_000);
    await prepareApplyReady(page, fresh);
    await openView(page, "queue");
    await page.getByRole("button", { name: /Apply now/i }).click();
    await closeWorkspaceDrawer(page);

    await clickUiRequestConfirm(page, "Yes");
    await fresh.waitForScriptedHoldAndRelease();

    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return "";
      const body = (await res.json()) as { run?: { status: string } | null };
      return body.run?.status ?? "";
    }, { timeout: 90_000 }).toMatch(/done|waiting/);

    expect(fresh.captchaProbe?.getRequestCount() ?? 0).toBe(0);
  });
});

test.describe("fresh run panel — stop while pending", () => {
  test.use({
    freshOpts: {
      withSubmissionFixture: true,
      scriptedSteps: [
        { tool: { name: "request_manual_verification", arguments: { kind: "captcha", message: "Waiting" } } },
        { holdUntilReleased: true, text: "never" },
      ],
    },
  });

  test("Abort writes stop marker, ends pi, and removes the run dir", async ({ page, fresh }) => {
    test.setTimeout(180_000);
    await prepareApplyReady(page, fresh);
    const countBefore = await fresh.readFixtureSubmitCount();

    await openView(page, "queue");
    await page.getByRole("button", { name: /Apply now/i }).click();
    await closeWorkspaceDrawer(page);
    await expect(page.locator(".rb-chat-ui-request")).toBeVisible({ timeout: 60_000 });

    let runId = "";
    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return false;
      const body = (await res.json()) as { run?: { runId: string } | null };
      runId = body.run?.runId ?? "";
      return runId.length > 0;
    }, { timeout: 60_000 }).toBe(true);

    let sawStop = false;
    const watcher = await watchStopMarker(fresh.app, runId, () => {
      sawStop = true;
    });

    let pid: number | null = null;
    await expect.poll(async () => {
      pid = await fresh.readRunManagerPid();
      return pid != null;
    }, { timeout: 30_000 }).toBe(true);

    await page.getByRole("button", { name: "Stop" }).click();

    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return true;
      const body = (await res.json()) as { run?: { status: string } | null };
      return !body.run || ["done", "stopped", "failed"].includes(body.run.status);
    }, { timeout: 60_000 }).toBe(true);

    await expect.poll(() => sawStop, { timeout: 30_000 }).toBe(true);
    watcher.close();

    await expect.poll(async () => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    }).toBe(false);

    expect(await fresh.readFixtureSubmitCount()).toBe(countBefore);
    expect(await fresh.runDirExists(runId)).toBe(false);
  });
});
