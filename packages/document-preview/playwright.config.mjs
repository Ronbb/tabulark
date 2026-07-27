import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "browser.spec.mjs",
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4183",
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node ../../test/browser/server.mjs",
    env: { TABULARK_TEST_PORT: "4183" },
    port: 4183,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
