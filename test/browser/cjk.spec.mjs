import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const corpusRoot = new URL("../fixtures/csv/v1/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", corpusRoot), "utf8"));
const cjkCase = manifest.cases.find(({ id }) => id === "tsv-cjk-crlf-bom");

if (cjkCase === undefined || cjkCase.expect.status !== "success") {
  throw new Error("The CJK browser regression requires the tsv-cjk-crlf-bom success fixture");
}

const fixtureText = await readFile(new URL(cjkCase.file, corpusRoot), "utf8");
const expectedColumns = cjkCase.expect.metadata.columns;
const expectedRows = cjkCase.expect.rows;
const expectedPaintedText = [...expectedColumns, ...expectedRows.flat()];
const expectedClipboardText = expectedRows
  .map((row) => row.map((value) => value ?? "").join("\t"))
  .join("\n");
const expectedSemanticRows = [
  {
    rowIndex: 1,
    cells: expectedColumns.map((text, index) => ({
      role: "columnheader",
      columnIndex: index + 1,
      text,
    })),
  },
  ...expectedRows.map((row, rowIndex) => ({
    rowIndex: rowIndex + 2,
    cells: row.map((text, columnIndex) => ({
      role: "gridcell",
      columnIndex: columnIndex + 1,
      text: text ?? "Empty",
    })),
  })),
];

test("preserves CJK text from BOM/CRLF TSV through Canvas and clipboard", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/test/browser/harness.html");

  const opened = await page.evaluate(
    async ({ fixtureCase, sourceText }) => {
      const contextPrototype = CanvasRenderingContext2D.prototype;
      const originalFillText = contextPrototype.fillText;
      const originalMeasureText = contextPrototype.measureText;
      const paintCalls = [];
      const measureCalls = [];
      contextPrototype.fillText = function (...arguments_) {
        paintCalls.push({ canvas: this.canvas, text: String(arguments_[0]) });
        return originalFillText.apply(this, arguments_);
      };
      contextPrototype.measureText = function (text) {
        measureCalls.push({ canvas: this.canvas, text: String(text) });
        return originalMeasureText.call(this, text);
      };

      const normalizedText = sourceText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let transformedText = fixtureCase.source?.lineEndings === "crlf"
        ? normalizedText.replaceAll("\n", "\r\n")
        : normalizedText;
      if (fixtureCase.source?.stripFinalNewline) {
        if (transformedText.endsWith("\r\n")) {
          transformedText = transformedText.slice(0, -2);
        } else if (transformedText.endsWith("\n") || transformedText.endsWith("\r")) {
          transformedText = transformedText.slice(0, -1);
        } else {
          throw new Error(`${fixtureCase.file} must end with a newline before stripping it`);
        }
      }
      if (fixtureCase.source?.utf8Bom) {
        transformedText = `\uFEFF${transformedText}`;
      }
      const bytes = new TextEncoder().encode(transformedText);

      const { createCanvasTableView, createEngine } = await import("/dist/index.js");
      const host = document.createElement("div");
      Object.assign(host.style, { height: "260px", width: "760px" });
      document.body.replaceChildren(host);

      const engine = await createEngine();
      const dataset = await engine.open(
        new File([bytes], fixtureCase.file, {
          type: fixtureCase.options.format === "tsv" ? "text/tab-separated-values" : "text/csv",
        }),
        {
          format: fixtureCase.options.format,
          header: fixtureCase.options.header ? "first-row" : "none",
          mode: fixtureCase.options.mode,
        },
      );
      const table = await dataset.openTable(dataset.tables[0].id);
      const batch = await table.readRange({
        rowStart: 0,
        rowCount: fixtureCase.expect.metadata.rows,
        columnStart: 0,
        columnCount: fixtureCase.expect.metadata.columns.length,
      });
      const view = createCanvasTableView({ container: host, table });
      view.focus();

      window.__tabularkCjkCanvas = view.element.querySelector("[data-tabulark-canvas]");
      window.__tabularkCjkPaintCalls = paintCalls;
      window.__tabularkCjkMeasureCalls = measureCalls;
      window.__tabularkCjkCleanup = async () => {
        contextPrototype.fillText = originalFillText;
        contextPrototype.measureText = originalMeasureText;
        view.destroy();
        try {
          await table.close();
        } finally {
          try {
            await dataset.close();
          } finally {
            await engine.close();
          }
        }
      };

      return {
        columns: table.metadata.schema.columns.map((column) => column.name),
        rows: batch.toRows(),
        startsWithUtf8Bom:
          bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
        usesOnlyCrlf:
          transformedText.includes("\r\n") &&
          !transformedText.replaceAll("\r\n", "").includes("\n"),
      };
    },
    { fixtureCase: cjkCase, sourceText: fixtureText },
  );

  try {
    expect(opened).toEqual({
      columns: expectedColumns,
      rows: expectedRows,
      startsWithUtf8Bom: true,
      usesOnlyCrlf: true,
    });

    const view = page.locator("[data-tabulark-view]");
    const canvas = view.locator("[data-tabulark-canvas]");
    const grid = view.locator("[data-tabulark-a11y-grid]");
    await expect(canvas).toBeVisible();
    await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
    await expect(grid).toHaveAttribute("aria-colcount", String(expectedColumns.length));
    await expect(grid).toHaveAttribute("aria-rowcount", String(expectedRows.length + 1));

    const semanticRows = await grid.locator('[role="row"]').evaluateAll((rows) =>
      rows.map((row) => ({
        rowIndex: Number(row.getAttribute("aria-rowindex")),
        cells: [...row.children].map((cell) => ({
          role: cell.getAttribute("role"),
          columnIndex: Number(cell.getAttribute("aria-colindex")),
          text: cell.textContent ?? "",
        })),
      })),
    );
    expect(semanticRows).toEqual(expectedSemanticRows);

    await expect
      .poll(() => page.evaluate(() =>
        (window.__tabularkCjkPaintCalls ?? [])
          .filter(({ canvas: receiver }) => receiver === window.__tabularkCjkCanvas)
          .map(({ text }) => text),
      ))
      .toEqual(expect.arrayContaining(expectedPaintedText));
    const paintedText = await page.evaluate(() =>
      (window.__tabularkCjkPaintCalls ?? [])
        .filter(({ canvas: receiver }) => receiver === window.__tabularkCjkCanvas)
        .map(({ text }) => text),
    );
    expect(paintedText.join("")).not.toContain("\uFFFD");
    expect(await grid.textContent()).not.toContain("\uFFFD");

    const resizeHandles = view.locator("[data-column-resize]");
    await expect(resizeHandles).toHaveCount(expectedColumns.length);
    for (let index = 0; index < expectedColumns.length; index += 1) {
      await resizeHandles.nth(index).dblclick();
    }
    await expect
      .poll(() => page.evaluate(() =>
        (window.__tabularkCjkMeasureCalls ?? [])
          .filter(({ canvas: receiver }) => receiver === window.__tabularkCjkCanvas)
          .map(({ text }) => text),
      ))
      .toEqual(expect.arrayContaining(expectedPaintedText));

    await grid.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(grid).toHaveAttribute("aria-activedescendant", /-r1-c2$/);
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(6);

    await page.keyboard.press("Control+C");
    await expect
      .poll(async () =>
        (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
      )
      .toBe(expectedClipboardText);
    await expect(view.locator("[data-tabulark-status]")).toHaveText(
      "Selection copied to clipboard.",
    );
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(async () => {
        await window.__tabularkCjkCleanup?.();
        delete window.__tabularkCjkCleanup;
        delete window.__tabularkCjkCanvas;
        delete window.__tabularkCjkPaintCalls;
        delete window.__tabularkCjkMeasureCalls;
      });
    }
  }
});
