import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  applyProjectTheme,
  assertCollapsedMobileHeader,
  assertProfileSubsectionCurrent,
  captureSurface,
  clearAcknowledgement,
  ensureScreenshotDir,
  expectPageTitle,
  openSetupAiConnections,
  openView,
  resetWorkspace,
  seedQueueApply,
  startQueueApply,
  waitForDiscovery,
  submitDemoCodeAndExpectReceipt,
} from "./test-helpers";

function isFullVisualGate(projectName: string) {
  return projectName.startsWith("visual-");
}

test.beforeAll(() => {
  ensureScreenshotDir();
});

test.describe("T19 visual gate", () => {
  test("captures key surfaces with layout and a11y checks", async ({ page, request }, testInfo) => {
    const project = testInfo.project.name;
    const full = isFullVisualGate(project);
    test.setTimeout(full ? 180_000 : 90_000);

    if (project.includes("dark")) {
      await page.addInitScript(() => document.documentElement.setAttribute("data-theme", "dark"));
    }
    await resetWorkspace(request);
    await page.goto("/");
    await applyProjectTheme(page, project);

    if (project.includes("mobile-390")) {
      await assertCollapsedMobileHeader(page);
    }

    // The hero shows only while the transcript is empty; earlier specs leave a conversation on the shared server.
    await expect(page.getByRole("textbox", { name: /Message Rolebound/i })).toBeVisible({ timeout: 15_000 });
    await captureSurface(page, project, "chat-home");

    await openView(page, "discover");
    await expectPageTitle(page, "Opportunities");
    await waitForDiscovery(page, /Platform Engineer/i);
    const axe = await new AxeBuilder({ page }).include(".rb-ws-content").analyze();
    const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
    await captureSurface(page, project, "opportunities");

    if (!full) return;

    await openView(page, "setup", { hardNavigate: true });
    await expectPageTitle(page, "Setup");
    await clearAcknowledgement(request);
    await page.reload();
    await expect(page.getByRole("region", { name: "Supervised automation acknowledgement" })).toBeVisible();
    const captureAck = project.includes("mobile-390") || project === "visual-desktop-1440-light";
    if (captureAck) {
      await captureSurface(page, project, "setup-ack-before");
    }
    await page.getByRole("button", { name: /I understand — enable automatic submission/i }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/readiness");
      if (!res.ok()) return false;
      const body = await res.json() as { applyReady?: boolean };
      return body.applyReady === true;
    }).toBe(true);
    if (captureAck) {
      await captureSurface(page, project, "setup-ack-after");
    }
    await openSetupAiConnections(page);
    await expect(page.getByRole("heading", { name: "E2E Fake Provider" })).toBeVisible();
    await captureSurface(page, project, "setup");

    await openView(page, "profile", { hardNavigate: true });
    await expectPageTitle(page, "Profile");
    await page.goto("/profile?tab=resumes");
    await assertProfileSubsectionCurrent(page, "Resumes");
    await captureSurface(page, project, "profile");

    await seedQueueApply(page);
    await startQueueApply(page);
    await captureSurface(page, project, "run-pending");

    await submitDemoCodeAndExpectReceipt(page);

    await page.goto("/applications/e2e-engineer");
    await expect(page.getByText(/Receipt evidence/i)).toBeVisible();
    await expect(page.locator(".evidence-shot")).toBeVisible();
    const stage = page.locator(".section select.control");
    await stage.selectOption("interviewing");
    await expect.poll(async () => {
      const res = await page.request.get("/api/applications/e2e-engineer");
      if (!res.ok()) return "";
      const body = await res.json() as { application?: { pipelineStatus?: string } };
      return body.application?.pipelineStatus ?? "";
    }).toBe("interviewing");
    await page.reload();
    await expect(stage).toHaveValue("interviewing");
    await captureSurface(page, project, "application");
  });
});
