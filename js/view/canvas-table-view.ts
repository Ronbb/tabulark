import type { TableHandle } from "../client.js";
import type {
  MergedCellRegion,
  PresentationRange,
  PresentationStyle,
  RangeRequest,
  SpreadsheetPresentation,
} from "../model.js";
import { TabularkError, invalidArgument } from "../errors.js";
import { containsCell } from "./selection.js";
import { AccessibleViewportGrid, type AccessibleGridRow } from "./accessible-grid.js";
import {
  CanvasTablePainter,
  DEFAULT_CANVAS_TABLE_THEME,
  forcedColorsCanvasTableTheme,
  type CanvasPaintColumn,
  type CanvasPaintMergedCell,
  type CanvasPaintRow,
  type CanvasTableTheme,
} from "./canvas-painter.js";
import { createTableController, type TableViewController } from "./controller.js";
import type {
  CellPosition,
  NavigationCommand,
  TableControllerOptions,
  TableViewSnapshot,
} from "./types.js";

const RESIZE_HANDLE_WIDTH = 8;
const RESIZE_TARGET_SIZE = 44;
const KEYBOARD_RESIZE_STEP = 8;
const KEYBOARD_RESIZE_COARSE_STEP = 32;
const AUTOSIZE_HORIZONTAL_PADDING = 24;
const MAX_PRESENTATION_WINDOW_CELLS = 100_000;

/**
 * Palette used when a high-level view is explicitly or automatically dark.
 * Keep these tokens aligned with the Playground's dark CSS palette so the
 * Canvas surface does not look like a separate theme from its host page.
 */
const DARK_CANVAS_TABLE_THEME: Readonly<CanvasTableTheme> = Object.freeze({
  background: "#182235",
  foreground: "#edf0f7",
  mutedForeground: "#b5c0d4",
  headerBackground: "#202c42",
  headerForeground: "#edf0f7",
  alternateRowBackground: "#202c42",
  gridLine: "#526079",
  selectionBackground: "rgba(167, 139, 250, 0.24)",
  selectionBorder: "#a78bfa",
  activeCellBorder: "#c4b5fd",
  loadingBackground: "#526079",
  font: '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  headerFont: '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
});

type CanvasColorScheme = "auto" | "light" | "dark";
type ResolvedCanvasColorScheme = Exclude<CanvasColorScheme, "auto">;

let nextViewId = 1;

export interface CanvasTableViewOptions {
  readonly container: HTMLElement;
  /** Provide either a table or a preconfigured controller, never both. */
  readonly table?: TableHandle;
  /** Provide either a controller or a table, never both. */
  readonly controller?: TableViewController;
  readonly controllerOptions?: TableControllerOptions;
  /**
   * Selects the table palette. `light` is the compatibility default;
   * `auto` follows the browser's `prefers-color-scheme` media query.
   * Forced-colors mode always takes precedence over this setting.
   */
  readonly colorScheme?: CanvasColorScheme;
  /**
   * Applies static spreadsheet sizing metadata when a TableHandle provides it.
   * Workbook colors never override the system palette in forced-colors mode.
   */
  readonly presentation?: "auto" | "ignore";
  readonly ariaLabel?: string;
  readonly theme?: Partial<CanvasTableTheme>;
  readonly maxDevicePixelRatio?: number;
  /** Testable clipboard seam; navigator.clipboard.writeText is used by default. */
  readonly writeClipboard?: (text: string) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
}

export interface CanvasTableView {
  readonly element: HTMLDivElement;
  readonly controller: TableViewController;
  focus(options?: FocusOptions): void;
  destroy(): void;
  dispose(): void;
}

type PointerInteraction =
  | Readonly<{
    kind: "resize";
    pointerId: number;
    columnIndex: number;
    startClientX: number;
    startWidth: number;
  }>
  | Readonly<{
    kind: "select";
    pointerId: number;
    anchor: Readonly<CellPosition>;
  }>;

class View implements CanvasTableView {
  readonly element: HTMLDivElement;
  readonly controller: TableViewController;

  readonly #scrollHost: HTMLDivElement;
  readonly #spacer: HTMLDivElement;
  readonly #surface: HTMLDivElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #resizeLayer: HTMLDivElement;
  readonly #resizeInstructions: HTMLDivElement;
  readonly #message: HTMLDivElement;
  readonly #accessibleGrid: AccessibleViewportGrid;
  readonly #painter: CanvasTablePainter;
  readonly #ownerWindow: Window & typeof globalThis;
  readonly #ownsController: boolean;
  readonly #writeClipboard: ((text: string) => Promise<void> | void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #themeOverrides: Readonly<Partial<CanvasTableTheme>>;
  readonly #colorScheme: CanvasColorScheme;
  readonly #colorSchemeQuery: MediaQueryList | undefined;
  readonly #presentationTable: TableHandle | undefined;
  #theme: Readonly<CanvasTableTheme>;
  readonly #forcedColorsQuery: MediaQueryList;
  readonly #unsubscribe: () => void;
  readonly #resizeObserver?: ResizeObserver;
  readonly #resizeHandles = new Map<string, HTMLDivElement>();

  #snapshot: Readonly<TableViewSnapshot>;
  #frame = 0;
  #interaction: PointerInteraction | null = null;
  #copyAbort: AbortController | null = null;
  #announcementFrame = 0;
  #forcedColors = false;
  #resolvedColorScheme: ResolvedCanvasColorScheme = "light";
  #presentation: SpreadsheetPresentation | null = null;
  #presentationRanges: readonly PresentationRange[] = [];
  #mergedCells: readonly MergedCellRegion[] = [];
  #presentationRequestKey = "";
  #presentationAbort: AbortController | null = null;
  #destroyed = false;

  constructor(options: CanvasTableViewOptions) {
    const ownerDocument = options.container.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) {
      throw invalidArgument("container must belong to an active browser document");
    }
    this.#ownerWindow = ownerWindow;
    const presentation = options.presentation ?? "auto";
    if (presentation !== "auto" && presentation !== "ignore") {
      throw invalidArgument("presentation must be auto or ignore");
    }
    const colorScheme = options.colorScheme ?? "light";
    if (colorScheme !== "auto" && colorScheme !== "light" && colorScheme !== "dark") {
      throw invalidArgument("colorScheme must be auto, light, or dark");
    }
    this.#ownsController = options.table !== undefined;
    this.controller = options.controller
      ?? createTableController(options.table!, options.controllerOptions);
    this.#snapshot = this.controller.getSnapshot();
    this.#writeClipboard = options.writeClipboard;
    this.#onError = options.onError;
    this.#presentationTable = presentation === "auto" ? options.table : undefined;
    this.#colorScheme = colorScheme;
    this.#themeOverrides = Object.freeze({ ...options.theme });
    this.#forcedColorsQuery = ownerWindow.matchMedia("(forced-colors: active)");
    this.#forcedColors = this.#forcedColorsQuery.matches;
    this.#colorSchemeQuery = colorScheme === "auto"
      ? ownerWindow.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
    this.#resolvedColorScheme = colorScheme === "dark"
      ? "dark"
      : colorScheme === "auto" && this.#colorSchemeQuery?.matches === true
        ? "dark"
        : "light";
    this.#theme = this.#resolveTheme();

    this.element = ownerDocument.createElement("div");
    this.element.className = "tabulark-view";
    this.element.dataset.tabularkView = "";
    this.element.setAttribute("aria-label", options.ariaLabel ?? this.#tableLabel());
    Object.assign(this.element.style, {
      background: this.#theme.background,
      border: `1px solid ${this.#theme.gridLine}`,
      borderRadius: "6px",
      boxSizing: "border-box",
      color: this.#theme.foreground,
      contain: "layout paint style",
      height: "100%",
      minHeight: "120px",
      minWidth: "0",
      overflow: "hidden",
      position: "relative",
      width: "100%",
    });

    this.#scrollHost = ownerDocument.createElement("div");
    this.#scrollHost.className = "tabulark-scroll";
    this.#scrollHost.dataset.tabularkScroll = "";
    this.#scrollHost.tabIndex = -1;
    Object.assign(this.#scrollHost.style, {
      inset: "0",
      overflow: "auto",
      overscrollBehavior: "contain",
      position: "absolute",
      scrollbarGutter: "stable",
    });

    this.#spacer = ownerDocument.createElement("div");
    this.#spacer.className = "tabulark-scroll-spacer";
    this.#spacer.dataset.tabularkScrollSpacer = "";
    this.#spacer.setAttribute("aria-hidden", "true");
    Object.assign(this.#spacer.style, {
      left: "0",
      pointerEvents: "none",
      position: "absolute",
      top: "0",
    });

    this.#surface = ownerDocument.createElement("div");
    this.#surface.className = "tabulark-surface";
    this.#surface.dataset.tabularkSurface = "";
    Object.assign(this.#surface.style, {
      left: "0",
      position: "sticky",
      top: "0",
      userSelect: "none",
      zIndex: "1",
    });

    this.#canvas = ownerDocument.createElement("canvas");
    this.#canvas.className = "tabulark-canvas";
    this.#canvas.dataset.tabularkCanvas = "";
    this.#canvas.setAttribute("aria-hidden", "true");
    this.#canvas.draggable = false;
    Object.assign(this.#canvas.style, {
      cursor: "default",
      display: "block",
      touchAction: "pan-x pan-y",
    });

    this.#resizeLayer = ownerDocument.createElement("div");
    this.#resizeLayer.className = "tabulark-resize-layer";
    Object.assign(this.#resizeLayer.style, {
      left: "0",
      pointerEvents: "none",
      position: "absolute",
      top: "0",
      width: "100%",
    });

    this.#resizeInstructions = ownerDocument.createElement("div");
    this.#resizeInstructions.id = `tabulark-resize-instructions-${nextViewId}`;
    nextViewId += 1;
    this.#resizeInstructions.textContent = "Use Left and Right Arrow keys to resize. Hold Shift for larger steps. Home and End use the minimum and maximum widths. Enter fits the visible content.";
    visuallyHide(this.#resizeInstructions);

    this.#message = ownerDocument.createElement("div");
    this.#message.className = "tabulark-message";
    this.#message.dataset.tabularkMessage = "";
    this.#message.setAttribute("aria-hidden", "true");
    Object.assign(this.#message.style, {
      alignItems: "center",
      background: this.#theme.background,
      color: this.#theme.mutedForeground,
      display: "none",
      font: this.#theme.font,
      inset: "0",
      justifyContent: "center",
      padding: "24px",
      pointerEvents: "none",
      position: "absolute",
      textAlign: "center",
      zIndex: "2",
    });

    this.#accessibleGrid = new AccessibleViewportGrid(
      ownerDocument,
      options.ariaLabel ?? this.#tableLabel(),
    );
    this.#painter = new CanvasTablePainter(this.#canvas, {
      theme: this.#theme,
      forcedColors: this.#forcedColors,
      ...(options.maxDevicePixelRatio === undefined
        ? {}
        : { maxDevicePixelRatio: options.maxDevicePixelRatio }),
    });
    this.#applyThemeToElements();

    this.#surface.append(this.#canvas, this.#resizeLayer);
    this.#scrollHost.append(this.#spacer, this.#surface);
    this.element.append(
      this.#scrollHost,
      this.#message,
      this.#accessibleGrid.element,
      this.#accessibleGrid.statusElement,
      this.#resizeInstructions,
    );
    options.container.append(this.element);

    this.#unsubscribe = this.controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      if (this.#isTerminal()) {
        if (this.#resizeLayer.contains(this.element.ownerDocument.activeElement)) {
          this.#accessibleGrid.focus({ preventScroll: true });
        }
        this.#cancelInteraction();
        this.#copyAbort?.abort();
        this.#copyAbort = null;
      }
      this.#schedulePresentationRanges();
      this.#scheduleFrame();
    });
    this.#scrollHost.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#surface.addEventListener("pointerdown", this.#onPointerDown);
    this.#surface.addEventListener("pointermove", this.#onPointerMove);
    this.#surface.addEventListener("pointerup", this.#onPointerUp);
    this.#surface.addEventListener("pointercancel", this.#onPointerUp);
    this.#surface.addEventListener("dblclick", this.#onDoubleClick);
    this.element.addEventListener("keydown", this.#onKeyDown);
    this.element.addEventListener("focusin", this.#onFocusIn);
    this.element.addEventListener("focusout", this.#onFocusOut);
    addMediaQueryListener(this.#forcedColorsQuery, this.#onForcedColorsChange);
    if (this.#colorSchemeQuery !== undefined) {
      addMediaQueryListener(this.#colorSchemeQuery, this.#onColorSchemeChange);
    }

    if (typeof ownerWindow.ResizeObserver === "function") {
      this.#resizeObserver = new ownerWindow.ResizeObserver(() => this.#updateViewport());
      this.#resizeObserver.observe(this.#scrollHost);
    } else {
      ownerWindow.addEventListener("resize", this.#onWindowResize);
    }

    this.#updateViewport();
    this.#scheduleFrame();
    if (this.#presentationTable !== undefined) {
      void this.#applyPresentation(this.#presentationTable);
    }
  }

  focus(options?: FocusOptions): void {
    this.#assertAlive();
    this.#accessibleGrid.focus(options);
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#presentationAbort?.abort();
    this.#presentationAbort = null;
    this.#copyAbort?.abort();
    this.#copyAbort = null;
    if (this.#frame !== 0) {
      this.#ownerWindow.cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    if (this.#announcementFrame !== 0) {
      this.#ownerWindow.cancelAnimationFrame(this.#announcementFrame);
      this.#announcementFrame = 0;
    }
    this.#resizeObserver?.disconnect();
    this.#ownerWindow.removeEventListener("resize", this.#onWindowResize);
    this.#unsubscribe();
    this.#scrollHost.removeEventListener("scroll", this.#onScroll);
    this.#surface.removeEventListener("pointerdown", this.#onPointerDown);
    this.#surface.removeEventListener("pointermove", this.#onPointerMove);
    this.#surface.removeEventListener("pointerup", this.#onPointerUp);
    this.#surface.removeEventListener("pointercancel", this.#onPointerUp);
    this.#surface.removeEventListener("dblclick", this.#onDoubleClick);
    this.element.removeEventListener("keydown", this.#onKeyDown);
    this.element.removeEventListener("focusin", this.#onFocusIn);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    removeMediaQueryListener(this.#forcedColorsQuery, this.#onForcedColorsChange);
    if (this.#colorSchemeQuery !== undefined) {
      removeMediaQueryListener(this.#colorSchemeQuery, this.#onColorSchemeChange);
    }
    this.#accessibleGrid.destroy();
    this.element.remove();
    if (this.#ownsController) {
      this.controller.dispose();
    }
  }

  dispose(): void {
    this.destroy();
  }

  readonly #onScroll = (): void => {
    this.#updateViewport();
  };

  readonly #onWindowResize = (): void => {
    this.#updateViewport();
  };

  readonly #onForcedColorsChange = (event: MediaQueryListEvent): void => {
    if (this.#destroyed) {
      return;
    }
    this.#forcedColors = event.matches;
    this.#theme = this.#resolveTheme();
    this.#painter.setTheme(this.#theme, { forcedColors: this.#forcedColors });
    this.#applyThemeToElements();
    this.#scheduleFrame();
  };

  readonly #onColorSchemeChange = (event: MediaQueryListEvent): void => {
    if (this.#destroyed || this.#colorScheme !== "auto") {
      return;
    }
    this.#resolvedColorScheme = event.matches ? "dark" : "light";
    this.#theme = this.#resolveTheme();
    this.#painter.setTheme(this.#theme, { forcedColors: this.#forcedColors });
    this.#applyThemeToElements();
    this.#scheduleFrame();
  };

  readonly #onFocusIn = (event: FocusEvent): void => {
    this.element.style.outline = `2px solid ${this.#focusColor()}`;
    this.element.style.outlineOffset = "-2px";
    const resizeHandle = this.#resizeHandleFromTarget(event.target);
    if (resizeHandle !== null) {
      resizeHandle.style.outline = `2px solid ${this.#focusColor()}`;
      resizeHandle.style.outlineOffset = "-2px";
      return;
    }
    if (
      !this.#isTerminal()
      && this.#snapshot.activeCell === null
      && this.#hasCells()
      && event.target === this.#accessibleGrid.element
    ) {
      this.controller.setActiveCell({ rowIndex: 0, columnIndex: 0 });
    }
  };

  readonly #onFocusOut = (event: FocusEvent): void => {
    const resizeHandle = this.#resizeHandleFromTarget(event.target);
    if (resizeHandle !== null) {
      resizeHandle.style.outline = "none";
    }
    queueMicrotask(() => {
      if (!this.#destroyed && !this.element.contains(this.element.ownerDocument.activeElement)) {
        this.element.style.outline = "none";
      }
    });
  };

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#isTerminal()) {
      return;
    }
    const position = this.#eventPosition(event);
    const resizeColumn = this.#resizeColumnFromTarget(event.target);
    const hit = resizeColumn === null
      ? this.controller.hitTest(position.x, position.y, RESIZE_HANDLE_WIDTH / 2)
      : { kind: "column-resize" as const, columnIndex: resizeColumn, boundaryX: position.x };

    if (hit.kind === "column-resize") {
      event.preventDefault();
      this.#interaction = Object.freeze({
        kind: "resize",
        pointerId: event.pointerId,
        columnIndex: hit.columnIndex,
        startClientX: event.clientX,
        startWidth: this.controller.columnWidths[hit.columnIndex]!,
      });
      this.#surface.setPointerCapture(event.pointerId);
      this.#surface.style.cursor = "col-resize";
      return;
    }

    const cell = this.#cellFromHit(hit);
    if (cell === null) {
      return;
    }
    this.focus({ preventScroll: true });
    this.controller.setActiveCell(cell, {
      extendSelection: event.shiftKey,
      scrollIntoView: false,
    });
    if (event.pointerType !== "touch") {
      this.#interaction = Object.freeze({
        kind: "select",
        pointerId: event.pointerId,
        anchor: event.shiftKey && this.#snapshot.selection !== null
          ? this.#snapshot.selection.anchor
          : cell,
      });
      this.#surface.setPointerCapture(event.pointerId);
    }
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#isTerminal()) {
      this.#cancelInteraction();
      return;
    }
    if (this.#interaction?.pointerId === event.pointerId) {
      if (this.#interaction.kind === "resize") {
        const delta = event.clientX - this.#interaction.startClientX;
        this.controller.resizeColumn(
          this.#interaction.columnIndex,
          this.#interaction.startWidth + delta,
        );
        return;
      }
      const position = this.#eventPosition(event);
      const hit = this.controller.hitTest(position.x, position.y, 0);
      if (hit.kind === "cell") {
        this.controller.setSelection(this.#interaction.anchor, {
          rowIndex: hit.rowIndex,
          columnIndex: hit.columnIndex,
        });
      }
      return;
    }

    const position = this.#eventPosition(event);
    const hit = this.controller.hitTest(position.x, position.y, RESIZE_HANDLE_WIDTH / 2);
    this.#surface.style.cursor = hit.kind === "column-resize" ? "col-resize" : "default";
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (this.#interaction?.pointerId !== event.pointerId) {
      return;
    }
    const resizedColumn = this.#interaction.kind === "resize"
      ? this.#interaction.columnIndex
      : null;
    if (this.#surface.hasPointerCapture(event.pointerId)) {
      this.#surface.releasePointerCapture(event.pointerId);
    }
    this.#interaction = null;
    this.#surface.style.cursor = "default";
    if (resizedColumn !== null) {
      this.controller.ensureColumnVisible(resizedColumn);
      this.#announceColumnWidth(resizedColumn, false);
    }
  };

  readonly #onDoubleClick = (event: MouseEvent): void => {
    if (this.#isTerminal()) {
      return;
    }
    const position = this.#eventPosition(event);
    const fromTarget = this.#resizeColumnFromTarget(event.target);
    const hit = fromTarget === null
      ? this.controller.hitTest(position.x, position.y, RESIZE_HANDLE_WIDTH / 2)
      : { kind: "column-resize" as const, columnIndex: fromTarget };
    if (hit.kind !== "column-resize") {
      return;
    }
    event.preventDefault();
    this.controller.autosizeColumn(hit.columnIndex, this.#measureColumn(hit.columnIndex));
    this.controller.ensureColumnVisible(hit.columnIndex);
    this.#announceColumnWidth(hit.columnIndex, true);
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const resizeColumn = this.#resizeColumnFromTarget(event.target);
    if (resizeColumn !== null) {
      if (this.#handleResizeKeyDown(event, resizeColumn)) {
        return;
      }
      if (keyboardCommand(event) !== null) {
        return;
      }
    }
    if (this.#isTerminal() || event.altKey) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void this.#copySelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.controller.clearSelection();
      return;
    }
    const command = keyboardCommand(event);
    if (command === null) {
      return;
    }
    event.preventDefault();
    this.controller.moveActive(command, {
      extendSelection: event.shiftKey,
      scrollIntoView: true,
    });
  };

  #handleResizeKeyDown(event: KeyboardEvent, columnIndex: number): boolean {
    if (this.#isTerminal() || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    const width = this.controller.columnWidths[columnIndex];
    if (width === undefined) {
      return false;
    }
    const step = event.shiftKey ? KEYBOARD_RESIZE_COARSE_STEP : KEYBOARD_RESIZE_STEP;
    let nextWidth: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width - step;
        break;
      case "ArrowRight":
        nextWidth = width + step;
        break;
      case "Home":
        nextWidth = this.controller.minColumnWidth;
        break;
      case "End":
        nextWidth = this.controller.maxColumnWidth;
        break;
      case "Enter":
        nextWidth = this.#measureColumn(columnIndex);
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") {
      this.controller.autosizeColumn(columnIndex, nextWidth);
    } else {
      this.controller.resizeColumn(columnIndex, nextWidth);
    }
    this.controller.ensureColumnVisible(columnIndex);
    this.#announceColumnWidth(columnIndex, event.key === "Enter");
    return true;
  }

  #updateViewport(): void {
    if (this.#isTerminal()) {
      return;
    }
    const width = this.#scrollHost.clientWidth;
    const height = this.#scrollHost.clientHeight;
    this.#surface.style.width = `${width}px`;
    this.#surface.style.height = `${height}px`;
    this.controller.updateViewport({
      width,
      height,
      scrollLeft: this.#scrollHost.scrollLeft,
      scrollTop: this.#scrollHost.scrollTop,
      devicePixelRatio: this.#ownerWindow.devicePixelRatio || 1,
    });
  }

  #scheduleFrame(): void {
    if (this.#destroyed || this.#frame !== 0) {
      return;
    }
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = 0;
      this.#render();
    });
  }

  async #applyPresentation(table: TableHandle): Promise<void> {
    try {
      const presentation = await table.getPresentation();
      if (this.#destroyed || presentation === null) {
        return;
      }
      this.#presentation = presentation;
      this.#applySpreadsheetPresentation(presentation);
    } catch (error) {
      // Presentation is an enhancement over the logical table contract. A
      // malformed or unavailable layout must not make the table inaccessible.
      if (!this.#destroyed) {
        this.#onError?.(error);
      }
    }
  }

  #applySpreadsheetPresentation(presentation: SpreadsheetPresentation): void {
    this.element.dataset.tabularkPresentation = presentation.kind;
    this.element.dataset.tabularkWorksheetVisibility = presentation.visibility;
    this.element.dataset.tabularkFrozenRows = String(presentation.frozenRows);
    this.element.dataset.tabularkFrozenColumns = String(presentation.frozenColumns);

    this.controller.applySpreadsheetPresentation(presentation);
    this.#schedulePresentationRanges();
    this.#scheduleFrame();
  }

  #schedulePresentationRanges(): void {
    const table = this.#presentationTable;
    const presentation = this.#presentation;
    if (this.#destroyed || table === undefined || presentation === null) return;
    const requests = presentationRequests(this.#snapshot.layout);
    const key = `${presentation.tableId}:${presentation.revision}:${requests.map(rangeKey).join("|")}`;
    if (key === this.#presentationRequestKey) return;
    this.#presentationRequestKey = key;
    this.#presentationAbort?.abort();
    this.#presentationAbort = null;
    if (requests.length === 0) {
      this.#presentationRanges = [];
      this.#mergedCells = [];
      this.controller.setMergedCells([]);
      this.#scheduleFrame();
      return;
    }
    const abort = new AbortController();
    this.#presentationAbort = abort;
    void (async () => {
      const viewportRanges = await Promise.all(requests.map((request) => (
        table.readPresentationRange(request, { signal: abort.signal })
      )));
      const currentRanges = viewportRanges.filter(
        (range): range is PresentationRange => range !== null
          && range.revision === presentation.revision,
      );
      const anchorRequests = missingMergeAnchorRequests(
        collectMergedRegions(currentRanges),
        currentRanges,
      );
      const anchorRanges = await Promise.all(anchorRequests.map((request) => (
        table.readPresentationRange(request, { signal: abort.signal })
      )));
      return [...viewportRanges, ...anchorRanges];
    })().then((ranges) => {
      if (
        this.#destroyed
        || abort.signal.aborted
        || this.#presentationAbort !== abort
        || this.#presentationRequestKey !== key
      ) {
        return;
      }
      this.#presentationAbort = null;
      this.#presentationRanges = Object.freeze(ranges.filter(
        (range): range is PresentationRange => range !== null
          && range.revision === presentation.revision,
      ));
      this.#mergedCells = collectMergedRegions(this.#presentationRanges);
      this.controller.setMergedCells(this.#mergedCells);
      this.#scheduleFrame();
    }).catch((error) => {
      if (this.#presentationAbort === abort) this.#presentationAbort = null;
      if (
        this.#destroyed
        || abort.signal.aborted
        || (error instanceof TabularkError && error.code === "CANCELLED")
      ) {
        return;
      }
      this.#onError?.(error);
    });
  }

  #mergedRegions(): readonly MergedCellRegion[] {
    return this.#mergedCells;
  }

  #render(): void {
    if (this.#destroyed) {
      return;
    }
    const snapshot = this.#snapshot;
    const layout = snapshot.layout;
    this.#spacer.style.width = `${Math.max(layout.width, layout.spacerWidth)}px`;
    this.#spacer.style.height = `${Math.max(layout.height, layout.spacerHeight)}px`;
    this.#surface.style.width = `${layout.width}px`;
    this.#surface.style.height = `${layout.height}px`;
    this.#syncNativeScroll(snapshot);

    const columns: readonly CanvasPaintColumn[] = layout.overscanColumns.map((column) => ({
      index: column.index,
      name: column.name,
      x: column.x,
      width: column.width,
      frozen: column.frozen,
    }));
    const rows = this.#paintRows(snapshot, columns);
    const mergedCells = this.#paintMergedCells();
    this.#painter.paint({
      width: layout.width,
      height: layout.height,
      headerHeight: layout.headerHeight,
      rowGutterWidth: layout.rowHeaderWidth,
      columns,
      rows,
      mergedCells,
      ...(snapshot.selection === null ? {} : { selection: snapshot.selection.range }),
      ...(snapshot.activeCell === null
        ? {}
        : {
          activeCell: {
            rowIndex: snapshot.activeCell.rowIndex,
            columnIndex: snapshot.activeCell.columnIndex,
          },
        }),
      busy: snapshot.status === "loading",
    });
    this.#renderResizeHandles(snapshot);
    this.#renderAccessibleGrid(snapshot);
    this.#renderMessage(snapshot);
  }

  #paintRows(
    snapshot: Readonly<TableViewSnapshot>,
    columns: readonly CanvasPaintColumn[],
  ): readonly CanvasPaintRow[] {
    const layout = snapshot.layout;
    const rows: CanvasPaintRow[] = [];
    for (const row of layout.overscanRows) {
      const rowIndex = row.index;
      rows.push({
        index: rowIndex,
        y: row.y,
        height: row.height,
        frozen: row.frozen,
        cells: columns.map((column) => {
          const cell = this.controller.getCell(rowIndex, column.index);
          return {
            columnIndex: column.index,
            value: cell.status === "loaded" ? cell.value : undefined,
            ...(this.#styleAt(rowIndex, column.index) === undefined
              ? {}
              : { style: this.#styleAt(rowIndex, column.index)! }),
            ...(this.#mergeContaining(rowIndex, column.index) === undefined
              ? {}
              : { coveredByMerge: true }),
          };
        }),
      });
    }
    return rows;
  }

  #paintMergedCells(): readonly CanvasPaintMergedCell[] {
    const result: CanvasPaintMergedCell[] = [];
    const layout = this.#snapshot.layout;
    for (const region of this.#mergedRegions()) {
      const cell = this.controller.getCell(region.rowStart, region.columnStart);
      const style = this.#styleAt(region.rowStart, region.columnStart);
      for (const fragment of splitMergedRegion(
        region,
        layout.frozenRowCount,
        layout.frozenColumnCount,
      )) {
        const first = this.controller.cellRect({
          rowIndex: fragment.rowStart,
          columnIndex: fragment.columnStart,
        });
        const last = this.controller.cellRect({
          rowIndex: fragment.rowEnd - 1,
          columnIndex: fragment.columnEnd - 1,
        });
        const clip = mergePaneClip(layout, fragment);
        const x = Math.max(first.x, clip.left);
        const y = Math.max(first.y, clip.top);
        const right = Math.min(last.x + last.width, clip.right);
        const bottom = Math.min(last.y + last.height, clip.bottom);
        if (right <= x || bottom <= y) continue;
        result.push(Object.freeze({
          region,
          x,
          y,
          width: right - x,
          height: bottom - y,
          value: cell.status === "loaded" ? cell.value : undefined,
          ...(style === undefined ? {} : { style }),
          ...(fragment.rowStart === region.rowStart
            && fragment.columnStart === region.columnStart
            ? {}
            : { continuation: true }),
        }));
      }
    }
    return Object.freeze(result);
  }

  #styleAt(rowIndex: number, columnIndex: number): PresentationStyle | undefined {
    const presentation = this.#presentation;
    if (presentation === null) return undefined;
    for (const window of this.#presentationRanges) {
      const range = window.range;
      if (
        rowIndex < range.rowStart
        || rowIndex >= range.rowStart + range.rowCount
        || columnIndex < range.columnStart
        || columnIndex >= range.columnStart + range.columnCount
      ) {
        continue;
      }
      const id = window.styleIds[rowIndex - range.rowStart]?.[columnIndex - range.columnStart];
      return id === null || id === undefined ? undefined : presentation.styles[id];
    }
    return undefined;
  }

  #mergeContaining(rowIndex: number, columnIndex: number): MergedCellRegion | undefined {
    return this.#mergedRegions().find((region) => (
      rowIndex >= region.rowStart
      && rowIndex < region.rowEnd
      && columnIndex >= region.columnStart
      && columnIndex < region.columnEnd
    ));
  }

  #renderResizeHandles(snapshot: Readonly<TableViewSnapshot>): void {
    const visibleIds = new Set<string>();
    if (this.#isTerminal()) {
      this.#removeStaleResizeHandles(visibleIds);
      return;
    }
    for (const column of snapshot.layout.visibleColumns) {
      const boundary = column.x + column.width;
      if (boundary < snapshot.layout.rowHeaderWidth || boundary > snapshot.layout.width) {
        continue;
      }
      visibleIds.add(column.id);
      let handle = this.#resizeHandles.get(column.id);
      if (handle === undefined) {
        handle = this.element.ownerDocument.createElement("div");
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-controls", this.#accessibleGrid.element.id);
        handle.setAttribute("aria-describedby", this.#resizeInstructions.id);
        handle.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Home End Enter");
        handle.tabIndex = 0;
        Object.assign(handle.style, {
          background: "transparent",
          boxSizing: "border-box",
          cursor: "col-resize",
          outline: "none",
          pointerEvents: "auto",
          position: "absolute",
          top: "0",
          touchAction: "none",
          width: `${RESIZE_TARGET_SIZE}px`,
        });
        const line = this.element.ownerDocument.createElement("div");
        line.dataset.tabularkResizeLine = "";
        line.setAttribute("aria-hidden", "true");
        Object.assign(line.style, {
          pointerEvents: "none",
          position: "absolute",
          top: "0",
        });
        handle.append(line);
        this.#resizeHandles.set(column.id, handle);
        this.#resizeLayer.append(handle);
      }
      handle.dataset.columnResize = String(column.index);
      handle.dataset.columnId = column.id;
      handle.setAttribute("aria-label", `Resize ${column.name} column`);
      handle.setAttribute("aria-valuemin", String(this.controller.minColumnWidth));
      handle.setAttribute("aria-valuemax", String(this.controller.maxColumnWidth));
      handle.setAttribute("aria-valuenow", String(column.width));
      handle.setAttribute("aria-valuetext", `${formatWidth(column.width)} CSS pixels`);
      Object.assign(handle.style, {
        height: `${Math.max(RESIZE_TARGET_SIZE, snapshot.layout.headerHeight)}px`,
        left: `${boundary - RESIZE_TARGET_SIZE / 2}px`,
      });
      const line = handle.firstElementChild as HTMLElement | null;
      if (line !== null) {
        Object.assign(line.style, {
          background: this.#theme.gridLine,
          height: `${snapshot.layout.headerHeight}px`,
          left: `${(RESIZE_TARGET_SIZE - (this.#forcedColors ? 2 : 1)) / 2}px`,
          width: `${this.#forcedColors ? 2 : 1}px`,
        });
      }
    }
    this.#resizeLayer.style.height = `${Math.max(RESIZE_TARGET_SIZE, snapshot.layout.headerHeight)}px`;
    this.#removeStaleResizeHandles(visibleIds);
  }

  #removeStaleResizeHandles(visibleIds: ReadonlySet<string>): void {
    for (const [columnId, handle] of this.#resizeHandles) {
      if (visibleIds.has(columnId)) {
        continue;
      }
      if (handle.contains(this.element.ownerDocument.activeElement)) {
        this.#accessibleGrid.focus({ preventScroll: true });
      }
      handle.remove();
      this.#resizeHandles.delete(columnId);
    }
  }

  #renderAccessibleGrid(snapshot: Readonly<TableViewSnapshot>): void {
    const layout = snapshot.layout;
    const visibleRowIndexes = new Set(layout.visibleRows.map((row) => row.index));
    const visibleColumnIndexes = new Set(layout.visibleColumns.map((column) => column.index));
    const accessibleMerges = this.#mergedRegions().filter((region) => (
      layout.visibleRows.some((row) => row.index >= region.rowStart && row.index < region.rowEnd)
      && layout.visibleColumns.some(
        (column) => column.index >= region.columnStart && column.index < region.columnEnd,
      )
    ));
    const columnIndexes = new Set(visibleColumnIndexes);
    const rowIndexes = new Set(visibleRowIndexes);
    for (const merge of accessibleMerges) {
      columnIndexes.add(merge.columnStart);
      rowIndexes.add(merge.rowStart);
    }
    const columns = [...columnIndexes]
      .sort((left, right) => left - right)
      .map((index) => ({
        index,
        name: snapshot.metadata.schema.columns[index]?.name ?? `Column ${index + 1}`,
      }));
    const rows: AccessibleGridRow[] = [];
    for (const rowIndex of [...rowIndexes].sort((left, right) => left - right)) {
      const candidateColumns = new Set<number>();
      if (visibleRowIndexes.has(rowIndex)) {
        for (const columnIndex of visibleColumnIndexes) candidateColumns.add(columnIndex);
      }
      for (const merge of accessibleMerges) {
        if (merge.rowStart === rowIndex) candidateColumns.add(merge.columnStart);
      }
      rows.push({
        index: rowIndex,
        cells: [...candidateColumns]
          .sort((left, right) => left - right)
          .flatMap((columnIndex) => {
          const merge = this.#mergeContaining(rowIndex, columnIndex);
          if (
            merge !== undefined
            && (rowIndex !== merge.rowStart || columnIndex !== merge.columnStart)
          ) {
            return [];
          }
          const cell = this.controller.getCell(rowIndex, columnIndex);
          return [{
            rowIndex,
            columnIndex,
            value: cell.status === "loaded" ? cell.value : undefined,
            selected: snapshot.selection !== null && containsCell(
              snapshot.selection.range,
              { rowIndex, columnIndex },
            ),
            active: snapshot.activeCell?.rowIndex === rowIndex
              && snapshot.activeCell.columnIndex === columnIndex,
            ...(merge === undefined ? {} : {
              rowSpan: merge.rowEnd - merge.rowStart,
              columnSpan: merge.columnEnd - merge.columnStart,
            }),
          }];
        }),
      });
    }
    this.#accessibleGrid.update({
      label: this.#tableLabel(),
      ...(snapshot.metadata.extent.rows.kind === "exact"
        ? { exactRowCount: snapshot.metadata.extent.rows.value }
        : {}),
      columnCount: layout.columnCount,
      columns,
      rows,
      busy: snapshot.status === "loading",
      status: this.#statusText(snapshot),
    });
  }

  #renderMessage(snapshot: Readonly<TableViewSnapshot>): void {
    let message = "";
    if (snapshot.status === "error") {
      message = `Unable to render table: ${errorMessage(snapshot.error)}`;
    } else if (snapshot.status === "closed") {
      message = "Table closed.";
    } else if (snapshot.layout.rowCount === 0 && snapshot.status === "ready") {
      message = "No rows to display.";
    } else if (snapshot.status === "loading" && snapshot.layout.rows.visible.start === snapshot.layout.rows.visible.end) {
      message = "Loading data…";
    }
    this.#message.textContent = message;
    this.#message.style.display = message === "" ? "none" : "flex";
  }

  #syncNativeScroll(snapshot: Readonly<TableViewSnapshot>): void {
    const desiredLeft = snapshot.layout.horizontal.physicalOffset;
    const desiredTop = snapshot.layout.vertical.physicalOffset;
    if (Math.abs(this.#scrollHost.scrollLeft - desiredLeft) > 0.5) {
      this.#scrollHost.scrollLeft = desiredLeft;
    }
    if (Math.abs(this.#scrollHost.scrollTop - desiredTop) > 0.5) {
      this.#scrollHost.scrollTop = desiredTop;
    }
  }

  #cellFromHit(hit: ReturnType<TableViewController["hitTest"]>): Readonly<CellPosition> | null {
    if (hit.kind === "cell") {
      return Object.freeze({ rowIndex: hit.rowIndex, columnIndex: hit.columnIndex });
    }
    if (hit.kind === "row-header" && this.#snapshot.layout.columnCount > 0) {
      return Object.freeze({
        rowIndex: hit.rowIndex,
        columnIndex: this.#snapshot.activeCell?.columnIndex ?? 0,
      });
    }
    if (hit.kind === "column-header" && this.#snapshot.layout.rowCount > 0) {
      return Object.freeze({
        rowIndex: this.#snapshot.activeCell?.rowIndex ?? 0,
        columnIndex: hit.columnIndex,
      });
    }
    return null;
  }

  #eventPosition(event: MouseEvent | PointerEvent): Readonly<{ x: number; y: number }> {
    const rect = this.#surface.getBoundingClientRect();
    return Object.freeze({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  #resizeColumnFromTarget(target: EventTarget | null): number | null {
    const handle = this.#resizeHandleFromTarget(target);
    if (handle === null) {
      return null;
    }
    const value = handle.dataset.columnResize;
    if (value === undefined) {
      return null;
    }
    const columnIndex = Number(value);
    return Number.isSafeInteger(columnIndex) ? columnIndex : null;
  }

  #resizeHandleFromTarget(target: EventTarget | null): HTMLDivElement | null {
    if (!(target instanceof this.#ownerWindow.HTMLElement)) {
      return null;
    }
    const handle = target.closest<HTMLElement>("[data-column-resize]");
    return handle instanceof this.#ownerWindow.HTMLDivElement && this.#resizeLayer.contains(handle)
      ? handle
      : null;
  }

  #measureColumn(columnIndex: number): number {
    const context = this.#canvas.getContext("2d");
    if (context === null) {
      return this.controller.columnWidths[columnIndex]!;
    }
    const column = this.#snapshot.metadata.schema.columns[columnIndex];
    if (column === undefined) {
      return this.controller.columnWidths[columnIndex]!;
    }
    context.save();
    context.font = this.#theme.headerFont;
    let width = context.measureText(column.name).width;
    context.font = this.#theme.font;
    const visible = this.#snapshot.layout.rows.visible;
    for (let rowIndex = visible.start; rowIndex < visible.end; rowIndex += 1) {
      const cell = this.controller.getCell(rowIndex, columnIndex);
      if (cell.status === "loaded") {
        width = Math.max(width, context.measureText(cell.value ?? "∅").width);
      }
    }
    context.restore();
    return Math.ceil(width + AUTOSIZE_HORIZONTAL_PADDING);
  }

  async #copySelection(): Promise<void> {
    this.#copyAbort?.abort();
    const abort = new AbortController();
    this.#copyAbort = abort;
    try {
      const text = await this.controller.copySelection({ signal: abort.signal });
      if (abort.signal.aborted || this.#destroyed || text === "") {
        return;
      }
      if (this.#writeClipboard !== undefined) {
        await this.#writeClipboard(text);
      } else {
        const clipboard = this.#ownerWindow.navigator.clipboard;
        if (clipboard === undefined) {
          throw new Error("Clipboard access is unavailable in this browser context");
        }
        await clipboard.writeText(text);
      }
      this.#accessibleGrid.statusElement.textContent = "Selection copied to clipboard.";
    } catch (error) {
      if (!abort.signal.aborted) {
        this.#accessibleGrid.statusElement.textContent = `Copy failed: ${errorMessage(error)}`;
        this.#reportError(error);
      }
    } finally {
      if (this.#copyAbort === abort) {
        this.#copyAbort = null;
      }
    }
  }

  #statusText(snapshot: Readonly<TableViewSnapshot>): string {
    if (snapshot.status === "error") {
      return `Table error: ${errorMessage(snapshot.error)}`;
    }
    if (snapshot.status === "closed") {
      return "Table closed.";
    }
    if (snapshot.status === "loading") {
      return "Loading visible table cells.";
    }
    return `${snapshot.layout.rowCount} rows and ${snapshot.layout.columnCount} columns.`;
  }

  #announceColumnWidth(columnIndex: number, fitted: boolean): void {
    const column = this.#snapshot.metadata.schema.columns[columnIndex];
    const width = this.controller.columnWidths[columnIndex];
    if (column === undefined || width === undefined) {
      return;
    }
    if (this.#announcementFrame !== 0) {
      this.#ownerWindow.cancelAnimationFrame(this.#announcementFrame);
    }
    const action = fitted ? "fit to" : "width";
    const qualifier = fitted ? " using visible content" : "";
    this.#announcementFrame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#announcementFrame = 0;
      if (!this.#destroyed) {
        this.#accessibleGrid.statusElement.textContent = `${column.name} column ${action} ${formatWidth(width)} CSS pixels${qualifier}.`;
      }
    });
  }

  #applyThemeToElements(): void {
    this.element.dataset.tabularkColorScheme = this.#resolvedColorScheme;
    this.element.dataset.tabularkForcedColors = this.#forcedColors ? "active" : "none";
    this.element.style.background = this.#theme.background;
    this.element.style.borderColor = this.#theme.gridLine;
    this.element.style.color = this.#theme.foreground;
    this.#message.style.background = this.#theme.background;
    this.#message.style.color = this.#theme.mutedForeground;
    this.#canvas.style.forcedColorAdjust = this.#forcedColors ? "none" : "auto";
    if (this.element.contains(this.element.ownerDocument.activeElement)) {
      this.element.style.outline = `2px solid ${this.#focusColor()}`;
      const handle = this.#resizeHandleFromTarget(this.element.ownerDocument.activeElement);
      if (handle !== null) {
        handle.style.outline = `2px solid ${this.#focusColor()}`;
      }
    }
  }

  #resolveTheme(): Readonly<CanvasTableTheme> {
    const palette = this.#resolvedColorScheme === "dark"
      ? DARK_CANVAS_TABLE_THEME
      : DEFAULT_CANVAS_TABLE_THEME;
    const baseTheme = Object.freeze({ ...palette, ...this.#themeOverrides });
    return this.#forcedColors
      ? forcedColorsCanvasTableTheme(baseTheme)
      : baseTheme;
  }

  #focusColor(): string {
    return this.#forcedColors ? "Highlight" : this.#theme.activeCellBorder;
  }

  #tableLabel(): string {
    return `${this.controller.metadata.name || "Data"} table`;
  }

  #hasCells(): boolean {
    return this.#snapshot.layout.rowCount > 0 && this.#snapshot.layout.columnCount > 0;
  }

  #isTerminal(): boolean {
    return this.#destroyed
      || this.#snapshot.status === "error"
      || this.#snapshot.status === "closed";
  }

  #cancelInteraction(): void {
    if (this.#interaction !== null && this.#surface.hasPointerCapture(this.#interaction.pointerId)) {
      this.#surface.releasePointerCapture(this.#interaction.pointerId);
    }
    this.#interaction = null;
    this.#surface.style.cursor = "default";
  }

  #reportError(error: unknown): void {
    if (this.#onError !== undefined) {
      this.#onError(error);
    } else if (typeof this.#ownerWindow.reportError === "function") {
      this.#ownerWindow.reportError(error);
    }
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new Error("Canvas table view is destroyed");
    }
  }
}

function splitMergedRegion(
  region: MergedCellRegion,
  frozenRowCount: number,
  frozenColumnCount: number,
): readonly Readonly<MergedCellRegion>[] {
  const rows = splitIndexRange(region.rowStart, region.rowEnd, frozenRowCount);
  const columns = splitIndexRange(region.columnStart, region.columnEnd, frozenColumnCount);
  return Object.freeze(rows.flatMap((row) => columns.map((column) => Object.freeze({
    rowStart: row.start,
    rowEnd: row.end,
    columnStart: column.start,
    columnEnd: column.end,
  }))));
}

function splitIndexRange(
  start: number,
  end: number,
  boundary: number,
): readonly Readonly<{ start: number; end: number }>[] {
  if (boundary <= start || boundary >= end) {
    return Object.freeze([Object.freeze({ start, end })]);
  }
  return Object.freeze([
    Object.freeze({ start, end: boundary }),
    Object.freeze({ start: boundary, end }),
  ]);
}

function mergePaneClip(
  layout: Readonly<TableViewSnapshot>["layout"],
  fragment: MergedCellRegion,
): Readonly<{ left: number; top: number; right: number; bottom: number }> {
  const frozenRight = layout.rowHeaderWidth
    + Math.min(layout.bodyWidth, layout.frozenColumnExtent);
  const frozenBottom = layout.headerHeight
    + Math.min(layout.bodyHeight, layout.frozenRowExtent);
  const frozenColumn = fragment.columnStart < layout.frozenColumnCount;
  const frozenRow = fragment.rowStart < layout.frozenRowCount;
  return Object.freeze({
    left: frozenColumn ? layout.rowHeaderWidth : frozenRight,
    right: frozenColumn ? frozenRight : layout.rowHeaderWidth + layout.bodyWidth,
    top: frozenRow ? layout.headerHeight : frozenBottom,
    bottom: frozenRow ? frozenBottom : layout.headerHeight + layout.bodyHeight,
  });
}

function presentationRequests(
  layout: Readonly<TableViewSnapshot>["layout"],
): readonly Readonly<RangeRequest>[] {
  const overscan = presentationRectangles(
    layout.rows.overscan,
    layout.columns.overscan,
    layout.frozenRowRange,
    layout.frozenColumnRange,
  );
  const overscanCells = overscan.reduce(
    (total, range) => total + range.rowCount * range.columnCount,
    0,
  );
  if (overscanCells <= MAX_PRESENTATION_WINDOW_CELLS) return overscan;
  return presentationRectangles(
    layout.rows.visible,
    layout.columns.visible,
    layout.frozenRowRange,
    layout.frozenColumnRange,
  );
}

function presentationRectangles(
  rows: Readonly<{ start: number; end: number }>,
  columns: Readonly<{ start: number; end: number }>,
  frozenRows: Readonly<{ start: number; end: number }>,
  frozenColumns: Readonly<{ start: number; end: number }>,
): readonly Readonly<RangeRequest>[] {
  const requests: RangeRequest[] = [];
  for (const row of presentationBands(rows, frozenRows)) {
    for (const column of presentationBands(columns, frozenColumns)) {
      requests.push(Object.freeze({
        rowStart: row.start,
        rowCount: row.end - row.start,
        columnStart: column.start,
        columnCount: column.end - column.start,
      }));
    }
  }
  return Object.freeze(requests);
}

function presentationBands(
  primary: Readonly<{ start: number; end: number }>,
  frozen: Readonly<{ start: number; end: number }>,
): readonly Readonly<{ start: number; end: number }>[] {
  const bands = [primary, frozen]
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start);
  if (bands.length < 2) return Object.freeze(bands.map((range) => Object.freeze({ ...range })));
  const first = bands[0]!;
  const second = bands[1]!;
  return first.end >= second.start
    ? Object.freeze([Object.freeze({ start: first.start, end: Math.max(first.end, second.end) })])
    : Object.freeze(bands.map((range) => Object.freeze({ ...range })));
}

function rangeKey(range: RangeRequest): string {
  return `${range.rowStart}:${range.rowCount}:${range.columnStart}:${range.columnCount}`;
}

function mergeKey(region: MergedCellRegion): string {
  return `${region.rowStart}:${region.rowEnd}:${region.columnStart}:${region.columnEnd}`;
}

function collectMergedRegions(
  ranges: readonly PresentationRange[],
): readonly MergedCellRegion[] {
  const unique = new Map<string, MergedCellRegion>();
  for (const window of ranges) {
    for (const region of window.mergedCells) unique.set(mergeKey(region), region);
  }
  return Object.freeze([...unique.values()]);
}

function missingMergeAnchorRequests(
  regions: readonly MergedCellRegion[],
  ranges: readonly PresentationRange[],
): readonly Readonly<RangeRequest>[] {
  const requests = new Map<string, Readonly<RangeRequest>>();
  for (const region of regions) {
    const anchorLoaded = ranges.some((window) => (
      region.rowStart >= window.range.rowStart
      && region.rowStart < window.range.rowStart + window.range.rowCount
      && region.columnStart >= window.range.columnStart
      && region.columnStart < window.range.columnStart + window.range.columnCount
    ));
    if (anchorLoaded) continue;
    const request = Object.freeze({
      rowStart: region.rowStart,
      rowCount: 1,
      columnStart: region.columnStart,
      columnCount: 1,
    });
    requests.set(`${region.rowStart}:${region.columnStart}`, request);
  }
  return Object.freeze([...requests.values()]);
}

/** Mounts an accessible, viewport-driven Canvas preview. */
export function createCanvasTableView(options: CanvasTableViewOptions): CanvasTableView {
  if (!options || !options.container || typeof options.container.append !== "function") {
    throw invalidArgument("container must be an HTMLElement");
  }
  const hasTable = options.table !== undefined;
  const hasController = options.controller !== undefined;
  if (hasTable === hasController) {
    throw invalidArgument("provide exactly one of table or controller");
  }
  return new View(options);
}

function addMediaQueryListener(
  query: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return;
  }
  query.addListener?.(listener);
}

function removeMediaQueryListener(
  query: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): void {
  if (typeof query.removeEventListener === "function") {
    query.removeEventListener("change", listener);
    return;
  }
  query.removeListener?.(listener);
}

function keyboardCommand(event: KeyboardEvent): NavigationCommand | null {
  switch (event.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "PageUp":
      return "page-up";
    case "PageDown":
      return "page-down";
    case "Home":
      return event.ctrlKey || event.metaKey ? "table-start" : "row-start";
    case "End":
      return event.ctrlKey || event.metaKey ? "table-end" : "row-end";
    default:
      return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}

function formatWidth(width: number): string {
  return Number.isInteger(width)
    ? String(width)
    : width.toFixed(2).replace(/(?:\.0+|(?<decimal>\.\d*?)0+)$/, "$<decimal>");
}

function visuallyHide(element: HTMLElement): void {
  Object.assign(element.style, {
    border: "0",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    height: "1px",
    margin: "-1px",
    overflow: "hidden",
    padding: "0",
    position: "absolute",
    whiteSpace: "nowrap",
    width: "1px",
  });
}
