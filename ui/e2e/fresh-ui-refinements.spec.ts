import { expect, test } from "./fresh-fixture";
test("fresh setup starts with AI and never acknowledges submission through navigation",async ({page}) => {
  await page.goto("/setup");
  await expect(page.getByRole("region",{name:"Connect AI",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/I understand/})).not.toBeVisible();
  const before = await (await page.request.get("/api/readiness")).json();
  expect(before.acknowledgement.at).toBeNull();
  await page.getByRole("button",{name:/4. Ready to apply/}).click();
  await expect(page.getByRole("button",{name:/I understand — enable automatic submission/})).toBeVisible();
  await page.getByRole("button",{name:/1. Connect AI/}).click();
  const after = await (await page.request.get("/api/readiness")).json();
  expect(after.acknowledgement.at).toBeNull();
  expect(after.applyReady).toBe(false);
});
