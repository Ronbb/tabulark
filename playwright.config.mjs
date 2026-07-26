import { defineConfig } from "@playwright/test";

const host = process.env.TABULARK_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.TABULARK_TEST_PORT ?? 4173);
const deployedBaseURL = process.env.TABULARK_DEPLOYED_BASE_URL?.trim();
const baseURL = deployedBaseURL || `http://${host}:${port}`;
const browserChannel = process.env.TABULARK_BROWSER_CHANNEL?.trim();
const chromiumChannel = browserChannel ? { channel: browserChannel } : {};
const chromiumOnly = [
  "**/visual.spec.mjs",
  "**/m6-large-file.spec.mjs",
];

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.mjs",
  globalSetup: deployedBaseURL ? undefined : "./test/browser/global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Release evidence must be a clean pass. A retry can still be requested
  // explicitly while diagnosing a local failure, but CI never masks one.
  retries: Number(process.env.TABULARK_PLAYWRIGHT_RETRIES ?? 0),
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
      use: { browserName: "chromium", ...chromiumChannel },
    },
    {
      name: "firefox",
      testIgnore: chromiumOnly,
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      testIgnore: chromiumOnly,
      use: { browserName: "webkit" },
    },
  ],
});
