import type { TableMetadata } from "../model.js";

export const DEFAULT_ROW_HEIGHT = 28;
export const DEFAULT_HEADER_HEIGHT = 36;
export const DEFAULT_ROW_HEADER_WIDTH = 64;
export const DEFAULT_COLUMN_WIDTH = 160;
export const DEFAULT_MIN_COLUMN_WIDTH = 64;
export const DEFAULT_MAX_COLUMN_WIDTH = 640;
export const DEFAULT_SCROLL_PIXEL_LIMIT = 16_000_000;
export const DEFAULT_OVERSCAN_ROWS = 8;
export const DEFAULT_OVERSCAN_COLUMNS = 1;

/** A zero-based table coordinate. */
export interface CellPosition {
  readonly rowIndex: number;
  readonly columnIndex: number;
}

/** A zero-based, half-open rectangular table range. */
export interface GridRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

export interface TableSelection {
  readonly anchor: Readonly<CellPosition>;
  readonly focus: Readonly<CellPosition>;
  readonly range: Readonly<GridRange>;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IndexRange {
  readonly start: number;
  readonly end: number;
}

export interface ScrollAxisLayout {
  readonly logicalContentSize: number;
  readonly logicalViewportSize: number;
  readonly logicalOffset: number;
  readonly logicalMaxOffset: number;
  readonly physicalContentSize: number;
  readonly physicalOffset: number;
  readonly physicalMaxOffset: number;
  readonly compressed: boolean;
}

export interface VisibleColumn {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  /** Viewport-relative left edge in CSS pixels. */
  readonly x: number;
  readonly width: number;
}

export interface TableLayout {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly rowHeight: number;
  readonly headerHeight: number;
  readonly rowHeaderWidth: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: Readonly<{
    readonly visible: Readonly<IndexRange>;
    readonly overscan: Readonly<IndexRange>;
  }>;
  readonly columns: Readonly<{
    readonly visible: Readonly<IndexRange>;
    readonly overscan: Readonly<IndexRange>;
  }>;
  readonly visibleColumns: readonly Readonly<VisibleColumn>[];
  readonly overscanColumns: readonly Readonly<VisibleColumn>[];
  readonly horizontal: Readonly<ScrollAxisLayout>;
  readonly vertical: Readonly<ScrollAxisLayout>;
  /** Spacer dimensions for a native scroll host, including sticky headers. */
  readonly spacerWidth: number;
  readonly spacerHeight: number;
}

export type HitTestResult =
  | Readonly<{ kind: "outside" }>
  | Readonly<{ kind: "corner" }>
  | Readonly<{ kind: "column-header"; columnIndex: number }>
  | Readonly<{ kind: "column-resize"; columnIndex: number; boundaryX: number }>
  | Readonly<{ kind: "row-header"; rowIndex: number }>
  | Readonly<{ kind: "cell"; rowIndex: number; columnIndex: number }>;

export type CellLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "loaded"; value: string | null }>;

export type TableViewStatus = "loading" | "ready" | "error" | "closed";

export interface TableViewSnapshot {
  readonly generation: number;
  readonly status: TableViewStatus;
  readonly metadata: Readonly<TableMetadata>;
  readonly layout: Readonly<TableLayout>;
  readonly activeCell: Readonly<CellPosition> | null;
  readonly selection: Readonly<TableSelection> | null;
  readonly error?: unknown;
}

export interface ViewportUpdate {
  readonly width: number;
  readonly height: number;
  /** Native scroll-host offset in CSS pixels. */
  readonly scrollLeft: number;
  /** Native scroll-host offset in CSS pixels. */
  readonly scrollTop: number;
  readonly devicePixelRatio?: number;
}

export interface TableControllerOptions {
  readonly rowHeight?: number;
  readonly headerHeight?: number;
  readonly rowHeaderWidth?: number;
  readonly columnWidth?: number;
  readonly minColumnWidth?: number;
  readonly maxColumnWidth?: number;
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly scrollPixelLimit?: number;
  readonly overscanRows?: number;
  readonly overscanColumns?: number;
  /** Hard bound for decoded render/cache cells. */
  readonly maxWindowCells?: number;
}

export type NavigationCommand =
  | "left"
  | "right"
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "row-start"
  | "row-end"
  | "table-start"
  | "table-end";

export interface SetActiveCellOptions {
  readonly extendSelection?: boolean;
  readonly scrollIntoView?: boolean;
}

export interface MoveActiveCellOptions extends SetActiveCellOptions {}
