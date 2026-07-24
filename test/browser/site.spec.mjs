import { expect, test } from "@playwright/test";

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

test("built Pages artifact keeps project-relative runtime URLs working", async ({ page }) => {
  await page.goto("/target/pages/index.html");
  await expectLandingReady(page);

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("2,000 rows are ready");
});

test("legacy playground path resolves to the Pages-safe root entry point", async ({ page }) => {
  await page.goto("/target/pages/examples/csv-preview/");
  await expect(page).toHaveURL(/\/target\/pages\/#playground$/);
  await expectLandingReady(page);
});

test.describe("mobile landing page", () => {
  test.use({ viewport: { height: 812, width: 375 } });

  test("keeps the primary path touch-friendly without horizontal overflow", async ({ page }) => {
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
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});
