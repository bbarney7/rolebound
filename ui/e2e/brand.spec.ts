import { expect, test } from "@playwright/test";
import { assertRoleboundBrandAssets, resetWorkspace } from "./test-helpers";

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request);
});

test.describe("Rolebound brand and offline fonts", () => {
  test("title, favicon, FontFaceSet load, and computed body font with no remote design requests", async ({ page }) => {
    const remoteDesignRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/i.test(url)) {
        remoteDesignRequests.push(url);
      }
    });

    await page.goto("/");
    await assertRoleboundBrandAssets(page, remoteDesignRequests);
    await expect(page.getByRole("link", { name: "Rolebound" })).toBeVisible();
  });

  test("brand SVG/CSS assets are served locally without CDN references", async ({ page }) => {
    for (const asset of [
      "/brand/rolebound-mark.svg",
      "/brand/rolebound-favicon.svg",
      "/brand/rolebound-icon.svg",
      "/brand/rolebound-wordmark.svg",
      "/fonts/rolebound.css",
    ]) {
      const res = await page.request.get(asset);
      expect(res.ok(), asset).toBeTruthy();
      const text = await res.text();
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/fonts\.googleapis\.com/);
    }

    const wordmark = await (await page.request.get("/brand/rolebound-wordmark.svg")).text();
    expect(wordmark).not.toMatch(/<text[\s>]/i);
  });
});
