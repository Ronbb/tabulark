import type { TableHandle } from "../client.js";
import { invalidArgument } from "../errors.js";
import { containsCell } from "./selection.js";
import { AccessibleViewportGrid, type AccessibleGridRow } from "./accessible-grid.js";
import {
  CanvasTablePainter,
  DEFAULT_CANVAS_TABLE_THEME,
  type CanvasPaintColumn,
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
const AUTOSIZE_HORIZONTAL_PADDING = 24;

export interface CanvasTableViewOptions {
  readonly container: HTMLElement;
  /** Provide either a table or a preconfigured controller, never both. */
  readonly table?: TableHandle;
  /** Provide either a controller or a table, never both. */
  readonly controller?: TableViewController;
  readonly controllerOptions?: TableControllerOptions;
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
  readonly #message: HTMLDivElement;
  readonly #accessibleGrid: AccessibleViewportGrid;
  readonly #painter: CanvasTablePainter;
  readonly #ownerWindow: Window & typeof globalThis;
  readonly #ownsController: boolean;
  readonly #writeClipboard: ((text: string) => Promise<void> | void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #theme: Readonly<CanvasTableTheme>;
  readonly #unsubscribe: () => void;
  readonly #resizeObserver?: ResizeObserver;

  #snapshot: Readonly<TableViewSnapshot>;
  #frame = 0;
  #interaction: PointerInteraction | null = null;
  #copyAbort: AbortController | null = null;
  #destroyed = false;

  constructor(options: CanvasTableViewOptions) {
    const ownerDocument = options.container.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) {
      throw invalidArgument("container must belong to an active browser document");
    }
    this.#ownerWindow = ownerWindow;
    this.#ownsController = options.table !== undefined;
    this.controller = options.controller
      ?? createTableController(options.table!, options.controllerOptions);
    this.#snapshot = this.controller.getSnapshot();
    this.#writeClipboard = options.writeClipboard;
    this.#onError = options.onError;
    this.#theme = Object.freeze({ ...DEFAULT_CANVAS_TABLE_THEME, ...options.theme });

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
    this.#resizeLayer.setAttribute("aria-hidden", "true");
    Object.assign(this.#resizeLayer.style, {
      left: "0",
      pointerEvents: "none",
      position: "absolute",
      top: "0",
      width: "100%",
    });

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
      ...(options.maxDevicePixelRatio === undefined
        ? {}
        : { maxDevicePixelRatio: options.maxDevicePixelRatio }),
    });

    this.#surface.append(this.#canvas, this.#resizeLayer);
    this.#scrollHost.append(this.#spacer, this.#surface);
    this.element.append(
      this.#scrollHost,
      this.#message,
      this.#accessibleGrid.element,
      this.#accessibleGrid.statusElement,
    );
    options.container.append(this.element);

    this.#unsubscribe = this.controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      if (this.#isTerminal()) {
        this.#cancelInteraction();
        this.#copyAbort?.abort();
        this.#copyAbort = null;
      }
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

    if (typeof ownerWindow.ResizeObserver === "function") {
      this.#resizeObserver = new ownerWindow.ResizeObserver(() => this.#updateViewport());
      this.#resizeObserver.observe(this.#scrollHost);
    } else {
      ownerWindow.addEventListener("resize", this.#onWindowResize);
    }

    this.#updateViewport();
    this.#scheduleFrame();
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
    this.#copyAbort?.abort();
    this.#copyAbort = null;
    if (this.#frame !== 0) {
      this.#ownerWindow.cancelAnimationFrame(this.#frame);
      this.#frame = 0;
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

  readonly #onFocusIn = (): void => {
    this.element.style.boxShadow = `inset 0 0 0 2px ${this.#theme.activeCellBorder}`;
    if (
      !this.#isTerminal()
      && this.#snapshot.activeCell === null
      && this.#hasCells()
    ) {
      this.controller.setActiveCell({ rowIndex: 0, columnIndex: 0 });
    }
  };

  readonly #onFocusOut = (): void => {
    queueMicrotask(() => {
      if (!this.#destroyed && !this.element.contains(this.element.ownerDocument.activeElement)) {
        this.element.style.boxShadow = "none";
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
    if (this.#surface.hasPointerCapture(event.pointerId)) {
      this.#surface.releasePointerCapture(event.pointerId);
    }
    this.#interaction = null;
    this.#surface.style.cursor = "default";
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
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
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
    }));
    const rows = this.#paintRows(snapshot, columns);
    this.#painter.paint({
      width: layout.width,
      height: layout.height,
      headerHeight: layout.headerHeight,
      rowGutterWidth: layout.rowHeaderWidth,
      columns,
      rows,
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
    for (let rowIndex = layout.rows.overscan.start; rowIndex < layout.rows.overscan.end; rowIndex += 1) {
      rows.push({
        index: rowIndex,
        y: layout.headerHeight + rowIndex * layout.rowHeight - layout.vertical.logicalOffset,
        height: layout.rowHeight,
        cells: columns.map((column) => {
          const cell = this.controller.getCell(rowIndex, column.index);
          return {
            columnIndex: column.index,
            value: cell.status === "loaded" ? cell.value : undefined,
          };
        }),
      });
    }
    return rows;
  }

  #renderResizeHandles(snapshot: Readonly<TableViewSnapshot>): void {
    const fragment = this.element.ownerDocument.createDocumentFragment();
    for (const column of snapshot.layout.visibleColumns) {
      const boundary = column.x + column.width;
      if (boundary < snapshot.layout.rowHeaderWidth || boundary > snapshot.layout.width) {
        continue;
      }
      const handle = this.element.ownerDocument.createElement("div");
      handle.dataset.columnResize = String(column.index);
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", `Resize ${column.name} column`);
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-valuenow", String(Math.round(column.width)));
      Object.assign(handle.style, {
        cursor: "col-resize",
        height: `${snapshot.layout.headerHeight}px`,
        left: `${boundary - RESIZE_HANDLE_WIDTH / 2}px`,
        pointerEvents: "auto",
        position: "absolute",
        top: "0",
        width: `${RESIZE_HANDLE_WIDTH}px`,
      });
      fragment.append(handle);
    }
    this.#resizeLayer.style.height = `${snapshot.layout.headerHeight}px`;
    this.#resizeLayer.replaceChildren(fragment);
  }

  #renderAccessibleGrid(snapshot: Readonly<TableViewSnapshot>): void {
    const layout = snapshot.layout;
    const columns = layout.visibleColumns.map((column) => ({
      index: column.index,
      name: column.name,
    }));
    const rows: AccessibleGridRow[] = [];
    for (let rowIndex = layout.rows.visible.start; rowIndex < layout.rows.visible.end; rowIndex += 1) {
      rows.push({
        index: rowIndex,
        cells: columns.map((column) => {
          const cell = this.controller.getCell(rowIndex, column.index);
          return {
            rowIndex,
            columnIndex: column.index,
            value: cell.status === "loaded" ? cell.value : undefined,
            selected: snapshot.selection !== null && containsCell(
              snapshot.selection.range,
              { rowIndex, columnIndex: column.index },
            ),
            active: snapshot.activeCell?.rowIndex === rowIndex
              && snapshot.activeCell.columnIndex === column.index,
          };
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
    if (!(target instanceof this.#ownerWindow.HTMLElement)) {
      return null;
    }
    const value = target.dataset.columnResize;
    if (value === undefined) {
      return null;
    }
    const columnIndex = Number(value);
    return Number.isSafeInteger(columnIndex) ? columnIndex : null;
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
