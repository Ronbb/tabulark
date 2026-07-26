/**
 * Low-level view primitives. This entrypoint is explicitly experimental and
 * may change incompatibly in any release.
 */
export {
  CanvasTablePainter,
  DEFAULT_CANVAS_TABLE_THEME,
} from "./view/canvas-painter.js";
export type {
  CanvasPaintActiveCell,
  CanvasPaintCell,
  CanvasPaintColumn,
  CanvasPaintMergedCell,
  CanvasPaintRow,
  CanvasPaintSelection,
  CanvasPaintSnapshot,
  CanvasTableTheme,
} from "./view/canvas-painter.js";
export { createTableController } from "./view/controller.js";
export type { TableViewController } from "./view/controller.js";
export {
  axisIndexAtOffset,
  axisPosition,
  axisSize,
  cellRect,
  columnHeaderRect,
  createSparseAxisGeometry,
  createScrollAxis,
  createTableLayout,
  hitTest,
  logicalToPhysicalOffset,
  nextVisibleAxisIndex,
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
  SparseAxisGeometry,
  SparseAxisOverride,
  SetActiveCellOptions,
  TableControllerOptions,
  TableLayout,
  TableSelection,
  TableViewSnapshot,
  TableViewStatus,
  ViewportUpdate,
  VisibleColumn,
  VisibleRow,
} from "./view/types.js";
