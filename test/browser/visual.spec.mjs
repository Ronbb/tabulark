import { expect, test } from "@playwright/test";

const HARNESS_VIEWPORT = Object.freeze({ width: 800, height: 480 });
const HOST_SIZE = Object.freeze({ width: 640, height: 320 });
const COLUMN_COUNT = 12;
const COLUMN_WIDTHS = Object.freeze([
  96, 144, 112, 168, 80, 136, 104, 152, 88, 128, 160, 120,
]);

const LAYOUT_ONLY_THEME = Object.freeze({
  background: "#ffffff",
  foreground: "transparent",
  mutedForeground: "transparent",
  headerBackground: "#e2e8f0",
  headerForeground: "transparent",
  alternateRowBackground: "#f8fafc",
  gridLine: "#94a3b8",
  selectionBackground: "#b8e1e8",
  selectionBorder: "#0e7490",
  activeCellBorder: "#be123c",
  loadingBackground: "#cbd5e1",
  font: "13px sans-serif",
  headerFont: "600 13px sans-serif",
});

const STRICT_SCREENSHOT = Object.freeze({
  animations: "disabled",
  caret: "hide",
  maxDiffPixels: 0,
  scale: "css",
  threshold: 0,
});

test.use({
  colorScheme: "light",
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  viewport: HARNESS_VIEWPORT,
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await globalThis.__tabularkVisualCleanup?.();
    delete globalThis.__tabularkVisualCleanup;
  });
});

test("keeps Canvas layout pixels stable across ready, selection, and horizontal scroll", async ({
  page,
}) => {
  await page.goto("/test/browser/harness.html");

  await page.evaluate(
    async ({ columnCount, columnWidths, height, theme, width }) => {
      const { createCanvasTableView, createEngine } = await import("/dist/index.js");
      const host = document.createElement("div");
      host.id = "visual-table-host";
      Object.assign(host.style, {
        boxSizing: "border-box",
        height: `${height}px`,
        width: `${width}px`,
      });
      document.body.style.margin = "0";
      document.body.replaceChildren(host);

      const scrollbarStyle = document.createElement("style");
      scrollbarStyle.textContent = `
        [data-tabulark-scroll] {
          scrollbar-gutter: auto !important;
          scrollbar-width: none;
        }
        [data-tabulark-scroll]::-webkit-scrollbar {
          width: 0;
          height: 0;
        }
      `;
      document.head.append(scrollbarStyle);

      const headers = Array.from(
        { length: columnCount },
        (_, index) => `Column ${index + 1}`,
      );
      const rows = Array.from({ length: 8 }, (_, rowIndex) =>
        Array.from(
          { length: columnCount },
          (_, columnIndex) => `R${rowIndex + 1}C${columnIndex + 1}`,
        ).join(","),
      );

      const engine = await createEngine();
      const dataset = await engine.open(
        new Blob([[headers.join(","), ...rows].join("\n") + "\n"]),
        { format: "csv", header: "first-row", mode: "strict" },
      );
      const table = await dataset.openTable(dataset.tables[0].id);
      const widthsById = Object.fromEntries(
        table.metadata.schema.columns.map((column, index) => [column.id, columnWidths[index]]),
      );
      const view = createCanvasTableView({
        container: host,
        table,
        controllerOptions: {
          columnWidth: 120,
          columnWidths: widthsById,
          headerHeight: 40,
          overscanColumns: 0,
          overscanRows: 0,
          rowHeaderWidth: 48,
          rowHeight: 32,
        },
        maxDevicePixelRatio: 1,
        theme,
      });
      view.element.style.border = "0";
      view.element.style.borderRadius = "0";

      globalThis.__tabularkVisualCleanup = async () => {
        view.destroy();
        scrollbarStyle.remove();
        await table.close();
        await dataset.close();
        await engine.close();
      };
    },
    {
      columnCount: COLUMN_COUNT,
      columnWidths: COLUMN_WIDTHS,
      height: HOST_SIZE.height,
      theme: LAYOUT_ONLY_THEME,
      width: HOST_SIZE.width,
    },
  );

  const view = page.locator("[data-tabulark-view]");
  const canvas = view.locator("[data-tabulark-canvas]");
  const grid = view.locator("[data-tabulark-a11y-grid]");
  const scroller = view.locator("[data-tabulark-scroll]");

  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(grid).toContainText("R1C1");
  await expect(canvas).toHaveScreenshot("canvas-ready.png", STRICT_SCREENSHOT);

  await grid.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(grid).toHaveAttribute("aria-activedescendant", /-r1-c1$/);
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(2);
  await expect(canvas).toHaveScreenshot("canvas-keyboard-selection.png", STRICT_SCREENSHOT);

  await page.keyboard.press("Escape");
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(grid.getByRole("columnheader", { name: `Column ${COLUMN_COUNT}` })).toHaveAttribute(
    "aria-colindex",
    String(COLUMN_COUNT),
  );
  await expect(grid).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(canvas).toHaveScreenshot("canvas-horizontal-scroll.png", STRICT_SCREENSHOT);
});
