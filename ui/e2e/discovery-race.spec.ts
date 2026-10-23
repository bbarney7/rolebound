import { expect, test, type Page, type Response } from "@playwright/test";
import { resetWorkspace } from "./test-helpers";

const ENGINEER = /Platform Engineer/i;
const DESIGNER = /Product Designer/i;
const ENGINEER_DETAIL = /\/api\/discoveries\/e2e-engineer$/;
const DESIGNER_DETAIL = /\/api\/discoveries\/e2e-designer$/;

function discoveryList(page: Page) {
  return page.getByRole("listbox", { name: "Opportunities" });
}

function discoveryOption(page: Page, pattern: RegExp) {
  return discoveryList(page).getByRole("option", { name: pattern });
}

function detailPanel(page: Page) {
  return page.locator(".rb-workbench-detail");
}

function createHeldRequestGate() {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let resolveReceipt!: () => void;
  const receipt = new Promise<void>((resolve) => {
    resolveReceipt = resolve;
  });
  let receiptSent = false;
  return {
    gate,
    receipt,
    release: () => releaseGate(),
    markHeld: () => {
      if (receiptSent) return;
      receiptSent = true;
      resolveReceipt();
    },
  };
}

function isDetailGet(response: Response, slug: string) {
  const url = new URL(response.url());
  return url.pathname === `/api/discoveries/${slug}` && response.request().method() === "GET";
}

async function drainUiFrames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    }),
  );
}

async function waitForDiscoveries(page: Page) {
  await expect.poll(async () => {
    const res = await page.request.get("/api/discoveries?dismissed=false&limit=100");
    if (!res.ok()) return 0;
    const body = await res.json() as { items: unknown[] };
    return body.items.length;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
}

test.describe("discover detail race guards", () => {
  test.beforeEach(async ({ request }) => {
    await resetWorkspace(request);
  });

  test("rejects a held stale detail response and promotes the displayed slug", async ({ page }) => {
    test.setTimeout(60_000);

    const engineerHold = createHeldRequestGate();
    let engineerGets = 0;

    await page.route(ENGINEER_DETAIL, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      engineerGets += 1;
      if (engineerGets === 1) {
        await route.continue();
        return;
      }
      engineerHold.markHeld();
      await engineerHold.gate;
      await route.continue();
    });

    await page.goto("/discover");
    await waitForDiscoveries(page);

    const panel = detailPanel(page);
    const promote = page.getByRole("button", { name: "Promote to queue" });

    await expect(panel.getByRole("heading", { name: ENGINEER })).toBeVisible();
    await discoveryOption(page, DESIGNER).click();
    await expect(panel.getByRole("heading", { name: DESIGNER })).toBeVisible();
    await expect(discoveryOption(page, DESIGNER)).toHaveAttribute("aria-selected", "true");

    await discoveryOption(page, ENGINEER).click();
    await expect(panel.getByText("Loading opportunity…")).toBeVisible();
    await expect(panel.getByRole("heading", { name: ENGINEER })).toHaveCount(0);
    await expect(promote).toHaveCount(0);
    await engineerHold.receipt;

    await discoveryOption(page, DESIGNER).click();
    await expect(panel.getByRole("heading", { name: DESIGNER })).toBeVisible();
    await expect(discoveryOption(page, DESIGNER)).toHaveAttribute("aria-selected", "true");
    await expect(promote).toBeEnabled();
    expect(engineerGets).toBe(2);

    const staleResponseDone = page.waitForResponse((response) => isDetailGet(response, "e2e-engineer"));
    engineerHold.release();
    const staleResponse = await staleResponseDone;
    await staleResponse.finished();
    await drainUiFrames(page);

    await expect(panel.getByRole("heading", { name: DESIGNER })).toBeVisible();
    await expect(panel.getByRole("heading", { name: ENGINEER })).toHaveCount(0);
    await expect(discoveryOption(page, DESIGNER)).toHaveAttribute("aria-selected", "true");

    let promotedSlug: string | null = null;
    await page.route("/api/queue/promote", async (route) => {
      promotedSlug = (route.request().postDataJSON() as { slug: string }).slug;
      await route.continue();
    });

    await promote.click();

    await expect.poll(() => promotedSlug).toBe("e2e-designer");
    await expect.poll(async () => {
      const res = await page.request.get("/api/queue");
      if (!res.ok()) return [];
      return (await res.json() as Array<{ slug: string }>).map((item) => item.slug);
    }).toEqual(expect.arrayContaining(["e2e-designer"]));

    const queueSlugs = await page.request.get("/api/queue").then(async (res) => {
      if (!res.ok()) return [] as string[];
      return (await res.json() as Array<{ slug: string }>).map((item) => item.slug);
    });
    expect(queueSlugs).not.toContain("e2e-engineer");
    await expect(discoveryOption(page, DESIGNER)).toHaveCount(0);
    await expect(discoveryOption(page, ENGINEER)).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("heading", { name: ENGINEER })).toBeVisible();
  });

  test("recovers detail panel after a failed fetch via Retry", async ({ page }) => {
    test.setTimeout(60_000);

    let designerGets = 0;

    await page.route(DESIGNER_DETAIL, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      designerGets += 1;
      if (designerGets === 1) {
        await route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "upstream unavailable",
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/discover");
    await waitForDiscoveries(page);

    const panel = detailPanel(page);
    await discoveryOption(page, DESIGNER).click();

    await expect(panel.getByRole("alert")).toContainText("503");
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(designerGets).toBe(1);

    const retryResponseDone = page.waitForResponse(
      (response) => isDetailGet(response, "e2e-designer") && response.status() === 200,
    );
    await panel.getByRole("button", { name: "Retry" }).click();
    const retryResponse = await retryResponseDone;
    await retryResponse.finished();

    await expect(panel.getByRole("heading", { name: DESIGNER })).toBeVisible();
    await expect(page.getByRole("button", { name: "Promote to queue" })).toBeEnabled();
    expect(designerGets).toBe(2);
  });
});
