import { defineConfig, devices } from "@playwright/test";

const host = process.env.TABULARK_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.TABULARK_TEST_PORT ?? 4173);
const baseURL = `http://${host}:${port}`;
const localChrome = process.env.CI ? {} : { channel: "chrome" };

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.mjs",
  globalSetup: "./test/browser/global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...localChrome },
    },
  ],
});
