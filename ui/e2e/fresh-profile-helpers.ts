import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openView } from "./test-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const uploadPdf = path.join(here, "fixtures", "upload-resume.pdf");

export const FRESH_CANDIDATE_SUMMARY =
  "PJ23 fresh pilot candidate summary — fictional platform engineer with TypeScript and distributed systems experience.";

const WORK_HISTORY_MD = `### Example Corp — Senior Engineer (2020-01 – present)

Remote

One paragraph about building reliable services and mentoring.

- Platform migration — led rollout and cut incidents 40%
- API redesign — improved latency for internal tools

### Prior Co — Engineer (2016-06 – 2019-12)

Denver, CO

Earlier role with backend focus.

- Data pipeline — shipped nightly analytics for product teams
`;

const EDUCATION_MD = `### B.S. Computer Science

State University — 2016

Dean's list
`;

const AUTHORIZATION_MD = `- Authorized to work in the United States
`;

const QA_BANK_MD = `**Why this company?**

Two sentences about mission fit and the kind of problems I want to solve.

**Cover letter**

A short paragraph I would be happy to submit unedited for fictional employers.
`;

/**
 * Clicks a section's Save button and waits until the saved markdown is
 * visible through /api/profile. Under CI/runner load a save occasionally does
 * not land within one poll budget; the click is retried once rather than
 * failing the whole onboarding flow on a transient miss.
 */
async function saveUntilPersisted(page: Page, buttonName: string, persisted: () => Promise<string>) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.getByRole("button", { name: buttonName }).click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await persisted()) === "ok") return;
      await page.waitForTimeout(100);
    }
  }
  throw new Error(`profile section save did not land in /api/profile: ${buttonName}`);
}

export async function fillBlockingProfileSections(page: Page) {
  await openView(page, "profile");

  await page.getByLabel("Full name").fill("Fresh Pilot");
  await page.getByLabel("Preferred name / first name on forms").fill("Fresh");
  await page.getByLabel("Email", { exact: true }).fill("fresh.pilot@example.com");
  await page.getByLabel("Phone").fill("+1 555 010 0200");
  await page.getByLabel("LinkedIn").fill("https://www.linkedin.com/in/fresh-pilot");
  await page.getByLabel("GitHub").fill("N/A");
  await page.getByLabel("Portfolio / website").fill("N/A");
  await page.getByLabel("Fallback email").fill("");
  await page.getByLabel("Pronouns").fill("they/them");
  const saveIdentity = page.getByRole("button", { name: "Save Identity" });
  await expect(saveIdentity).toBeEnabled({ timeout: 5_000 });
  await saveIdentity.click();
  await expect.poll(async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { identity?: { parsed?: { fullName?: string | null } } };
    return body.identity?.parsed?.fullName === "Fresh Pilot" ? "ok" : "";
  }, { timeout: 20_000, message: "profile section save did not land in /api/profile" }).toBe("ok");

  await page.getByRole("button", { name: "Job preferences" }).click();
  await page.getByLabel("Target roles").fill("staff engineer, platform engineer, software engineer");
  await page.getByLabel("Target level").fill("staff, senior");
  await saveUntilPersisted(page, "Save job search preferences", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { preferences?: { topics?: string[] } };
    return body.preferences?.topics?.includes("platform") ? "ok" : "";
  });

  await page.getByRole("button", { name: "Work history" }).click();
  await page.locator("#profile-workHistory").fill(WORK_HISTORY_MD);
  await saveUntilPersisted(page, "Save work history", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { markdownBodies?: { workHistory?: string } };
    return body.markdownBodies?.workHistory?.includes("Example Corp") ? "ok" : "";
  });

  await page.locator("#profile-education").fill(EDUCATION_MD);
  await saveUntilPersisted(page, "Save education", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { markdownBodies?: { education?: string } };
    return body.markdownBodies?.education?.includes("State University") ? "ok" : "";
  });

  await page.locator("#profile-authorization").fill(AUTHORIZATION_MD);
  await saveUntilPersisted(page, "Save work authorization", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { markdownBodies?: { authorization?: string } };
    return body.markdownBodies?.authorization?.includes("Authorized") ? "ok" : "";
  });

  await page.getByRole("button", { name: "Q&A bank" }).click();
  const qa = page.locator("textarea.control").first();
  await qa.fill(QA_BANK_MD);
  await saveUntilPersisted(page, "Save Q&A bank", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { qaBank?: string };
    return body.qaBank?.includes("mission fit") ? "ok" : "";
  });

  await page.getByRole("button", { name: "Candidate summary" }).click();
  const summary = page.locator("textarea.control").first();
  await summary.fill(FRESH_CANDIDATE_SUMMARY);
  await saveUntilPersisted(page, "Save candidate summary", async () => {
    const res = await page.request.get("/api/profile");
    if (!res.ok()) return "";
    const body = (await res.json()) as { markdownBodies?: { candidateSummary?: string } };
    return body.markdownBodies?.candidateSummary?.includes("PJ23 fresh pilot") ? "ok" : "";
  });
}

export async function addLoopbackConnection(page: Page, modelBaseUrl: string, label = "Fresh loopback") {
  await page.goto("/setup");
  await page.getByRole("dialog",{name:"Workspace"}).locator("details.rb-paste-key summary").click();
  await page.getByRole("dialog",{name:"Workspace"}).locator("#paste-label").fill(label);
  await page.getByRole("dialog",{name:"Workspace"}).locator("#paste-provider").selectOption("openai-compatible");
  await page.getByRole("dialog",{name:"Workspace"}).locator("#paste-base").fill(`${modelBaseUrl}/v1`);
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect.poll(async () => ((await (await page.request.get("/api/connections")).json()) as {data:{connections:Array<{label:string}>}}).data.connections.some(c => c.label === label)).toBe(true);
  await page.getByRole("button",{name:/1. Connect AI/}).click();
  await page.getByText(/Manage accounts/).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Connection works/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", {name:"Change",exact:true}).click();
  await page.locator("#agent-connection").selectOption({ index: 1 });
  await page.locator("#agent-model").fill("fresh-scripted");
  await page.getByRole("option",{name:/fresh-scripted/}).first().click();
  await page.getByRole("button", { name: "Save model selection" }).click();
  await expect(page.getByText("Saved",{exact:true})).toBeVisible();
}

export async function uploadDefaultResume(page: Page) {
  await openView(page, "profile");
  await page.getByRole("button", { name: "Resumes" }).click();
  await page.getByRole("dialog",{name:"Workspace"}).locator('input[type="file"]').setInputFiles(uploadPdf);
  await expect.poll(async () => {
    const res = await page.request.get("/api/resumes");
    if (!res.ok()) return 0;
    const body = (await res.json()) as { files: Array<{ name: string }> };
    return body.files.some((f) => f.name === "upload-resume.pdf") ? 1 : 0;
  }).toBe(1);
  const row = page.locator("tr", { has: page.locator("td.mono", { hasText: "upload-resume.pdf" }) });
  await row.getByRole("button", { name: "Make default" }).click();
}

export async function saveFictionalAddress(page: Page) {
  await page.goto("/profile?tab=addresses");
  await page.getByRole("button", { name: "Edit saved address" }).first().click();
  await page.locator("#address-street").fill("100 Fresh Test St");
  await page.locator("#address-city").fill("Denver");
  await page.locator("#address-state").fill("CO");
  await page.locator("#address-zip").fill("80202");
  await saveUntilPersisted(page, "Save address", async () => {
    const res = await page.request.get("/api/addresses");
    if (!res.ok()) return "";
    const body = (await res.json()) as { rows: Array<{ key: string }> };
    return body.rows.some((r) => r.key === "denver") ? "ok" : "";
  });
}

export async function replaceTargetsWithFixtureSlugs(page: Page) {
  await openView(page, "discover");
  await page.getByRole("button", { name: "Edit targets" }).click();
  await page.getByLabel("Targets").fill("greenhouse:fictional-greenhouse");
  await page.getByRole("button", { name: "Save companies" }).click();
  await expect(page.getByRole("heading", { name: "Companies to watch" })).toBeHidden({ timeout: 15_000 });
}

export async function acknowledgeAutoSubmit(page: Page) {
  await openView(page, "setup");
  await page.getByRole("button", {name:/4. Ready to apply/}).click();
  await page.getByRole("button", { name: /I understand — enable automatic submission/i }).click();
  await expect.poll(async () => {
    const res = await page.request.get("/api/readiness");
    if (!res.ok()) return false;
    const body = (await res.json()) as { applyReady?: boolean };
    return body.applyReady === true;
  }).toBe(true);
}
