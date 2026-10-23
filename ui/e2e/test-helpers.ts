import { expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const screenshotDir = path.join(here, "artifacts", "screenshots");

/** Canonical Workspace destinations; legacy routes remain reachable. */
export const NAV = { overview: "Today", discover: "Job search", queue: "Shortlist", applications: /^Applications/, profile: "Profile", setup: "Setup", settings: "Settings", accounts: "Site logins" } as const;

const SUPERVISED_ACKNOWLEDGEMENT_TOKEN = "ACKNOWLEDGE";

export function ensureScreenshotDir() {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

export function stageNav(page: Page) {
  return page.locator('nav[aria-label="Workspace sections"]');
}

export async function openView(page: Page, view: keyof typeof NAV) {
  if (view === "overview") { await page.goto("/today"); return; }
  if (!await page.getByRole("dialog",{name:"Workspace"}).isVisible()) await page.getByRole("button",{name:"Workspace",exact:true}).click();
  const current = new URL(page.url()).pathname;
  if (current === (view === "accounts" ? "/settings/accounts" : `/${view}`)) return;
  if ((page.viewportSize()?.width ?? 1440) <= 720) {
    await page.locator(".rb-mobile-sections > summary").click();
    const names = { profile:"Identity", discover:"Found jobs", queue:"Shortlist", applications:"Applications", settings:"AI settings", accounts:"Site logins", setup:"Setup checklist" };
    await page.getByRole("navigation",{name:"Choose workspace section"}).getByRole("link",{name:names[view],exact:true}).click();
    return;
  }
  if (view === "queue") {
    await stageNav(page).getByRole("link",{name:"Job search",exact:true}).click();
    await page.getByRole("navigation",{name:"Job search",exact:true}).getByRole("link",{name:"Shortlist"}).click();
  } else if (view === "accounts") {
    await stageNav(page).getByRole("link",{name:"Settings",exact:true}).click();
    await page.getByRole("link",{name:/Manage site logins/}).click();
  } else await stageNav(page).getByRole("link",{name:NAV[view],exact:view!=="applications"}).click();
}

export async function openRun(page: Page) {
  await page.getByRole("button", { name: /Agent session:/i }).click();
}

export function discoveryList(page: Page) {
  return page.getByRole("listbox", { name: "Opportunities" });
}

export function discoveryOption(page: Page, pattern: RegExp | string) {
  return discoveryList(page).getByRole("option", { name: pattern });
}

export async function waitForDiscovery(page: Page, pattern: RegExp) {
  await expect.poll(async () => {
    const res = await page.request.get("/api/discoveries?dismissed=false&limit=100");
    if (!res.ok()) return 0;
    const body = await res.json() as { items: Array<{ title: string | null; slug: string }> };
    return body.items.filter((item) => pattern.test(item.title ?? item.slug)).length;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(discoveryOption(page, pattern)).toBeVisible();
}

export async function selectDiscovery(page: Page, pattern: RegExp) {
  await waitForDiscovery(page, pattern);
  // A list refresh can re-render the option under the click on slow runners; retry until the detail opens.
  await expect(async () => {
    await discoveryOption(page, pattern).click();
    await expect(page.getByRole("heading", { name: pattern })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Promote to queue" })).toBeEnabled();
}

export async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
}

export async function assertPipelineNavLabels(page: Page) {
  const nav = stageNav(page);
  for (const name of ["Profile","Job search","Settings","Setup"]) await expect(nav.getByRole("link",{name,exact:true})).toBeVisible();
  await expect(nav.getByRole("link",{name:/^Applications/})).toBeVisible();
}

/** Page titles live in `.rb-display-title` (editorial routes) or `.topbar h1` (surfaces routes). */
export function expectPageTitle(page: Page, title: string | RegExp) {
  return expect(page.locator(".rb-display-title, .topbar h1").filter({ hasText: title }).first()).toBeVisible();
}

export async function applyProjectTheme(page: Page, projectName: string) {
  if (projectName.includes("dark")) {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  }
}

export async function assertCollapsedMobileHeader(page: Page) {
  const height = await page.evaluate(() => {
    const header = document.querySelector(".rb-chat-header");
    if (!header) return -1;
    if (document.querySelector('dialog[open][aria-label="Workspace"]')) return -1;
    return header.getBoundingClientRect().height;
  });
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThanOrEqual(80);
}

export async function captureSurface(page: Page, projectName: string, surface: string) {
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: path.join(screenshotDir, `${surface}-${projectName}.png`),
    fullPage: true,
  });
}

export async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const session = await request.get("/api/session");
  expect(session.ok()).toBeTruthy();
  const body = await session.json() as { csrfToken: string };
  return { "x-pi-jobs-csrf": body.csrfToken };
}

export async function ensureSupervisedAcknowledgement(request: APIRequestContext) {
  const headers = await csrfHeaders(request);
  const res = await request.post("/api/readiness/acknowledgement", {
    headers,
    data: { acknowledgement: SUPERVISED_ACKNOWLEDGEMENT_TOKEN },
  });
  expect(res.ok()).toBeTruthy();
}

export async function stopActiveRun(request: APIRequestContext) {
  const current = await request.get("/api/runs/current");
  if (!current.ok()) return;
  const body = await current.json() as { run?: { runId: string; status: string } | null };
  if (!body.run) return;
  const headers = await csrfHeaders(request);
  const id = body.run.runId;
  if (body.run.status === "waiting") {
    await request.post(`/api/runs/${id}/finish`, { headers });
    return;
  }
  if (body.run.status === "starting" || body.run.status === "running") {
    await request.post(`/api/runs/${id}/abort`, { headers });
  }
}

export async function resetWorkspace(request: APIRequestContext) {
  await stopActiveRun(request);
  const headers = await csrfHeaders(request);
  const res = await request.post("/api/e2e/reset-workspace", { headers });
  expect(res.ok()).toBeTruthy();
  await ensureSupervisedAcknowledgement(request);
}

export async function clearAcknowledgement(request: APIRequestContext) {
  const headers = await csrfHeaders(request);
  const res = await request.post("/api/e2e/clear-acknowledgement", { headers });
  expect(res.ok()).toBeTruthy();
}

export async function seedQueueApply(page: Page) {
  await page.goto("/discover");
  await selectDiscovery(page, /Platform Engineer/i);
  await page.getByRole("button", { name: "Promote to queue" }).click();
  await expect.poll(async () => {
    const res = await page.request.get("/api/queue");
    if (!res.ok()) return false;
    const body = await res.json() as Array<{ slug: string }>;
    return body.some((item) => item.slug === "e2e-engineer");
  }).toBeTruthy();
}

export async function assertRoleboundBrandAssets(page: Page, remoteDesignRequests: string[]) {
  await expect(page).toHaveTitle(/^Rolebound$/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/brand/rolebound-favicon.svg");

  const display = await page.request.get("/fonts/rolebound-display.woff2");
  const bodyFont = await page.request.get("/fonts/rolebound-body.woff2");
  expect(display.ok()).toBeTruthy();
  expect(bodyFont.ok()).toBeTruthy();
  expect(Number(display.headers()["content-length"] ?? "0")).toBeGreaterThan(10_000);
  expect(Number(bodyFont.headers()["content-length"] ?? "0")).toBeGreaterThan(10_000);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((face) =>
      /Rolebound Display|Rolebound Body/.test(face.family),
    );
    const loaded = faces.filter((face) => face.status === "loaded");
    const bodyFamily = getComputedStyle(document.body).fontFamily;
    const rootFamily = getComputedStyle(document.documentElement).fontFamily;
    return {
      faceCount: faces.length,
      loadedCount: loaded.length,
      bodyFamily,
      rootFamily,
    };
  });

  expect(fonts.faceCount).toBeGreaterThanOrEqual(2);
  expect(fonts.loadedCount).toBeGreaterThanOrEqual(2);
  expect(fonts.bodyFamily.toLowerCase()).toMatch(/rolebound body|funnel/);
  expect(remoteDesignRequests).toEqual([]);
}

export function workspaceSectionNav(page: Page) {
  return page.locator('nav[aria-label="Workspace sections"]');
}

export function workspaceDialog(page: Page) {
  return page.getByRole("dialog", { name: "Workspace" });
}

export async function closeWorkspaceDrawer(page: Page) {
  const close = page.getByRole("button", { name: "Close workspace" });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  }
}

export function chatComposer(page: Page) {
  return page.getByLabel("Message Rolebound");
}

export async function assertWorkspaceSectionNav(page: Page) {
  const nav = workspaceSectionNav(page);
  for (const key of ["discover", "queue", "applications", "profile", "setup"] as const) {
    await expect(nav.getByRole("link").filter({ hasText: NAV[key] })).toBeVisible();
  }
}

/** Labels from `SECTIONS` in `ui/src/chat/WorkspaceDrawer.tsx`. */
export const WORKSPACE_DRAWER_SECTIONS = [
  "Profile",
  "Job search",
  "Agent instructions",
  "Applications",
  "Settings",
  "Setup",
] as const;

/** Nested links in `MOBILE_GROUPS` (`WorkspaceDrawer.tsx`) when the section rail is hidden. */
export const MOBILE_WORKSPACE_LINKS = [
  "Identity",
  "Found jobs",
  "Shortlist",
  "Companies to watch",
  "Applications",
  "Agent instructions",
  "AI settings",
  "Setup checklist",
] as const;

function workspaceSectionLink(nav: ReturnType<typeof workspaceSectionNav>, label: string) {
  if (label === "Applications") {
    return nav.getByRole("link", { name: /^Applications/ });
  }
  return nav.getByRole("link", { name: label, exact: true });
}

export function isMobileWorkspaceViewport(page: Page) {
  return (page.viewportSize()?.width ?? 1440) <= 720;
}

export function workspaceSectionChooser(page: Page) {
  return page.locator(".rb-mobile-sections > summary");
}

export async function assertCurrentWorkspaceSectionNav(page: Page) {
  if (isMobileWorkspaceViewport(page)) {
    await expect(workspaceSectionChooser(page)).toBeVisible();
    await workspaceSectionChooser(page).click();
    const chooser = page.getByRole("navigation", { name: "Choose workspace section" });
    for (const label of MOBILE_WORKSPACE_LINKS) {
      await expect(chooser.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await workspaceSectionChooser(page).press("Escape");
    return;
  }
  const nav = workspaceSectionNav(page);
  await expect(nav).toBeVisible();
  for (const label of WORKSPACE_DRAWER_SECTIONS) {
    await expect(workspaceSectionLink(nav, label)).toBeVisible();
  }
}

export async function assertWorkspaceNavigationVisible(page: Page) {
  if (isMobileWorkspaceViewport(page)) {
    await expect(workspaceSectionChooser(page)).toBeVisible();
  } else {
    await expect(workspaceSectionNav(page)).toBeVisible();
  }
}

export async function assertProfileSubsectionCurrent(page: Page, label: string) {
  if (isMobileWorkspaceViewport(page)) {
    await expect(workspaceSectionChooser(page)).toContainText(label);
    return;
  }
  await expect(
    page.getByRole("navigation", { name: "Profile sections" })
      .getByRole("button", { name: label, exact: true }),
  ).toHaveAttribute("aria-current", "page");
}

export async function openSetupAiConnections(page: Page) {
  await page.getByRole("button", { name: /1\. Connect AI/ }).click();
  await page.getByText(/Manage accounts/).click();
}

export async function expectUiRequest(page: Page, title: string | RegExp) {
  await expect(uiRequestCard(page, title)).toBeVisible({ timeout: 20_000 });
}

export async function submitUiRequestInput(page: Page, title: string | RegExp, value: string) {
  const card = uiRequestCard(page, title);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.locator("textarea.rb-chat-ui-input").fill(value);
  await card.getByRole("button", { name: "Submit" }).click();
}

export async function clickUiRequestConfirm(page: Page, answer: "Yes" | "No") {
  const card = page.locator(".rb-chat-ui-request").filter({ hasNot: page.locator(".rb-chat-ui-request--resolved") });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: answer }).click();
}

export async function startQueueApply(page: Page) {
  await page.goto("/queue");
  const apply = page.getByRole("button", { name: /Apply now/i }).first();
  await apply.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    (el as HTMLButtonElement).click();
  });
  await closeWorkspaceDrawer(page);
  await expectUiRequest(page, "Demo verification code");
}

function uiRequestCard(page: Page, title: string | RegExp) {
  return page.locator(".rb-chat-ui-request:not(.rb-chat-ui-request--resolved)").filter({
    has: page.locator(".rb-chat-ui-title", { hasText: title }),
  });
}

/**
 * Enters the demo verification code and expects exactly one new receipt notice. Specs share one
 * demo server, so the chat may already show receipts from earlier runs.
 */
export async function submitDemoCodeAndExpectReceipt(page: Page) {
  const receipts = page.getByText(/Demo receipt written/i);
  const before = await receipts.count();
  await submitUiRequestInput(page, "Demo verification code", "12345678");
  await expect(receipts).toHaveCount(before + 1, { timeout: 20_000 });
}
