import type { TableHandle, TableEvent, Unsubscribe } from "../client.js";
import { TabularkError, closedError, invalidArgument } from "../errors.js";
import { MAX_RANGE_CELLS, type RangeRequest, type TableBatch } from "../model.js";
import {
  cellRect,
  columnOffsets,
  createTableLayout,
  extentValue,
  hitTest,
  logicalToPhysicalOffset,
  selectionRect,
  type LayoutOptions,
} from "./layout.js";
import { assertCellPosition, clampCell, createSelection, moveCell } from "./selection.js";
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_MAX_COLUMN_WIDTH,
  DEFAULT_MIN_COLUMN_WIDTH,
  type CellLoadState,
  type CellPosition,
  type GridRange,
  type HitTestResult,
  type MoveActiveCellOptions,
  type NavigationCommand,
  type PixelRect,
  type SetActiveCellOptions,
  type TableControllerOptions,
  type TableSelection,
  type TableViewSnapshot,
  type ViewportUpdate,
} from "./types.js";

const DEFAULT_MAX_WINDOW_CELLS = 100_000;

interface LoadedWindow {
  readonly range: Readonly<GridRange>;
  readonly rows: readonly (readonly (string | null)[])[];
}

interface NormalizedOptions extends LayoutOptions {
  readonly columnWidth: number;
  readonly minColumnWidth: number;
  readonly maxColumnWidth: number;
  readonly columnWidths: Readonly<Record<string, number>>;
  readonly maxWindowCells: number;
}

export interface TableViewController {
  readonly metadata: TableHandle["metadata"];
  readonly columnWidths: readonly number[];
  getSnapshot(): Readonly<TableViewSnapshot>;
  subscribe(listener: (snapshot: Readonly<TableViewSnapshot>) => void): Unsubscribe;
  updateViewport(viewport: ViewportUpdate): void;
  setActiveCell(cell: CellPosition, options?: SetActiveCellOptions): void;
  extendSelection(cell: CellPosition, options?: Omit<SetActiveCellOptions, "extendSelection">): void;
  setSelection(anchor: CellPosition, focus?: CellPosition): void;
  clearSelection(): void;
  moveActive(command: NavigationCommand, options?: MoveActiveCellOptions): void;
  ensureCellVisible(cell: CellPosition): void;
  resizeColumn(columnIndex: number, width: number): void;
  autosizeColumn(columnIndex: number, measuredWidth: number): void;
  hitTest(x: number, y: number, resizeHandleWidth?: number): HitTestResult;
  cellRect(cell: CellPosition): Readonly<PixelRect>;
  selectionRect(selection?: TableSelection | null): Readonly<PixelRect> | null;
  getCell(rowIndex: number, columnIndex: number): CellLoadState;
  copySelection(options?: { readonly signal?: AbortSignal }): Promise<string>;
  dispose(): void;
}

class Controller implements TableViewController {
  readonly #table: TableHandle;
  readonly #options: NormalizedOptions;
  readonly #listeners = new Set<(snapshot: Readonly<TableViewSnapshot>) => void>();
  readonly #unsubscribe: Unsubscribe;
  #viewport: Required<ViewportUpdate> = {
    width: 0,
    height: 0,
    scrollLeft: 0,
    scrollTop: 0,
    devicePixelRatio: 1,
  };
  #columnWidths: number[];
  #snapshot: Readonly<TableViewSnapshot>;
  #activeCell: Readonly<CellPosition> | null = null;
  #selection: Readonly<TableSelection> | null = null;
  #windows: readonly LoadedWindow[] = [];
  #loadingRanges: readonly Readonly<GridRange>[] = [];
  #requestAbort: AbortController | null = null;
  #generation = 0;
  #loadQueued = false;
  #disposed = false;
  #tableClosed = false;

  constructor(table: TableHandle, options: TableControllerOptions) {
    this.#table = table;
    this.#options = normalizeOptions(options);
    this.#columnWidths = initialColumnWidths(table.metadata, this.#options);
    const layout = createTableLayout(
      table.metadata,
      this.#columnWidths,
      this.#viewport,
      this.#options,
    );
    this.#snapshot = Object.freeze({
      generation: this.#generation,
      status: "loading",
      metadata: table.metadata,
      layout,
      activeCell: null,
      selection: null,
    });
    this.#unsubscribe = table.subscribe((event) => this.#handleTableEvent(event));
  }

  get metadata(): TableHandle["metadata"] {
    return this.#table.metadata;
  }

  get columnWidths(): readonly number[] {
    return Object.freeze([...this.#columnWidths]);
  }

  getSnapshot(): Readonly<TableViewSnapshot> {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: Readonly<TableViewSnapshot>) => void): Unsubscribe {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  updateViewport(viewport: ViewportUpdate): void {
    this.#assertOpen();
    const normalized = normalizeViewport(viewport);
    if (sameViewport(normalized, this.#viewport)) {
      return;
    }
    this.#viewport = normalized;
    this.#advanceGeneration();
  }

  setActiveCell(cell: CellPosition, options: SetActiveCellOptions = {}): void {
    this.#assertOpen();
    assertCellPosition(cell, "cell");
    const next = clampCell(
      cell,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (next === null) {
      return;
    }
    const anchor = options.extendSelection && this.#selection !== null
      ? this.#selection.anchor
      : next;
    this.#activeCell = next;
    this.#selection = createSelection(anchor, next);
    if (options.scrollIntoView !== false && this.#scrollCellIntoView(next)) {
      this.#advanceGeneration();
      return;
    }
    this.#publish();
  }

  extendSelection(
    cell: CellPosition,
    options: Omit<SetActiveCellOptions, "extendSelection"> = {},
  ): void {
    this.setActiveCell(cell, { ...options, extendSelection: true });
  }

  setSelection(anchor: CellPosition, focus: CellPosition = anchor): void {
    this.#assertOpen();
    assertCellPosition(anchor, "anchor");
    assertCellPosition(focus, "focus");
    const clampedAnchor = clampCell(
      anchor,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    const clampedFocus = clampCell(
      focus,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (clampedAnchor === null || clampedFocus === null) {
      this.clearSelection();
      return;
    }
    this.#activeCell = clampedFocus;
    this.#selection = createSelection(clampedAnchor, clampedFocus);
    this.#publish();
  }

  clearSelection(): void {
    this.#assertOpen();
    if (this.#selection === null) {
      return;
    }
    this.#selection = null;
    this.#publish();
  }

  moveActive(command: NavigationCommand, options: MoveActiveCellOptions = {}): void {
    this.#assertOpen();
    const current = this.#activeCell ?? { rowIndex: 0, columnIndex: 0 };
    const next = moveCell(
      current,
      command,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
      Math.max(1, Math.floor(this.#snapshot.layout.bodyHeight / this.#snapshot.layout.rowHeight)),
    );
    if (next !== null) {
      this.setActiveCell(next, options);
    }
  }

  ensureCellVisible(cell: CellPosition): void {
    this.#assertOpen();
    assertCellPosition(cell, "cell");
    const next = clampCell(
      cell,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (next !== null && this.#scrollCellIntoView(next)) {
      this.#advanceGeneration();
    }
  }

  resizeColumn(columnIndex: number, width: number): void {
    this.#assertOpen();
    assertColumnIndex(columnIndex, this.#columnWidths.length);
    const normalized = clampWidth(width, this.#options);
    if (this.#columnWidths[columnIndex] === normalized) {
      return;
    }
    this.#columnWidths[columnIndex] = normalized;
    this.#advanceGeneration();
  }

  autosizeColumn(columnIndex: number, measuredWidth: number): void {
    this.resizeColumn(columnIndex, measuredWidth);
  }

  hitTest(x: number, y: number, resizeHandleWidth?: number): HitTestResult {
    return hitTest(
      this.#snapshot.layout,
      x,
      y,
      this.#columnWidths,
      resizeHandleWidth,
    );
  }

  cellRect(cell: CellPosition): Readonly<PixelRect> {
    assertCellPosition(cell, "cell");
    if (cell.rowIndex >= this.#snapshot.layout.rowCount
      || cell.columnIndex >= this.#snapshot.layout.columnCount) {
      throw invalidArgument("cell must be inside the current table extent");
    }
    return cellRect(
      this.#snapshot.layout,
      this.#columnWidths,
      cell.rowIndex,
      cell.columnIndex,
    );
  }

  selectionRect(selection: TableSelection | null = this.#selection): Readonly<PixelRect> | null {
    return selection === null
      ? null
      : selectionRect(this.#snapshot.layout, this.#columnWidths, selection.range);
  }

  getCell(rowIndex: number, columnIndex: number): CellLoadState {
    if (!isValidCell(rowIndex, columnIndex, this.#snapshot.layout.rowCount, this.#columnWidths.length)) {
      return Object.freeze({ status: "unavailable" });
    }
    for (const window of this.#windows) {
      if (rangeContains(window.range, rowIndex, columnIndex)) {
        return Object.freeze({
          status: "loaded",
          value: window.rows[rowIndex - window.range.rowStart]![columnIndex - window.range.columnStart]!,
        });
      }
    }
    for (const range of this.#loadingRanges) {
      if (rangeContains(range, rowIndex, columnIndex)) {
        return Object.freeze({ status: "loading" });
      }
    }
    return Object.freeze({ status: "unavailable" });
  }

  async copySelection(options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    this.#assertOpen();
    const selection = this.#selection;
    if (selection === null) {
      return "";
    }
    const request = gridRangeToRequest(selection.range);
    assertWindowCellLimit(request, MAX_RANGE_CELLS, "selection");
    const batch = await this.#table.readRange(
      request,
      options.signal ? { signal: options.signal } : {},
    );
    return rowsToTsv(batchRows(batch));
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#requestAbort?.abort();
    this.#requestAbort = null;
    this.#unsubscribe();
    this.#listeners.clear();
    this.#windows = [];
    this.#loadingRanges = [];
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      status: "closed",
      activeCell: null,
      selection: null,
    });
  }

  #advanceGeneration(): void {
    this.#generation += 1;
    this.#requestAbort?.abort();
    this.#requestAbort = null;
    this.#loadingRanges = [];
    this.#rebuildSnapshot("loading");
    this.#queueLoad();
  }

  #queueLoad(): void {
    if (this.#loadQueued || this.#disposed) {
      return;
    }
    this.#loadQueued = true;
    queueMicrotask(() => {
      this.#loadQueued = false;
      if (!this.#disposed) {
        void this.#loadGeneration(this.#generation);
      }
    });
  }

  async #loadGeneration(generation: number): Promise<void> {
    let visible: Readonly<GridRange> | null;
    let overscan: Readonly<GridRange> | null;
    try {
      ({ visible, overscan } = layoutRanges(
        this.#snapshot.layout,
        this.#options.maxWindowCells,
      ));
    } catch (error) {
      if (!this.#disposed && generation === this.#generation) {
        this.#loadingRanges = [];
        this.#rebuildSnapshot("error", error);
      }
      return;
    }
    if (visible === null) {
      this.#windows = [];
      this.#loadingRanges = [];
      this.#rebuildSnapshot("ready");
      return;
    }
    const abort = new AbortController();
    this.#requestAbort = abort;
    const ranges = sameGridRange(visible, overscan) || overscan === null
      ? [visible]
      : [visible, overscan];
    this.#loadingRanges = Object.freeze(ranges);
    this.#publish();
    let loaded: LoadedWindow[] = [];
    try {
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index]!;
        const batch = await this.#table.readRange(
          gridRangeToRequest(range),
          { signal: abort.signal },
        );
        if (this.#disposed || generation !== this.#generation || abort.signal.aborted) {
          return;
        }
        const returnedRange = batchGridRange(batch);
        if (returnedRange.rowStart < returnedRange.rowEnd
          && returnedRange.columnStart < returnedRange.columnEnd) {
          const window = Object.freeze({ range: returnedRange, rows: batchRows(batch) });
          loaded = [window, ...loaded.filter(
            (candidate) => !rangeContainsRange(returnedRange, candidate.range),
          )];
        }
        this.#windows = Object.freeze([...loaded]);
        this.#loadingRanges = Object.freeze(ranges.slice(index + 1));
        this.#rebuildSnapshot("ready");
      }
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || abort.signal.aborted
        || (error instanceof TabularkError && error.code === "CANCELLED")) {
        return;
      }
      this.#loadingRanges = [];
      this.#rebuildSnapshot("error", error);
    } finally {
      if (this.#requestAbort === abort) {
        this.#requestAbort = null;
      }
    }
  }

  #scrollCellIntoView(cell: CellPosition): boolean {
    const layout = this.#snapshot.layout;
    const offsets = columnOffsets(this.#columnWidths);
    const cellLeft = offsets[cell.columnIndex]!;
    const cellRight = offsets[cell.columnIndex + 1]!;
    const cellTop = cell.rowIndex * layout.rowHeight;
    const cellBottom = cellTop + layout.rowHeight;
    const logicalLeft = revealOffset(
      layout.horizontal.logicalOffset,
      layout.bodyWidth,
      cellLeft,
      cellRight,
      layout.horizontal.logicalMaxOffset,
    );
    const logicalTop = revealOffset(
      layout.vertical.logicalOffset,
      layout.bodyHeight,
      cellTop,
      cellBottom,
      layout.vertical.logicalMaxOffset,
    );
    const scrollLeft = logicalToPhysicalOffset(layout.horizontal, logicalLeft);
    const scrollTop = logicalToPhysicalOffset(layout.vertical, logicalTop);
    if (scrollLeft === this.#viewport.scrollLeft && scrollTop === this.#viewport.scrollTop) {
      return false;
    }
    this.#viewport = Object.freeze({ ...this.#viewport, scrollLeft, scrollTop });
    return true;
  }

  #handleTableEvent(event: TableEvent): void {
    if (this.#disposed) {
      return;
    }
    switch (event.type) {
      case "metadata": {
        this.#columnWidths = reconcileColumnWidths(
          this.#snapshot.metadata,
          event.metadata,
          this.#columnWidths,
          this.#options,
        );
        this.#clampInteraction();
        this.#advanceGeneration();
        break;
      }
      case "runtimeError":
        this.#requestAbort?.abort();
        this.#requestAbort = null;
        this.#loadingRanges = [];
        this.#rebuildSnapshot("error", event.error);
        break;
      case "closed":
        this.#tableClosed = true;
        this.#requestAbort?.abort();
        this.#requestAbort = null;
        this.#loadingRanges = [];
        if (this.#snapshot.status !== "error") {
          this.#rebuildSnapshot("closed");
        }
        break;
      case "warning":
        break;
    }
  }

  #clampInteraction(): void {
    if (this.#activeCell === null) {
      return;
    }
    const rowCount = extentValue(this.#table.metadata.extent.rows);
    const columnCount = this.#table.metadata.schema.columns.length;
    const nextActive = clampCell(this.#activeCell, rowCount, columnCount);
    if (nextActive === null) {
      this.#activeCell = null;
      this.#selection = null;
      return;
    }
    this.#activeCell = nextActive;
    if (this.#selection !== null) {
      const anchor = clampCell(this.#selection.anchor, rowCount, columnCount)!;
      const focus = clampCell(this.#selection.focus, rowCount, columnCount)!;
      this.#selection = createSelection(anchor, focus);
    }
  }

  #rebuildSnapshot(status: TableViewSnapshot["status"], error?: unknown): void {
    const layout = createTableLayout(
      this.#table.metadata,
      this.#columnWidths,
      this.#viewport,
      this.#options,
    );
    this.#viewport = Object.freeze({
      ...this.#viewport,
      scrollLeft: layout.horizontal.physicalOffset,
      scrollTop: layout.vertical.physicalOffset,
    });
    this.#snapshot = Object.freeze({
      generation: this.#generation,
      status,
      metadata: this.#table.metadata,
      layout,
      activeCell: this.#activeCell,
      selection: this.#selection,
      ...(error === undefined ? {} : { error }),
    });
    this.#emit();
  }

  #publish(): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      activeCell: this.#activeCell,
      selection: this.#selection,
    });
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch (error) {
        if (typeof reportError === "function") {
          reportError(error);
        }
      }
    }
  }

  #assertOpen(): void {
    if (this.#disposed || this.#tableClosed || this.#snapshot.status === "closed") {
      throw closedError("Table view controller");
    }
  }
}

export function createTableController(
  table: TableHandle,
  options: TableControllerOptions = {},
): TableViewController {
  if (!table || typeof table.readRange !== "function" || typeof table.subscribe !== "function") {
    throw invalidArgument("table must be a TableHandle");
  }
  return new Controller(table, options);
}

function normalizeOptions(options: TableControllerOptions): NormalizedOptions {
  const minColumnWidth = positiveFinite(
    options.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH,
    "minColumnWidth",
  );
  const maxColumnWidth = positiveFinite(
    options.maxColumnWidth ?? DEFAULT_MAX_COLUMN_WIDTH,
    "maxColumnWidth",
  );
  if (maxColumnWidth < minColumnWidth) {
    throw invalidArgument("maxColumnWidth must be greater than or equal to minColumnWidth");
  }
  const maxWindowCells = positiveInteger(
    options.maxWindowCells ?? DEFAULT_MAX_WINDOW_CELLS,
    "maxWindowCells",
  );
  if (maxWindowCells > MAX_RANGE_CELLS) {
    throw invalidArgument(`maxWindowCells cannot exceed ${MAX_RANGE_CELLS}`);
  }
  return Object.freeze({
    ...(options.rowHeight === undefined ? {} : { rowHeight: options.rowHeight }),
    ...(options.headerHeight === undefined ? {} : { headerHeight: options.headerHeight }),
    ...(options.rowHeaderWidth === undefined ? {} : { rowHeaderWidth: options.rowHeaderWidth }),
    ...(options.scrollPixelLimit === undefined ? {} : { scrollPixelLimit: options.scrollPixelLimit }),
    ...(options.overscanRows === undefined ? {} : { overscanRows: options.overscanRows }),
    ...(options.overscanColumns === undefined ? {} : { overscanColumns: options.overscanColumns }),
    columnWidth: positiveFinite(options.columnWidth ?? DEFAULT_COLUMN_WIDTH, "columnWidth"),
    minColumnWidth,
    maxColumnWidth,
    columnWidths: Object.freeze({ ...(options.columnWidths ?? {}) }),
    maxWindowCells,
  });
}

function initialColumnWidths(
  metadata: TableHandle["metadata"],
  options: NormalizedOptions,
): number[] {
  return metadata.schema.columns.map((column) => clampWidth(
    options.columnWidths[column.id] ?? options.columnWidth,
    options,
  ));
}

function reconcileColumnWidths(
  previousMetadata: TableHandle["metadata"],
  nextMetadata: TableHandle["metadata"],
  previousWidths: readonly number[],
  options: NormalizedOptions,
): number[] {
  const byId = new Map(previousMetadata.schema.columns.map(
    (column, index) => [column.id, previousWidths[index]!] as const,
  ));
  return nextMetadata.schema.columns.map((column) => clampWidth(
    byId.get(column.id) ?? options.columnWidths[column.id] ?? options.columnWidth,
    options,
  ));
}

function normalizeViewport(viewport: ViewportUpdate): Required<ViewportUpdate> {
  return Object.freeze({
    width: nonNegativeFinite(viewport.width, "viewport.width"),
    height: nonNegativeFinite(viewport.height, "viewport.height"),
    scrollLeft: nonNegativeFinite(viewport.scrollLeft, "viewport.scrollLeft"),
    scrollTop: nonNegativeFinite(viewport.scrollTop, "viewport.scrollTop"),
    devicePixelRatio: positiveFinite(viewport.devicePixelRatio ?? 1, "viewport.devicePixelRatio"),
  });
}

function layoutRanges(
  layout: TableViewSnapshot["layout"],
  maxCells: number,
): Readonly<{
  visible: Readonly<GridRange> | null;
  overscan: Readonly<GridRange> | null;
}> {
  const visibleRows = layout.rows.visible;
  const visibleColumns = layout.columns.visible;
  if (visibleRows.start === visibleRows.end || visibleColumns.start === visibleColumns.end) {
    return Object.freeze({ visible: null, overscan: null });
  }
  const visible = Object.freeze({
    rowStart: visibleRows.start,
    rowEnd: visibleRows.end,
    columnStart: visibleColumns.start,
    columnEnd: visibleColumns.end,
  });
  const visibleCellCount = rangeCellCount(visible);
  if (visibleCellCount > maxCells) {
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `The viewport contains ${visibleCellCount} cells; the window limit is ${maxCells}`,
      { details: { visibleCellCount, maxCells } },
    );
  }
  const overscanRows = layout.rows.overscan;
  const overscanColumns = layout.columns.overscan;
  const fullOverscan = Object.freeze({
    rowStart: overscanRows.start,
    rowEnd: overscanRows.end,
    columnStart: overscanColumns.start,
    columnEnd: overscanColumns.end,
  });
  if (rangeCellCount(fullOverscan) <= maxCells) {
    return Object.freeze({ visible, overscan: fullOverscan });
  }

  let columnStart = fullOverscan.columnStart;
  let columnEnd = fullOverscan.columnEnd;
  const visibleRowCount = visible.rowEnd - visible.rowStart;
  if ((columnEnd - columnStart) * visibleRowCount > maxCells) {
    columnStart = visible.columnStart;
    columnEnd = visible.columnEnd;
  }
  const columnCount = columnEnd - columnStart;
  const maximumRows = Math.max(visibleRowCount, Math.floor(maxCells / columnCount));
  const extraRows = maximumRows - visibleRowCount;
  let rowStart = Math.max(fullOverscan.rowStart, visible.rowStart - Math.floor(extraRows / 2));
  let rowEnd = Math.min(fullOverscan.rowEnd, rowStart + maximumRows);
  rowStart = Math.max(fullOverscan.rowStart, rowEnd - maximumRows);
  rowEnd = Math.max(rowEnd, visible.rowEnd);
  return Object.freeze({
    visible,
    overscan: Object.freeze({ rowStart, rowEnd, columnStart, columnEnd }),
  });
}

function gridRangeToRequest(range: GridRange): Readonly<RangeRequest> {
  return Object.freeze({
    rowStart: range.rowStart,
    rowCount: range.rowEnd - range.rowStart,
    columnStart: range.columnStart,
    columnCount: range.columnEnd - range.columnStart,
  });
}

function batchGridRange(batch: TableBatch): Readonly<GridRange> {
  return Object.freeze({
    rowStart: batch.range.rowStart,
    rowEnd: batch.range.rowStart + batch.range.rowCount,
    columnStart: batch.range.columnStart,
    columnEnd: batch.range.columnStart + batch.range.columnCount,
  });
}

function batchRows(batch: TableBatch): readonly (readonly (string | null)[])[] {
  return Object.freeze(batch.toRows({
    maxCells: Math.max(1, batch.range.rowCount * batch.range.columnCount),
  }).map((row) => Object.freeze(row)));
}

function rowsToTsv(rows: readonly (readonly (string | null)[])[]): string {
  return rows.map((row) => row.map(tsvField).join("\t")).join("\n");
}

function tsvField(value: string | null): string {
  if (value === null) {
    return "";
  }
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function revealOffset(
  current: number,
  viewportSize: number,
  itemStart: number,
  itemEnd: number,
  maximum: number,
): number {
  if (viewportSize <= 0 || itemStart < current) {
    return Math.min(maximum, Math.max(0, itemStart));
  }
  if (itemEnd > current + viewportSize) {
    return Math.min(maximum, Math.max(0, itemEnd - viewportSize));
  }
  return current;
}

function rangeContains(range: GridRange, rowIndex: number, columnIndex: number): boolean {
  return rowIndex >= range.rowStart && rowIndex < range.rowEnd
    && columnIndex >= range.columnStart && columnIndex < range.columnEnd;
}

function rangeContainsRange(container: GridRange, candidate: GridRange): boolean {
  return candidate.rowStart >= container.rowStart
    && candidate.rowEnd <= container.rowEnd
    && candidate.columnStart >= container.columnStart
    && candidate.columnEnd <= container.columnEnd;
}

function rangeCellCount(range: GridRange): number {
  return (range.rowEnd - range.rowStart) * (range.columnEnd - range.columnStart);
}

function sameGridRange(left: GridRange, right: GridRange | null): boolean {
  return right !== null
    && left.rowStart === right.rowStart
    && left.rowEnd === right.rowEnd
    && left.columnStart === right.columnStart
    && left.columnEnd === right.columnEnd;
}

function sameViewport(left: Required<ViewportUpdate>, right: Required<ViewportUpdate>): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.scrollLeft === right.scrollLeft
    && left.scrollTop === right.scrollTop
    && left.devicePixelRatio === right.devicePixelRatio;
}

function isValidCell(
  rowIndex: number,
  columnIndex: number,
  rowCount: number,
  columnCount: number,
): boolean {
  return Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < rowCount
    && Number.isSafeInteger(columnIndex) && columnIndex >= 0 && columnIndex < columnCount;
}

function assertColumnIndex(columnIndex: number, columnCount: number): void {
  if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount) {
    throw invalidArgument(`columnIndex must be between 0 and ${Math.max(0, columnCount - 1)}`);
  }
}

function assertWindowCellLimit(request: RangeRequest, limit: number, label: string): void {
  const cells = request.rowCount * request.columnCount;
  if (!Number.isSafeInteger(cells) || cells > limit) {
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `The ${label} contains ${cells} cells; the limit is ${limit}`,
      { details: { cells, limit } },
    );
  }
}

function clampWidth(width: number, options: NormalizedOptions): number {
  if (!Number.isFinite(width)) {
    throw invalidArgument("column width must be a finite number");
  }
  return Math.min(options.maxColumnWidth, Math.max(options.minColumnWidth, width));
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidArgument(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw invalidArgument(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidArgument(`${name} must be a positive safe integer`);
  }
  return value;
}
