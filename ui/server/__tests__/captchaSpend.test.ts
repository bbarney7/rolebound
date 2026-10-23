import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigValidationError, validateSettings } from "../../shared/config";
import { resolveCaptchaSettings, readCaptchaSettings } from "../../../.pi/extensions/lib/captcha";
import {
  CAPTCHA_SPEND_WINDOW_MS,
  countPaidTasksInWindow,
  reservePaidTask,
} from "../../../.pi/extensions/lib/captcha-spend";
import { spawnCrossProcessChild } from "./crossProcessHelpers";
import { createExtensionHarnessWorkspace } from "./extensionHarness";

describe("captchaSpend", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function workspace() {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.mkdir(path.join(ws.root, ".pi-jobs"), { recursive: true });
    const settingsPath = path.join(ws.root, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        schemaVersion: 2,
        connections: [],
        agent: null,
        scoring: null,
        captcha: { provider: "2captcha", api_key: "k".repeat(32), max_paid_tasks_per_day: 20 },
      }),
      "utf8",
    );
    return { ...ws, settingsPath };
  }

  it("blocks the 21st task across three applications", async () => {
    // boundary: B13 — rolling 24-hour workspace CAPTCHA spend cap.
    const ws = await workspace();
    const base = Date.now();
    for (let i = 0; i < 20; i++) {
      const slug = i % 3 === 0 ? "a-co" : i % 3 === 1 ? "b-co" : "c-co";
      const res = await reservePaidTask(ws.root, base + i, {
        slug,
        provider: "2captcha",
        settingsPath: ws.settingsPath,
      });
      expect(res).toEqual({ ok: true });
    }
    const blocked = await reservePaidTask(ws.root, base + 20, {
      slug: "a-co",
      provider: "2captcha",
      settingsPath: ws.settingsPath,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("budget_exhausted");
      expect(blocked.cap).toBe("daily");
      expect(blocked.error).toMatch(/Daily paid CAPTCHA task cap \(20/);
      expect(blocked.freesAt).toBeDefined();
    }
  });

  it("frees a slot after the 24-hour window with a fake clock", async () => {
    const ws = await workspace();
    await fs.writeFile(
      path.join(ws.root, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        connections: [],
        agent: null,
        scoring: null,
        captcha: { provider: "2captcha", api_key: "k".repeat(32), max_paid_tasks_per_day: 1 },
      }),
      "utf8",
    );
    const t0 = 1_700_000_000_000;
    expect(await reservePaidTask(ws.root, t0, { slug: "one", provider: "2captcha", settingsPath: ws.settingsPath })).toEqual({
      ok: true,
    });
    const blocked = await reservePaidTask(ws.root, t0 + 1000, {
      slug: "two",
      provider: "2captcha",
      settingsPath: ws.settingsPath,
    });
    expect(blocked.ok).toBe(false);
    const later = await reservePaidTask(ws.root, t0 + CAPTCHA_SPEND_WINDOW_MS + 1, {
      slug: "two",
      provider: "2captcha",
      settingsPath: ws.settingsPath,
    });
    expect(later).toEqual({ ok: true });
    expect(await countPaidTasksInWindow(ws.root, t0 + CAPTCHA_SPEND_WINDOW_MS + 1)).toBe(1);
  });

  it(
    "two concurrent reservers never exceed the cap (cross-process)",
    async () => {
      const ws = await workspace();
      await fs.writeFile(
        path.join(ws.root, "settings.json"),
        JSON.stringify({
          schemaVersion: 2,
          connections: [],
          agent: null,
          scoring: null,
          captcha: { provider: "2captcha", api_key: "k".repeat(32), max_paid_tasks_per_day: 20 },
        }),
        "utf8",
      );
      const now = Date.now();
      const children = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          spawnCrossProcessChild(ws.root, {
            op: "reserve_captcha_spend",
            slug: `role-${i}`,
            provider: "2captcha",
            now: now + i,
          }),
        ),
      );
      const results = await Promise.all(children.map((c) => c.wait()));
      for (const r of results) expect(r.code).toBe(0);
      const count = await countPaidTasksInWindow(ws.root, now + 25);
      expect(count).toBe(20);
    },
    60_000,
  );

  it("fails closed on a corrupt spend file", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws.root, ".pi-jobs", "captcha-spend.json"), "{ nope", "utf8");
    const res = await reservePaidTask(ws.root, Date.now(), {
      slug: "x",
      provider: "2captcha",
      settingsPath: ws.settingsPath,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.cap).toBe("corrupt");
      expect(res.error).toMatch(/corrupt/);
    }
  });

  it("rejects an out-of-range max_paid_tasks_per_day in validateSettings", () => {
    const base = {
      schemaVersion: 2,
      connections: [],
      agent: null,
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    };
    expect(() => validateSettings({ ...base, captcha: { ...base.captcha, max_paid_tasks_per_day: 0 } })).toThrow(
      ConfigValidationError,
    );
    expect(() => validateSettings({ ...base, captcha: { ...base.captcha, max_paid_tasks_per_day: 201 } })).toThrow(
      ConfigValidationError,
    );
  });

  it("fresh install from templates/settings.json resolves to off even with CAPSOLVER_API_KEY", async () => {
    // boundary: B12 — env alone cannot enable a solver.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "captcha-fresh-"));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    await fs.copyFile(path.join(repoRoot, "templates", "settings.json"), path.join(dir, "settings.json"));
    const resolved = await readCaptchaSettings(path.join(dir, "settings.json"), { CAPSOLVER_API_KEY: "cap-key" });
    expect(resolveCaptchaSettings({ provider: "off", api_key: "" }, { CAPSOLVER_API_KEY: "cap-key" })).toEqual({
      provider: "off",
      apiKey: "",
      keySource: "none",
      warnings: [],
    });
    expect(resolved.provider).toBe("off");
    expect(resolved.apiKey).toBe("");
  });
});
