import { invalidArgument } from "../errors.js";
import type { TableMetadata } from "../model.js";
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_HEADER_HEIGHT,
  DEFAULT_OVERSCAN_COLUMNS,
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_ROW_HEADER_WIDTH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_SCROLL_PIXEL_LIMIT,
  type GridRange,
  type HitTestResult,
  type IndexRange,
  type PixelRect,
  type ScrollAxisLayout,
  type TableLayout,
  type ViewportUpdate,
  type VisibleColumn,
} from "./types.js";

export interface LayoutOptions {
  readonly rowHeight?: number;
  readonly headerHeight?: number;
  readonly rowHeaderWidth?: number;
  readonly scrollPixelLimit?: number;
  readonly overscanRows?: number;
  readonly overscanColumns?: number;
}

export function createTableLayout(
  metadata: Readonly<TableMetadata>,
  columnWidths: readonly number[],
  viewport: ViewportUpdate,
  options: LayoutOptions = {},
): Readonly<TableLayout> {
  const rowHeight = positiveFinite(options.rowHeight ?? DEFAULT_ROW_HEIGHT, "rowHeight");
  const headerHeight = nonNegativeFinite(
    options.headerHeight ?? DEFAULT_HEADER_HEIGHT,
    "headerHeight",
  );
  const rowHeaderWidth = nonNegativeFinite(
    options.rowHeaderWidth ?? DEFAULT_ROW_HEADER_WIDTH,
    "rowHeaderWidth",
  );
  const scrollPixelLimit = positiveFinite(
    options.scrollPixelLimit ?? DEFAULT_SCROLL_PIXEL_LIMIT,
    "scrollPixelLimit",
  );
  const overscanRows = nonNegativeInteger(
    options.overscanRows ?? DEFAULT_OVERSCAN_ROWS,
    "overscanRows",
  );
  const overscanColumns = nonNegativeInteger(
    options.overscanColumns ?? DEFAULT_OVERSCAN_COLUMNS,
    "overscanColumns",
  );
  const width = nonNegativeFinite(viewport.width, "viewport.width");
  const height = nonNegativeFinite(viewport.height, "viewport.height");
  const devicePixelRatio = positiveFinite(
    viewport.devicePixelRatio ?? 1,
    "viewport.devicePixelRatio",
  );
  const columnCount = metadata.schema.columns.length;
  if (columnWidths.length !== columnCount) {
    throw invalidArgument(
      `columnWidths has ${columnWidths.length} entries; expected ${columnCount}`,
    );
  }
  for (let index = 0; index < columnWidths.length; index += 1) {
    positiveFinite(columnWidths[index]!, `columnWidths[${index}]`);
  }

  const rowCount = extentValue(metadata.extent.rows);
  const bodyWidth = Math.max(0, width - rowHeaderWidth);
  const bodyHeight = Math.max(0, height - headerHeight);
  const prefixes = columnOffsets(columnWidths);
  const logicalWidth = prefixes[prefixes.length - 1] ?? 0;
  const logicalHeight = rowCount * rowHeight;
  const horizontal = createScrollAxis(
    logicalWidth,
    bodyWidth,
    viewport.scrollLeft,
    scrollPixelLimit,
  );
  const vertical = createScrollAxis(
    logicalHeight,
    bodyHeight,
    viewport.scrollTop,
    scrollPixelLimit,
  );
  const visibleRows = visibleRowRange(
    rowCount,
    rowHeight,
    vertical.logicalOffset,
    bodyHeight,
  );
  const visibleColumns = visibleColumnRange(
    prefixes,
    horizontal.logicalOffset,
    bodyWidth,
  );
  const overscanRowRange = expandRange(visibleRows, overscanRows, rowCount);
  const overscanColumnRange = expandRange(visibleColumns, overscanColumns, columnCount);

  return Object.freeze({
    width,
    height,
    devicePixelRatio,
    rowHeight,
    headerHeight,
    rowHeaderWidth,
    bodyWidth,
    bodyHeight,
    rowCount,
    columnCount,
    rows: Object.freeze({ visible: visibleRows, overscan: overscanRowRange }),
    columns: Object.freeze({ visible: visibleColumns, overscan: overscanColumnRange }),
    visibleColumns: materializeColumns(
      metadata,
      columnWidths,
      prefixes,
      visibleColumns,
      rowHeaderWidth,
      horizontal.logicalOffset,
    ),
    overscanColumns: materializeColumns(
      metadata,
      columnWidths,
      prefixes,
      overscanColumnRange,
      rowHeaderWidth,
      horizontal.logicalOffset,
    ),
    horizontal,
    vertical,
    spacerWidth: rowHeaderWidth + horizontal.physicalContentSize,
    spacerHeight: headerHeight + vertical.physicalContentSize,
  });
}

export function createScrollAxis(
  logicalContentSize: number,
  logicalViewportSize: number,
  physicalOffset: number,
  pixelLimit = DEFAULT_SCROLL_PIXEL_LIMIT,
): Readonly<ScrollAxisLayout> {
  nonNegativeFinite(logicalContentSize, "logicalContentSize");
  nonNegativeFinite(logicalViewportSize, "logicalViewportSize");
  positiveFinite(pixelLimit, "pixelLimit");
  const logicalMaxOffset = Math.max(0, logicalContentSize - logicalViewportSize);
  const largestUsableSize = Math.max(pixelLimit, logicalViewportSize + 1);
  const physicalContentSize = Math.min(logicalContentSize, largestUsableSize);
  const physicalMaxOffset = Math.max(0, physicalContentSize - logicalViewportSize);
  const normalizedPhysicalOffset = clampFinite(physicalOffset, 0, physicalMaxOffset);
  const compressed = logicalMaxOffset > physicalMaxOffset;
  const logicalOffset = physicalMaxOffset === 0
    ? 0
    : compressed
      ? (normalizedPhysicalOffset / physicalMaxOffset) * logicalMaxOffset
      : normalizedPhysicalOffset;
  return Object.freeze({
    logicalContentSize,
    logicalViewportSize,
    logicalOffset,
    logicalMaxOffset,
    physicalContentSize,
    physicalOffset: normalizedPhysicalOffset,
    physicalMaxOffset,
    compressed,
  });
}

export function logicalToPhysicalOffset(axis: ScrollAxisLayout, logicalOffset: number): number {
  const normalized = clampFinite(logicalOffset, 0, axis.logicalMaxOffset);
  if (!axis.compressed) {
    return Math.min(normalized, axis.physicalMaxOffset);
  }
  return axis.logicalMaxOffset === 0
    ? 0
    : (normalized / axis.logicalMaxOffset) * axis.physicalMaxOffset;
}

export function physicalToLogicalOffset(axis: ScrollAxisLayout, physicalOffset: number): number {
  const normalized = clampFinite(physicalOffset, 0, axis.physicalMaxOffset);
  if (!axis.compressed) {
    return Math.min(normalized, axis.logicalMaxOffset);
  }
  return axis.physicalMaxOffset === 0
    ? 0
    : (normalized / axis.physicalMaxOffset) * axis.logicalMaxOffset;
}

export function hitTest(
  layout: TableLayout,
  x: number,
  y: number,
  columnWidths: readonly number[],
  resizeHandleWidth = 6,
): HitTestResult {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
    || x >= layout.width || y >= layout.height) {
    return Object.freeze({ kind: "outside" });
  }
  if (x < layout.rowHeaderWidth && y < layout.headerHeight) {
    return Object.freeze({ kind: "corner" });
  }
  if (y < layout.headerHeight) {
    const offsets = columnOffsets(columnWidths);
    const logicalX = x - layout.rowHeaderWidth + layout.horizontal.logicalOffset;
    const nextBoundary = lowerBound(offsets, logicalX);
    const handleWidth = Math.max(0, resizeHandleWidth);
    for (const boundaryIndex of [nextBoundary, nextBoundary - 1]) {
      if (boundaryIndex <= 0 || boundaryIndex >= offsets.length) {
        continue;
      }
      const boundaryX = layout.rowHeaderWidth
        + offsets[boundaryIndex]!
        - layout.horizontal.logicalOffset;
      if (Math.abs(x - boundaryX) <= handleWidth) {
        return Object.freeze({
          kind: "column-resize",
          columnIndex: boundaryIndex - 1,
          boundaryX,
        });
      }
    }
    const columnIndex = columnAtViewportX(layout, x, columnWidths);
    if (columnIndex === null) {
      return Object.freeze({ kind: "outside" });
    }
    return Object.freeze({ kind: "column-header", columnIndex });
  }
  const rowIndex = rowAtViewportY(layout, y);
  if (rowIndex === null) {
    return Object.freeze({ kind: "outside" });
  }
  if (x < layout.rowHeaderWidth) {
    return Object.freeze({ kind: "row-header", rowIndex });
  }
  const columnIndex = columnAtViewportX(layout, x, columnWidths);
  return columnIndex === null
    ? Object.freeze({ kind: "outside" })
    : Object.freeze({ kind: "cell", rowIndex, columnIndex });
}

export function cellRect(
  layout: TableLayout,
  columnWidths: readonly number[],
  rowIndex: number,
  columnIndex: number,
): Readonly<PixelRect> {
  const offsets = columnOffsets(columnWidths);
  return Object.freeze({
    x: layout.rowHeaderWidth + offsets[columnIndex]! - layout.horizontal.logicalOffset,
    y: layout.headerHeight + (rowIndex * layout.rowHeight) - layout.vertical.logicalOffset,
    width: columnWidths[columnIndex] ?? 0,
    height: layout.rowHeight,
  });
}

export function columnHeaderRect(
  layout: TableLayout,
  columnWidths: readonly number[],
  columnIndex: number,
): Readonly<PixelRect> {
  const offsets = columnOffsets(columnWidths);
  return Object.freeze({
    x: layout.rowHeaderWidth + offsets[columnIndex]! - layout.horizontal.logicalOffset,
    y: 0,
    width: columnWidths[columnIndex] ?? 0,
    height: layout.headerHeight,
  });
}

export function rowHeaderRect(layout: TableLayout, rowIndex: number): Readonly<PixelRect> {
  return Object.freeze({
    x: 0,
    y: layout.headerHeight + (rowIndex * layout.rowHeight) - layout.vertical.logicalOffset,
    width: layout.rowHeaderWidth,
    height: layout.rowHeight,
  });
}

export function selectionRect(
  layout: TableLayout,
  columnWidths: readonly number[],
  range: GridRange,
): Readonly<PixelRect> | null {
  if (range.rowStart >= range.rowEnd || range.columnStart >= range.columnEnd) {
    return null;
  }
  const offsets = columnOffsets(columnWidths);
  const columnStart = clampInteger(range.columnStart, 0, columnWidths.length);
  const columnEnd = clampInteger(range.columnEnd, columnStart, columnWidths.length);
  const rowStart = clampInteger(range.rowStart, 0, layout.rowCount);
  const rowEnd = clampInteger(range.rowEnd, rowStart, layout.rowCount);
  if (columnStart === columnEnd || rowStart === rowEnd) {
    return null;
  }
  return Object.freeze({
    x: layout.rowHeaderWidth + offsets[columnStart]! - layout.horizontal.logicalOffset,
    y: layout.headerHeight + (rowStart * layout.rowHeight) - layout.vertical.logicalOffset,
    width: offsets[columnEnd]! - offsets[columnStart]!,
    height: (rowEnd - rowStart) * layout.rowHeight,
  });
}

export function columnOffsets(columnWidths: readonly number[]): readonly number[] {
  const offsets = new Array<number>(columnWidths.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < columnWidths.length; index += 1) {
    offsets[index + 1] = offsets[index]! + (columnWidths[index] ?? DEFAULT_COLUMN_WIDTH);
  }
  return offsets;
}

export function extentValue(extent: TableMetadata["extent"]["rows"]): number {
  return extent.kind === "unknown" ? 0 : extent.value;
}

function visibleRowRange(
  rowCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): Readonly<IndexRange> {
  if (rowCount === 0 || viewportHeight <= 0) {
    return Object.freeze({ start: 0, end: 0 });
  }
  const start = clampInteger(Math.floor(scrollTop / rowHeight), 0, rowCount);
  const end = clampInteger(Math.ceil((scrollTop + viewportHeight) / rowHeight), start, rowCount);
  return Object.freeze({ start, end });
}

function visibleColumnRange(
  offsets: readonly number[],
  scrollLeft: number,
  viewportWidth: number,
): Readonly<IndexRange> {
  const count = Math.max(0, offsets.length - 1);
  if (count === 0 || viewportWidth <= 0) {
    return Object.freeze({ start: 0, end: 0 });
  }
  const start = columnAtLogicalX(offsets, scrollLeft) ?? count;
  const end = Math.min(count, lowerBound(offsets, scrollLeft + viewportWidth));
  return Object.freeze({ start, end: Math.max(start, end) });
}

function expandRange(range: IndexRange, amount: number, limit: number): Readonly<IndexRange> {
  return Object.freeze({
    start: Math.max(0, range.start - amount),
    end: Math.min(limit, range.end + amount),
  });
}

function materializeColumns(
  metadata: Readonly<TableMetadata>,
  widths: readonly number[],
  offsets: readonly number[],
  range: IndexRange,
  rowHeaderWidth: number,
  scrollLeft: number,
): readonly Readonly<VisibleColumn>[] {
  const columns: VisibleColumn[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const column = metadata.schema.columns[index]!;
    columns.push(Object.freeze({
      index,
      id: column.id,
      name: column.name,
      x: rowHeaderWidth + offsets[index]! - scrollLeft,
      width: widths[index]!,
    }));
  }
  return Object.freeze(columns);
}

function columnAtViewportX(
  layout: TableLayout,
  x: number,
  columnWidths: readonly number[],
): number | null {
  if (x < layout.rowHeaderWidth) {
    return null;
  }
  return columnAtLogicalX(
    columnOffsets(columnWidths),
    x - layout.rowHeaderWidth + layout.horizontal.logicalOffset,
  );
}

function columnAtLogicalX(offsets: readonly number[], x: number): number | null {
  const count = Math.max(0, offsets.length - 1);
  if (x < 0 || count === 0 || x >= offsets[count]!) {
    return null;
  }
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1]! <= x) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function rowAtViewportY(layout: TableLayout, y: number): number | null {
  const logicalY = y - layout.headerHeight + layout.vertical.logicalOffset;
  const rowIndex = Math.floor(logicalY / layout.rowHeight);
  return rowIndex >= 0 && rowIndex < layout.rowCount ? rowIndex : null;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
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

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
