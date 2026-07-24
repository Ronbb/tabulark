export interface AccessibleGridColumn {
  readonly index: number;
  readonly name: string;
}

export interface AccessibleGridCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly value: string | null | undefined;
  readonly selected: boolean;
  readonly active: boolean;
}

export interface AccessibleGridRow {
  readonly index: number;
  readonly cells: readonly AccessibleGridCell[];
}

export interface AccessibleGridSnapshot {
  readonly label: string;
  readonly exactRowCount?: number;
  readonly columnCount: number;
  readonly columns: readonly AccessibleGridColumn[];
  readonly rows: readonly AccessibleGridRow[];
  readonly busy: boolean;
  readonly status?: string;
}

let nextGridId = 1;

/** A viewport-bounded semantic counterpart to the visual Canvas table. */
export class AccessibleViewportGrid {
  readonly element: HTMLDivElement;
  readonly statusElement: HTMLDivElement;

  readonly #idPrefix: string;
  #destroyed = false;

  constructor(ownerDocument: Document, label = "Data table") {
    this.#idPrefix = `tabulark-grid-${nextGridId}`;
    nextGridId += 1;

    this.element = ownerDocument.createElement("div");
    this.element.className = "tabulark-a11y-grid";
    this.element.dataset.tabularkA11yGrid = "";
    this.element.id = this.#idPrefix;
    this.element.setAttribute("role", "grid");
    this.element.setAttribute("aria-label", label);
    this.element.tabIndex = 0;
    visuallyHide(this.element);

    this.statusElement = ownerDocument.createElement("div");
    this.statusElement.className = "tabulark-status";
    this.statusElement.dataset.tabularkStatus = "";
    this.statusElement.setAttribute("role", "status");
    this.statusElement.setAttribute("aria-live", "polite");
    this.statusElement.setAttribute("aria-atomic", "true");
    visuallyHide(this.statusElement);
  }

  update(snapshot: AccessibleGridSnapshot): void {
    if (this.#destroyed) {
      return;
    }

    this.element.setAttribute("aria-label", snapshot.label);
    this.element.setAttribute("aria-colcount", String(snapshot.columnCount));
    setOptionalAttribute(
      this.element,
      "aria-rowcount",
      snapshot.exactRowCount === undefined ? undefined : String(snapshot.exactRowCount + 1),
    );
    this.element.setAttribute("aria-busy", String(snapshot.busy));

    const fragment = this.element.ownerDocument.createDocumentFragment();
    fragment.append(this.#createHeader(snapshot.columns));

    let activeId: string | undefined;
    for (const row of snapshot.rows) {
      const rowElement = this.element.ownerDocument.createElement("div");
      rowElement.setAttribute("role", "row");
      // ARIA row indices are one-based; index 1 belongs to the header row.
      rowElement.setAttribute("aria-rowindex", String(row.index + 2));

      for (const cell of row.cells) {
        const cellElement = this.element.ownerDocument.createElement("div");
        cellElement.setAttribute("role", "gridcell");
        cellElement.setAttribute("aria-colindex", String(cell.columnIndex + 1));
        cellElement.setAttribute("aria-selected", String(cell.selected));
        cellElement.textContent = cell.value === undefined
          ? "Loading"
          : cell.value === null
            ? "Empty"
            : cell.value;
        if (cell.active) {
          activeId = this.#cellId(cell.rowIndex, cell.columnIndex);
          cellElement.id = activeId;
        }
        rowElement.append(cellElement);
      }
      fragment.append(rowElement);
    }

    this.element.replaceChildren(fragment);
    setOptionalAttribute(this.element, "aria-activedescendant", activeId);
    if (snapshot.status !== undefined && snapshot.status !== this.statusElement.textContent) {
      this.statusElement.textContent = snapshot.status;
    }
  }

  focus(options?: FocusOptions): void {
    this.element.focus(options);
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.element.remove();
    this.statusElement.remove();
  }

  #createHeader(columns: readonly AccessibleGridColumn[]): HTMLDivElement {
    const row = this.element.ownerDocument.createElement("div");
    row.setAttribute("role", "row");
    row.setAttribute("aria-rowindex", "1");
    for (const column of columns) {
      const cell = this.element.ownerDocument.createElement("div");
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-colindex", String(column.index + 1));
      cell.textContent = column.name;
      row.append(cell);
    }
    return row;
  }

  #cellId(rowIndex: number, columnIndex: number): string {
    return `${this.#idPrefix}-r${rowIndex}-c${columnIndex}`;
  }
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
    pointerEvents: "none",
    position: "absolute",
    whiteSpace: "nowrap",
    width: "1px",
  });
}

function setOptionalAttribute(
  element: Element,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}
