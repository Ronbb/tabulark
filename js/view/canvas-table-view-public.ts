import type { TableHandle } from "../client.js";
import { createCanvasTableView as createInternalCanvasTableView } from "./canvas-table-view.js";

/** Stable, high-level sizing and cache controls for the Canvas table view. */
export interface CanvasTableViewControllerOptions {
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

/** Stable theme tokens accepted by the high-level Canvas table view. */
export interface CanvasTableViewTheme {
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly headerBackground: string;
  readonly headerForeground: string;
  readonly alternateRowBackground: string;
  readonly gridLine: string;
  readonly selectionBackground: string;
  readonly selectionBorder: string;
  readonly activeCellBorder: string;
  readonly loadingBackground: string;
  readonly font: string;
  readonly headerFont: string;
}

/** Stable options for mounting a Canvas preview from a logical table handle. */
export interface CanvasTableViewOptions {
  readonly container: HTMLElement;
  readonly table: TableHandle;
  readonly controllerOptions?: CanvasTableViewControllerOptions;
  /**
   * Applies static spreadsheet presentation metadata when available.
   * Workbook colors never override the system palette in forced-colors mode.
   */
  readonly presentation?: "auto" | "ignore";
  readonly ariaLabel?: string;
  readonly theme?: Partial<CanvasTableViewTheme>;
  readonly maxDevicePixelRatio?: number;
  /** Testable clipboard seam; navigator.clipboard.writeText is used by default. */
  readonly writeClipboard?: (text: string) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
}

/** Stable lifecycle surface for a mounted Canvas table view. */
export interface CanvasTableView {
  readonly element: HTMLDivElement;
  focus(options?: FocusOptions): void;
  destroy(): void;
  dispose(): void;
}

/** Mounts an accessible, viewport-driven Canvas preview. */
export function createCanvasTableView(options: CanvasTableViewOptions): CanvasTableView {
  return createInternalCanvasTableView(options);
}
