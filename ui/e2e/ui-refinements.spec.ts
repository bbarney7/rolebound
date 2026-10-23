import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function fixture(page: Page) {
  const connection = {id:"fixture-ai",label:"Example account with a deliberately long workspace name",provider:"openai",credential:{configured:true,source:"app-store"},validation:{status:"untested",checkedAt:null},origin:{kind:"pi-auth"}};
  let data = {revision:"fixture-1",data:{connections:[connection],agent:{connectionId:connection.id,modelId:"alpha-model"},scoring:null}};
  await page.route("**/api/connections", route => route.fulfill({json:data}));
  await page.route("**/api/connections/*/models", route => route.fulfill({json:{models:[{id:"alpha-model"},{id:"beta-model"},{id:"long-model-name-that-should-wrap-cleanly-at-phone-width"}]}}));
  await page.route("**/api/connections/selections",async route => { const body = route.request().postDataJSON(); data = {...data,revision:"fixture-2",data:{...data.data,agent:body.agent,scoring:body.scoring}}; await route.fulfill({json:data}); });
  await page.route("**/api/providers/detected",route => route.fulfill({json:[]}));
}

for (const theme of ["light","dark"] as const) for (const size of [{width:1440,height:900},{width:1024,height:768},{width:768,height:1024},{width:390,height:844},{width:360,height:800},{width:720,height:450}]) {
  test(`configuration layout ${size.width} ${theme}`,async ({page},info) => {
    await page.setViewportSize(size);
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.addInitScript(value => localStorage.setItem("rolebound-theme",value),theme);
    await fixture(page); await page.goto("/settings");
    await page.getByRole("button",{name:"Change",exact:true}).click();
    await expect(page.getByRole("combobox",{name:"Applying model"})).toHaveValue("alpha-model");
    await page.getByRole("combobox",{name:"Applying model"}).click();
    await expect(page.getByRole("option",{name:"beta-model",exact:true})).toBeVisible();
    await page.getByRole("option",{name:"beta-model",exact:true}).click();
    await expect(page.getByRole("button",{name:"Save model selection"})).toBeEnabled();
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.rb-ws-content,.rb-settings-grid,.rb-model-picker')].some(el => el.scrollWidth > el.clientWidth+1));
    expect(overflow).toBe(false);
    await page.screenshot({path:info.outputPath(`settings-${size.width}-${theme}.png`)});
    await page.getByRole("button",{name:"Save model selection"}).click();
    await expect(page.getByText("Saved",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Close workspace"}).click();
    await expect(page.getByRole("dialog",{name:"Workspace"})).not.toBeVisible();
  });
}

test("model queries cancel; drafts survive navigation; modal contains keyboard focus",async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await fixture(page); await page.goto("/settings");
  await page.getByRole("button",{name:"Change",exact:true}).click();
  const model = page.getByRole("combobox",{name:"Applying model"});
  await model.fill("uncommitted-query"); await model.press("Escape");
  await expect(model).toHaveValue("alpha-model");
  await expect(page.getByRole("button",{name:"Save model selection"})).toBeDisabled();
  await model.fill("beta"); await page.getByRole("option",{name:"beta-model",exact:true}).click();
  const nav = page.getByRole("navigation",{name:"Workspace sections",exact:true});
  await nav.getByRole("link",{name:"Setup",exact:true}).click();
  await nav.getByRole("link",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Change",exact:true}).click();
  await expect(model).toHaveValue("beta-model");
  await page.getByRole("button",{name:"Close workspace"}).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Workspace"})).not.toBeVisible();
});

test("mobile uses one grouped chooser and preserves nested URLs",async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await fixture(page); await page.goto("/profile?tab=identity");
  const chooser = page.locator(".rb-mobile-sections > summary");
  await chooser.click();
  await page.getByRole("navigation",{name:"Choose workspace section"}).getByRole("link",{name:"Job preferences",exact:true}).click();
  await expect(page).toHaveURL(/tab=searchPreferences/);
  await expect(page.getByRole("navigation",{name:"Profile sections"})).not.toBeVisible();
  await chooser.click(); await chooser.press("Escape");
  await expect(page.getByRole("dialog",{name:"Workspace"})).toBeVisible();
  await expect(page.getByRole("navigation",{name:"Choose workspace section"})).not.toBeVisible();
});

test("settings has no serious accessibility violations",async ({page}) => {
  await fixture(page); await page.goto("/settings"); await page.getByRole("button",{name:"Change",exact:true}).click();
  const scan = await new AxeBuilder({page}).include('dialog').analyze();
  expect(scan.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("all configuration surfaces remain usable at phone and laptop widths", async ({page},info) => {
  await fixture(page);
  for (const width of [360,1024]) {
    await page.setViewportSize({width,height:800});
    for (const path of ["/setup","/profile?tab=identity","/profile?tab=addresses","/profile?tab=resumes","/profile?tab=candidateSummary","/profile?tab=qaBank","/profile?tab=workHistory","/queue","/settings/accounts","/discover?tab=companies"]) {
      await page.goto(path); await expect(page.getByRole("dialog",{name:"Workspace"})).toBeVisible();
      const content = page.locator(".rb-ws-content");
      expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth+1),path).toBe(true);
      await page.screenshot({path:info.outputPath(`surface-${width}-${path.replace(/\W/g,"_")}.png`)});
    }
  }
});

test("composer stays compact, grows to eight lines and retains one focus boundary",async ({page},info) => {
  await fixture(page); await page.goto("/");
  for (const width of [390,1024]) {
    await page.setViewportSize({width,height:844});
    const input = page.getByRole("textbox",{name:"Message Rolebound"});
    await input.fill(""); await input.focus();
    expect(await page.locator(".rb-chat-composer").evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(80);
    await input.fill(Array.from({length:12},(_,i)=>`A line of text ${i}`).join("\n"));
    const box = await input.evaluate(el => ({height:el.clientHeight,scroll:el.scrollHeight,line:parseFloat(getComputedStyle(el).lineHeight),padding:parseFloat(getComputedStyle(el).paddingTop)+parseFloat(getComputedStyle(el).paddingBottom),outline:getComputedStyle(el).outlineStyle}));
    expect(box.height).toBeLessThanOrEqual(box.line*8+box.padding+1);
    expect(box.scroll).toBeGreaterThan(box.height);
    expect(box.outline).toBe("none");
    await page.screenshot({path:info.outputPath(`composer-${width}.png`)});
    await input.fill("");
  }
});

test("profile subsection stays in sync when switching from desktop to phone",async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await fixture(page); await page.goto("/profile?tab=identity");
  await page.getByRole("navigation",{name:"Profile sections"}).getByRole("button",{name:"Resumes",exact:true}).click();
  await expect(page).toHaveURL(/tab=resumes/);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator(".rb-mobile-sections > summary")).toContainText("Resumes");
});
