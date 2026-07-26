import { invalidArgument } from "../errors.js";
import type { PresentationAxisEntry, TableMetadata } from "../model.js";
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
  type SparseAxisGeometry,
  type TableLayout,
  type ViewportUpdate,
  type VisibleColumn,
  type VisibleRow,
} from "./types.js";

export interface LayoutOptions {
  readonly rowHeight?: number;
  readonly headerHeight?: number;
  readonly rowHeaderWidth?: number;
  readonly scrollPixelLimit?: number;
  readonly overscanRows?: number;
  readonly overscanColumns?: number;
  readonly rowEntries?: readonly PresentationAxisEntry[];
  readonly hiddenColumns?: readonly boolean[];
  readonly frozenRows?: number;
  readonly frozenColumns?: number;
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
  const hiddenColumns = options.hiddenColumns ?? [];
  if (hiddenColumns.length !== 0 && hiddenColumns.length !== columnCount) {
    throw invalidArgument(
      `hiddenColumns has ${hiddenColumns.length} entries; expected ${columnCount}`,
    );
  }
  const effectiveColumnWidths = Object.freeze(columnWidths.map(
    (width, index) => hiddenColumns[index] === true ? 0 : width,
  ));

  const rowCount = extentValue(metadata.extent.rows);
  const frozenRowCount = Math.min(
    rowCount,
    nonNegativeInteger(options.frozenRows ?? 0, "frozenRows"),
  );
  const frozenColumnCount = Math.min(
    columnCount,
    nonNegativeInteger(options.frozenColumns ?? 0, "frozenColumns"),
  );
  const bodyWidth = Math.max(0, width - rowHeaderWidth);
  const bodyHeight = Math.max(0, height - headerHeight);
  const prefixes = columnOffsets(effectiveColumnWidths);
  const rowGeometry = createSparseAxisGeometry(
    rowCount,
    rowHeight,
    options.rowEntries ?? [],
  );
  const logicalWidth = prefixes[prefixes.length - 1] ?? 0;
  const logicalHeight = rowGeometry.contentSize;
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
    rowGeometry,
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
  const frozenRowExtent = axisPosition(rowGeometry, frozenRowCount);
  const frozenColumnExtent = prefixes[frozenColumnCount] ?? 0;
  const frozenRowRange = frozenRowCount === 0
    ? Object.freeze({ start: 0, end: 0 })
    : clampRangeEnd(
      visibleRowRange(rowGeometry, 0, Math.min(bodyHeight, frozenRowExtent)),
      frozenRowCount,
    );
  const frozenColumnRange = frozenColumnCount === 0
    ? Object.freeze({ start: 0, end: 0 })
    : clampRangeEnd(
      visibleColumnRange(prefixes, 0, Math.min(bodyWidth, frozenColumnExtent)),
      frozenColumnCount,
    );

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
      effectiveColumnWidths,
      prefixes,
      visibleColumns,
      frozenColumnRange,
      rowHeaderWidth,
      horizontal.logicalOffset,
      frozenColumnCount,
    ),
    overscanColumns: materializeColumns(
      metadata,
      effectiveColumnWidths,
      prefixes,
      overscanColumnRange,
      frozenColumnRange,
      rowHeaderWidth,
      horizontal.logicalOffset,
      frozenColumnCount,
    ),
    visibleRows: materializeRows(
      rowGeometry,
      visibleRows,
      frozenRowRange,
      headerHeight,
      vertical.logicalOffset,
      frozenRowCount,
    ),
    overscanRows: materializeRows(
      rowGeometry,
      overscanRowRange,
      frozenRowRange,
      headerHeight,
      vertical.logicalOffset,
      frozenRowCount,
    ),
    effectiveColumnWidths,
    rowGeometry,
    frozenRowCount,
    frozenColumnCount,
    frozenRowExtent,
    frozenColumnExtent,
    frozenRowRange,
    frozenColumnRange,
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
  _columnWidths: readonly number[],
  resizeHandleWidth = 6,
): HitTestResult {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
    || x >= layout.width || y >= layout.height) {
    return Object.freeze({ kind: "outside" });
  }
  const columnWidths = layout.effectiveColumnWidths;
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
  _columnWidths: readonly number[],
  rowIndex: number,
  columnIndex: number,
): Readonly<PixelRect> {
  const columnWidths = layout.effectiveColumnWidths;
  const offsets = columnOffsets(columnWidths);
  const rowOffset = axisPosition(layout.rowGeometry, rowIndex);
  const columnOffset = offsets[columnIndex] ?? 0;
  return Object.freeze({
    x: layout.rowHeaderWidth + columnOffset
      - (columnIndex < layout.frozenColumnCount ? 0 : layout.horizontal.logicalOffset),
    y: layout.headerHeight + rowOffset
      - (rowIndex < layout.frozenRowCount ? 0 : layout.vertical.logicalOffset),
    width: columnWidths[columnIndex] ?? 0,
    height: axisSize(layout.rowGeometry, rowIndex),
  });
}

export function columnHeaderRect(
  layout: TableLayout,
  _columnWidths: readonly number[],
  columnIndex: number,
): Readonly<PixelRect> {
  const columnWidths = layout.effectiveColumnWidths;
  const offsets = columnOffsets(columnWidths);
  return Object.freeze({
    x: layout.rowHeaderWidth + offsets[columnIndex]!
      - (columnIndex < layout.frozenColumnCount ? 0 : layout.horizontal.logicalOffset),
    y: 0,
    width: columnWidths[columnIndex] ?? 0,
    height: layout.headerHeight,
  });
}

export function rowHeaderRect(layout: TableLayout, rowIndex: number): Readonly<PixelRect> {
  const rowOffset = axisPosition(layout.rowGeometry, rowIndex);
  return Object.freeze({
    x: 0,
    y: layout.headerHeight + rowOffset
      - (rowIndex < layout.frozenRowCount ? 0 : layout.vertical.logicalOffset),
    width: layout.rowHeaderWidth,
    height: axisSize(layout.rowGeometry, rowIndex),
  });
}

export function selectionRect(
  layout: TableLayout,
  _columnWidths: readonly number[],
  range: GridRange,
): Readonly<PixelRect> | null {
  const columnWidths = layout.effectiveColumnWidths;
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
  const frozenColumns = columnEnd <= layout.frozenColumnCount;
  const frozenRows = rowEnd <= layout.frozenRowCount;
  const rowStartOffset = axisPosition(layout.rowGeometry, rowStart);
  const rowEndOffset = axisPosition(layout.rowGeometry, rowEnd);
  return Object.freeze({
    x: layout.rowHeaderWidth + offsets[columnStart]!
      - (frozenColumns ? 0 : layout.horizontal.logicalOffset),
    y: layout.headerHeight + rowStartOffset
      - (frozenRows ? 0 : layout.vertical.logicalOffset),
    width: offsets[columnEnd]! - offsets[columnStart]!,
    height: rowEndOffset - rowStartOffset,
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

/** Builds a compact sparse axis without allocating one entry per worksheet row. */
export function createSparseAxisGeometry(
  count: number,
  defaultSize: number,
  entries: readonly PresentationAxisEntry[] = [],
): Readonly<SparseAxisGeometry> {
  nonNegativeInteger(count, "axis count");
  positiveFinite(defaultSize, "axis defaultSize");
  const byIndex = new Map<number, number>();
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= count) {
      continue;
    }
    if (entry.hidden === true) {
      byIndex.set(entry.index, 0);
      continue;
    }
    if (entry.size !== undefined) {
      if (!Number.isFinite(entry.size) || entry.size < 0) {
        continue;
      }
      byIndex.set(entry.index, entry.size);
    }
  }
  let cumulativeDelta = 0;
  const overrides = [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, size]) => {
      cumulativeDelta += size - defaultSize;
      return Object.freeze({ index, size, cumulativeDelta });
    });
  const contentSize = count * defaultSize + cumulativeDelta;
  return Object.freeze({
    count,
    defaultSize,
    contentSize: Math.max(0, contentSize),
    overrides: Object.freeze(overrides),
  });
}

/** Logical offset at the start of an axis index. */
export function axisPosition(geometry: SparseAxisGeometry, index: number): number {
  const normalized = clampInteger(index, 0, geometry.count);
  const overrideIndex = lowerBoundOverride(geometry.overrides, normalized);
  const delta = overrideIndex === 0 ? 0 : geometry.overrides[overrideIndex - 1]!.cumulativeDelta;
  return normalized * geometry.defaultSize + delta;
}

/** Effective axis extent, zero when a row/column is hidden. */
export function axisSize(geometry: SparseAxisGeometry, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= geometry.count) {
    return 0;
  }
  const match = sparseOverrideAt(geometry, index);
  return match?.size ?? geometry.defaultSize;
}

/** Finds the visible axis index containing a logical pixel offset. */
export function axisIndexAtOffset(geometry: SparseAxisGeometry, offset: number): number | null {
  if (!Number.isFinite(offset) || offset < 0 || offset >= geometry.contentSize || geometry.count === 0) {
    return null;
  }
  let low = 0;
  let high = geometry.count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (axisPosition(geometry, middle + 1) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low; index < geometry.count; index += 1) {
    const size = axisSize(geometry, index);
    const start = axisPosition(geometry, index);
    if (size > 0 && offset >= start && offset < start + size) {
      return index;
    }
    if (start > offset) {
      return null;
    }
  }
  return null;
}

export function nextVisibleAxisIndex(
  geometry: SparseAxisGeometry,
  from: number,
  direction: -1 | 1 = 1,
): number | null {
  for (
    let index = clampInteger(from, 0, Math.max(0, geometry.count - 1));
    index >= 0 && index < geometry.count;
    index += direction
  ) {
    if (axisSize(geometry, index) > 0) {
      return index;
    }
  }
  return null;
}

function sparseOverrideAt(
  geometry: SparseAxisGeometry,
  index: number,
): Readonly<SparseAxisGeometry["overrides"][number]> | undefined {
  const low = lowerBoundOverride(geometry.overrides, index);
  const candidate = geometry.overrides[low];
  return candidate?.index === index ? candidate : undefined;
}

function lowerBoundOverride(
  entries: readonly Readonly<SparseAxisGeometry["overrides"][number]>[],
  target: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle]!.index < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function clampRangeEnd(range: IndexRange, end: number): Readonly<IndexRange> {
  return Object.freeze({
    start: Math.min(range.start, end),
    end: Math.min(range.end, end),
  });
}

function visibleRowRange(
  geometry: SparseAxisGeometry,
  scrollTop: number,
  viewportHeight: number,
): Readonly<IndexRange> {
  if (geometry.count === 0 || viewportHeight <= 0 || geometry.contentSize <= 0) {
    return Object.freeze({ start: 0, end: 0 });
  }
  const start = axisIndexAtOffset(geometry, scrollTop);
  if (start === null) {
    return Object.freeze({ start: geometry.count, end: geometry.count });
  }
  const last = axisIndexAtOffset(
    geometry,
    Math.max(
      scrollTop,
      Math.min(geometry.contentSize, scrollTop + viewportHeight)
        - Math.max(1e-7, Math.abs(scrollTop + viewportHeight) * Number.EPSILON * 4),
    ),
  );
  return Object.freeze({
    start,
    end: last === null ? start + 1 : Math.min(geometry.count, last + 1),
  });
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
  frozenRange: IndexRange,
  rowHeaderWidth: number,
  scrollLeft: number,
  frozenColumnCount: number,
): readonly Readonly<VisibleColumn>[] {
  const indexes = rangeIndexes(range, frozenRange);
  const columns: VisibleColumn[] = [];
  for (const index of indexes) {
    const column = metadata.schema.columns[index]!;
    const width = widths[index] ?? 0;
    if (width <= 0) {
      continue;
    }
    const frozen = index < frozenColumnCount;
    columns.push(Object.freeze({
      index,
      id: column.id,
      name: column.name,
      x: rowHeaderWidth + offsets[index]! - (frozen ? 0 : scrollLeft),
      width,
      frozen,
    }));
  }
  return Object.freeze(columns);
}

function materializeRows(
  geometry: SparseAxisGeometry,
  range: IndexRange,
  frozenRange: IndexRange,
  headerHeight: number,
  scrollTop: number,
  frozenRowCount: number,
): readonly Readonly<VisibleRow>[] {
  const rows: VisibleRow[] = [];
  for (const index of rangeIndexes(range, frozenRange)) {
    const height = axisSize(geometry, index);
    if (height <= 0) {
      continue;
    }
    const frozen = index < frozenRowCount;
    rows.push(Object.freeze({
      index,
      y: headerHeight + axisPosition(geometry, index) - (frozen ? 0 : scrollTop),
      height,
      frozen,
    }));
  }
  return Object.freeze(rows);
}

function rangeIndexes(primary: IndexRange, frozen: IndexRange): readonly number[] {
  const indexes = new Set<number>();
  for (let index = primary.start; index < primary.end; index += 1) {
    indexes.add(index);
  }
  for (let index = frozen.start; index < frozen.end; index += 1) {
    indexes.add(index);
  }
  return Object.freeze([...indexes].sort((left, right) => left - right));
}

function columnAtViewportX(
  layout: TableLayout,
  x: number,
  columnWidths: readonly number[],
): number | null {
  if (x < layout.rowHeaderWidth) {
    return null;
  }
  const bodyX = x - layout.rowHeaderWidth;
  if (bodyX < Math.min(layout.bodyWidth, layout.frozenColumnExtent)) {
    const frozen = columnAtLogicalX(columnOffsets(columnWidths), bodyX);
    if (frozen !== null && frozen < layout.frozenColumnCount) {
      return frozen;
    }
  }
  return columnAtLogicalX(
    columnOffsets(columnWidths),
    bodyX + layout.horizontal.logicalOffset,
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
  const bodyY = y - layout.headerHeight;
  if (bodyY < Math.min(layout.bodyHeight, layout.frozenRowExtent)) {
    const frozen = axisIndexAtOffset(layout.rowGeometry, bodyY);
    if (frozen !== null && frozen < layout.frozenRowCount) {
      return frozen;
    }
  }
  return axisIndexAtOffset(
    layout.rowGeometry,
    bodyY + layout.vertical.logicalOffset,
  );
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
