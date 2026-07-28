import type { TableHandle, TableEvent, Unsubscribe } from "../client.js";
import { TabularkError, closedError, invalidArgument } from "../errors.js";
import {
  MAX_RANGE_CELLS,
  type MergedCellRegion,
  type PresentationAxisEntry,
  type RangeRequest,
  type SpreadsheetPresentation,
  type TableBatch,
} from "../model.js";
import {
  axisPosition,
  axisSize,
  cellRect,
  columnOffsets,
  createTableLayout,
  extentValue,
  hitTest,
  logicalToPhysicalOffset,
  nextVisibleAxisIndex,
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
  readonly minColumnWidth: number;
  readonly maxColumnWidth: number;
  getSnapshot(): Readonly<TableViewSnapshot>;
  subscribe(listener: (snapshot: Readonly<TableViewSnapshot>) => void): Unsubscribe;
  updateViewport(viewport: ViewportUpdate): void;
  setActiveCell(cell: CellPosition, options?: SetActiveCellOptions): void;
  extendSelection(cell: CellPosition, options?: Omit<SetActiveCellOptions, "extendSelection">): void;
  setSelection(anchor: CellPosition, focus?: CellPosition): void;
  clearSelection(): void;
  moveActive(command: NavigationCommand, options?: MoveActiveCellOptions): void;
  ensureCellVisible(cell: CellPosition): void;
  ensureColumnVisible(columnIndex: number): void;
  resizeColumn(columnIndex: number, width: number): void;
  autosizeColumn(columnIndex: number, measuredWidth: number): void;
  /** Applies validated static worksheet geometry in one controller generation. */
  applySpreadsheetPresentation(presentation: SpreadsheetPresentation): void;
  /** Updates merge interaction geometry for the currently loaded presentation window. */
  setMergedCells(regions: readonly MergedCellRegion[]): void;
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
  #hiddenColumns: boolean[];
  #presentationRows: readonly PresentationAxisEntry[] = [];
  #frozenRows = 0;
  #frozenColumns = 0;
  #mergedCells: readonly MergedCellRegion[] = [];
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
    this.#hiddenColumns = Array.from({ length: this.#columnWidths.length }, () => false);
    const layout = createTableLayout(
      table.metadata,
      this.#columnWidths,
      this.#viewport,
      this.#layoutOptions(),
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

  get minColumnWidth(): number {
    return this.#options.minColumnWidth;
  }

  get maxColumnWidth(): number {
    return this.#options.maxColumnWidth;
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
    const clamped = clampCell(
      cell,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (clamped === null) {
      return;
    }
    const next = this.#visibleCell(this.#mergeAnchor(clamped), 1, 1);
    if (next === null) return;
    const anchor = options.extendSelection && this.#selection !== null
      ? this.#selection.anchor
      : next;
    this.#activeCell = next;
    this.#selection = createMergedSelection(anchor, next, this.#mergedCells);
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
    const rawAnchor = clampCell(
      anchor,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    const rawFocus = clampCell(
      focus,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (rawAnchor === null || rawFocus === null) {
      this.clearSelection();
      return;
    }
    const clampedAnchor = this.#visibleCell(this.#mergeAnchor(rawAnchor), 1, 1);
    const clampedFocus = this.#visibleCell(this.#mergeAnchor(rawFocus), 1, 1);
    if (clampedAnchor === null || clampedFocus === null) {
      this.clearSelection();
      return;
    }
    this.#activeCell = clampedFocus;
    this.#selection = createMergedSelection(clampedAnchor, clampedFocus, this.#mergedCells);
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
    const origin = navigationOrigin(current, command, this.#mergedCells);
    const moved = moveCell(
      origin,
      command,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
      Math.max(1, this.#snapshot.layout.visibleRows.filter((row) => !row.frozen).length),
    );
    const [rowDirection, columnDirection] = navigationDirections(command);
    const next = moved === null
      ? null
      : this.#visibleCell(this.#mergeAnchor(moved), rowDirection, columnDirection);
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

  ensureColumnVisible(columnIndex: number): void {
    this.#assertOpen();
    assertColumnIndex(columnIndex, this.#columnWidths.length);
    if (this.#scrollColumnIntoView(columnIndex)) {
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

  applySpreadsheetPresentation(presentation: SpreadsheetPresentation): void {
    this.#assertOpen();
    if (presentation.kind !== "spreadsheet-v1" || presentation.tableId !== this.metadata.tableId) {
      throw invalidArgument("presentation must belong to the controller table");
    }
    const nextWidths = [...this.#columnWidths];
    const hiddenColumns = Array.from({ length: nextWidths.length }, () => false);
    for (const entry of presentation.columns) {
      if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= nextWidths.length) {
        continue;
      }
      hiddenColumns[entry.index] = entry.hidden === true;
      if (entry.size !== undefined && Number.isFinite(entry.size) && entry.size > 0) {
        nextWidths[entry.index] = clampWidth(entry.size, this.#options);
      }
    }
    this.#columnWidths = nextWidths;
    this.#hiddenColumns = hiddenColumns;
    this.#presentationRows = Object.freeze(presentation.rows.map((entry) => Object.freeze({ ...entry })));
    this.#frozenRows = presentation.frozenRows;
    this.#frozenColumns = presentation.frozenColumns;
    this.#mergedCells = [];
    this.#advanceGeneration();
    this.#normalizeInteractionForPresentation();
    this.#publish();
  }

  setMergedCells(regions: readonly MergedCellRegion[]): void {
    this.#assertOpen();
    const normalized = normalizeMergedCells(
      regions,
      this.#snapshot.layout.rowCount,
      this.#snapshot.layout.columnCount,
    );
    if (sameMergedCells(normalized, this.#mergedCells)) {
      return;
    }
    this.#mergedCells = normalized;
    this.#normalizeInteractionForPresentation();
    // A merge may intersect the viewport while its value anchor is far
    // outside the ordinary visible/overscan windows. Start a new generation
    // so those anchors are requested along with the visible cells.
    this.#advanceGeneration();
  }

  hitTest(x: number, y: number, resizeHandleWidth?: number): HitTestResult {
    const result = hitTest(
      this.#snapshot.layout,
      x,
      y,
      this.#columnWidths,
      resizeHandleWidth,
    );
    if (result.kind !== "cell") {
      return result;
    }
    const anchor = this.#mergeAnchor(result);
    return Object.freeze({ kind: "cell", ...anchor });
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
    let visible: readonly Readonly<GridRange>[];
    let overscan: readonly Readonly<GridRange>[];
    try {
      ({ visible, overscan } = layoutRanges(
        this.#snapshot.layout,
        this.#options.maxWindowCells,
        this.#mergedCells,
      ));
    } catch (error) {
      if (!this.#disposed && generation === this.#generation) {
        this.#loadingRanges = [];
        this.#rebuildSnapshot("error", error);
      }
      return;
    }
    if (visible.length === 0) {
      this.#windows = [];
      this.#loadingRanges = [];
      this.#rebuildSnapshot("ready");
      return;
    }
    if (visible.every((range) => this.#windows.some(
      (window) => rangeContainsRange(window.range, range),
    ))) {
      this.#loadingRanges = [];
      this.#rebuildSnapshot("ready");
      return;
    }
    const abort = new AbortController();
    this.#requestAbort = abort;
    const ranges = Object.freeze([
      ...visible,
      ...overscan.filter((candidate) => !visible.some(
        (required) => rangeContainsRange(candidate, required) && sameGridRange(candidate, required),
      )),
    ]);
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
    const offsets = columnOffsets(layout.effectiveColumnWidths);
    const cellLeft = offsets[cell.columnIndex]!;
    const cellRight = offsets[cell.columnIndex + 1]!;
    const cellTop = axisPosition(layout.rowGeometry, cell.rowIndex);
    const cellBottom = cellTop + axisSize(layout.rowGeometry, cell.rowIndex);
    const logicalLeft = cell.columnIndex < layout.frozenColumnCount
      ? layout.horizontal.logicalOffset
      : revealOffset(
        layout.horizontal.logicalOffset,
        layout.bodyWidth,
        cellLeft,
        cellRight,
        layout.horizontal.logicalMaxOffset,
      );
    const logicalTop = cell.rowIndex < layout.frozenRowCount
      ? layout.vertical.logicalOffset
      : revealOffset(
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

  #scrollColumnIntoView(columnIndex: number): boolean {
    const layout = this.#snapshot.layout;
    const offsets = columnOffsets(layout.effectiveColumnWidths);
    const logicalLeft = columnIndex < layout.frozenColumnCount
      ? layout.horizontal.logicalOffset
      : revealOffset(
        layout.horizontal.logicalOffset,
        layout.bodyWidth,
        offsets[columnIndex]!,
        offsets[columnIndex + 1]!,
        layout.horizontal.logicalMaxOffset,
      );
    const scrollLeft = logicalToPhysicalOffset(layout.horizontal, logicalLeft);
    if (scrollLeft === this.#viewport.scrollLeft) {
      return false;
    }
    this.#viewport = Object.freeze({ ...this.#viewport, scrollLeft });
    return true;
  }

  #handleTableEvent(event: TableEvent): void {
    if (this.#disposed) {
      return;
    }
    switch (event.type) {
      case "metadata": {
        const previousMetadata = this.#snapshot.metadata;
        this.#columnWidths = reconcileColumnWidths(
          previousMetadata,
          event.metadata,
          this.#columnWidths,
          this.#options,
        );
        const hiddenById = new Map(previousMetadata.schema.columns.map(
          (column, index) => [column.id, this.#hiddenColumns[index] === true] as const,
        ));
        this.#hiddenColumns = event.metadata.schema.columns.map(
          (column) => hiddenById.get(column.id) === true,
        );
        this.#advanceGeneration();
        this.#clampInteraction();
        this.#publish();
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
    const rawActive = clampCell(this.#activeCell, rowCount, columnCount);
    const nextActive = rawActive === null
      ? null
      : this.#visibleCell(this.#mergeAnchor(rawActive), 1, 1);
    if (nextActive === null) {
      this.#activeCell = null;
      this.#selection = null;
      return;
    }
    this.#activeCell = nextActive;
    if (this.#selection !== null) {
      const rawAnchor = clampCell(this.#selection.anchor, rowCount, columnCount)!;
      const rawFocus = clampCell(this.#selection.focus, rowCount, columnCount)!;
      const anchor = this.#visibleCell(this.#mergeAnchor(rawAnchor), 1, 1);
      const focus = this.#visibleCell(this.#mergeAnchor(rawFocus), 1, 1);
      this.#selection = anchor === null || focus === null
        ? null
        : createMergedSelection(anchor, focus, this.#mergedCells);
    }
  }

  #layoutOptions(): LayoutOptions {
    return Object.freeze({
      ...this.#options,
      rowEntries: this.#presentationRows,
      hiddenColumns: this.#hiddenColumns,
      frozenRows: this.#frozenRows,
      frozenColumns: this.#frozenColumns,
    });
  }

  #mergeAnchor(cell: CellPosition): Readonly<CellPosition> {
    const region = mergeContaining(this.#mergedCells, cell);
    return region === undefined
      ? Object.freeze({ rowIndex: cell.rowIndex, columnIndex: cell.columnIndex })
      : Object.freeze({ rowIndex: region.rowStart, columnIndex: region.columnStart });
  }

  #visibleCell(
    cell: CellPosition,
    rowDirection: -1 | 1,
    columnDirection: -1 | 1,
  ): Readonly<CellPosition> | null {
    const layout = this.#snapshot.layout;
    const row = nextVisibleAxisIndex(layout.rowGeometry, cell.rowIndex, rowDirection)
      ?? nextVisibleAxisIndex(layout.rowGeometry, cell.rowIndex, rowDirection === 1 ? -1 : 1);
    if (row === null) return null;
    const column = nextVisibleColumn(
      layout.effectiveColumnWidths,
      cell.columnIndex,
      columnDirection,
    ) ?? nextVisibleColumn(
      layout.effectiveColumnWidths,
      cell.columnIndex,
      columnDirection === 1 ? -1 : 1,
    );
    return column === null ? null : Object.freeze({ rowIndex: row, columnIndex: column });
  }

  #normalizeInteractionForPresentation(): void {
    this.#clampInteraction();
  }

  #rebuildSnapshot(status: TableViewSnapshot["status"], error?: unknown): void {
    const layout = createTableLayout(
      this.#table.metadata,
      this.#columnWidths,
      this.#viewport,
      this.#layoutOptions(),
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

function normalizeMergedCells(
  regions: readonly MergedCellRegion[],
  rowCount: number,
  columnCount: number,
): readonly MergedCellRegion[] {
  const unique = new Map<string, MergedCellRegion>();
  for (const region of regions) {
    if (
      !region
      || !Number.isSafeInteger(region.rowStart)
      || !Number.isSafeInteger(region.rowEnd)
      || !Number.isSafeInteger(region.columnStart)
      || !Number.isSafeInteger(region.columnEnd)
      || region.rowStart < 0
      || region.columnStart < 0
      || region.rowEnd <= region.rowStart
      || region.columnEnd <= region.columnStart
      || region.rowEnd > rowCount
      || region.columnEnd > columnCount
    ) {
      continue;
    }
    const frozen = Object.freeze({ ...region });
    unique.set(mergeKey(frozen), frozen);
  }
  return Object.freeze([...unique.values()].sort(
    (left, right) => left.rowStart - right.rowStart
      || left.columnStart - right.columnStart
      || left.rowEnd - right.rowEnd
      || left.columnEnd - right.columnEnd,
  ));
}

function sameMergedCells(
  left: readonly MergedCellRegion[],
  right: readonly MergedCellRegion[],
): boolean {
  return left.length === right.length
    && left.every((region, index) => mergeKey(region) === mergeKey(right[index]!));
}

function mergeKey(region: MergedCellRegion): string {
  return `${region.rowStart}:${region.rowEnd}:${region.columnStart}:${region.columnEnd}`;
}

function mergeContaining(
  regions: readonly MergedCellRegion[],
  cell: CellPosition,
): MergedCellRegion | undefined {
  return regions.find((region) => (
    cell.rowIndex >= region.rowStart
    && cell.rowIndex < region.rowEnd
    && cell.columnIndex >= region.columnStart
    && cell.columnIndex < region.columnEnd
  ));
}

function createMergedSelection(
  anchor: CellPosition,
  focus: CellPosition,
  regions: readonly MergedCellRegion[],
): Readonly<TableSelection> {
  const selection = createSelection(anchor, focus);
  let range = selection.range;
  for (;;) {
    let expanded = range;
    for (const region of regions) {
      if (!rangesIntersect(expanded, region)) continue;
      expanded = Object.freeze({
        rowStart: Math.min(expanded.rowStart, region.rowStart),
        rowEnd: Math.max(expanded.rowEnd, region.rowEnd),
        columnStart: Math.min(expanded.columnStart, region.columnStart),
        columnEnd: Math.max(expanded.columnEnd, region.columnEnd),
      });
    }
    if (sameGridRange(range, expanded)) break;
    range = expanded;
  }
  return Object.freeze({ ...selection, range });
}

function rangesIntersect(left: GridRange, right: MergedCellRegion): boolean {
  return left.rowStart < right.rowEnd
    && left.rowEnd > right.rowStart
    && left.columnStart < right.columnEnd
    && left.columnEnd > right.columnStart;
}

function navigationOrigin(
  current: CellPosition,
  command: NavigationCommand,
  regions: readonly MergedCellRegion[],
): Readonly<CellPosition> {
  const merge = mergeContaining(regions, current);
  if (merge === undefined) return current;
  if (command === "right") {
    return Object.freeze({ rowIndex: current.rowIndex, columnIndex: merge.columnEnd - 1 });
  }
  if (command === "down" || command === "page-down") {
    return Object.freeze({ rowIndex: merge.rowEnd - 1, columnIndex: current.columnIndex });
  }
  return current;
}

function navigationDirections(command: NavigationCommand): readonly [-1 | 1, -1 | 1] {
  switch (command) {
    case "left":
    case "row-start":
      return [1, -1];
    case "up":
    case "page-up":
      return [-1, 1];
    case "table-start":
      return [-1, -1];
    default:
      return [1, 1];
  }
}

function nextVisibleColumn(
  widths: readonly number[],
  from: number,
  direction: -1 | 1,
): number | null {
  for (
    let index = Math.min(widths.length - 1, Math.max(0, from));
    index >= 0 && index < widths.length;
    index += direction
  ) {
    if ((widths[index] ?? 0) > 0) return index;
  }
  return null;
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
  mergedCells: readonly MergedCellRegion[] = [],
): Readonly<{
  visible: readonly Readonly<GridRange>[];
  overscan: readonly Readonly<GridRange>[];
}> {
  const visible = windowRectangles(
    layout.rows.visible,
    layout.columns.visible,
    layout.frozenRowRange,
    layout.frozenColumnRange,
  );
  const anchors = mergeAnchorRanges(mergedCells, visible);
  const visibleWithAnchors = Object.freeze([
    ...visible,
    ...anchors.filter((anchor) => !visible.some((range) => rangeContainsRange(range, anchor))),
  ]);
  const visibleCellCount = visibleWithAnchors.reduce(
    (total, range) => total + rangeCellCount(range),
    0,
  );
  if (visibleCellCount > maxCells) {
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `The viewport contains ${visibleCellCount} cells; the window limit is ${maxCells}`,
      {
        details: {
          resource: "viewport-cells",
          required: visibleCellCount,
          available: maxCells,
          visibleCellCount,
          maxCells,
        },
      },
    );
  }
  const fullOverscan = windowRectangles(
    layout.rows.overscan,
    layout.columns.overscan,
    layout.frozenRowRange,
    layout.frozenColumnRange,
  );
  const overscanCellCount = fullOverscan.reduce(
    (total, range) => total + rangeCellCount(range),
    0,
  );
  const overscanWithAnchors = Object.freeze([
    ...fullOverscan,
    ...anchors.filter((anchor) => !fullOverscan.some(
      (range) => rangeContainsRange(range, anchor),
    )),
  ]);
  return Object.freeze({
    visible: visibleWithAnchors,
    overscan: overscanCellCount + anchors.length <= maxCells
      ? overscanWithAnchors
      : visibleWithAnchors,
  });
}

function mergeAnchorRanges(
  mergedCells: readonly MergedCellRegion[],
  visible: readonly Readonly<GridRange>[],
): readonly Readonly<GridRange>[] {
  const anchors = new Map<string, Readonly<GridRange>>();
  for (const region of mergedCells) {
    if (!visible.some((range) => rangesIntersect(range, region))) continue;
    const range = Object.freeze({
      rowStart: region.rowStart,
      rowEnd: region.rowStart + 1,
      columnStart: region.columnStart,
      columnEnd: region.columnStart + 1,
    });
    anchors.set(`${range.rowStart}:${range.columnStart}`, range);
  }
  return Object.freeze([...anchors.values()]);
}

function windowRectangles(
  rows: Readonly<{ start: number; end: number }>,
  columns: Readonly<{ start: number; end: number }>,
  frozenRows: Readonly<{ start: number; end: number }>,
  frozenColumns: Readonly<{ start: number; end: number }>,
): readonly Readonly<GridRange>[] {
  const rowBands = mergeIndexBands(rows, frozenRows);
  const columnBands = mergeIndexBands(columns, frozenColumns);
  const rectangles: GridRange[] = [];
  for (const row of rowBands) {
    for (const column of columnBands) {
      rectangles.push(Object.freeze({
        rowStart: row.start,
        rowEnd: row.end,
        columnStart: column.start,
        columnEnd: column.end,
      }));
    }
  }
  return Object.freeze(rectangles);
}

function mergeIndexBands(
  primary: Readonly<{ start: number; end: number }>,
  frozen: Readonly<{ start: number; end: number }>,
): readonly Readonly<{ start: number; end: number }>[] {
  const bands = [primary, frozen]
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start);
  if (bands.length <= 1) return Object.freeze(bands.map((range) => Object.freeze({ ...range })));
  const [first, second] = bands as [typeof primary, typeof primary];
  return first.end >= second.start
    ? Object.freeze([Object.freeze({ start: first.start, end: Math.max(first.end, second.end) })])
    : Object.freeze(bands.map((range) => Object.freeze({ ...range })));
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
  return Object.freeze(batch.toDisplayRows({
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
      {
        details: {
          resource: "view-window-cells",
          required: cells,
          available: limit,
          cells,
          limit,
        },
      },
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
