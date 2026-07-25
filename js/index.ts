/** The current maturity of the experimental M4 API. */
export const PROJECT_STATUS = "pre-alpha" as const;

/** Immutable row and column counts for an exact table. */
export interface TableShape {
  readonly rows: number;
  readonly columns: number;
}

/** Creates immutable exact shape metadata for a table. */
export function createTableShape(rows: number, columns: number): Readonly<TableShape> {
  assertCount(rows, "rows");
  assertCount(columns, "columns");
  return Object.freeze({ rows, columns });
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    // Preserve the original prototype API's RangeError behavior.
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export { createEngine } from "./client.js";
export { delimitedAdapter } from "./adapters.js";
export type {
  DatasetEvent,
  DatasetSession,
  EngineOptions,
  OpenSourceOptions,
  ReadRangeOptions,
  RuntimeProgress,
  SourceWarning,
  TableEvent,
  TableHandle,
  TabularkEngine,
  Unsubscribe,
} from "./client.js";
export type {
  AdapterDescriptor,
  ArrowIpcAdapterOptions,
  ArrowIpcContainer,
  DelimitedAdapterOptions,
  DelimitedDialect,
  HeaderMode,
  OfficialAdapterId,
  ParseMode,
} from "./adapters.js";
export { TabularkError } from "./errors.js";
export type { TabularkErrorCode } from "./errors.js";
export {
  DEFAULT_MEMORY_BUDGET_BYTES,
  DEFAULT_TO_ROWS_CELL_LIMIT,
  MAX_NESTING_DEPTH,
  MAX_ARRAY_BUFFER_BYTES,
  MAX_RANGE_CELLS,
} from "./model.js";
export type {
  ArrowDataType,
  ArrowField,
  AxisExtent,
  BatchBufferRegion,
  ColumnSchema,
  DecimalValue,
  DisplayColumnDescriptor,
  IntervalValue,
  MapEntryValue,
  NativeColumnDescriptor,
  NativeValue,
  RangeRequest,
  ReturnedRange,
  TableBatch,
  TableBatchColumn,
  TableCapabilities,
  TableDescriptor,
  TableExtent,
  TableMetadata,
  ToRowsOptions,
  TemporalValue,
  TimeUnit,
  UnionValue,
} from "./model.js";
export { ADAPTER_API_VERSION, BATCH_LAYOUT_VERSION, PROTOCOL_VERSION } from "./protocol.js";

export { createCanvasTableView } from "./view/canvas-table-view.js";
export type {
  CanvasTableView,
  CanvasTableViewOptions,
} from "./view/canvas-table-view.js";
export {
  CanvasTablePainter,
  DEFAULT_CANVAS_TABLE_THEME,
} from "./view/canvas-painter.js";
export type {
  CanvasPaintActiveCell,
  CanvasPaintCell,
  CanvasPaintColumn,
  CanvasPaintRow,
  CanvasPaintSelection,
  CanvasPaintSnapshot,
  CanvasTableTheme,
} from "./view/canvas-painter.js";
export { createTableController } from "./view/controller.js";
export type { TableViewController } from "./view/controller.js";
export {
  cellRect,
  columnHeaderRect,
  createScrollAxis,
  createTableLayout,
  hitTest,
  logicalToPhysicalOffset,
  physicalToLogicalOffset,
  rowHeaderRect,
  selectionRect,
} from "./view/layout.js";
export type { LayoutOptions } from "./view/layout.js";
export {
  clampCell,
  containsCell,
  createSelection,
  moveCell,
  selectionRange,
} from "./view/selection.js";
export {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_HEADER_HEIGHT,
  DEFAULT_MAX_COLUMN_WIDTH,
  DEFAULT_MIN_COLUMN_WIDTH,
  DEFAULT_OVERSCAN_COLUMNS,
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_ROW_HEADER_WIDTH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_SCROLL_PIXEL_LIMIT,
} from "./view/types.js";
export type {
  CellLoadState,
  CellPosition,
  GridRange,
  HitTestResult,
  IndexRange,
  MoveActiveCellOptions,
  NavigationCommand,
  PixelRect,
  ScrollAxisLayout,
  SetActiveCellOptions,
  TableControllerOptions,
  TableLayout,
  TableSelection,
  TableViewSnapshot,
  TableViewStatus,
  ViewportUpdate,
  VisibleColumn,
} from "./view/types.js";
