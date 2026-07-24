import { invalidArgument } from "../errors.js";
import type {
  CellPosition,
  GridRange,
  NavigationCommand,
  TableSelection,
} from "./types.js";

export function createSelection(
  anchor: CellPosition,
  focus: CellPosition = anchor,
): Readonly<TableSelection> {
  assertCellPosition(anchor, "anchor");
  assertCellPosition(focus, "focus");
  const normalizedAnchor = Object.freeze({ ...anchor });
  const normalizedFocus = Object.freeze({ ...focus });
  return Object.freeze({
    anchor: normalizedAnchor,
    focus: normalizedFocus,
    range: selectionRange(normalizedAnchor, normalizedFocus),
  });
}

export function selectionRange(anchor: CellPosition, focus: CellPosition): Readonly<GridRange> {
  return Object.freeze({
    rowStart: Math.min(anchor.rowIndex, focus.rowIndex),
    rowEnd: Math.max(anchor.rowIndex, focus.rowIndex) + 1,
    columnStart: Math.min(anchor.columnIndex, focus.columnIndex),
    columnEnd: Math.max(anchor.columnIndex, focus.columnIndex) + 1,
  });
}

export function containsCell(range: GridRange, cell: CellPosition): boolean {
  return cell.rowIndex >= range.rowStart
    && cell.rowIndex < range.rowEnd
    && cell.columnIndex >= range.columnStart
    && cell.columnIndex < range.columnEnd;
}

export function clampCell(
  cell: CellPosition,
  rowCount: number,
  columnCount: number,
): Readonly<CellPosition> | null {
  if (rowCount <= 0 || columnCount <= 0) {
    return null;
  }
  return Object.freeze({
    rowIndex: clampInteger(cell.rowIndex, 0, rowCount - 1),
    columnIndex: clampInteger(cell.columnIndex, 0, columnCount - 1),
  });
}

export function moveCell(
  cell: CellPosition,
  command: NavigationCommand,
  rowCount: number,
  columnCount: number,
  pageRowCount: number,
): Readonly<CellPosition> | null {
  const current = clampCell(cell, rowCount, columnCount);
  if (current === null) {
    return null;
  }
  const page = Math.max(1, Math.floor(pageRowCount));
  switch (command) {
    case "left":
      return clampCell({ rowIndex: current.rowIndex, columnIndex: current.columnIndex - 1 }, rowCount, columnCount);
    case "right":
      return clampCell({ rowIndex: current.rowIndex, columnIndex: current.columnIndex + 1 }, rowCount, columnCount);
    case "up":
      return clampCell({ rowIndex: current.rowIndex - 1, columnIndex: current.columnIndex }, rowCount, columnCount);
    case "down":
      return clampCell({ rowIndex: current.rowIndex + 1, columnIndex: current.columnIndex }, rowCount, columnCount);
    case "page-up":
      return clampCell({ rowIndex: current.rowIndex - page, columnIndex: current.columnIndex }, rowCount, columnCount);
    case "page-down":
      return clampCell({ rowIndex: current.rowIndex + page, columnIndex: current.columnIndex }, rowCount, columnCount);
    case "row-start":
      return Object.freeze({ rowIndex: current.rowIndex, columnIndex: 0 });
    case "row-end":
      return Object.freeze({ rowIndex: current.rowIndex, columnIndex: columnCount - 1 });
    case "table-start":
      return Object.freeze({ rowIndex: 0, columnIndex: 0 });
    case "table-end":
      return Object.freeze({ rowIndex: rowCount - 1, columnIndex: columnCount - 1 });
  }
}

export function assertCellPosition(value: CellPosition, name: string): void {
  if (!Number.isSafeInteger(value.rowIndex) || value.rowIndex < 0) {
    throw invalidArgument(`${name}.rowIndex must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(value.columnIndex) || value.columnIndex < 0) {
    throw invalidArgument(`${name}.columnIndex must be a non-negative safe integer`);
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
