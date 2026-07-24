import { defineConfig, devices } from "@playwright/test";

const host = process.env.TABULARK_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.TABULARK_TEST_PORT ?? 4173);
const baseURL = `http://${host}:${port}`;
const browserChannel = process.env.TABULARK_BROWSER_CHANNEL?.trim();
const localBrowser = browserChannel ? { channel: browserChannel } : {};

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.mjs",
  globalSetup: "./test/browser/global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 0,
      pathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
      scale: "css",
    },
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "chromium",
      use: localBrowser,
    },
  ],
});
