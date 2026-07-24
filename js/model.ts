import { TabularkError, invalidArgument } from "./errors.js";

export const DEFAULT_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
export const MAX_ARRAY_BUFFER_BYTES = 128 * 1024 * 1024;
export const MAX_RANGE_CELLS = 250_000;
export const DEFAULT_TO_ROWS_CELL_LIMIT = 10_000;

const INDEX_BUDGET_MAX_BYTES = 64 * 1024 * 1024;
const WORKER_RANGE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const MAIN_THREAD_RANGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const FIELD_AND_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export const MAX_SOURCES = 2;
export const MAX_ACTIVE_RANGES = 2;
export const MAX_RANGE_WAITERS = 8;

export interface MemoryBudgetLimits {
  readonly memoryBudgetBytes: number;
  readonly indexBudgetBytes: number;
  readonly workerRangeCacheBytes: number;
  readonly workerDatasetRangeCacheBytes: number;
  readonly mainThreadRangeCacheBytes: number;
  readonly maxFieldBytes: number;
  readonly maxBatchBytes: number;
  readonly maxArrayBufferBytes: number;
  readonly maxSources: number;
  readonly maxActiveRanges: number;
  readonly maxRangeWaiters: number;
}

/** Derives every bounded runtime allocation from one engine-wide budget. */
export function deriveMemoryBudgetLimits(memoryBudgetBytes: number): MemoryBudgetLimits {
  assertPositiveSafeInteger(memoryBudgetBytes, "memoryBudgetBytes");
  const oneEighth = Math.floor(memoryBudgetBytes / 8);
  const oneThirtySecond = Math.floor(memoryBudgetBytes / 32);
  const workerRangeCacheBytes = Math.min(
    WORKER_RANGE_CACHE_MAX_BYTES,
    Math.floor((memoryBudgetBytes / 8) * 3),
  );
  return Object.freeze({
    memoryBudgetBytes,
    indexBudgetBytes: Math.min(INDEX_BUDGET_MAX_BYTES, oneEighth),
    workerRangeCacheBytes,
    workerDatasetRangeCacheBytes: Math.floor(workerRangeCacheBytes / MAX_SOURCES),
    mainThreadRangeCacheBytes: Math.min(MAIN_THREAD_RANGE_CACHE_MAX_BYTES, oneEighth),
    maxFieldBytes: Math.min(FIELD_AND_BATCH_MAX_BYTES, oneThirtySecond),
    maxBatchBytes: Math.min(FIELD_AND_BATCH_MAX_BYTES, oneThirtySecond),
    maxArrayBufferBytes: Math.min(MAX_ARRAY_BUFFER_BYTES, Math.floor(memoryBudgetBytes / 2)),
    maxSources: MAX_SOURCES,
    maxActiveRanges: MAX_ACTIVE_RANGES,
    maxRangeWaiters: MAX_RANGE_WAITERS,
  });
}

export type AxisExtent =
  | Readonly<{ kind: "exact"; value: number }>
  | Readonly<{ kind: "at-least"; value: number }>
  | Readonly<{ kind: "unknown" }>;

export interface TableExtent {
  readonly rows: AxisExtent;
  readonly columns: AxisExtent;
}

export type LogicalType =
  | "unknown"
  | "utf8"
  | "boolean"
  | "int64"
  | "float64"
  | "decimal"
  | "date"
  | "datetime"
  | "binary";

export interface ColumnSchema {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly logicalType: LogicalType;
  readonly nullable: boolean;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface TableCapabilities {
  readonly randomAccess: "indexed-prefix" | "full";
  readonly typedValues: boolean;
  readonly search: boolean;
  readonly sort: boolean;
  readonly filter: boolean;
  readonly multiTable: boolean;
  readonly [name: string]: unknown;
}

export interface TableMetadata {
  readonly tableId: string;
  readonly name: string;
  readonly revision: number;
  readonly extent: Readonly<TableExtent>;
  readonly schema: Readonly<{
    readonly version: number;
    readonly columns: readonly Readonly<ColumnSchema>[];
  }>;
  readonly capabilities: Readonly<TableCapabilities>;
}

export interface TableDescriptor {
  readonly id: string;
  readonly name: string;
}

export interface RangeRequest {
  readonly rowStart: number;
  readonly rowCount: number;
  readonly columnStart: number;
  readonly columnCount: number;
}

export interface ReturnedRange extends RangeRequest {}

export interface Utf8Column {
  readonly columnId: string;
  readonly encoding: "utf8";
  readonly data: Uint8Array;
  readonly offsets: Uint32Array;
  readonly validity: Uint8Array;
}

export interface ToRowsOptions {
  /** Maximum decoded cells. Defaults to 10,000. */
  readonly maxCells?: number;
}

export interface TableBatch {
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: Readonly<ReturnedRange>;
  readonly columns: readonly Utf8Column[];
  readonly complete: boolean;
  readonly byteLength: number;
  toRows(options?: ToRowsOptions): (string | null)[][];
}

export interface WireUtf8Column {
  readonly columnId: string;
  readonly encoding?: "utf8";
  readonly data: Uint8Array | ArrayBuffer;
  readonly offsets: Uint32Array | ArrayBuffer;
  readonly validity: Uint8Array | ArrayBuffer;
}

export interface WireTableBatch {
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: ReturnedRange;
  readonly columns: readonly WireUtf8Column[];
  readonly complete: boolean;
}

export class ColumnarTableBatch implements TableBatch {
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: Readonly<ReturnedRange>;
  readonly columns: readonly Utf8Column[];
  readonly complete: boolean;
  readonly byteLength: number;

  constructor(value: WireTableBatch) {
    this.tableId = value.tableId;
    this.revision = value.revision;
    this.schemaVersion = value.schemaVersion;
    this.range = Object.freeze({ ...value.range });
    this.columns = Object.freeze(
      value.columns.map((column) =>
        Object.freeze({
          columnId: column.columnId,
          encoding: "utf8" as const,
          data: asUint8Array(column.data),
          offsets: asUint32Array(column.offsets),
          validity: asUint8Array(column.validity),
        }),
      ),
    );
    this.complete = value.complete;
    this.byteLength = this.columns.reduce(
      (total, column) =>
        total + column.data.byteLength + column.offsets.byteLength + column.validity.byteLength,
      0,
    );

    validateBatch(this);
  }

  toRows(options: ToRowsOptions = {}): (string | null)[][] {
    const maxCells = options.maxCells ?? DEFAULT_TO_ROWS_CELL_LIMIT;
    assertPositiveSafeInteger(maxCells, "maxCells");

    const cellCount = this.range.rowCount * this.columns.length;
    if (cellCount > maxCells) {
      throw new TabularkError(
        "RESOURCE_LIMIT",
        `Decoding ${cellCount} cells exceeds the toRows limit of ${maxCells}`,
        { details: { cellCount, maxCells } },
      );
    }

    const decoder = new TextDecoder();
    const rows: (string | null)[][] = Array.from(
      { length: this.range.rowCount },
      () => Array<string | null>(this.columns.length),
    );

    for (let columnIndex = 0; columnIndex < this.columns.length; columnIndex += 1) {
      const column = this.columns[columnIndex]!;
      for (let rowIndex = 0; rowIndex < this.range.rowCount; rowIndex += 1) {
        if (!isValid(column.validity, rowIndex)) {
          rows[rowIndex]![columnIndex] = null;
          continue;
        }

        rows[rowIndex]![columnIndex] = decoder.decode(
          column.data.subarray(column.offsets[rowIndex], column.offsets[rowIndex + 1]),
        );
      }
    }

    return rows;
  }
}

export function validateRange(request: RangeRequest): RangeRequest {
  for (const [name, value] of Object.entries(request)) {
    assertNonNegativeSafeInteger(value, name);
  }

  if (
    !Number.isSafeInteger(request.rowStart + request.rowCount) ||
    !Number.isSafeInteger(request.columnStart + request.columnCount)
  ) {
    throw new TabularkError("INVALID_RANGE", "Range end must be a safe integer");
  }

  const cells = request.rowCount * request.columnCount;
  if (!Number.isSafeInteger(cells) || cells > MAX_RANGE_CELLS) {
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `A range may contain at most ${MAX_RANGE_CELLS} cells`,
      { details: { cells, limit: MAX_RANGE_CELLS } },
    );
  }

  return Object.freeze({ ...request });
}

export function normalizeMetadata(value: TableMetadata): Readonly<TableMetadata> {
  return Object.freeze({
    ...value,
    extent: Object.freeze({
      rows: Object.freeze({ ...value.extent.rows }),
      columns: Object.freeze({ ...value.extent.columns }),
    }),
    schema: Object.freeze({
      version: value.schema.version,
      columns: Object.freeze(
        value.schema.columns.map((column) =>
          Object.freeze({
            ...column,
            ...(column.extensions
              ? { extensions: Object.freeze({ ...column.extensions }) }
              : {}),
          }),
        ),
      ),
    }),
    capabilities: Object.freeze({ ...value.capabilities }),
  });
}

function validateBatch(batch: TableBatch): void {
  const rows = batch.range.rowCount;
  for (const column of batch.columns) {
    if (column.offsets.length !== rows + 1) {
      throw invalidArgument(
        `Column ${column.columnId} has ${column.offsets.length} offsets; expected ${rows + 1}`,
      );
    }
    if (column.validity.byteLength < Math.ceil(rows / 8)) {
      throw invalidArgument(`Column ${column.columnId} has an incomplete validity bitmap`);
    }
    let previous = 0;
    for (const offset of column.offsets) {
      if (offset < previous || offset > column.data.byteLength) {
        throw invalidArgument(`Column ${column.columnId} has invalid UTF-8 offsets`);
      }
      previous = offset;
    }
  }
}

function isValid(validity: Uint8Array, index: number): boolean {
  return (validity[index >>> 3]! & (1 << (index & 7))) !== 0;
}

function asUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function asUint32Array(value: Uint32Array | ArrayBuffer): Uint32Array {
  return value instanceof Uint32Array ? value : new Uint32Array(value);
}

export function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidArgument(`${name} must be a non-negative safe integer`, {
      name,
      value,
    });
  }
}

export function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidArgument(`${name} must be a positive safe integer`, {
      name,
      value,
    });
  }
}
