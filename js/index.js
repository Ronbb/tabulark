/** The current maturity of the published API. */
export const PROJECT_STATUS = "prototype";

/**
 * Creates immutable shape metadata for a table.
 *
 * JavaScript counts are restricted to non-negative safe integers. Larger
 * datasets will be represented through the future viewport API instead of
 * relying on imprecise Number values.
 *
 * @param {number} rows
 * @param {number} columns
 * @returns {Readonly<{rows: number, columns: number}>}
 */
export function createTableShape(rows, columns) {
  assertCount(rows, "rows");
  assertCount(columns, "columns");

  return Object.freeze({ rows, columns });
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
