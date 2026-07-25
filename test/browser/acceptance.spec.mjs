import { expect, test } from "@playwright/test";

test("opens a tab-separated File using the TSV default delimiter", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const engine = await createEngine({ adapters: [delimitedAdapter] });
    let dataset;
    let table;
    try {
      dataset = await engine.open(
        new File(["name\tnote\tactive\nAda\t\"red\tteam\"\tyes\nGrace\tblue,no\t\n"], "sample.tsv", {
          type: "text/tab-separated-values",
        }),
        { adapter: delimitedAdapter, adapterOptions: { dialect: "tsv", header: "first-row", mode: "strict" } },
      );
      table = await dataset.openTable(dataset.tables[0].id);
      const batch = await table.readRange({
        rowStart: 0,
        rowCount: 2,
        columnStart: 0,
        columnCount: 3,
      });
      return {
        columns: table.metadata.schema.columns.map((column) => column.name),
        rows: batch.toRows(),
      };
    } finally {
      await table?.close();
      await dataset?.close();
      await engine.close();
    }
  });

  expect(result).toEqual({
    columns: ["name", "note", "active"],
    rows: [
      ["Ada", "red\tteam", "yes"],
      ["Grace", "blue,no", ""],
    ],
  });
});

test("can explicitly transfer an ArrayBuffer source to the Worker and returns its table", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const engine = await createEngine({ adapters: [delimitedAdapter] });
    let dataset;
    let table;
    try {
      const source = new TextEncoder().encode("name,score\nAda,10\n").buffer;
      const bytesBeforeOpen = source.byteLength;
      dataset = await engine.open(source, {
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
        transferInput: true,
      });
      const bytesAfterOpen = source.byteLength;
      table = await dataset.openTable(dataset.tables[0].id);
      const batch = await table.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 2,
      });
      return { bytesBeforeOpen, bytesAfterOpen, rows: batch.toRows() };
    } finally {
      await table?.close();
      await dataset?.close();
      await engine.close();
    }
  });

  expect(result.bytesBeforeOpen).toBeGreaterThan(0);
  expect(result.bytesAfterOpen).toBe(0);
  expect(result.rows).toEqual([["Ada", "10"]]);
});

test("treats the first row as data with header none and honors a custom delimiter", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const engine = await createEngine({ adapters: [delimitedAdapter] });
    let dataset;
    let table;
    try {
      dataset = await engine.open(new Blob(["alpha|beta\none|two\n"]), {
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "none", delimiter: "|", mode: "strict" },
      });
      table = await dataset.openTable(dataset.tables[0].id);
      const batch = await table.readRange({
        rowStart: 0,
        rowCount: 2,
        columnStart: 0,
        columnCount: 2,
      });
      return {
        columns: table.metadata.schema.columns.map((column) => column.name),
        rowCount: table.metadata.extent.rows.value,
        rows: batch.toRows(),
      };
    } finally {
      await table?.close();
      await dataset?.close();
      await engine.close();
    }
  });

  expect(result).toEqual({
    columns: ["column_1", "column_2"],
    rowCount: 2,
    rows: [
      ["alpha", "beta"],
      ["one", "two"],
    ],
  });
});

test("reports malformed delimited input as a strict parse failure", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const failure = await page.evaluate(async () => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const engine = await createEngine({ adapters: [delimitedAdapter] });
    try {
      await engine.open(new Blob(["left,right\nonly-left\n"]), {
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
      });
      return { code: "RESOLVED" };
    } catch (error) {
      return {
        code: error?.code ?? error?.name ?? "UNKNOWN",
        details: error?.details ?? null,
        message: error?.message ?? String(error),
      };
    } finally {
      await engine.close();
    }
  });

  expect(failure.code).toBe("PARSE_FAILED");
  expect(failure.details).toMatchObject({ kind: "ragged-row", row: 0 });
  expect(failure.message).toContain("row has 1 fields");
});

test("keeps the Canvas, horizontal scroll host, and bounded ARIA viewport in sync", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  await page.evaluate(async () => {
    const { createCanvasTableView, createEngine, delimitedAdapter } = await import("/dist/index.js");
    const host = document.createElement("div");
    host.id = "wide-table-host";
    Object.assign(host.style, { height: "220px", width: "420px" });
    document.body.replaceChildren(host);

    const engine = await createEngine({ adapters: [delimitedAdapter] });
    const headers = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`).join(",");
    const values = Array.from({ length: 12 }, (_, index) => `Value ${index + 1}`).join(",");
    const dataset = await engine.open(new Blob([`${headers}\n${values}\n`]), {
      adapter: delimitedAdapter,
      adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    const view = createCanvasTableView({ container: host, table });
    view.focus();

    window.__tabularkBrowserAcceptanceCleanup = async () => {
      view.destroy();
      await table.close();
      await dataset.close();
      await engine.close();
    };
  });

  const view = page.locator("[data-tabulark-view]");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  const scroller = view.locator("[data-tabulark-scroll]");
  const canvas = view.locator("[data-tabulark-canvas]");
  const status = page.locator("[data-tabulark-status]");

  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(grid).toHaveAttribute("aria-colcount", "12");
  await expect(status).toHaveText("1 rows and 12 columns.");
  await expect(grid).toHaveAttribute("aria-activedescendant", /-r0-c0$/);

  const initialHeaderIndexes = await grid.locator('[role="columnheader"]').evaluateAll((headers) =>
    headers.map((header) => Number(header.getAttribute("aria-colindex"))),
  );
  expect(initialHeaderIndexes[0]).toBe(1);
  expect(initialHeaderIndexes.at(-1)).toBeLessThan(12);
  const beforeScroll = await canvas.screenshot();

  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    element.dispatchEvent(new Event("scroll"));
  });

  await expect
    .poll(async () => {
      const indexes = await grid.locator('[role="columnheader"]').evaluateAll((headers) =>
        headers.map((header) => Number(header.getAttribute("aria-colindex"))),
      );
      return indexes.at(-1);
    })
    .toBe(12);

  const visibleHeaderIndexes = await grid.locator('[role="columnheader"]').evaluateAll((headers) =>
    headers.map((header) => Number(header.getAttribute("aria-colindex"))),
  );
  const visibleCellIndexes = await grid.locator('[role="gridcell"]').evaluateAll((cells) =>
    cells.map((cell) => Number(cell.getAttribute("aria-colindex"))),
  );

  expect(visibleHeaderIndexes[0]).toBeGreaterThan(1);
  expect(visibleHeaderIndexes.at(-1)).toBe(12);
  expect(visibleCellIndexes).toEqual(visibleHeaderIndexes);
  await expect(grid.getByRole("columnheader", { name: "Column 12" })).toHaveAttribute(
    "aria-colindex",
    "12",
  );
  await expect(grid.getByRole("gridcell", { name: "Value 12" })).toHaveAttribute(
    "aria-colindex",
    "12",
  );
  await expect(grid).not.toHaveAttribute("aria-activedescendant", /.+/);

  const afterScroll = await canvas.screenshot();
  expect(afterScroll.equals(beforeScroll)).toBe(false);
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await grid.focus();
  await page.keyboard.press("End");
  await expect(grid).toHaveAttribute("aria-activedescendant", /-r0-c11$/);
  await expect(status).toHaveText("1 rows and 12 columns.");

  await page.evaluate(async () => {
    await window.__tabularkBrowserAcceptanceCleanup?.();
    delete window.__tabularkBrowserAcceptanceCleanup;
  });
});
