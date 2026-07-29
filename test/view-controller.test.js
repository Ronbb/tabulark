import assert from "node:assert/strict";
import test from "node:test";

import {
  axisPosition,
  axisSize,
  cellRect,
  createScrollAxis,
  createTableController,
  createTableLayout,
  hitTest,
  logicalToPhysicalOffset,
  physicalToLogicalOffset,
} from "../dist/experimental.js";

test("compresses extreme logical scroll space with reversible offsets", () => {
  const axis = createScrollAxis(2_000_000, 80, 4_960, 10_000);

  assert.equal(axis.compressed, true);
  assert.equal(axis.physicalContentSize, 10_000);
  assert.equal(physicalToLogicalOffset(axis, axis.physicalOffset), axis.logicalOffset);
  assert.equal(logicalToPhysicalOffset(axis, axis.logicalOffset), axis.physicalOffset);

  const table = createMockTable({ rows: 100_000, columns: 3 });
  const layout = createTableLayout(
    table.metadata,
    [100, 100, 100],
    { width: 240, height: 100, scrollLeft: 0, scrollTop: 9_920 },
    {
      rowHeight: 20,
      headerHeight: 20,
      rowHeaderWidth: 40,
      scrollPixelLimit: 10_000,
    },
  );

  assert.equal(layout.vertical.compressed, true);
  assert.equal(layout.spacerHeight, 10_020);
  assert.ok(layout.rows.visible.start > 99_000);
  assert.ok(layout.rows.overscan.end <= 100_000);
});

test("layout applies sparse worksheet sizes, hidden axes, and pinned geometry", () => {
  const table = createMockTable({ rows: 1_000_000, columns: 5 });
  const widths = [90, 80, 70, 60, 50];
  const layout = createTableLayout(
    table.metadata,
    widths,
    { width: 200, height: 140, scrollLeft: 80, scrollTop: 100 },
    {
      rowHeight: 20,
      headerHeight: 20,
      rowHeaderWidth: 40,
      rowEntries: [
        { index: 0, size: 32 },
        { index: 1, hidden: true },
        { index: 999_999, size: 40 },
      ],
      hiddenColumns: [false, true, false, false, false],
      frozenRows: 1,
      frozenColumns: 1,
      overscanRows: 0,
      overscanColumns: 0,
    },
  );

  assert.equal(layout.rowGeometry.overrides.length, 3);
  assert.equal(layout.rowGeometry.contentSize, 20_000_012);
  assert.equal(axisPosition(layout.rowGeometry, 2), 32);
  assert.equal(axisSize(layout.rowGeometry, 1), 0);
  assert.deepEqual(layout.effectiveColumnWidths, [90, 0, 70, 60, 50]);
  assert.equal(layout.visibleRows.some((row) => row.index === 1), false);
  assert.equal(layout.visibleColumns.some((column) => column.index === 1), false);

  const pinned = cellRect(layout, widths, 0, 0);
  assert.deepEqual(pinned, { x: 40, y: 20, width: 90, height: 32 });
  assert.deepEqual(hitTest(layout, 50, 30, widths, 0), {
    kind: "cell",
    rowIndex: 0,
    columnIndex: 0,
  });
});

test("controller requests only the viewport and overscan window", async () => {
  const table = createMockTable({ rows: 10_000, columns: 12 });
  const controller = createTableController(table);

  controller.updateViewport({
    width: 520,
    height: 260,
    scrollLeft: 0,
    scrollTop: 0,
    devicePixelRatio: 2,
  });
  await waitFor(() => controller.getSnapshot().status === "ready");

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.layout.rowCount, 10_000);
  assert.equal(snapshot.layout.columnCount, 12);
  assert.ok(snapshot.layout.rows.visible.end < 20);
  assert.ok(snapshot.layout.columns.visible.end < 5);
  assert.ok(table.calls.length >= 1);
  assert.ok(table.calls.length <= 2);
  assert.ok(table.readOptions.every(
    (options) => options[Symbol.for("tabulark.internal.display-only-read.v1")] === true,
  ));
  for (const request of table.calls) {
    assert.ok(request.rowCount < 40);
    assert.ok(request.columnCount < 8);
  }
  assert.deepEqual(controller.getCell(0, 0), { status: "loaded", value: "R0C0" });

  controller.dispose();
});

test("controller adaptively splits typed batches that exceed their byte budget", async () => {
  const table = createMockTable({
    rows: 10_000,
    columns: 3,
    errorFor(request) {
      return request.rowCount > 4 ? rangeByteLimitError() : undefined;
    },
  });
  const controller = createTableController(table);

  controller.updateViewport({ width: 520, height: 260, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  const initialLayout = controller.getSnapshot().layout;
  await waitFor(() => controller.getCell(
    initialLayout.rows.overscan.end - 1,
    initialLayout.columns.overscan.end - 1,
  ).status === "loaded");
  assert.ok(table.calls.some((request) => request.rowCount > 4));
  assert.deepEqual(controller.getCell(0, 0), { status: "loaded", value: "R0C0" });

  table.calls.length = 0;
  controller.updateViewport({ width: 520, height: 260, scrollLeft: 0, scrollTop: 5_600 });
  await waitFor(() => controller.getSnapshot().layout.rows.visible.start >= 190);
  const scrolledLayout = controller.getSnapshot().layout;
  await waitFor(() => controller.getCell(
    scrolledLayout.rows.overscan.end - 1,
    scrolledLayout.columns.overscan.end - 1,
  ).status === "loaded");

  assert.equal(controller.getSnapshot().status, "ready");
  assert.ok(table.calls.length > 0);
  assert.ok(table.calls.every((request) => request.rowCount <= 4));
  const visibleRow = scrolledLayout.rows.visible.start;
  assert.deepEqual(controller.getCell(visibleRow, 0), {
    status: "loaded",
    value: `R${visibleRow}C0`,
  });

  controller.dispose();
});

test("controller contains an irreducibly oversized cell to an explicit preview placeholder", async () => {
  const table = createMockTable({
    rows: 20,
    columns: 2,
    errorFor(request) {
      const containsFirstCell = request.rowStart === 0
        && request.rowCount > 0
        && request.columnStart === 0
        && request.columnCount > 0;
      return containsFirstCell ? rangeByteLimitError("compressed-pages") : undefined;
    },
  });
  const controller = createTableController(table);

  controller.updateViewport({ width: 400, height: 180, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  await waitFor(() => controller.getCell(0, 1).status === "loaded");

  assert.deepEqual(controller.getCell(0, 0), {
    status: "loaded",
    value: "[Value exceeds the preview byte limit]",
  });
  assert.deepEqual(controller.getCell(0, 1), { status: "loaded", value: "R0C1" });
  assert.deepEqual(controller.getCell(1, 0), { status: "loaded", value: "R1C0" });
  assert.equal(controller.getSnapshot().status, "ready");

  controller.dispose();
});

test("controller still surfaces resource failures that cannot be repaired by range sharding", async () => {
  const failure = rangeByteLimitError("decompression");
  const table = createMockTable({
    rows: 20,
    columns: 2,
    errorFor() {
      return failure;
    },
  });
  const controller = createTableController(table);

  controller.updateViewport({ width: 400, height: 180, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "error");

  assert.equal(controller.getSnapshot().error, failure);
  assert.equal(table.calls.length, 1);
  assert.deepEqual(controller.getCell(0, 0), { status: "unavailable" });
  controller.dispose();
});

test("controller reuses a loaded overscan window for nearby scrolling", async () => {
  const table = createMockTable({ rows: 10_000, columns: 12 });
  const controller = createTableController(table);

  controller.updateViewport({
    width: 520,
    height: 260,
    scrollLeft: 0,
    scrollTop: 0,
  });
  await waitFor(() => controller.getSnapshot().status === "ready");
  await waitFor(() => table.calls.length === 2);
  const callCount = table.calls.length;

  controller.updateViewport({
    width: 520,
    height: 260,
    scrollLeft: 0,
    scrollTop: 28,
  });
  await waitFor(() => controller.getSnapshot().status === "ready");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(table.calls.length, callCount);
  const visibleRow = controller.getSnapshot().layout.rows.visible.start;
  assert.deepEqual(controller.getCell(visibleRow, 0), {
    status: "loaded",
    value: `R${visibleRow}C0`,
  });

  controller.dispose();
});

test("controller drops responses from an older scroll generation", async () => {
  const table = createMockTable({
    rows: 10_000,
    columns: 4,
    delayFor(request) {
      return request.rowStart >= 80 && request.rowStart < 180 ? 80 : 0;
    },
  });
  const controller = createTableController(table);

  controller.updateViewport({ width: 420, height: 220, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  table.calls.length = 0;

  controller.updateViewport({ width: 420, height: 220, scrollLeft: 0, scrollTop: 2_800 });
  await waitFor(() => table.calls.some((request) => request.rowStart >= 80));
  controller.updateViewport({ width: 420, height: 220, scrollLeft: 0, scrollTop: 5_600 });

  await waitFor(() => {
    const snapshot = controller.getSnapshot();
    return snapshot.status === "ready" && snapshot.layout.rows.visible.start >= 190;
  });
  const settled = controller.getSnapshot();
  const settledGeneration = settled.generation;
  const visibleRow = settled.layout.rows.visible.start;
  assert.deepEqual(controller.getCell(visibleRow, 0), {
    status: "loaded",
    value: `R${visibleRow}C0`,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.getSnapshot().generation, settledGeneration);
  assert.equal(controller.getSnapshot().layout.rows.visible.start, visibleRow);
  assert.deepEqual(controller.getCell(visibleRow, 0), {
    status: "loaded",
    value: `R${visibleRow}C0`,
  });

  controller.dispose();
});

test("selection navigation copies escaped TSV without a DOM dependency", async () => {
  const values = [
    ["hello\tworld", "plain"],
    [null, "line\nbreak"],
  ];
  const table = createMockTable({
    rows: 2,
    columns: 2,
    valueAt(rowIndex, columnIndex) {
      return values[rowIndex]?.[columnIndex] ?? null;
    },
  });
  const controller = createTableController(table);

  controller.updateViewport({ width: 400, height: 180, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  controller.setActiveCell({ rowIndex: 0, columnIndex: 0 });
  controller.moveActive("right", { extendSelection: true });
  controller.moveActive("down", { extendSelection: true });

  assert.deepEqual(controller.getSnapshot().selection?.range, {
    rowStart: 0,
    rowEnd: 2,
    columnStart: 0,
    columnEnd: 2,
  });
  assert.equal(
    await controller.copySelection(),
    '"hello\tworld"\tplain\n\t"line\nbreak"',
  );

  controller.dispose();
});

test("keyboard navigation scrolls an offscreen active cell into view", async () => {
  const table = createMockTable({ rows: 100, columns: 3 });
  const controller = createTableController(table, {
    rowHeight: 20,
    headerHeight: 20,
    rowHeaderWidth: 40,
    columnWidth: 100,
    overscanRows: 0,
    overscanColumns: 0,
  });

  controller.updateViewport({ width: 240, height: 80, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  controller.setActiveCell({ rowIndex: 0, columnIndex: 0 });
  controller.moveActive("page-down");

  const snapshot = controller.getSnapshot();
  assert.deepEqual(snapshot.activeCell, { rowIndex: 3, columnIndex: 0 });
  assert.equal(snapshot.layout.vertical.logicalOffset, 20);
  assert.equal(snapshot.layout.vertical.physicalOffset, 20);
  controller.dispose();
});

test("spreadsheet presentation keeps hidden navigation and merged interaction coherent", async () => {
  const table = createMockTable({ rows: 100_000, columns: 20 });
  const controller = createTableController(table, {
    rowHeight: 20,
    headerHeight: 20,
    rowHeaderWidth: 40,
    columnWidth: 100,
    overscanRows: 2,
    overscanColumns: 1,
  });

  controller.updateViewport({ width: 700, height: 300, scrollLeft: 0, scrollTop: 0 });
  await waitFor(() => controller.getSnapshot().status === "ready");
  const previousGeneration = controller.getSnapshot().generation;
  controller.applySpreadsheetPresentation({
    kind: "spreadsheet-v1",
    tableId: table.metadata.tableId,
    revision: table.metadata.revision,
    visibility: "visible",
    frozenRows: 1,
    frozenColumns: 1,
    rows: [{ index: 0, size: 32 }, { index: 1, hidden: true }],
    columns: [{ index: 0, size: 120 }, { index: 1, hidden: true }],
    styles: [],
  });
  assert.equal(controller.getSnapshot().generation, previousGeneration + 1);
  await waitFor(() => controller.getSnapshot().status === "ready");

  const presented = controller.getSnapshot().layout;
  assert.equal(controller.columnWidths[0], 120);
  assert.equal(presented.effectiveColumnWidths[1], 0);
  assert.equal(axisSize(presented.rowGeometry, 0), 32);
  assert.equal(axisSize(presented.rowGeometry, 1), 0);

  controller.setActiveCell({ rowIndex: 0, columnIndex: 0 }, { scrollIntoView: false });
  controller.moveActive("right", { scrollIntoView: false });
  assert.deepEqual(controller.getSnapshot().activeCell, { rowIndex: 0, columnIndex: 2 });
  controller.moveActive("down", { scrollIntoView: false });
  assert.deepEqual(controller.getSnapshot().activeCell, { rowIndex: 2, columnIndex: 2 });

  controller.setMergedCells([{
    rowStart: 2,
    rowEnd: 4,
    columnStart: 2,
    columnEnd: 4,
  }]);
  controller.setActiveCell({ rowIndex: 3, columnIndex: 3 }, { scrollIntoView: false });
  assert.deepEqual(controller.getSnapshot().activeCell, { rowIndex: 2, columnIndex: 2 });
  assert.deepEqual(controller.getSnapshot().selection?.range, {
    rowStart: 2,
    rowEnd: 4,
    columnStart: 2,
    columnEnd: 4,
  });
  const covered = controller.cellRect({ rowIndex: 3, columnIndex: 3 });
  assert.deepEqual(
    controller.hitTest(covered.x + covered.width / 2, covered.y + covered.height / 2, 0),
    { kind: "cell", rowIndex: 2, columnIndex: 2 },
  );
  controller.moveActive("right", { scrollIntoView: false });
  assert.deepEqual(controller.getSnapshot().activeCell, { rowIndex: 2, columnIndex: 4 });

  table.calls.length = 0;
  controller.updateViewport({ width: 420, height: 180, scrollLeft: 1_000, scrollTop: 8_000 });
  await waitFor(() => table.calls.some((request) => request.rowStart > 200));
  await waitFor(() => controller.getSnapshot().status === "ready");
  assert.ok(table.calls.some((request) => request.rowStart === 0));
  assert.ok(table.calls.length <= 8);
  for (const request of table.calls) {
    assert.ok(request.rowCount < 40);
    assert.ok(request.columnCount < 8);
  }
  assert.deepEqual(
    controller.cellRect({ rowIndex: 0, columnIndex: 0 }),
    { x: 40, y: 20, width: 120, height: 32 },
  );

  controller.dispose();
});

test("intersecting merges load offscreen anchors and hit-test across frozen panes", async () => {
  const table = createMockTable({ rows: 1_000, columns: 20 });
  const controller = createTableController(table, {
    rowHeight: 20,
    headerHeight: 20,
    rowHeaderWidth: 40,
    columnWidth: 80,
    overscanRows: 0,
    overscanColumns: 0,
  });
  controller.applySpreadsheetPresentation({
    kind: "spreadsheet-v1",
    tableId: table.metadata.tableId,
    revision: table.metadata.revision,
    visibility: "visible",
    frozenRows: 1,
    frozenColumns: 1,
    rows: [],
    columns: [],
    styles: [],
  });
  controller.updateViewport({ width: 400, height: 180, scrollLeft: 160, scrollTop: 4_000 });
  await waitFor(() => controller.getSnapshot().status === "ready");

  table.calls.length = 0;
  controller.setMergedCells([{
    rowStart: 10,
    rowEnd: 500,
    columnStart: 2,
    columnEnd: 18,
  }]);
  await waitFor(() => controller.getSnapshot().status === "ready");
  assert.ok(table.calls.some((request) => (
    request.rowStart === 10
    && request.rowCount === 1
    && request.columnStart === 2
    && request.columnCount === 1
  )));
  assert.deepEqual(controller.getCell(10, 2), { status: "loaded", value: "R10C2" });

  controller.updateViewport({ width: 400, height: 180, scrollLeft: 80, scrollTop: 20 });
  controller.setMergedCells([{
    rowStart: 0,
    rowEnd: 3,
    columnStart: 0,
    columnEnd: 3,
  }]);
  await waitFor(() => controller.getSnapshot().status === "ready");
  for (const cell of [
    { rowIndex: 0, columnIndex: 0 },
    { rowIndex: 0, columnIndex: 2 },
    { rowIndex: 2, columnIndex: 0 },
    { rowIndex: 2, columnIndex: 2 },
  ]) {
    const rect = controller.cellRect(cell);
    assert.deepEqual(
      controller.hitTest(rect.x + rect.width / 2, rect.y + rect.height / 2, 0),
      { kind: "cell", rowIndex: 0, columnIndex: 0 },
    );
  }
  controller.dispose();
});

test("column resizing exposes its limits and keeps a focused boundary visible", () => {
  const table = createMockTable({ rows: 0, columns: 4 });
  const controller = createTableController(table, {
    columnWidth: 120,
    minColumnWidth: 72,
    maxColumnWidth: 192,
    rowHeaderWidth: 40,
    scrollPixelLimit: 300,
  });

  assert.equal(controller.minColumnWidth, 72);
  assert.equal(controller.maxColumnWidth, 192);
  controller.resizeColumn(0, 40);
  assert.equal(controller.columnWidths[0], 72);
  controller.resizeColumn(0, 240);
  assert.equal(controller.columnWidths[0], 192);
  controller.autosizeColumn(1, 500);
  assert.equal(controller.columnWidths[1], 192);
  assert.throws(() => controller.resizeColumn(0, Number.POSITIVE_INFINITY), /finite/);

  controller.updateViewport({ width: 220, height: 100, scrollLeft: 0, scrollTop: 0 });
  controller.ensureColumnVisible(3);
  const layout = controller.getSnapshot().layout;
  assert.equal(layout.horizontal.compressed, true);
  assert.ok(layout.horizontal.logicalOffset > 0);
  assert.ok(layout.visibleColumns.some((column) => column.index === 3));

  controller.dispose();
});

function createMockTable({
  rows,
  columns,
  delayFor = () => 0,
  errorFor = () => undefined,
  valueAt = (rowIndex, columnIndex) => `R${rowIndex}C${columnIndex}`,
}) {
  const calls = [];
  const readOptions = [];
  const listeners = new Set();
  const metadata = Object.freeze({
    tableId: "mock-table",
    name: "Mock",
    revision: 1,
    extent: Object.freeze({
      rows: Object.freeze({ kind: "exact", value: rows }),
      columns: Object.freeze({ kind: "exact", value: columns }),
    }),
    schema: Object.freeze({
      version: 1,
      columns: Object.freeze(Array.from({ length: columns }, (_, index) => Object.freeze({
        id: `column-${index}`,
        name: `Column ${index + 1}`,
        index,
        dataType: { type: "utf8" },
        nullable: true,
      }))),
    }),
    capabilities: Object.freeze({
      randomAccess: "full",
      typedValues: false,
      search: false,
      sort: false,
      filter: false,
      multiTable: false,
    }),
  });

  return {
    metadata,
    calls,
    readOptions,
    async readRange(request, options = {}) {
      calls.push({ ...request });
      readOptions.push(options);
      const delay = delayFor(request);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const error = errorFor(request);
      if (error !== undefined) {
        throw error;
      }
      return createBatch(metadata, request, valueAt);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      for (const listener of listeners) {
        listener({ type: "closed" });
      }
      listeners.clear();
    },
  };
}

function rangeByteLimitError(resource = "typed-batch-output") {
  return Object.assign(new Error(`${resource} exceeds the configured byte limit`), {
    code: "RESOURCE_LIMIT",
    details: Object.freeze({ resource, requiredBytes: 2, availableBytes: 1 }),
  });
}

function createBatch(metadata, request, valueAt) {
  return Object.freeze({
    tableId: metadata.tableId,
    revision: metadata.revision,
    schemaVersion: metadata.schema.version,
    range: Object.freeze({ ...request }),
    columns: Object.freeze([]),
    complete: true,
    byteLength: 0,
    toDisplayRows() {
      return Array.from({ length: request.rowCount }, (_, rowOffset) =>
        Array.from({ length: request.columnCount }, (_, columnOffset) =>
          valueAt(request.rowStart + rowOffset, request.columnStart + columnOffset),
        ),
      );
    },
  });
}

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for controller state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
