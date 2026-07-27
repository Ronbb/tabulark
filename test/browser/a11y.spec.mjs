import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_21_A_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function openExample(page, colorScheme, forcedColors = "none") {
  await page.emulateMedia({ colorScheme, forcedColors });
  await page.goto("/examples/csv-preview/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
}

async function openParsingOptions(page) {
  const options = page.getByTestId("advanced-options");
  if (await options.getAttribute("open") === null) {
    // WebKit can suppress the native <details> click while forced-colors is
    // emulated. Opening the standard property keeps this setup deterministic;
    // keyboard/pointer behavior remains covered by the interaction suite.
    await options.evaluate((element) => { element.open = true; });
    await expect(options).toHaveAttribute("open", "");
  }
}

async function openSample(page, { forceDomClick = false } = {}) {
  const sample = page.getByTestId("sample-button");
  await expect(sample).toBeEnabled();
  if (forceDomClick) {
    // WebKit can acknowledge a synthetic pointer click while forced-colors is
    // emulated without delivering the activation. This is setup only; normal
    // pointer and keyboard activation remain covered by the interaction suite.
    await sample.evaluate((element) => { element.click(); });
    return;
  }
  await sample.click();
}

async function expectReady(page) {
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute(
    "aria-busy",
    "false",
    { timeout: 15_000 },
  );
}

async function expectNoWcagViolations(
  page,
  testInfo,
  { disableColorContrast = false } = {},
) {
  const builder = new AxeBuilder({ page }).withTags(WCAG_21_A_AA_TAGS);
  // axe evaluates the synthetic system Highlight palette as authored CSS in
  // Firefox/WebKit. Their forced-colors gate therefore keeps every structural
  // WCAG rule here and validates observable contrast behavior separately.
  if (disableColorContrast) builder.disableRules("color-contrast");
  const results = await builder.analyze();

  if (results.violations.length > 0) {
    await testInfo.attach("axe-results", {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
  }

  expect(results.violations).toEqual([]);
}

test.describe("CSV preview accessibility", () => {
  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) {
      await page.close();
    }
  });

  test("idle light state has no WCAG 2.1 A or AA violations", async ({ page }, testInfo) => {
    await openExample(page, "light");
    await expect(page.getByTestId("state-label")).toHaveText("Idle");

    await expectNoWcagViolations(page, testInfo);
  });

  test("ready light state has no WCAG 2.1 A or AA violations", async ({ page }, testInfo) => {
    await openExample(page, "light");
    await openSample(page);
    await expectReady(page);
    await expect(page.getByTestId("state-label")).toHaveText("Ready");

    await expectNoWcagViolations(page, testInfo);
  });

  test("strict parse error light state has no WCAG 2.1 A or AA violations", async (
    { page },
    testInfo,
  ) => {
    await openExample(page, "light");
    await page.getByTestId("source-input").setInputFiles({
      name: "ragged.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("left,right\nonly-left\n"),
    });
    await openParsingOptions(page);
    await page.getByTestId("parse-mode").selectOption("strict");
    await page.getByTestId("open-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "error", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("state-label")).toHaveText("Error");
    await expect(page.getByTestId("status")).toContainText("PARSE_FAILED");

    await expectNoWcagViolations(page, testInfo);
  });

  test("ready dark state has no WCAG 2.1 A or AA violations", async ({ page }, testInfo) => {
    await openExample(page, "dark");
    await openSample(page);
    await expectReady(page);
    await expect(page.getByTestId("state-label")).toHaveText("Ready");
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);

    await expectNoWcagViolations(page, testInfo);
  });

  test("ready forced-colors state has no WCAG 2.1 A or AA violations", async (
    { browserName, page },
    testInfo,
  ) => {
    await openExample(page, "light", "active");
    await openSample(page, { forceDomClick: true });
    await expectReady(page);
    await expect(page.getByTestId("state-label")).toHaveText("Ready");
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

    await expectNoWcagViolations(page, testInfo, {
      disableColorContrast: browserName !== "chromium",
    });
  });

  test("strict parse error forced-colors state has no WCAG 2.1 A or AA violations", async (
    { browserName, page },
    testInfo,
  ) => {
    await openExample(page, "light", "active");
    await page.getByTestId("source-input").setInputFiles({
      name: "ragged.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("left,right\nonly-left\n"),
    });
    await openParsingOptions(page);
    await page.getByTestId("parse-mode").selectOption("strict");
    await page.getByTestId("open-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "error", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("status")).toContainText("PARSE_FAILED");
    await expect(page.getByTestId("retry-button")).toBeVisible();

    await expectNoWcagViolations(page, testInfo, {
      disableColorContrast: browserName !== "chromium",
    });
  });
});
