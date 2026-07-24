export interface CanvasPaintColumn {
  readonly index: number;
  readonly name: string;
  /** Viewport-relative x coordinate, including the pinned row gutter offset. */
  readonly x: number;
  readonly width: number;
}

export interface CanvasPaintCell {
  readonly columnIndex: number;
  readonly value: string | null | undefined;
}

export interface CanvasPaintRow {
  readonly index: number;
  /** Viewport-relative y coordinate, including the pinned header offset. */
  readonly y: number;
  readonly height: number;
  readonly cells: readonly CanvasPaintCell[];
}

export interface CanvasPaintSelection {
  readonly rowStart: number;
  /** Exclusive table row bound. */
  readonly rowEnd: number;
  readonly columnStart: number;
  /** Exclusive table column bound. */
  readonly columnEnd: number;
}

export interface CanvasPaintActiveCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
}

export interface CanvasPaintSnapshot {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly rowGutterWidth: number;
  readonly columns: readonly CanvasPaintColumn[];
  readonly rows: readonly CanvasPaintRow[];
  readonly selection?: CanvasPaintSelection;
  readonly activeCell?: CanvasPaintActiveCell;
  readonly busy: boolean;
}

export interface CanvasTableTheme {
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

export const DEFAULT_CANVAS_TABLE_THEME: Readonly<CanvasTableTheme> = Object.freeze({
  background: "#ffffff",
  foreground: "#172033",
  mutedForeground: "#667085",
  headerBackground: "#f2f4f7",
  headerForeground: "#344054",
  alternateRowBackground: "#f9fafb",
  gridLine: "#d0d5dd",
  selectionBackground: "rgba(21, 112, 239, 0.14)",
  selectionBorder: "#1570ef",
  activeCellBorder: "#175cd3",
  loadingBackground: "#e4e7ec",
  font: '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  headerFont: '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
});

/** Resolves author-independent system colors for Windows High Contrast and other forced palettes. */
export function forcedColorsCanvasTableTheme(
  base: Readonly<CanvasTableTheme> = DEFAULT_CANVAS_TABLE_THEME,
): Readonly<CanvasTableTheme> {
  return Object.freeze({
    ...base,
    background: "Canvas",
    foreground: "CanvasText",
    mutedForeground: "GrayText",
    headerBackground: "Canvas",
    headerForeground: "CanvasText",
    alternateRowBackground: "Canvas",
    gridLine: "CanvasText",
    selectionBackground: "Highlight",
    selectionBorder: "Highlight",
    activeCellBorder: "CanvasText",
    loadingBackground: "GrayText",
  });
}

/** Paints one viewport frame and keeps the backing store device-pixel aware. */
export class CanvasTablePainter {
  readonly canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #theme: Readonly<CanvasTableTheme>;
  readonly #maxDevicePixelRatio: number;
  #forcedColors: boolean;

  #cssWidth = 0;
  #cssHeight = 0;
  #devicePixelRatio = 1;

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      readonly theme?: Partial<CanvasTableTheme>;
      readonly maxDevicePixelRatio?: number;
      readonly forcedColors?: boolean;
    } = {},
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw new Error("Tabulark Canvas rendering requires a 2D rendering context");
    }
    this.canvas = canvas;
    this.#context = context;
    this.#theme = Object.freeze({ ...DEFAULT_CANVAS_TABLE_THEME, ...options.theme });
    this.#maxDevicePixelRatio = positive(options.maxDevicePixelRatio, Number.POSITIVE_INFINITY);
    this.#forcedColors = options.forcedColors ?? false;
  }

  setTheme(theme: Readonly<CanvasTableTheme>, options: { readonly forcedColors?: boolean } = {}): void {
    this.#theme = Object.freeze({ ...theme });
    this.#forcedColors = options.forcedColors ?? false;
  }

  paint(snapshot: CanvasPaintSnapshot): void {
    this.#resize(snapshot.width, snapshot.height);
    const context = this.#context;
    const theme = this.#theme;

    context.save();
    context.setTransform(
      this.#devicePixelRatio,
      0,
      0,
      this.#devicePixelRatio,
      0,
      0,
    );
    context.clearRect(0, 0, snapshot.width, snapshot.height);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, snapshot.width, snapshot.height);

    this.#paintRows(snapshot);
    this.#paintHeader(snapshot);
    this.#paintGrid(snapshot);
    this.#paintSelection(snapshot);
    context.restore();
  }

  #resize(width: number, height: number): void {
    const view = this.canvas.ownerDocument.defaultView;
    const browserRatio = view?.devicePixelRatio ?? 1;
    const ratio = Math.max(1, Math.min(browserRatio, this.#maxDevicePixelRatio));
    const cssWidth = Math.max(0, Math.floor(width));
    const cssHeight = Math.max(0, Math.floor(height));
    const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
    const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));

    if (
      cssWidth === this.#cssWidth &&
      cssHeight === this.#cssHeight &&
      ratio === this.#devicePixelRatio &&
      this.canvas.width === pixelWidth &&
      this.canvas.height === pixelHeight
    ) {
      return;
    }

    this.#cssWidth = cssWidth;
    this.#cssHeight = cssHeight;
    this.#devicePixelRatio = ratio;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  #paintRows(snapshot: CanvasPaintSnapshot): void {
    const context = this.#context;
    const theme = this.#theme;
    const columnsByIndex = new Map(snapshot.columns.map((column) => [column.index, column]));
    context.font = theme.font;
    context.textBaseline = "middle";

    for (const row of snapshot.rows) {
      if (row.y + row.height <= snapshot.headerHeight || row.y >= snapshot.height) {
        continue;
      }
      context.fillStyle = row.index % 2 === 0 ? theme.background : theme.alternateRowBackground;
      context.fillRect(0, row.y, snapshot.width, row.height);

      context.fillStyle = theme.mutedForeground;
      context.textAlign = "right";
      context.fillText(
        String(row.index + 1),
        snapshot.rowGutterWidth - 10,
        row.y + row.height / 2,
      );

      for (const cell of row.cells) {
        const column = columnsByIndex.get(cell.columnIndex);
        if (column === undefined || column.x + column.width <= snapshot.rowGutterWidth) {
          continue;
        }
        this.#paintCellValue(cell.value, column.x, row.y, column.width, row.height);
      }
    }
  }

  #paintCellValue(
    value: string | null | undefined,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const context = this.#context;
    const theme = this.#theme;
    const horizontalPadding = 10;
    if (width <= horizontalPadding * 2) {
      return;
    }

    context.save();
    context.beginPath();
    context.rect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
    context.clip();
    context.textAlign = "left";
    if (value === undefined) {
      context.fillStyle = theme.loadingBackground;
      const skeletonWidth = Math.max(12, Math.min(width - horizontalPadding * 2, width * 0.42));
      context.fillRect(x + horizontalPadding, y + height / 2 - 3, skeletonWidth, 6);
    } else {
      context.fillStyle = value === null ? theme.mutedForeground : theme.foreground;
      const label = value === null ? "∅" : value;
      context.fillText(label, x + horizontalPadding, y + height / 2);
    }
    context.restore();
  }

  #paintHeader(snapshot: CanvasPaintSnapshot): void {
    const context = this.#context;
    const theme = this.#theme;
    context.fillStyle = theme.headerBackground;
    context.fillRect(0, 0, snapshot.width, snapshot.headerHeight);
    context.font = theme.headerFont;
    context.fillStyle = theme.headerForeground;
    context.textBaseline = "middle";
    context.textAlign = "left";

    for (const column of snapshot.columns) {
      if (column.x + column.width <= snapshot.rowGutterWidth || column.x >= snapshot.width) {
        continue;
      }
      context.save();
      context.beginPath();
      context.rect(column.x + 1, 0, Math.max(0, column.width - 2), snapshot.headerHeight);
      context.clip();
      context.fillText(column.name, column.x + 10, snapshot.headerHeight / 2);
      context.restore();
    }

    context.textAlign = "center";
    context.fillText(
      "#",
      snapshot.rowGutterWidth / 2,
      snapshot.headerHeight / 2,
      snapshot.rowGutterWidth,
    );
  }

  #paintGrid(snapshot: CanvasPaintSnapshot): void {
    const context = this.#context;
    const theme = this.#theme;
    context.strokeStyle = theme.gridLine;
    context.lineWidth = 1 / this.#devicePixelRatio;
    context.beginPath();

    const snap = 0.5 / this.#devicePixelRatio;
    context.moveTo(snapshot.rowGutterWidth + snap, 0);
    context.lineTo(snapshot.rowGutterWidth + snap, snapshot.height);
    context.moveTo(0, snapshot.headerHeight + snap);
    context.lineTo(snapshot.width, snapshot.headerHeight + snap);

    for (const column of snapshot.columns) {
      const x = column.x + column.width + snap;
      if (x > snapshot.rowGutterWidth && x < snapshot.width) {
        context.moveTo(x, 0);
        context.lineTo(x, snapshot.height);
      }
    }
    for (const row of snapshot.rows) {
      const y = row.y + row.height + snap;
      if (y > snapshot.headerHeight && y < snapshot.height) {
        context.moveTo(0, y);
        context.lineTo(snapshot.width, y);
      }
    }
    context.stroke();
  }

  #paintSelection(snapshot: CanvasPaintSnapshot): void {
    const selection = snapshot.selection;
    const context = this.#context;
    const theme = this.#theme;
    if (selection !== undefined) {
      const selectedColumns = snapshot.columns.filter(
        (column) => column.index >= selection.columnStart && column.index < selection.columnEnd,
      );
      const selectedRows = snapshot.rows.filter(
        (row) => row.index >= selection.rowStart && row.index < selection.rowEnd,
      );
      if (selectedColumns.length > 0 && selectedRows.length > 0) {
        const firstColumn = selectedColumns[0]!;
        const lastColumn = selectedColumns.at(-1)!;
        const firstRow = selectedRows[0]!;
        const lastRow = selectedRows.at(-1)!;
        const x = Math.max(snapshot.rowGutterWidth, firstColumn.x);
        const y = Math.max(snapshot.headerHeight, firstRow.y);
        const right = Math.min(snapshot.width, lastColumn.x + lastColumn.width);
        const bottom = Math.min(snapshot.height, lastRow.y + lastRow.height);
        if (right > x && bottom > y) {
          context.save();
          context.fillStyle = theme.selectionBackground;
          if (this.#forcedColors) {
            context.globalAlpha = 0.28;
          }
          context.fillRect(x, y, right - x, bottom - y);
          context.restore();
          context.strokeStyle = theme.selectionBorder;
          context.lineWidth = this.#forcedColors ? 2 : 1;
          context.setLineDash(this.#forcedColors ? [4, 2] : []);
          context.strokeRect(
            x + context.lineWidth / 2,
            y + context.lineWidth / 2,
            Math.max(0, right - x - context.lineWidth),
            Math.max(0, bottom - y - context.lineWidth),
          );
          context.setLineDash([]);
        }
      }
    }

    const activeColumn = snapshot.activeCell === undefined
      ? undefined
      : snapshot.columns.find((column) => column.index === snapshot.activeCell!.columnIndex);
    const activeRow = snapshot.activeCell === undefined
      ? undefined
      : snapshot.rows.find((row) => row.index === snapshot.activeCell!.rowIndex);
    if (activeColumn !== undefined && activeRow !== undefined) {
      const activeX = Math.max(snapshot.rowGutterWidth, activeColumn.x);
      const activeY = Math.max(snapshot.headerHeight, activeRow.y);
      const activeRight = Math.min(snapshot.width, activeColumn.x + activeColumn.width);
      const activeBottom = Math.min(snapshot.height, activeRow.y + activeRow.height);
      context.strokeStyle = theme.activeCellBorder;
      context.lineWidth = this.#forcedColors ? 3 : 2;
      context.setLineDash([]);
      context.strokeRect(
        activeX + context.lineWidth / 2,
        activeY + context.lineWidth / 2,
        Math.max(0, activeRight - activeX - context.lineWidth),
        Math.max(0, activeBottom - activeY - context.lineWidth),
      );
    }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
