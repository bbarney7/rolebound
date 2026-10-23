import { test as base } from "@playwright/test";
import { startFreshWorkspace, type FRESH_MODEL_ID } from "./fresh-web-server.mjs";

export type SeedLoginsOptions = {
  cursorSdk?: boolean;
  piAuth?: boolean;
  claudeCode?: boolean;
  codex?: boolean;
  ghHosts?: boolean;
};

export type FreshWorkspaceOptions = {
  scriptedSteps?: Array<Record<string, unknown>>;
  withSubmissionFixture?: boolean;
  withCaptchaProbe?: boolean;
  seedLogins?: SeedLoginsOptions;
};

export type FreshWorkspaceHandle = Awaited<ReturnType<typeof startFreshWorkspace>>;

export const test = base.extend<{ fresh: FreshWorkspaceHandle; freshOpts: FreshWorkspaceOptions }>({
  freshOpts: [{}, { option: true }],
  fresh: async ({ freshOpts }, use) => {
    const ws = await startFreshWorkspace(freshOpts);
    try {
      await use(ws);
    } finally {
      await ws.stop();
    }
  },
  baseURL: async ({ fresh }, use) => {
    await use(fresh.baseURL);
  },
});

export { expect } from "@playwright/test";
export { FRESH_MODEL_ID };
