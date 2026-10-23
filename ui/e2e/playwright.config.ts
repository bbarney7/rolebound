import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PI_JOBS_E2E_PORT || 14747);
const baseURL = `http://127.0.0.1:${port}`;

const visualGate = /visual-gate\.spec\.ts/;
const freshSpecs = /(^|\/)fresh-.*\.spec\.ts$/;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: freshSpecs,
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: process.env.PI_JOBS_E2E_MAX_FAILURES ? Number(process.env.PI_JOBS_E2E_MAX_FAILURES) : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/html-report" }]],
  outputDir: "artifacts/test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-1440-light", testIgnore: [visualGate, freshSpecs], use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "desktop-1024-light", testIgnore: [visualGate, freshSpecs], use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } } },
    { name: "tablet-768-light", testIgnore: [visualGate, freshSpecs], use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "mobile-390-light", testIgnore: [visualGate, freshSpecs], use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "mobile-390-dark", testIgnore: [visualGate, freshSpecs], use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, colorScheme: "dark" } },
    { name: "visual-desktop-1440-light", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "visual-mobile-390-light", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "visual-mobile-390-dark", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, colorScheme: "dark" } },
    { name: "desktop-1440-dark", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
    { name: "desktop-1024-dark", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 }, colorScheme: "dark" } },
    { name: "tablet-768-dark", testMatch: visualGate, use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, colorScheme: "dark" } },
  ],
  webServer: {
    command: "node e2e/web-server.mjs",
    cwd: "..",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { PI_JOBS_E2E_PORT: String(port) },
  },
});
