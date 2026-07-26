import { expect, test } from "@playwright/test";

import { installClipboardContract, readClipboardText } from "./clipboard.mjs";

async function expectLandingReady(page) {
  await expect(page).toHaveTitle(/Tabulark · Local table preview infrastructure/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Open big tables without locking the page." }),
  ).toBeVisible();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  await expect(page.getByRole("link", { name: "Open the playground" })).toHaveAttribute(
    "href",
    "#playground",
  );
  await expect(page.getByRole("link", { exact: true, name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/Ronbb/tabulark",
  );
}

test("serves the introduction and interactive playground from the site root", async ({ page }) => {
  await page.goto("/");
  await expectLandingReady(page);
  await expectVisibleTargetsAtLeast44CssPixels(page);

  await expect(page.getByTestId("advanced-options")).toBeVisible();
  await expect(page.getByTestId("arrow-options")).toBeHidden();
  await page.getByTestId("format").selectOption("arrow");
  await expect(page.getByTestId("advanced-options")).toBeHidden();
  await expect(page.getByTestId("arrow-options")).toBeVisible();
  await page.getByTestId("format").selectOption("csv");

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.locator("[data-tabulark-canvas]")).toBeVisible();
  await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("assembled Pages artifact keeps both adapter artifacts lazy and single-load", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("_bg.wasm")) requests.push(request.url());
  });

  await page.goto("/target/pages/index.html");
  await expectLandingReady(page);
  expect(requests).toEqual([]);

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  expect(requests.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(requests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(0);

  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  expect(requests.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(requests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(1);

  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  expect(requests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(1);
});

test("built Pages artifact opens and switches CSV, TSV, and Arrow with relative assets", async ({
  browserName,
  context,
  page,
}) => {
  await installClipboardContract({ browserName, context, page });
  await page.goto("/target/pages/index.html");
  await expectLandingReady(page);

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("2,000 rows are ready");

  await page.getByTestId("source-input").setInputFiles({
    name: "pages-switch.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("name\tnote\n甲\t你好\n乙\t世界\n", "utf8"),
  });
  await page.getByTestId("format").selectOption("tsv");
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("2 rows are ready");
  let grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toContainText("你好");
  await grid.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+C");
  await expect.poll(async () => navigatorText(page)).toBe("甲\t你好");

  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("status")).toContainText("4 rows are ready");
  await expect(page.locator("[data-tabulark-view]")).toHaveCount(1);
  grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toContainText("你好，Arrow");
  await expect(grid).toContainText("上海");
});

test("legacy playground path resolves to the Pages-safe root entry point", async ({ page }) => {
  await page.goto("/target/pages/examples/csv-preview/");
  await expect(page).toHaveURL(/\/target\/pages\/#playground$/);
  await expectLandingReady(page);
});

test.describe("mobile landing page", () => {
  test.use({ reducedMotion: "reduce", viewport: { height: 812, width: 375 } });

  test("keeps the primary path touch-friendly without horizontal overflow", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expectLandingReady(page);

    const callToAction = page.getByRole("link", { name: "Open the playground" });
    const callToActionBox = await callToAction.boundingBox();
    expect(callToActionBox).not.toBeNull();
    expect(callToActionBox.height).toBeGreaterThanOrEqual(44);

    await callToAction.click();
    await expect(page).toHaveURL(/#playground$/);
    await expect(page.getByTestId("open-form")).toBeVisible();

    const sampleButtonBox = await page.getByTestId("sample-button").boundingBox();
    expect(sampleButtonBox).not.toBeNull();
    expect(sampleButtonBox.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("advanced-options").locator("summary").click();
    await expectVisibleTargetsAtLeast44CssPixels(page);

    const format = page.getByTestId("format");
    await format.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(format).toHaveValue("arrow");
    await expect(page.getByTestId("advanced-options")).toBeHidden();
    await expect(page.getByTestId("arrow-options")).toBeVisible();
    await expectVisibleTargetsAtLeast44CssPixels(page);

    await page.keyboard.press("Home");
    await expect(format).toHaveValue("csv");
    await page.keyboard.press("ArrowDown");
    await expect(format).toHaveValue("tsv");
    await expect(page.getByTestId("delimiter-help")).toContainText("Leave blank for a tab");
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    ).toBe(true);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe("auto");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const arrowSample = page.getByTestId("arrow-sample-button");
    await arrowSample.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("state-label")).toHaveText("Ready");
    await expect(page.getByTestId("status")).toContainText("4 rows are ready");
    await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute("aria-colcount", "7");
    await expectVisibleTargetsAtLeast44CssPixels(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

test("exposes a visible keyboard focus indicator on the landing-page entry path", async ({
  page,
}) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveClass(/skip-link/);
  await expectFocusedOutline(page, ".skip-link");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#playground$/);
  await expect(page.getByTestId("open-form")).toBeVisible();

  await page.goto("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveClass(/brand/);
  await expectFocusedOutline(page, ".brand");
});

test.describe("mobile landscape landing page", () => {
  test.use({ viewport: { height: 375, width: 667 } });

  test("keeps the playground operable without page-level horizontal overflow", async ({ page }) => {
    await page.goto("/target/pages/index.html#playground");
    await expect(page.getByTestId("open-form")).toBeVisible();
    await page.getByTestId("arrow-sample-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
      timeout: 30_000,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const openButtonBox = await page.getByTestId("open-button").boundingBox();
    expect(openButtonBox).not.toBeNull();
    expect(openButtonBox.height).toBeGreaterThanOrEqual(44);
  });
});

async function navigatorText(page) {
  return readClipboardText(page);
}

async function expectFocusedOutline(page, selector) {
  const focused = page.locator(selector);
  await expect(focused).toBeFocused();
  const focusStyle = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      width: bounds.width,
    };
  });
  expect(focusStyle.height).toBeGreaterThanOrEqual(44);
  expect(focusStyle.width).toBeGreaterThanOrEqual(44);
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(3);
}

async function expectVisibleTargetsAtLeast44CssPixels(page) {
  const undersizedTargets = await page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "select",
      "input:not([type='file'])",
      "summary",
      "#file-picker",
      "[role='separator'][tabindex='0']",
    ].join(",");
    return [...document.querySelectorAll(selector)]
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.height > 0
          && bounds.width > 0
          && style.display !== "none"
          && style.visibility !== "hidden";
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          id: element.id
            || element.getAttribute("data-testid")
            || element.getAttribute("aria-label")
            || element.textContent?.trim()
            || element.tagName,
          height: bounds.height,
          width: bounds.width,
        };
      })
      .filter(({ height, width }) => height < 44 || width < 44);
  });
  expect(undersizedTargets).toEqual([]);
}
