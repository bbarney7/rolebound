import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_SUBMIT_DISCLOSURE_TEXT } from "../shared/autoSubmitPolicy";
import {
  assertCurrentWorkspaceSectionNav,
  assertNoHorizontalOverflow,
  assertProfileSubsectionCurrent,
  assertWorkspaceNavigationVisible,
  chatComposer,
  openSetupAiConnections,
  closeWorkspaceDrawer,
  csrfHeaders,
  discoveryOption,
  expectPageTitle,
  openView,
  resetWorkspace,
  selectDiscovery,
  startQueueApply,
  submitUiRequestInput,
  waitForDiscovery,
  workspaceDialog,
} from "./test-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePdf = path.join(here, "fixtures", "sample.pdf");
const uploadPdf = path.join(here, "fixtures", "upload-resume.pdf");
const seedPdfBytes = fs.readFileSync(samplePdf);
const uploadPdfBytes = fs.readFileSync(uploadPdf);

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request);
});

test.describe("fresh user acknowledgement", () => {
  test("blocks apply until Setup records supervised acknowledgement", async ({ page, request }) => {
    test.setTimeout(60_000);
    const headers = await csrfHeaders(request);
    await request.post("/api/e2e/clear-acknowledgement", { headers });
    await page.goto("/discover");
    await selectDiscovery(page, /Platform Engineer/i);
    await page.getByRole("button", { name: "Promote to queue" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/queue");
      if (!res.ok()) return false;
      const body = await res.json() as Array<{ slug: string }>;
      return body.some((item) => item.slug === "e2e-engineer");
    }).toBeTruthy();

    await openView(page, "queue");
    await expect(page.getByRole("button", { name: "Apply now" })).toBeDisabled();

    await page.goto("/today");
    await expect(page.getByRole("region", { name: "Next action" })).toContainText(/setup/i);
    await expect(page.getByRole("button", { name: "Open setup" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Apply next/i })).toHaveCount(0);
    await expect.poll(async () => {
      const res = await page.request.get("/api/readiness");
      if (!res.ok()) return true;
      const body = await res.json() as { applyReady?: boolean };
      return body.applyReady === false;
    }).toBe(true);

    await openView(page, "setup");
    await expect(page.getByRole("region", { name: "Supervised automation acknowledgement" })).toBeVisible();
    await expect(page.getByText(AUTO_SUBMIT_DISCLOSURE_TEXT)).toBeVisible();
    await page.getByRole("button", { name: /I understand — enable automatic submission/i }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/readiness");
      if (!res.ok()) return false;
      const body = await res.json() as { applyReady?: boolean };
      return body.applyReady === true;
    }).toBe(true);

    await openView(page, "overview");
    await expect(page.getByRole("button", { name: "Apply next in queue" })).toBeEnabled();

    const current = await request.get("/api/runs/current");
    expect(current.ok()).toBeTruthy();
    const runBody = await current.json() as { run?: { status: string } | null };
    const active = runBody.run && ["starting", "running", "waiting"].includes(runBody.run.status);
    expect(active).toBeFalsy();
  });
});

test.describe("primary routes", () => {
  test("chat home, workspace sections, and form surfaces render", async ({ page }) => {
    await page.goto("/");
    // The hero shows only while the transcript is empty; earlier specs leave a conversation on the shared server.
    await expect(page.getByRole("textbox", { name: /Message Rolebound/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Workspace" })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await openView(page, "discover");
    await expectPageTitle(page, "Opportunities");
    await assertCurrentWorkspaceSectionNav(page);
    await waitForDiscovery(page, /Platform Engineer/i);

    await openView(page, "queue");
    await expectPageTitle(page, "Shortlist");

    await openView(page, "applications");
    await expectPageTitle(page, "Applications");

    await openView(page, "profile");
    await expectPageTitle(page, "Profile");

    await openView(page, "setup");
    await expectPageTitle(page, "Setup");

    await openView(page, "settings");
    await expectPageTitle(page, "Settings");
  });
});

test.describe("discover workflow", () => {
  test("filter, detail, targets edit, dismiss, and promote", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/discover");
    await waitForDiscovery(page, /Platform Engineer/i);
    await page.getByLabel("Filter opportunities").fill("Platform");
    await expect.poll(async () => {
      const res = await page.request.get("/api/discoveries?q=Platform&dismissed=false");
      if (!res.ok()) return 0;
      const body = await res.json() as { total: number };
      return body.total;
    }).toBeGreaterThan(0);
    await expect(discoveryOption(page, /Platform Engineer/i)).toBeVisible();

    await selectDiscovery(page, /Platform Engineer/i);
    await expect(page.getByRole("heading", { name: /Platform Engineer/i })).toBeVisible();
    await expect(page.getByText(/Strong fictional fit/i)).toBeVisible();
    await expect(page.getByText(/Discovered/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore" })).toHaveCount(0);

    await page.getByRole("button", { name: "Edit targets" }).click();
    await expect(page.getByRole("heading", { name: "Companies to watch" })).toBeVisible();
    const targetsField = page.getByLabel("Targets");
    await expect.poll(async () => {
      const loaded = await page.getByRole("status").filter({ hasText: "Up to date" }).isVisible();
      const value = await targetsField.inputValue();
      return loaded && value.length > 0;
    }, { timeout: 15_000 }).toBeTruthy();
    await targetsField.fill(`${await targetsField.inputValue()}\nashby:e2e-journey-watch`);
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await page.getByRole("button", { name: "Save companies" }).click();
    await expect(page.locator('[role="alert"].rb-inline-error')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Companies to watch" })).toBeHidden({ timeout: 15_000 });

    await expect.poll(async () => {
      const res = await page.request.get("/api/targets");
      if (!res.ok()) return [];
      const body = await res.json() as { entries: Array<{ source: string; slug: string }> };
      return body.entries;
    }).toEqual(expect.arrayContaining([
      { source: "greenhouse", slug: "e2e-co" },
      { source: "ashby", slug: "e2e-journey-watch" },
    ]));

    await page.getByLabel("Filter opportunities").fill("");
    await expect(discoveryOption(page, /Business Analyst/i)).toBeVisible();

    await selectDiscovery(page, /Business Analyst/i);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/discoveries?dismissed=true");
      if (!res.ok()) return false;
      const body = await res.json() as { items: Array<{ slug: string }> };
      return body.items.some((item) => item.slug === "e2e-analyst");
    }).toBeTruthy();

    await selectDiscovery(page, /Platform Engineer/i);
    await page.getByRole("button", { name: "Promote to queue" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/queue");
      if (!res.ok()) return false;
      const body = await res.json() as Array<{ slug: string }>;
      return body.some((item) => item.slug === "e2e-engineer");
    }).toBeTruthy();
  });
});

test.describe("demo apply journey", () => {
  test("promote, supervised apply, verification code, receipt, and hiring stage persist", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/discover");
    await selectDiscovery(page, /Platform Engineer/i);
    await page.getByRole("button", { name: "Promote to queue" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/queue");
      if (!res.ok()) return false;
      const body = await res.json() as Array<{ slug: string }>;
      return body.some((item) => item.slug === "e2e-engineer");
    }).toBeTruthy();

    await startQueueApply(page);
    await submitUiRequestInput(page, "Demo verification code", "12345678");
    await expect(page.getByText(/Demo receipt written/i)).toBeVisible({ timeout: 20_000 });

    await expect.poll(async () => {
      const res = await page.request.get("/api/applications/e2e-engineer");
      if (!res.ok()) return "";
      const body = await res.json() as {
        application?: {
          applyState?: string;
          screenshot?: string | null;
          demo?: boolean;
          attempts?: Array<{ outcome?: string }>;
        };
      };
      const app = body.application;
      if (!app || app.applyState !== "submitted" || app.attempts?.[0]?.outcome !== "submitted") return "";
      if (!app.screenshot?.includes("demo-synthetic-e2e-engineer-confirmation.svg")) return "";
      return "ready";
    }).toBe("ready");

    const shot = await page.request.get("/api/applications/e2e-engineer/screenshot");
    expect(shot.ok()).toBeTruthy();
    expect(await shot.text()).toContain("Demo application receipt");

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
  });
});

test.describe("profile resume journey", () => {
  test("upload distinct PDF bytes, make default, runtime resolver uses copied file", async ({ page }) => {
    await page.goto("/profile?tab=resumes");
    await assertProfileSubsectionCurrent(page, "Resumes");

    const before = await page.request.get("/api/resumes");
    expect(before.ok()).toBeTruthy();
    const beforeBody = await before.json() as { files: Array<{ name: string; bytes: number }> };
    const defaultBefore = beforeBody.files.find((file) => file.name === "default.pdf");
    expect(defaultBefore?.bytes).toBe(seedPdfBytes.length);

    page.once("dialog", (dialog) => dialog.accept());
    await workspaceDialog(page).locator('input[type="file"]').setInputFiles(uploadPdf);
    await expect.poll(async () => {
      const res = await page.request.get("/api/resumes");
      if (!res.ok()) return 0;
      const body = await res.json() as { files: Array<{ name: string; bytes: number }> };
      const uploaded = body.files.find((file) => file.name === "upload-resume.pdf");
      return uploaded?.bytes === uploadPdfBytes.length ? uploaded.bytes : 0;
    }).toBe(uploadPdfBytes.length);

    const uploadRow = page.locator("tr", { has: page.locator("td.mono", { hasText: "upload-resume.pdf" }) });
    await uploadRow.getByRole("button", { name: "Make default" }).click();

    await expect.poll(async () => {
      const res = await page.request.get("/api/resumes");
      if (!res.ok()) return 0;
      const body = await res.json() as { files: Array<{ name: string; bytes: number; reachability: string }> };
      const defaultFile = body.files.find((file) => file.name === "default.pdf");
      return defaultFile?.reachability === "default" && defaultFile.bytes === uploadPdfBytes.length
        ? defaultFile.bytes
        : 0;
    }).toBe(uploadPdfBytes.length);
    expect(uploadPdfBytes.length).not.toBe(seedPdfBytes.length);
  });
});

test.describe("address revision", () => {
  test("saves address with revision and reloads", async ({ page }) => {
    await page.goto("/profile?tab=addresses");
    await assertProfileSubsectionCurrent(page, "Addresses");

    await page.getByRole("button", { name: "Edit saved address" }).first().click();
    await page.locator("#address-street").fill("200 Revision Ave");
    await page.getByRole("button", { name: "Save address" }).click();

    await expect.poll(async () => {
      const res = await page.request.get("/api/addresses");
      if (!res.ok()) return "";
      const body = await res.json() as { rows: Array<{ key: string; address: { street: string } | null }> };
      return body.rows.find((row) => row.key === "denver")?.address?.street ?? "";
    }).toBe("200 Revision Ave");
  });
});

test.describe("setup and settings", () => {
  test("shows keyless fake provider without echoing keys", async ({ page }) => {
    await page.goto("/setup");
    await openSetupAiConnections(page);
    const fakeProvider = page.locator(".rb-account-row", {
      has: page.getByRole("heading", { name: "E2E Fake Provider" }),
    });
    await expect(fakeProvider).toBeVisible();
    await fakeProvider.locator("details.rb-account-details summary").click();
    await expect(fakeProvider.locator("#paste-key")).toHaveCount(0);
    await expect(fakeProvider.getByText(/none/i)).toBeVisible();
    await page.getByRole("button", { name: /4\. Ready to apply/ }).click();
    await expect(page.getByText(/Your workspace is ready to apply/i)).toBeVisible();

    await openView(page, "settings");
    await expectPageTitle(page, "Settings");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Applying model" })).toHaveValue("e2e-model");
    await page.getByText(/Manage accounts/).click();
    await page.locator("details.rb-paste-key summary").click();
    await expect(page.locator("#paste-key")).toHaveValue("");
    await expect(page.locator("#captcha-key")).toHaveValue("");
    await expect(page.getByLabel("Reasoning effort")).toHaveValue("");
  });
});

test.describe("accessibility", () => {
  test("discover page has no serious axe violations", async ({ page }) => {
    await page.goto("/discover");
    await waitForDiscovery(page, /Platform Engineer/i);
    const results = await new AxeBuilder({ page }).include(".rb-ws-content").analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });

  test("primary regions expose labels and headings", async ({ page }) => {
    await page.goto("/discover");
    await assertWorkspaceNavigationVisible(page);
    await expect(page.getByLabel("Filter opportunities")).toBeVisible();
    await expectPageTitle(page, "Opportunities");
    await assertCurrentWorkspaceSectionNav(page);
  });
});

test.describe("keyboard and responsive evidence", () => {
  test("primary navigation is keyboard reachable", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    let sawWorkspace = false;
    for (let i = 0; i < 24; i += 1) {
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? "");
      if (/Workspace/.test(focused)) {
        sawWorkspace = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(sawWorkspace).toBeTruthy();
  });

  test("discover route has no horizontal overflow", async ({ page }) => {
    await page.goto("/discover");
    await expectPageTitle(page, "Opportunities");
    await assertNoHorizontalOverflow(page);
  });
});

test.describe("applications and run draft", () => {
  test("application filters restore from URL", async ({ page }) => {
    await page.goto("/applications?status=interviewing&apply=submitted");
    await expect(page.getByLabel("Hiring stage")).toHaveValue("interviewing");
    await expect(page.getByLabel("Execution state")).toHaveValue("submitted");
  });

  test("composer draft survives workspace navigation", async ({ page, request }) => {
    test.setTimeout(45_000);
    const headers = await csrfHeaders(request);
    const start = await request.post("/api/runs", { headers, data: { kind: "status" } });
    expect(start.ok()).toBeTruthy();
    await page.goto("/");
    const composer = chatComposer(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("manual otp code 123456");
    await openView(page, "discover");
    await closeWorkspaceDrawer(page);
    await expect(composer).toHaveValue("manual otp code 123456");
  });
});
