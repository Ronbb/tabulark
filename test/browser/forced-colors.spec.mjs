import { expect, test } from "@playwright/test";

async function openSample(page) {
  await page.goto("/examples/csv-preview/");
  await page.getByRole("button", { name: "Try sample data" }).click();
  const view = page.locator("[data-tabulark-view]");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(view).toBeVisible({ timeout: 15_000 });
  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(grid).toContainText("Record 1");
  return { grid, view };
}

test.describe("forced-colors Canvas table contract", () => {
  test("switches to system colors and preserves distinct focus, selection, and resize cues", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const records = [];
      const prototype = CanvasRenderingContext2D.prototype;
      for (const operation of ["fillRect", "strokeRect"]) {
        const original = prototype[operation];
        prototype[operation] = function (...args) {
          if (this.canvas?.matches?.("[data-tabulark-canvas]")) {
            records.push({
              alpha: this.globalAlpha,
              dash: this.getLineDash(),
              fillStyle: String(this.fillStyle),
              lineWidth: this.lineWidth,
              operation,
              strokeStyle: String(this.strokeStyle),
            });
          }
          return original.apply(this, args);
        };
      }
      globalThis.__tabularkCanvasPaintRecords = records;
    });
    await page.emulateMedia({ forcedColors: "none" });
    const { grid, view } = await openSample(page);
    await expect(view).toHaveAttribute("data-tabulark-forced-colors", "none");

    await page.emulateMedia({ forcedColors: "active" });
    await expect.poll(() => page.evaluate(() => (
      matchMedia("(forced-colors: active)").matches
    ))).toBe(true);
    await expect(view).toHaveAttribute("data-tabulark-forced-colors", "active");
    await expect(view.locator("canvas")).toHaveCSS("forced-color-adjust", "none");

    await grid.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(2);
    await expect.poll(async () => Number.parseFloat(
      await view.evaluate((element) => getComputedStyle(element).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    await expect(view).toHaveCSS("outline-style", "solid");

    const paint = await page.evaluate(() => {
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = "Highlight";
      const highlight = String(context.fillStyle);
      context.strokeStyle = "CanvasText";
      const canvasText = String(context.strokeStyle);
      return {
        canvasText,
        highlight,
        records: globalThis.__tabularkCanvasPaintRecords,
      };
    });
    expect(paint.records.some((record) => (
      record.operation === "fillRect"
      && Math.abs(record.alpha - 0.28) < 0.001
      && record.fillStyle === paint.highlight
    ))).toBe(true);
    expect(paint.records.some((record) => (
      record.operation === "strokeRect"
      && record.lineWidth === 2
      && record.dash.join(",") === "4,2"
      && record.strokeStyle === paint.highlight
    ))).toBe(true);
    expect(paint.records.some((record) => (
      record.operation === "strokeRect"
      && record.lineWidth === 3
      && record.dash.length === 0
      && record.strokeStyle === paint.canvasText
    ))).toBe(true);

    const separator = view.getByRole("separator").first();
    await separator.focus();
    await separator.evaluate((element) => {
      globalThis.__tabularkForcedResizeHandle = element;
    });
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", String(before + 8));
    await expect.poll(() => page.evaluate(() => (
      document.activeElement === globalThis.__tabularkForcedResizeHandle
    ))).toBe(true);
    await expect(separator).toHaveCSS("outline-style", "solid");
    await expect.poll(async () => Number.parseFloat(
      await separator.evaluate((element) => getComputedStyle(element).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    const lineColor = await separator.locator("[data-tabulark-resize-line]").evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(lineColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("keeps a forced-colors parse error textual, retryable, and visibly focused", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/examples/csv-preview/");
    await page.getByTestId("source-input").setInputFiles({
      name: "ragged.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("left,right\nonly-left\n"),
    });
    const options = page.getByTestId("advanced-options");
    if (await options.getAttribute("open") === null) {
      await options.locator("summary").click();
    }
    await page.getByTestId("parse-mode").selectOption("strict");
    await page.getByTestId("open-button").click();

    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "error", {
      timeout: 15_000,
    });
    const status = page.getByTestId("status");
    await expect(status).toContainText("PARSE_FAILED");
    await expect(page.getByTestId("retry-button")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("status");
    await expect(status).toHaveCSS("outline-style", "solid");
    await expect.poll(async () => Number.parseFloat(
      await status.evaluate((element) => getComputedStyle(element).outlineWidth),
    )).toBeGreaterThanOrEqual(3);
  });
});
