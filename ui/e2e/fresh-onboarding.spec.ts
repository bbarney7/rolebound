import fs from "node:fs/promises";
import path from "node:path";
import { analyzeProfilePlaceholders, PROFILE_PLACEHOLDER_CATALOG } from "../shared/profilePlaceholders";
import {
  acknowledgeAutoSubmit,
  addLoopbackConnection,
  FRESH_CANDIDATE_SUMMARY,
  fillBlockingProfileSections,
  replaceTargetsWithFixtureSlugs,
  saveFictionalAddress,
  uploadDefaultResume,
} from "./fresh-profile-helpers";
import { expect, test } from "./fresh-fixture";
import { interactions } from "./interactions";
import { openView, selectDiscovery, stopActiveRun } from "./test-helpers";

async function openSetupFromFirstLaunch(page: import("@playwright/test").Page) {
  await page.goto("/");
  await openView(page, "setup");
}

async function captureSetupScreenshot(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
) {
  const screenshotPath = testInfo.outputPath(name);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function expectConnectionStepComplete(page: import("@playwright/test").Page) {
  await expect.poll(async () => {
    const res = await page.request.get("/api/readiness");
    if (!res.ok()) return false;
    const body = (await res.json()) as { steps: Array<{ id: string; complete: boolean }> };
    return body.steps.find((step) => step.id === "connection")?.complete === true;
  }, { timeout: 30_000 }).toBe(true);
}

const samplePlaceholder = PROFILE_PLACEHOLDER_CATALOG[0]?.token ?? "<FILL IN>";

test.describe("fresh provider autodetect onboarding", () => {
  test("interaction counter records two trusted clicks exactly", async ({ page }) => {
    const counter = interactions(page);
    await counter.install();
    await page.goto("/setup");
    const pasteKey = page.getByRole("dialog", { name: "Workspace" }).getByText("Paste a key instead");
    await pasteKey.click();
    await pasteKey.click();
    expect(await counter.count()).toBe(2);
  });

  test.describe("detected Cursor SDK login", () => {
    test.use({ freshOpts: { seedLogins: { cursorSdk: true } } });

    test("Setup → Use this → connection ready, composer-2.5, SCORING_MODEL_MISSING, interactions ≤ 2", async ({ page }, testInfo) => {
      const counter = interactions(page);
      await counter.install();
      await page.setViewportSize({ width: 1440, height: 900 });
      await openSetupFromFirstLaunch(page);
      await expect(page.getByRole("heading", { name: "Detected accounts" })).toBeVisible();
      await captureSetupScreenshot(page, testInfo, "setup-desktop.png");
      await page.setViewportSize({ width: 360, height: 780 });
      const detectedCard = page.getByRole("dialog",{name:"Workspace"}).locator(".rb-detected-card", { hasText: /Cursor/i });
      const cardBox = await detectedCard.boundingBox();
      expect(cardBox?.height ?? 999).toBeLessThan(140);
      await captureSetupScreenshot(page, testInfo, "setup-phone.png");
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(360);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("dialog",{name:"Workspace"})
        .locator(".rb-detected-card", { hasText: /Cursor/i })
        .getByRole("button", { name: "Use this" })
        .click();
      await expectConnectionStepComplete(page);
      await captureSetupScreenshot(page, testInfo, "setup-desktop-adopted.png");
      await expect.poll(async () => {
        const res = await page.request.get("/api/connections");
        if (!res.ok()) return "";
        const body = (await res.json()) as { data: { agent: { modelId: string } | null } };
        return body.data.agent?.modelId ?? "";
      }).toBe("composer-2.5");
      await expect.poll(async () => {
        const res = await page.request.get("/api/readiness");
        if (!res.ok()) return false;
        const body = (await res.json()) as { scoreBlockers: Array<{ code: string }> };
        return body.scoreBlockers.some((b) => b.code === "SCORING_MODEL_MISSING");
      }).toBe(true);
      const count = await counter.count();
      console.log(`fresh onboarding cursor-sdk interactions: ${count}`);
      expect(count).toBe(2);
    });
  });

  test.describe("detected pi anthropic key", () => {
    test.use({ freshOpts: { seedLogins: { piAuth: true } } });

    test("Setup → Use this → connection step complete, interactions ≤ 2", async ({ page }) => {
      const counter = interactions(page);
      await counter.install();
      await openSetupFromFirstLaunch(page);
      await page.getByRole("dialog",{name:"Workspace"})
        .locator(".rb-detected-card", { hasText: /Claude Pro\/Max/i })
        .getByRole("button", { name: "Use this" })
        .click();
      await expectConnectionStepComplete(page);
      await expect.poll(async () => {
        const res = await page.request.get("/api/connections");
        if (!res.ok()) return false;
        const body = (await res.json()) as { data: { connections: Array<{ provider: string }> } };
        return body.data.connections.some((c) => c.provider === "anthropic");
      }).toBe(true);
      const count = await counter.count();
      console.log(`fresh onboarding pi-anthropic interactions: ${count}`);
      expect(count).toBe(2);
    });
  });

  test.describe("detected Claude Code login", () => {
    test.use({ freshOpts: { seedLogins: { claudeCode: true } } });

    test("Use this → login session pending with authUrl (popup route aborted)", async ({ page, context }) => {
      const counter = interactions(page);
      await counter.install();
      let sessionAuthUrl = "";
      let popupNavigationUrl = "";
      await context.route(/claude\.ai\/oauth\/authorize/, async (route) => {
        popupNavigationUrl = route.request().url();
        await route.abort();
      });
      const popupPromise = page.waitForEvent("popup");
      await openSetupFromFirstLaunch(page);
      await page.getByRole("dialog",{name:"Workspace"})
        .locator(".rb-detected-card", { hasText: "Claude Pro/Max" })
        .getByRole("button", { name: "Use this" })
        .click();
      await popupPromise;
      await expect.poll(async () => {
        const listRes = await page.request.get("/api/connections");
        if (!listRes.ok()) return "";
        const list = (await listRes.json()) as { data: { connections: Array<{ id: string; provider: string }> } };
        const conn = list.data.connections.find((c) => c.provider === "anthropic");
        if (!conn) return "";
        const loginRes = await page.request.get(`/api/connections/${encodeURIComponent(conn.id)}/login`);
        if (!loginRes.ok()) return "";
        const session = (await loginRes.json()) as { status: string; authUrl?: string };
        if (session.status === "pending" && session.authUrl) {
          sessionAuthUrl = session.authUrl;
          return session.authUrl;
        }
        return "";
      }, { timeout: 30_000 }).not.toBe("");
      await expect.poll(() => popupNavigationUrl, { timeout: 30_000 }).toBe(sessionAuthUrl);
      const count = await counter.count();
      console.log(`fresh onboarding claude-code interactions: ${count}`);
      expect(count).toBe(2);
    });
  });

  test.describe("detected GitHub CLI login", () => {
    test.use({ freshOpts: { seedLogins: { ghHosts: true } } });

    test("seeded hosts.yml produces a GitHub Copilot sign-in detection", async ({ page }) => {
      const response = await page.request.get("/api/providers/detected");
      expect(response.ok()).toBe(true);
      const detected = await response.json() as Array<{
        kind: string;
        provider: string;
        account?: string;
        action: string;
      }>;
      expect(detected).toContainEqual(
        expect.objectContaining({
          kind: "github-cli",
          provider: "github-copilot",
          account: "fixture-user",
          action: "sign-in",
        }),
      );
    });
  });
});

test.describe("fresh workspace onboarding", () => {
  test.use({
    freshOpts: {
      scriptedSteps: [
        { tool: { name: "gather_all", arguments: {} } },
        { text: "Gather complete." },
        { text: '{"score":4,"reason":"Strong fictional fit for fresh e2e."}' },
      ],
    },
  });

  test("full UI onboarding through gather, score, promote, and setup complete", async ({ page, fresh }) => {
    test.setTimeout(180_000);

    const loopbackCounter = interactions(page);
    await loopbackCounter.install();

    await page.goto("/setup");
    const setup = page.getByRole("dialog",{name:"Workspace"});
    await expect(setup.getByText("Choose an agent connection and model.",{exact:false})).toBeVisible();
    await expect(setup.getByRole("region",{name:"Connect AI",exact:true})).toBeVisible();
    await expect(setup.getByRole("navigation",{name:"Setup progress"}).getByRole("button")).toHaveCount(4);
    await expect(setup.getByRole("region", { name: "Supervised automation acknowledgement" })).not.toBeVisible();

    await addLoopbackConnection(page, fresh.modelOrigin);
    console.log(`fresh onboarding loopback interactions: ${await loopbackCounter.count()}`);
    await fillBlockingProfileSections(page);
    await uploadDefaultResume(page);
    await saveFictionalAddress(page);
    await replaceTargetsWithFixtureSlugs(page);
    await acknowledgeAutoSubmit(page);

    const targetsMdBeforeGather = await fs.readFile(path.join(fresh.app, "targets.md"), "utf8");
    expect(targetsMdBeforeGather).toContain("fictional-greenhouse");

    await page.goto("/discover");
    await page.getByRole("button", { name: "Gather now" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return "";
      const body = (await res.json()) as { run?: { status: string; kind?: string } | null };
      return body.run?.kind === "gather" ? body.run.status : "";
    }, { timeout: 30_000 }).not.toBe("");
    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return true;
      const body = (await res.json()) as { run?: { status: string; kind?: string } | null };
      if (!body.run || body.run.kind !== "gather") return true;
      return ["done", "waiting", "stopped", "failed"].includes(body.run.status);
    }, { timeout: 120_000 }).toBe(true);
    const gatherRequests = await fresh.readScriptedRequests();
    expect(gatherRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(gatherRequests)).toMatch(/gather_all/);
    const gatherState = JSON.parse(await fs.readFile(path.join(fresh.app, "gather_state.json"), "utf8")) as {
      per_company?: Record<string, { matched_count?: number; error?: string }>;
    };
    expect(Object.keys(gatherState.per_company ?? {}).length).toBeGreaterThan(0);
    await stopActiveRun(page.request);
    await expect.poll(async () => {
      const res = await page.request.get("/api/discoveries?dismissed=false&limit=100");
      if (!res.ok()) return 0;
      const body = (await res.json()) as { items: Array<{ title: string | null }> };
      return body.items.filter((item) => /Staff Platform Engineer/i.test(item.title ?? "")).length;
    }, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.reload();
    await stopActiveRun(page.request);
    await expect.poll(async () => {
      const res = await page.request.get("/api/readiness");
      if (!res.ok()) return false;
      const body = (await res.json()) as { scoreReady?: boolean };
      return body.scoreReady === true;
    }, { timeout: 30_000 }).toBe(true);

    await page.getByRole("button", { name: "Score unscored" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/runs/current");
      if (!res.ok()) return "";
      const body = (await res.json()) as { run?: { status: string; kind?: string } | null };
      if (!body.run || body.run.kind !== "score") return "";
      return ["done", "waiting", "stopped", "failed"].includes(body.run.status) ? body.run.status : "";
    }, { timeout: 120_000 }).not.toBe("");

    await expect.poll(async () => {
      const reqs = await fresh.readScriptedRequests();
      const bodies = reqs.map((r: { body?: string }) => r.body ?? "").join("\n");
      return bodies.includes(FRESH_CANDIDATE_SUMMARY) ? bodies : "";
    }, { timeout: 90_000 }).not.toBe("");
    const allBodies = JSON.stringify(await fresh.readScriptedRequests());
    expect(allBodies).not.toContain(samplePlaceholder);
    await stopActiveRun(page.request);
    await expect.poll(async () => {
      const res = await page.request.get("/api/discoveries?dismissed=false&limit=20");
      if (!res.ok()) return false;
      const body = (await res.json()) as { items: Array<{ llmScore: number | null }> };
      return body.items.some((item) => item.llmScore != null);
    }, { timeout: 30_000 }).toBe(true);

    await stopActiveRun(page.request);
    await selectDiscovery(page, /Staff Platform Engineer/i);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/discoveries?dismissed=true");
      if (!res.ok()) return false;
      const body = (await res.json()) as { items: Array<{ title: string | null }> };
      return body.items.some((item) => /Staff Platform Engineer/i.test(item.title ?? ""));
    }).toBeTruthy();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Restore" }).click();

    await page.getByRole("button", { name: "Promote to queue" }).click();
    await expect.poll(async () => {
      const res = await page.request.get("/api/queue");
      if (!res.ok()) return false;
      const body = await res.json() as Array<{ slug: string }>;
      return body.length > 0;
    }).toBeTruthy();

    await openView(page, "setup");
    for (const step of ["Connect AI", "Resume & profile", "Find jobs", "Ready to apply"]) {
      await expect(page.getByRole("navigation",{name:"Setup progress"}).getByRole("button", {name:new RegExp(step+" Complete")})).toBeVisible();
    }

    const profileMd = await fs.readFile(path.join(fresh.app, "profile.md"), "utf8");
    expect(profileMd).toContain(FRESH_CANDIDATE_SUMMARY);
    const placeholders = analyzeProfilePlaceholders(profileMd);
    expect(placeholders.applySections).toEqual([]);
    expect(placeholders.scoreSections).toEqual([]);
    const targetsMd = await fs.readFile(path.join(fresh.app, "targets.md"), "utf8");
    expect(targetsMd).toContain("fictional-greenhouse");
  });

  test("score stays blocked while candidate summary still has placeholders", async ({ page, fresh }) => {
    await addLoopbackConnection(page, fresh.modelOrigin);
    await page.goto("/discover");
    const scoreButton = page.getByRole("button", { name: "Score unscored" });
    await expect(scoreButton).toBeDisabled();
    await expect(page.locator(".rb-inline-hint", { hasText: /candidate summary/i })).toBeVisible();
  });

  test("corrupt state.json shows repair banner until restore", async ({ page, fresh }) => {
    const backupId = await fresh.createStateBackup();
    await fresh.corruptStateJson();
    await page.goto("/");
    await expect(page.getByText(/Repair needed:.*state\.json.*corrupt/i)).toBeVisible();
    await fresh.restoreStateBackup(backupId);
    await page.reload();
    await expect(page.getByText(/Repair needed:.*state\.json.*corrupt/i)).toHaveCount(0);
  });
});
