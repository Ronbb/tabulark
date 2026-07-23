/** The current maturity of the published API. */
export declare const PROJECT_STATUS: "prototype";

/** Immutable row and column counts for a table. */
export interface TableShape {
  readonly rows: number;
  readonly columns: number;
}

/**
 * Creates immutable shape metadata for a table.
 *
 * Both arguments must be non-negative safe integers.
 */
export declare function createTableShape(
  rows: number,
  columns: number,
): Readonly<TableShape>;
