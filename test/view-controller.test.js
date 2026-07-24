import assert from "node:assert/strict";
import test from "node:test";

import {
  createScrollAxis,
  createTableController,
  createTableLayout,
  logicalToPhysicalOffset,
  physicalToLogicalOffset,
} from "../dist/index.js";

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
  for (const request of table.calls) {
    assert.ok(request.rowCount < 40);
    assert.ok(request.columnCount < 8);
  }
  assert.deepEqual(controller.getCell(0, 0), { status: "loaded", value: "R0C0" });

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
  valueAt = (rowIndex, columnIndex) => `R${rowIndex}C${columnIndex}`,
}) {
  const calls = [];
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
        logicalType: "utf8",
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
    async readRange(request) {
      calls.push({ ...request });
      const delay = delayFor(request);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
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

function createBatch(metadata, request, valueAt) {
  return Object.freeze({
    tableId: metadata.tableId,
    revision: metadata.revision,
    schemaVersion: metadata.schema.version,
    range: Object.freeze({ ...request }),
    columns: Object.freeze([]),
    complete: true,
    byteLength: 0,
    toRows() {
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
