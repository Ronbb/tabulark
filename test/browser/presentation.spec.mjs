import { expect, test } from "@playwright/test";

test("Canvas auto presentation preserves geometry, styles, merges, and forced colors", async ({ page }) => {
  await page.addInitScript(() => {
    const log = [];
    Object.defineProperty(globalThis, "__tabularkPaintLog", {
      configurable: true,
      value: log,
    });
    const prototype = CanvasRenderingContext2D.prototype;
    for (const name of ["fillRect", "fillText", "stroke", "strokeRect"]) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        log.push({
          kind: name,
          text: name === "fillText" ? String(args[0]) : undefined,
          fillStyle: String(this.fillStyle),
          strokeStyle: String(this.strokeStyle),
          font: this.font,
          textAlign: this.textAlign,
          textBaseline: this.textBaseline,
        });
        return original.apply(this, args);
      };
    }
  });
  await page.goto("/test/browser/harness.html");

  await page.evaluate(async () => {
    const { createCanvasTableView } = await import("/dist/index.js");
    const columns = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      name: `Column ${index + 1}`,
      index,
      dataType: { type: "utf8" },
      nullable: true,
    }));
    const metadata = {
      tableId: "presentation-table",
      name: "Presentation sample",
      revision: 1,
      extent: {
        rows: { kind: "exact", value: 100 },
        columns: { kind: "exact", value: columns.length },
      },
      schema: { version: 1, columns },
      capabilities: {
        randomAccess: "full",
        typedValues: false,
        search: false,
        sort: false,
        filter: false,
        multiTable: false,
      },
    };
    const presentation = {
      kind: "spreadsheet-v1",
      tableId: metadata.tableId,
      revision: metadata.revision,
      visibility: "visible",
      frozenRows: 1,
      frozenColumns: 1,
      rows: [{ index: 0, size: 40 }, { index: 1, hidden: true }],
      columns: [{ index: 0, size: 120 }, { index: 1, hidden: true }],
      styles: [{
        numberFormat: "0.00",
        font: {
          family: "serif",
          size: 17,
          bold: true,
          italic: true,
          underline: true,
          color: { css: "#123456" },
        },
        fillColor: { css: "#abcdef" },
        borders: {
          bottom: { style: "thick", color: { css: "#654321" } },
        },
        horizontalAlignment: "center",
        verticalAlignment: "bottom",
      }],
    };
    const merge = { rowStart: 2, rowEnd: 4, columnStart: 2, columnEnd: 4 };
    const listeners = new Set();
    const calls = { getPresentation: 0, presentationRanges: [], errors: [] };
    const table = {
      metadata,
      async getPresentation() {
        calls.getPresentation += 1;
        return presentation;
      },
      async readPresentationRange(request) {
        calls.presentationRanges.push({ ...request });
        const rowEnd = request.rowStart + request.rowCount;
        const columnEnd = request.columnStart + request.columnCount;
        const intersectsMerge = request.rowStart < merge.rowEnd
          && rowEnd > merge.rowStart
          && request.columnStart < merge.columnEnd
          && columnEnd > merge.columnStart;
        return {
          kind: "spreadsheet-v1",
          tableId: metadata.tableId,
          revision: metadata.revision,
          range: { ...request },
          styleIds: Array.from({ length: request.rowCount }, (_, rowOffset) => (
            Array.from({ length: request.columnCount }, (_, columnOffset) => (
              request.rowStart + rowOffset === 0 && request.columnStart + columnOffset === 0
                ? 0
                : null
            ))
          )),
          mergedCells: intersectsMerge ? [merge] : [],
          rows: presentation.rows.filter((entry) => (
            entry.index >= request.rowStart && entry.index < rowEnd
          )),
          columns: presentation.columns.filter((entry) => (
            entry.index >= request.columnStart && entry.index < columnEnd
          )),
        };
      },
      async readRange(request) {
        return {
          tableId: metadata.tableId,
          revision: metadata.revision,
          schemaVersion: metadata.schema.version,
          range: { ...request },
          columns: [],
          complete: true,
          byteLength: 0,
          toDisplayRows() {
            return Array.from({ length: request.rowCount }, (_, rowOffset) => (
              Array.from({ length: request.columnCount }, (_, columnOffset) => (
                `R${request.rowStart + rowOffset}C${request.columnStart + columnOffset}`
              ))
            ));
          },
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {},
    };

    const host = document.createElement("div");
    host.id = "presentation-host";
    Object.assign(host.style, { height: "320px", width: "720px" });
    document.body.replaceChildren(host);
    const view = createCanvasTableView({
      container: host,
      table,
      onError: (error) => calls.errors.push(error?.message ?? String(error)),
    });

    const ignoredCalls = { getPresentation: 0, readPresentationRange: 0 };
    const ignoredHost = document.createElement("div");
    Object.assign(ignoredHost.style, {
      height: "160px",
      left: "-10000px",
      position: "absolute",
      width: "320px",
    });
    document.body.append(ignoredHost);
    const ignoredTable = {
      ...table,
      async getPresentation() {
        ignoredCalls.getPresentation += 1;
        return presentation;
      },
      async readPresentationRange(request) {
        ignoredCalls.readPresentationRange += 1;
        return table.readPresentationRange(request);
      },
    };
    const ignoredView = createCanvasTableView({
      container: ignoredHost,
      table: ignoredTable,
      presentation: "ignore",
    });

    globalThis.__tabularkPresentation = { calls, ignoredCalls, ignoredView, view };
  });

  const view = page.locator("#presentation-host [data-tabulark-view]");
  const grid = view.locator("[data-tabulark-a11y-grid]");
  await expect(view).toHaveAttribute("data-tabulark-presentation", "spreadsheet-v1");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => (
    globalThis.__tabularkPresentation.calls.presentationRanges.length
  ))).toBeGreaterThan(0);

  await expect(grid.locator('[role="columnheader"][aria-colindex="2"]')).toHaveCount(0);
  await expect(grid.locator('[role="row"][aria-rowindex="3"]')).toHaveCount(0);
  const mergeAnchor = grid.locator(
    '[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="3"]',
  );
  await expect(mergeAnchor).toHaveAttribute("aria-rowspan", "2");
  await expect(mergeAnchor).toHaveAttribute("aria-colspan", "2");
  await expect(
    grid.locator('[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="4"]'),
  ).toHaveCount(0);

  const interaction = await page.evaluate(() => {
    const controller = globalThis.__tabularkPresentation.view.controller;
    const covered = controller.cellRect({ rowIndex: 3, columnIndex: 3 });
    const hit = controller.hitTest(
      covered.x + covered.width / 2,
      covered.y + covered.height / 2,
      0,
    );
    controller.setActiveCell({ rowIndex: 3, columnIndex: 3 }, { scrollIntoView: false });
    return {
      hit,
      pinnedBefore: controller.cellRect({ rowIndex: 0, columnIndex: 0 }),
      selection: controller.getSnapshot().selection?.range,
    };
  });
  expect(interaction.hit).toEqual({ kind: "cell", rowIndex: 2, columnIndex: 2 });
  expect(interaction.pinnedBefore).toEqual({ x: 64, y: 36, width: 120, height: 40 });
  expect(interaction.selection).toEqual({
    rowStart: 2,
    rowEnd: 4,
    columnStart: 2,
    columnEnd: 4,
  });
  await expect(grid).toHaveAttribute("aria-activedescendant", /-r2-c2$/);

  const workbookColors = await page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d");
    const resolve = (value) => {
      context.fillStyle = value;
      return String(context.fillStyle);
    };
    return {
      fill: resolve("#abcdef"),
      foreground: resolve("#123456"),
      border: resolve("#654321"),
    };
  });
  const normalPaint = await page.evaluate(() => ({
    cell: globalThis.__tabularkPaintLog.filter(
      (entry) => entry.kind === "fillText" && entry.text === "R0C0",
    ).at(-1),
    records: globalThis.__tabularkPaintLog,
  }));
  expect(normalPaint.cell.fillStyle).toBe(workbookColors.foreground);
  expect(normalPaint.cell.font).toMatch(/italic/);
  expect(normalPaint.cell.font).toMatch(/17px/);
  expect(normalPaint.cell.textAlign).toBe("center");
  expect(normalPaint.cell.textBaseline).toBe("bottom");
  expect(normalPaint.records.some((entry) => entry.fillStyle === workbookColors.fill)).toBe(true);
  expect(normalPaint.records.some((entry) => entry.strokeStyle === workbookColors.border)).toBe(true);

  const scroller = view.locator("[data-tabulark-scroll]");
  await scroller.evaluate((element) => {
    element.scrollLeft = 300;
    element.scrollTop = 300;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.evaluate(() => (
    globalThis.__tabularkPresentation.view.controller.getSnapshot().layout.vertical.logicalOffset
  ))).toBeGreaterThan(0);
  const pinnedAfter = await page.evaluate(() => (
    globalThis.__tabularkPresentation.view.controller.cellRect({ rowIndex: 0, columnIndex: 0 })
  ));
  expect(pinnedAfter).toEqual(interaction.pinnedBefore);
  const presentationCalls = await page.evaluate(() => (
    globalThis.__tabularkPresentation.calls.presentationRanges
  ));
  expect(presentationCalls.some((request) => request.rowStart === 0)).toBe(true);
  expect(presentationCalls.some((request) => request.rowStart > 0)).toBe(true);
  expect(presentationCalls.every((request) => (
    request.rowCount * request.columnCount <= 100_000
  ))).toBe(true);

  await page.evaluate(() => {
    globalThis.__tabularkPaintLog.length = 0;
  });
  await page.emulateMedia({ forcedColors: "active" });
  await expect(view).toHaveAttribute("data-tabulark-forced-colors", "active");
  await expect.poll(() => page.evaluate(() => (
    globalThis.__tabularkPaintLog.some(
      (entry) => entry.kind === "fillText"
        && entry.text === "R0C0"
        && entry.font.includes("italic")
        && entry.font.includes("17px"),
    )
  ))).toBe(true);
  const forcedPaint = await page.evaluate(() => ({
    cell: globalThis.__tabularkPaintLog.findLast(
      (entry) => entry.kind === "fillText"
        && entry.text === "R0C0"
        && entry.font.includes("italic")
        && entry.font.includes("17px"),
    ),
    records: globalThis.__tabularkPaintLog,
  }));
  expect(forcedPaint.cell.font).toMatch(/italic/);
  expect(forcedPaint.cell.font).toMatch(/17px/);
  expect(forcedPaint.cell.textAlign).toBe("center");
  expect(forcedPaint.cell.textBaseline).toBe("bottom");
  expect(forcedPaint.records.some((entry) => (
    entry.fillStyle === workbookColors.fill
    || entry.fillStyle === workbookColors.foreground
    || entry.strokeStyle === workbookColors.border
  ))).toBe(false);

  const state = await page.evaluate(() => ({
    errors: globalThis.__tabularkPresentation.calls.errors,
    getPresentation: globalThis.__tabularkPresentation.calls.getPresentation,
    ignored: globalThis.__tabularkPresentation.ignoredCalls,
  }));
  expect(state.errors).toEqual([]);
  expect(state.getPresentation).toBe(1);
  expect(state.ignored).toEqual({ getPresentation: 0, readPresentationRange: 0 });
});

test("large merges retain offscreen anchors and clip across frozen panes", async ({ page }) => {
  await page.addInitScript(() => {
    const log = [];
    Object.defineProperty(globalThis, "__tabularkMergePaintLog", {
      configurable: true,
      value: log,
    });
    const prototype = CanvasRenderingContext2D.prototype;
    for (const name of ["clearRect", "fillText", "strokeRect"]) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        log.push({ kind: name, args: [...args] });
        return original.apply(this, args);
      };
    }
  });
  await page.goto("/test/browser/harness.html");

  await page.evaluate(async () => {
    const { createCanvasTableView } = await import("/dist/index.js");
    const columns = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      name: `Column ${index + 1}`,
      index,
      dataType: { type: "utf8" },
      nullable: true,
    }));
    const metadata = {
      tableId: "merge-boundary-table",
      name: "Merge boundary sample",
      revision: 1,
      extent: {
        rows: { kind: "exact", value: 1_000 },
        columns: { kind: "exact", value: columns.length },
      },
      schema: { version: 1, columns },
      capabilities: {
        randomAccess: "full",
        typedValues: false,
        search: false,
        sort: false,
        filter: false,
        multiTable: false,
      },
    };
    const merges = [
      { rowStart: 0, rowEnd: 3, columnStart: 0, columnEnd: 3 },
      { rowStart: 10, rowEnd: 700, columnStart: 2, columnEnd: 18 },
    ];
    const calls = { data: [], presentation: [], errors: [] };
    const table = {
      metadata,
      async getPresentation() {
        return {
          kind: "spreadsheet-v1",
          tableId: metadata.tableId,
          revision: metadata.revision,
          visibility: "visible",
          frozenRows: 1,
          frozenColumns: 1,
          rows: [],
          columns: [],
          styles: [],
        };
      },
      async readPresentationRange(request) {
        calls.presentation.push({ ...request });
        const rowEnd = request.rowStart + request.rowCount;
        const columnEnd = request.columnStart + request.columnCount;
        return {
          kind: "spreadsheet-v1",
          tableId: metadata.tableId,
          revision: metadata.revision,
          range: { ...request },
          styleIds: Array.from({ length: request.rowCount }, () => (
            Array.from({ length: request.columnCount }, () => null)
          )),
          mergedCells: merges.filter((merge) => (
            request.rowStart < merge.rowEnd
            && rowEnd > merge.rowStart
            && request.columnStart < merge.columnEnd
            && columnEnd > merge.columnStart
          )),
          rows: [],
          columns: [],
        };
      },
      async readRange(request) {
        calls.data.push({ ...request });
        return {
          tableId: metadata.tableId,
          revision: metadata.revision,
          schemaVersion: metadata.schema.version,
          range: { ...request },
          columns: [],
          complete: true,
          byteLength: 0,
          toDisplayRows() {
            return Array.from({ length: request.rowCount }, (_, rowOffset) => (
              Array.from({ length: request.columnCount }, (_, columnOffset) => {
                const row = request.rowStart + rowOffset;
                const column = request.columnStart + columnOffset;
                if (row === 0 && column === 0) return "CROSS";
                if (row === 10 && column === 2) return "ANCHOR";
                return `R${row}C${column}`;
              })
            ));
          },
        };
      },
      subscribe() {
        return () => {};
      },
      async close() {},
    };
    const host = document.createElement("div");
    host.id = "merge-boundary-host";
    Object.assign(host.style, { height: "180px", width: "400px" });
    document.body.replaceChildren(host);
    const view = createCanvasTableView({
      container: host,
      table,
      controllerOptions: {
        rowHeight: 20,
        headerHeight: 20,
        rowHeaderWidth: 40,
        columnWidth: 80,
        overscanRows: 0,
        overscanColumns: 0,
      },
      onError: (error) => calls.errors.push(error?.message ?? String(error)),
    });
    globalThis.__tabularkMergeBoundary = { calls, view };
  });

  const root = page.locator("#merge-boundary-host [data-tabulark-view]");
  const grid = root.locator("[data-tabulark-a11y-grid]");
  const scroller = root.locator("[data-tabulark-scroll]");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect(
    grid.locator('[role="row"][aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]'),
  ).toContainText("CROSS");

  await scroller.evaluate((element) => {
    element.scrollLeft = 80;
    element.scrollTop = 20;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.evaluate(() => {
    const layout = globalThis.__tabularkMergeBoundary.view.controller.getSnapshot().layout;
    return [layout.horizontal.logicalOffset, layout.vertical.logicalOffset];
  })).toEqual([80, 20]);
  await page.evaluate(() => {
    globalThis.__tabularkMergePaintLog.length = 0;
    globalThis.__tabularkMergeBoundary.view.controller.setActiveCell(
      { rowIndex: 0, columnIndex: 0 },
      { scrollIntoView: false },
    );
  });
  await expect.poll(() => page.evaluate(() => (
    globalThis.__tabularkMergePaintLog.some(
      (entry) => entry.kind === "fillText" && entry.args[0] === "CROSS",
    )
  ))).toBe(true);
  const paneState = await page.evaluate(() => {
    const { view } = globalThis.__tabularkMergeBoundary;
    const controller = view.controller;
    const hits = [
      { rowIndex: 0, columnIndex: 0 },
      { rowIndex: 0, columnIndex: 2 },
      { rowIndex: 2, columnIndex: 0 },
      { rowIndex: 2, columnIndex: 2 },
    ].map((cell) => {
      const rect = controller.cellRect(cell);
      return controller.hitTest(rect.x + rect.width / 2, rect.y + rect.height / 2, 0);
    });
    const log = globalThis.__tabularkMergePaintLog;
    const lastClear = log.findLastIndex((entry) => entry.kind === "clearRect");
    const frame = log.slice(lastClear + 1);
    return {
      hits,
      crossTextCount: frame.filter(
        (entry) => entry.kind === "fillText" && entry.args[0] === "CROSS",
      ).length,
      mergeRects: frame
        .filter((entry) => (
          entry.kind === "strokeRect"
          && Math.abs(entry.args[2] - 79) < 0.01
          && Math.abs(entry.args[3] - 19) < 0.01
        ))
        .map((entry) => entry.args.slice(0, 4)),
    };
  });
  expect(paneState.hits).toEqual(Array.from({ length: 4 }, () => ({
    kind: "cell",
    rowIndex: 0,
    columnIndex: 0,
  })));
  expect(paneState.crossTextCount).toBe(1);
  expect(paneState.mergeRects).toHaveLength(4);

  await scroller.evaluate((element) => {
    element.scrollLeft = 800;
    element.scrollTop = 8_000;
    element.dispatchEvent(new Event("scroll"));
  });
  const largeAnchor = grid.locator(
    '[role="row"][aria-rowindex="12"] [role="gridcell"][aria-colindex="3"]',
  );
  await expect(largeAnchor).toHaveAttribute("aria-rowspan", "690");
  await expect(largeAnchor).toHaveAttribute("aria-colspan", "16");
  await expect(largeAnchor).toContainText("ANCHOR");
  const largeState = await page.evaluate(() => {
    const { calls, view } = globalThis.__tabularkMergeBoundary;
    const controller = view.controller;
    // The first scrolled row/column sits underneath the frozen panes. Probe a
    // fully visible continuation cell instead of that intentionally clipped slot.
    const covered = controller.cellRect({ rowIndex: 402, columnIndex: 13 });
    return {
      dataAnchorLoaded: calls.data.some((request) => (
        request.rowStart === 10
        && request.rowCount === 1
        && request.columnStart === 2
        && request.columnCount === 1
      )),
      presentationAnchorLoaded: calls.presentation.some((request) => (
        request.rowStart === 10
        && request.rowCount === 1
        && request.columnStart === 2
        && request.columnCount === 1
      )),
      hit: controller.hitTest(
        covered.x + covered.width / 2,
        covered.y + covered.height / 2,
        0,
      ),
      errors: calls.errors,
    };
  });
  expect(largeState).toEqual({
    dataAnchorLoaded: true,
    presentationAnchorLoaded: true,
    hit: { kind: "cell", rowIndex: 10, columnIndex: 2 },
    errors: [],
  });
});
