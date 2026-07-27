import { TabularkError, invalidArgument } from "./errors.js";
import { BATCH_LAYOUT_VERSION } from "./protocol.js";

export const DEFAULT_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
export const MAX_ARRAY_BUFFER_BYTES = 128 * 1024 * 1024;
export const MAX_RANGE_CELLS = 250_000;
export const DEFAULT_TO_ROWS_CELL_LIMIT = 10_000;
export const MAX_NESTING_DEPTH = 64;

const INDEX_BUDGET_MAX_BYTES = 64 * 1024 * 1024;
const ADAPTER_TILE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const MAIN_THREAD_RANGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const FIELD_AND_BATCH_MAX_BYTES = 8 * 1024 * 1024;

// Batch values are decoded one cell at a time by the logical facade. Reusing
// these immutable helpers avoids constructing a TextDecoder/DataView for every
// UTF-8 value and primitive read while keeping the cache weakly tied to the
// transferred backing buffer's lifetime.
const UTF8_DECODER = new TextDecoder();
const DATA_VIEW_CACHE = new WeakMap<object, Map<number, Map<number, DataView>>>();

export const MAX_SOURCES = 2;
export const MAX_ACTIVE_RANGES = 2;
export const MAX_RANGE_WAITERS = 8;

export interface MemoryBudgetLimits {
  readonly memoryBudgetBytes: number;
  /** Cross-thread accounting slices used by RangeSource brokers. */
  readonly workerBudgetBytes: number;
  readonly mainThreadSourceBytes: number;
  readonly mainThreadRetainedBytes: number;
  readonly sourceRangeCacheBytes: number;
  /** Shared retained capacity allocated among the adapters actually registered. */
  readonly adapterRuntimePoolBytes: number;
  /** Maximum transient/decoded budget retained by one active adapter operation. */
  readonly operationBudgetBytes: number;
  readonly indexBudgetBytes: number;
  readonly adapterTileCacheBudgetBytes: number;
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
  // The Worker allocates this pool through one reservation ledger using the
  // adapters actually registered for an engine. This deliberately avoids a
  // hard-coded split based on a historic number of built-in adapters.
  const adapterRuntimePoolBytes = Math.max(1, Math.floor(memoryBudgetBytes / 2));
  const operationBudgetBytes = Math.max(1, Math.floor(memoryBudgetBytes / 8));
  const workerBudgetBytes = Math.max(1, Math.floor(memoryBudgetBytes * 3 / 4));
  const mainThreadSourceBytes = Math.max(1, oneEighth);
  const mainThreadRetainedBytes = Math.max(
    1,
    memoryBudgetBytes - workerBudgetBytes - mainThreadSourceBytes,
  );
  return Object.freeze({
    memoryBudgetBytes,
    workerBudgetBytes,
    mainThreadSourceBytes,
    mainThreadRetainedBytes,
    sourceRangeCacheBytes: Math.max(1, Math.floor(workerBudgetBytes / 8)),
    adapterRuntimePoolBytes,
    operationBudgetBytes,
    indexBudgetBytes: Math.min(INDEX_BUDGET_MAX_BYTES, oneEighth),
    adapterTileCacheBudgetBytes: Math.min(ADAPTER_TILE_CACHE_MAX_BYTES, operationBudgetBytes),
    mainThreadRangeCacheBytes: Math.min(MAIN_THREAD_RANGE_CACHE_MAX_BYTES, oneEighth),
    maxFieldBytes: Math.min(FIELD_AND_BATCH_MAX_BYTES, oneThirtySecond),
    maxBatchBytes: Math.min(FIELD_AND_BATCH_MAX_BYTES, oneThirtySecond),
    maxArrayBufferBytes: Math.min(MAX_ARRAY_BUFFER_BYTES, Math.floor(memoryBudgetBytes / 2)),
    maxSources: MAX_SOURCES,
    maxActiveRanges: MAX_ACTIVE_RANGES,
    maxRangeWaiters: MAX_RANGE_WAITERS,
  });
}

export type MemoryResourceKind =
  | "adapter-runtime"
  | "source-staging"
  | "compressed-page"
  | "decompression"
  | "batch";

export interface MemoryReservation {
  readonly resource: MemoryResourceKind;
  readonly bytes: number;
  release(): void;
}

/**
 * Single-accounting ledger for Worker-owned bounded allocations.
 *
 * A reservation is deliberately idempotent so cancellation, close and failure
 * races can all execute their normal cleanup paths without double accounting.
 */
export class MemoryReservationLedger {
  readonly #capacityBytes: number;
  #usedBytes = 0;

  constructor(capacityBytes: number) {
    assertPositiveSafeInteger(capacityBytes, "capacityBytes");
    this.#capacityBytes = capacityBytes;
  }

  get capacityBytes(): number {
    return this.#capacityBytes;
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get availableBytes(): number {
    return this.#capacityBytes - this.#usedBytes;
  }

  reserve(resource: MemoryResourceKind, bytes: number): MemoryReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw invalidArgument("Reservation bytes must be a non-negative safe integer");
    }
    const availableBytes = this.availableBytes;
    if (bytes > availableBytes) {
      throw new TabularkError(
        "RESOURCE_LIMIT",
        `Insufficient memory reservation capacity for ${resource}`,
        { details: { resource, requiredBytes: bytes, availableBytes } },
      );
    }
    this.#usedBytes += bytes;
    let released = false;
    return Object.freeze({
      resource,
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.#usedBytes -= bytes;
      },
    });
  }
}

export type AxisExtent =
  | Readonly<{ kind: "exact"; value: number }>
  | Readonly<{ kind: "at-least"; value: number }>
  | Readonly<{ kind: "unknown" }>;

export interface TableExtent {
  readonly rows: AxisExtent;
  readonly columns: AxisExtent;
}

export type TimeUnit = "second" | "millisecond" | "microsecond" | "nanosecond";
export type IntervalUnit = "year-month" | "day-time" | "month-day-nano";

export interface ArrowField {
  readonly name: string;
  readonly nullable: boolean;
  readonly dataType: ArrowDataType;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface SimpleDataType<Type extends string> {
  readonly type: Type;
}

/** A recursive representation of every arrow-schema 59.1.0 built-in DataType. */
export type ArrowDataType =
  | SimpleDataType<
      | "null"
      | "unknown"
      | "boolean"
      | "int8"
      | "int16"
      | "int32"
      | "int64"
      | "uint8"
      | "uint16"
      | "uint32"
      | "uint64"
      | "float16"
      | "float32"
      | "float64"
      | "date32"
      | "date64"
      | "binary"
      | "large-binary"
      | "binary-view"
      | "utf8"
      | "large-utf8"
      | "utf8-view"
    >
  | Readonly<{ type: "timestamp"; unit: TimeUnit; timezone?: string }>
  | Readonly<{ type: "time32" | "time64" | "duration"; unit: TimeUnit }>
  | Readonly<{ type: "interval"; unit: IntervalUnit }>
  | Readonly<{ type: "fixed-size-binary"; byteWidth: number }>
  | Readonly<{ type: "decimal32" | "decimal64" | "decimal128" | "decimal256"; precision: number; scale: number }>
  | Readonly<{ type: "list" | "large-list" | "list-view" | "large-list-view"; field: ArrowField }>
  | Readonly<{ type: "fixed-size-list"; field: ArrowField; listSize: number }>
  | Readonly<{ type: "struct"; fields: readonly ArrowField[] }>
  | Readonly<{
      type: "union";
      mode: "sparse" | "dense";
      fields: readonly Readonly<{ typeId: number; field: ArrowField }>[];
    }>
  | Readonly<{
      type: "dictionary";
      indexType: ArrowDataType;
      valueType: ArrowDataType;
      ordered?: boolean;
    }>
  | Readonly<{ type: "map"; entries: ArrowField; keysSorted: boolean }>
  | Readonly<{ type: "run-end-encoded"; runEnds: ArrowField; values: ArrowField }>
  | Readonly<{
      type: "extension";
      name: string;
      metadata?: string;
      storageType: ArrowDataType;
    }>;

export interface ColumnSchema {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly dataType: ArrowDataType;
  readonly nullable: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
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

export type WorksheetVisibility = "visible" | "hidden" | "very-hidden";

/** One sparse row or column override supplied by a spreadsheet presentation. */
export interface PresentationAxisEntry {
  readonly index: number;
  /** CSS pixel extent when the source supplies an explicit dimension. */
  readonly size?: number;
  readonly hidden?: boolean;
}

export interface PresentationColor {
  /** CSS-compatible resolved color, when the workbook supplied one. */
  readonly css?: string;
}

export interface PresentationFont {
  readonly family?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly color?: PresentationColor;
}

export interface PresentationBorderSide {
  readonly style?: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  readonly color?: PresentationColor;
}

/** Static cell styling that 0.1 preserves from spreadsheet input. */
export interface PresentationStyle {
  readonly numberFormat?: string;
  readonly font?: PresentationFont;
  readonly foregroundColor?: PresentationColor;
  readonly backgroundColor?: PresentationColor;
  readonly fillColor?: PresentationColor;
  readonly borders?: Readonly<{
    readonly top?: PresentationBorderSide;
    readonly right?: PresentationBorderSide;
    readonly bottom?: PresentationBorderSide;
    readonly left?: PresentationBorderSide;
  }>;
  readonly horizontalAlignment?: "general" | "left" | "center" | "right" | "justify";
  readonly verticalAlignment?: "top" | "center" | "bottom" | "justify";
  readonly wrapText?: boolean;
}

export interface MergedCellRegion {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

/**
 * Presentation metadata for a worksheet. It is intentionally static: formula
 * calculation and document round-tripping are outside the 0.1 contract.
 */
export interface SpreadsheetPresentation {
  readonly kind: "spreadsheet-v1";
  readonly tableId: string;
  readonly revision: number;
  readonly visibility: WorksheetVisibility;
  readonly frozenRows: number;
  readonly frozenColumns: number;
  readonly rows: readonly PresentationAxisEntry[];
  readonly columns: readonly PresentationAxisEntry[];
  /** Deduplicated styles addressed by `SpreadsheetPresentationRange.styleIds`. */
  readonly styles: readonly PresentationStyle[];
}

export type TablePresentation = SpreadsheetPresentation;

export interface SpreadsheetPresentationRange {
  readonly kind: "spreadsheet-v1";
  readonly tableId: string;
  readonly revision: number;
  readonly range: Readonly<ReturnedRange>;
  /** Rows and columns are exactly aligned with `range`; null means no style. */
  readonly styleIds: readonly (readonly (number | null)[])[];
  readonly mergedCells: readonly MergedCellRegion[];
  /** Sparse layout entries that intersect this requested range. */
  readonly rows: readonly PresentationAxisEntry[];
  readonly columns: readonly PresentationAxisEntry[];
}

export type PresentationRange = SpreadsheetPresentationRange;

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

/** A byte region in the batch's deduplicated buffer pool. */
export interface BatchBufferRegion {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
  /** First bit for bitmap regions; ignored for byte-oriented regions. */
  readonly bitOffset?: number;
}

/** UTF-8 text generated by Rust for rendering, ARIA, width measurement and copy. */
export interface DisplayColumnDescriptor {
  readonly encoding: "utf8";
  readonly data: BatchBufferRegion;
  readonly offsets: BatchBufferRegion;
  readonly validity?: BatchBufferRegion;
  /** Logical offset into the display arrays, for sliced batches. */
  readonly offset?: number;
}

/**
 * Recursive Arrow ArrayData layout. Buffer regions always point into the
 * enclosing TableBatch buffer pool; encoded dictionaries and run ends remain
 * visible in this descriptor even though `toRows()` returns logical values.
 */
export interface NativeColumnDescriptor {
  /** Rust ArrayData layout encoding (for example `dictionary` or `run-end-encoded`). */
  readonly encoding?: string;
  readonly dataType: ArrowDataType;
  readonly length: number;
  readonly offset?: number;
  readonly validity?: BatchBufferRegion;
  readonly values?: BatchBufferRegion;
  readonly offsets?: BatchBufferRegion;
  readonly sizes?: BatchBufferRegion;
  readonly data?: BatchBufferRegion;
  readonly typeIds?: BatchBufferRegion;
  readonly unionOffsets?: BatchBufferRegion;
  readonly variadicBuffers?: readonly BatchBufferRegion[];
  readonly children?: readonly NativeColumnDescriptor[];
  readonly dictionary?: NativeColumnDescriptor;
  readonly runEnds?: NativeColumnDescriptor;
  readonly typeId?: number;
}

/** @internal Layout-v1 column descriptor received from an official WASM runtime. */
export interface WireTableBatchColumn {
  readonly columnId: string;
  readonly native: NativeColumnDescriptor;
  readonly display: DisplayColumnDescriptor;
}

export interface DecimalValue {
  readonly kind: "decimal";
  readonly unscaled: bigint;
  readonly precision: number;
  readonly scale: number;
}

export interface TemporalValue {
  readonly kind: "date32" | "date64" | "time32" | "time64" | "timestamp" | "duration";
  readonly value: number | bigint;
  readonly unit?: TimeUnit;
  readonly timezone?: string;
}

export interface IntervalValue {
  readonly kind: "interval";
  readonly unit: IntervalUnit;
  readonly months?: number;
  readonly days?: number;
  readonly milliseconds?: number;
  readonly nanoseconds?: bigint;
}

export interface UnionValue {
  readonly kind: "union";
  readonly typeId: number;
  readonly value: NativeValue | null;
}

export interface MapEntryValue {
  readonly key: NativeValue | null;
  readonly value: NativeValue | null;
}

export interface NativeListValue extends ReadonlyArray<NativeValue | null> {}
export interface NativeStructValue {
  readonly [name: string]: NativeValue | null;
}
export interface NativeMapValue extends ReadonlyArray<Readonly<MapEntryValue>> {}

export type NativeValue =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | DecimalValue
  | TemporalValue
  | IntervalValue
  | UnionValue
  | NativeListValue
  | NativeStructValue
  | NativeMapValue;

export interface ToRowsOptions {
  /** Maximum decoded cells. Defaults to 10,000. */
  readonly maxCells?: number;
}

/**
 * Logical, column-oriented access to one returned batch column.
 *
 * Values are indexed relative to `TableBatch.range.rowStart`; physical buffer
 * regions and adapter transport details intentionally remain private.
 */
export interface TableBatchColumn {
  readonly columnId: string;
  readonly columnIndex: number;
  readonly rowCount: number;
  getValue(rowOffset: number): NativeValue | null;
  getDisplayValue(rowOffset: number): string | null;
  toValues(options?: ToRowsOptions): (NativeValue | null)[];
  toDisplayValues(options?: ToRowsOptions): (string | null)[];
}

/** Stable logical batch contract. Wire buffers and ABI layout stay private. */
export interface TableBatch {
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: Readonly<ReturnedRange>;
  readonly columns: readonly TableBatchColumn[];
  readonly complete: boolean;
  toRows(options?: ToRowsOptions): (NativeValue | null)[][];
  toDisplayRows(options?: ToRowsOptions): (string | null)[][];
}

export type WireBatchBuffer = ArrayBuffer | ArrayBufferView;

export interface WireTableBatch {
  readonly layoutVersion: typeof BATCH_LAYOUT_VERSION;
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: ReturnedRange;
  readonly buffers: readonly WireBatchBuffer[];
  readonly columns: readonly WireTableBatchColumn[];
  readonly complete: boolean;
}

/** Owns and validates one generic layout-v1 batch received from the Worker. */
export class ColumnarTableBatch implements TableBatch {
  readonly tableId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly range: Readonly<ReturnedRange>;
  readonly columns: readonly TableBatchColumn[];
  readonly complete: boolean;
  readonly #buffers: readonly Uint8Array[];
  readonly #wireColumns: readonly WireTableBatchColumn[];

  constructor(value: WireTableBatch) {
    if (value.layoutVersion !== BATCH_LAYOUT_VERSION) {
      throw invalidArgument(
        `Batch layout ${String(value.layoutVersion)} is incompatible with layout ${BATCH_LAYOUT_VERSION}`,
      );
    }
    this.tableId = value.tableId;
    this.revision = value.revision;
    this.schemaVersion = value.schemaVersion;
    this.range = Object.freeze({ ...value.range });
    this.#buffers = Object.freeze(value.buffers.map(asUint8Array));
    this.#wireColumns = Object.freeze(value.columns.map((column) => freezeWireColumn(column)));
    this.complete = value.complete;
    validateWireBatch(this.range, this.#buffers, this.#wireColumns);
    this.columns = Object.freeze(this.#wireColumns.map((column, index) => new LogicalBatchColumn(
      column,
      this.#buffers,
      this.range.rowCount,
      this.range.columnStart + index,
    )));
  }

  toRows(options: ToRowsOptions = {}): (NativeValue | null)[][] {
    const maxCells = normalizeCellLimit(options.maxCells);
    assertCellLimit(this.range.rowCount, this.columns.length, maxCells);
    const rows: (NativeValue | null)[][] = Array.from(
      { length: this.range.rowCount },
      () => Array<NativeValue | null>(this.columns.length),
    );
    for (let columnIndex = 0; columnIndex < this.columns.length; columnIndex += 1) {
      for (let rowIndex = 0; rowIndex < this.range.rowCount; rowIndex += 1) {
        rows[rowIndex]![columnIndex] = this.columns[columnIndex]!.getValue(rowIndex);
      }
    }
    return rows;
  }

  toDisplayRows(options: ToRowsOptions = {}): (string | null)[][] {
    const maxCells = normalizeCellLimit(options.maxCells);
    assertCellLimit(this.range.rowCount, this.columns.length, maxCells);
    const rows: (string | null)[][] = Array.from(
      { length: this.range.rowCount },
      () => Array<string | null>(this.columns.length),
    );

    for (let columnIndex = 0; columnIndex < this.columns.length; columnIndex += 1) {
      for (let rowIndex = 0; rowIndex < this.range.rowCount; rowIndex += 1) {
        rows[rowIndex]![columnIndex] = this.columns[columnIndex]!.getDisplayValue(rowIndex);
      }
    }
    return rows;
  }
}

class LogicalBatchColumn implements TableBatchColumn {
  readonly columnId: string;
  readonly columnIndex: number;
  readonly rowCount: number;
  readonly #wire: WireTableBatchColumn;
  readonly #buffers: readonly Uint8Array[];

  constructor(
    wire: WireTableBatchColumn,
    buffers: readonly Uint8Array[],
    rowCount: number,
    columnIndex: number,
  ) {
    this.columnId = wire.columnId;
    this.columnIndex = columnIndex;
    this.rowCount = rowCount;
    this.#wire = wire;
    this.#buffers = buffers;
    Object.freeze(this);
  }

  getValue(rowOffset: number): NativeValue | null {
    assertBatchRowOffset(rowOffset, this.rowCount);
    return decodeNativeValue(this.#wire.native, rowOffset, this.#buffers, 0);
  }

  getDisplayValue(rowOffset: number): string | null {
    assertBatchRowOffset(rowOffset, this.rowCount);
    return decodeDisplayValue(this.#wire.display, rowOffset, this.#buffers, this.columnId);
  }

  toValues(options: ToRowsOptions = {}): (NativeValue | null)[] {
    const maxCells = normalizeCellLimit(options.maxCells);
    assertCellLimit(this.rowCount, 1, maxCells);
    return Array.from({ length: this.rowCount }, (_, index) => this.getValue(index));
  }

  toDisplayValues(options: ToRowsOptions = {}): (string | null)[] {
    const maxCells = normalizeCellLimit(options.maxCells);
    assertCellLimit(this.rowCount, 1, maxCells);
    return Array.from({ length: this.rowCount }, (_, index) => this.getDisplayValue(index));
  }
}

function assertBatchRowOffset(rowOffset: number, rowCount: number): void {
  if (!Number.isSafeInteger(rowOffset) || rowOffset < 0 || rowOffset >= rowCount) {
    throw invalidArgument(`Batch row offset must be an integer from 0 through ${Math.max(0, rowCount - 1)}`);
  }
}

function decodeDisplayValue(
  display: DisplayColumnDescriptor,
  rowOffset: number,
  buffers: readonly Uint8Array[],
  columnId: string,
): string | null {
  const physicalIndex = (display.offset ?? 0) + rowOffset;
  if (!validAt(display.validity, physicalIndex, buffers)) {
    return null;
  }
  const offsets = regionView(display.offsets, buffers, "display offsets");
  const data = regionView(display.data, buffers, "display data");
  const start = readUnsignedOffset(offsets, physicalIndex, 4);
  const end = readUnsignedOffset(offsets, physicalIndex + 1, 4);
  if (end < start || end > data.byteLength) {
    throw invalidArgument(`Column ${columnId} has invalid display offsets`);
  }
  return UTF8_DECODER.decode(data.subarray(start, end));
}

export function validateRange(request: RangeRequest): RangeRequest {
  for (const [name, value] of Object.entries(request)) {
    assertNonNegativeSafeInteger(value, name);
  }
  if (
    request.rowCount > Number.MAX_SAFE_INTEGER - request.rowStart
    || request.columnCount > Number.MAX_SAFE_INTEGER - request.columnStart
  ) {
    throw new TabularkError("INVALID_RANGE", "Range end must be a safe integer");
  }
  const cells = request.rowCount * request.columnCount;
  // Bound each dimension as well as the product. A zero-height/zero-width
  // range still reaches adapter loops and must not smuggle an unbounded axis
  // through the `0 * Number.MAX_SAFE_INTEGER` product.
  if (
    request.rowCount > MAX_RANGE_CELLS
    || request.columnCount > MAX_RANGE_CELLS
    || !Number.isSafeInteger(cells)
    || cells > MAX_RANGE_CELLS
  ) {
    const required = Number.isSafeInteger(cells)
      ? Math.max(cells, request.rowCount, request.columnCount)
      : Number.MAX_SAFE_INTEGER;
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `A range may contain at most ${MAX_RANGE_CELLS} cells`,
      {
        details: {
          resource: "range-cells",
          required,
          available: MAX_RANGE_CELLS,
          cells: Number.isSafeInteger(cells) ? cells : Number.MAX_SAFE_INTEGER,
          limit: MAX_RANGE_CELLS,
        },
      },
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
      columns: Object.freeze(value.schema.columns.map((column) => Object.freeze({
        ...column,
        dataType: freezeDataType(column.dataType),
        ...(column.metadata ? { metadata: Object.freeze({ ...column.metadata }) } : {}),
      }))),
    }),
    capabilities: Object.freeze({ ...value.capabilities }),
  });
}

/** Normalizes a protocol DataType and rejects cycles or excessive nesting. */
export function normalizeDataType(value: unknown, depth = 0): ArrowDataType {
  if (depth >= MAX_NESTING_DEPTH) {
    throw invalidArgument(`Arrow data type nesting may not exceed ${MAX_NESTING_DEPTH}`);
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidArgument("Column dataType must be a recursive Arrow data type descriptor");
  }
  const type: string = ({
    "u-int8": "uint8",
    "u-int16": "uint16",
    "u-int32": "uint32",
    "u-int64": "uint64",
  } as const)[value.type as "u-int8" | "u-int16" | "u-int32" | "u-int64"] ?? value.type;
  const simple = new Set([
    "unknown", "null", "boolean", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
    "float16", "float32", "float64", "date32", "date64", "binary", "large-binary", "binary-view",
    "utf8", "large-utf8", "utf8-view",
  ]);
  if (simple.has(type)) {
    return Object.freeze({ type }) as ArrowDataType;
  }
  if (type === "timestamp") {
    return Object.freeze({
      type,
      unit: timeUnit(value.unit),
      ...(typeof value.timezone === "string" ? { timezone: value.timezone } : {}),
    });
  }
  if (type === "time32" || type === "time64" || type === "duration") {
    return Object.freeze({ type, unit: timeUnit(value.unit) });
  }
  if (type === "interval") {
    return Object.freeze({ type, unit: intervalUnit(value.unit) });
  }
  if (type === "fixed-size-binary") {
    return Object.freeze({
      type,
      byteWidth: positiveInteger(value.byteWidth ?? value.byte_width, "byteWidth"),
    });
  }
  if (type === "decimal32" || type === "decimal64" || type === "decimal128" || type === "decimal256") {
    return Object.freeze({
      type,
      precision: positiveInteger(value.precision, "precision"),
      scale: integer(value.scale, "scale"),
    });
  }
  if (type === "list" || type === "large-list" || type === "list-view" || type === "large-list-view") {
    return Object.freeze({ type, field: normalizeField(value.field, depth + 1) });
  }
  if (type === "fixed-size-list") {
    return Object.freeze({
      type,
      field: normalizeField(value.field, depth + 1),
      listSize: positiveInteger(value.listSize ?? value.list_size, "listSize"),
    });
  }
  if (type === "struct") {
    if (!Array.isArray(value.fields)) {
      throw invalidArgument("Struct fields must be an array");
    }
    return Object.freeze({
      type,
      fields: Object.freeze(value.fields.map((field) => normalizeField(field, depth + 1))),
    });
  }
  if (type === "union") {
    if (!Array.isArray(value.fields) || (value.mode !== "sparse" && value.mode !== "dense")) {
      throw invalidArgument("Union dataType requires a mode and fields");
    }
    return Object.freeze({
      type,
      mode: value.mode,
      fields: Object.freeze(value.fields.map((entry) => {
        if (!isRecord(entry)) {
          throw invalidArgument("Union field entries must be objects");
        }
        return Object.freeze({
          typeId: integer(entry.typeId, "typeId"),
          field: normalizeField(entry.field, depth + 1),
        });
      })),
    });
  }
  if (type === "dictionary") {
    return Object.freeze({
      type,
      indexType: normalizeDataType(value.indexType, depth + 1),
      valueType: normalizeDataType(value.valueType, depth + 1),
      ...(value.ordered === true ? { ordered: true } : {}),
    });
  }
  if (type === "map") {
    return Object.freeze({
      type,
      entries: normalizeField(value.entries, depth + 1),
      keysSorted: value.keysSorted === true || value.keys_sorted === true,
    });
  }
  if (type === "run-end-encoded") {
    return Object.freeze({
      type,
      runEnds: normalizeField(value.runEnds ?? value.run_ends, depth + 1),
      values: normalizeField(value.values, depth + 1),
    });
  }
  if (type === "extension") {
    if (typeof value.name !== "string" || value.name.length === 0) {
      throw invalidArgument("Arrow extension name must be a non-empty string");
    }
    return Object.freeze({
      type,
      name: value.name,
      ...(typeof value.metadata === "string" ? { metadata: value.metadata } : {}),
      storageType: normalizeDataType(value.storageType, depth + 1),
    });
  }
  throw invalidArgument(`Unknown Arrow data type: ${type}`);
}

function normalizeField(value: unknown, depth: number): ArrowField {
  if (!isRecord(value)) {
    throw invalidArgument("Arrow field must be an object");
  }
  const metadata = isRecord(value.metadata)
    ? Object.freeze(Object.fromEntries(Object.entries(value.metadata).map(([key, entry]) => [key, String(entry)])))
    : undefined;
  return Object.freeze({
    name: typeof value.name === "string" ? value.name : "",
    nullable: value.nullable !== false,
    dataType: normalizeDataType(value.dataType, depth),
    ...(metadata ? { metadata } : {}),
  });
}

function validateWireBatch(
  range: Readonly<ReturnedRange>,
  buffers: readonly Uint8Array[],
  columns: readonly WireTableBatchColumn[],
): void {
  validateRange(range);
  if (columns.length !== range.columnCount) {
    throw invalidArgument(
      `Batch has ${columns.length} columns; expected ${range.columnCount}`,
    );
  }
  for (const [index, column] of columns.entries()) {
    validateDisplay(column.display, range.rowCount, buffers, column.columnId);
    validateNative(column.native, buffers, 0, `columns[${index}].native`);
    if (column.native.length < range.rowCount) {
      throw invalidArgument(`Column ${column.columnId} is shorter than the returned range`);
    }
  }
}

function validateDisplay(
  display: DisplayColumnDescriptor,
  rows: number,
  buffers: readonly Uint8Array[],
  columnId: string,
): void {
  const offset = display.offset ?? 0;
  assertNonNegativeSafeInteger(offset, "display offset");
  const offsets = regionView(display.offsets, buffers, "display offsets");
  if (offsets.byteLength < (offset + rows + 1) * 4) {
    throw invalidArgument(`Column ${columnId} has incomplete display offsets`);
  }
  const data = regionView(display.data, buffers, "display data");
  if (display.validity) {
    const validity = regionView(display.validity, buffers, "display validity");
    if (validity.byteLength < Math.ceil((offset + rows) / 8)) {
      throw invalidArgument(`Column ${columnId} has an incomplete display validity bitmap`);
    }
  }
  let previous = 0;
  for (let index = offset; index <= offset + rows; index += 1) {
    const next = readUnsignedOffset(offsets, index, 4);
    if (next < previous || next > data.byteLength) {
      throw invalidArgument(`Column ${columnId} has invalid display offsets`);
    }
    previous = next;
  }
}

function validateNative(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  depth: number,
  name: string,
): void {
  if (depth >= MAX_NESTING_DEPTH) {
    throw invalidArgument(`Native column nesting may not exceed ${MAX_NESTING_DEPTH}`);
  }
  assertNonNegativeSafeInteger(descriptor.length, `${name}.length`);
  assertNonNegativeSafeInteger(descriptor.offset ?? 0, `${name}.offset`);
  normalizeDataType(descriptor.dataType, depth);
  const regions = [
    descriptor.validity,
    descriptor.values,
    descriptor.offsets,
    descriptor.sizes,
    descriptor.data,
    descriptor.typeIds,
    descriptor.unionOffsets,
    ...(descriptor.variadicBuffers ?? []),
  ];
  for (const region of regions) {
    if (region) {
      regionView(region, buffers, name);
    }
  }
  for (const [index, child] of (descriptor.children ?? []).entries()) {
    validateNative(child, buffers, depth + 1, `${name}.children[${index}]`);
  }
  if (descriptor.dictionary) {
    validateNative(descriptor.dictionary, buffers, depth + 1, `${name}.dictionary`);
  }
  if (descriptor.runEnds) {
    validateNative(descriptor.runEnds, buffers, depth + 1, `${name}.runEnds`);
  }
}

function decodeNativeValue(
  descriptor: NativeColumnDescriptor,
  logicalIndex: number,
  buffers: readonly Uint8Array[],
  depth: number,
): NativeValue | null {
  if (depth >= MAX_NESTING_DEPTH) {
    throw invalidArgument(`Native value nesting may not exceed ${MAX_NESTING_DEPTH}`);
  }
  if (logicalIndex < 0 || logicalIndex >= descriptor.length) {
    throw invalidArgument("Native value index is outside its descriptor");
  }
  const physicalIndex = (descriptor.offset ?? 0) + logicalIndex;
  if (!validAt(descriptor.validity, physicalIndex, buffers)) {
    return null;
  }
  const type = unwrapExtension(descriptor.dataType);
  switch (type.type) {
    case "null":
      return null;
    case "unknown": {
      const bytes = decodeVariableBytes(descriptor, buffers, physicalIndex, 4);
      return UTF8_DECODER.decode(bytes);
    }
    case "boolean": {
      const values = requiredRegion(descriptor.values, buffers, "boolean values");
      const bitIndex = (descriptor.values?.bitOffset ?? 0) + physicalIndex;
      return (values[bitIndex >>> 3]! & (1 << (bitIndex & 7))) !== 0;
    }
    case "int8": return readNumber(descriptor, buffers, physicalIndex, 1, "signed");
    case "uint8": return readNumber(descriptor, buffers, physicalIndex, 1, "unsigned");
    case "int16": return readNumber(descriptor, buffers, physicalIndex, 2, "signed");
    case "uint16": return readNumber(descriptor, buffers, physicalIndex, 2, "unsigned");
    case "int32": return readNumber(descriptor, buffers, physicalIndex, 4, "signed");
    case "uint32": return readNumber(descriptor, buffers, physicalIndex, 4, "unsigned");
    case "int64": return readBigInt(descriptor, buffers, physicalIndex, true);
    case "uint64": return readBigInt(descriptor, buffers, physicalIndex, false);
    case "float16": return decodeFloat16(readNumber(descriptor, buffers, physicalIndex, 2, "unsigned"));
    case "float32": return readFloat(descriptor, buffers, physicalIndex, 4);
    case "float64": return readFloat(descriptor, buffers, physicalIndex, 8);
    case "utf8":
    case "large-utf8": {
      const bytes = decodeVariableBytes(descriptor, buffers, physicalIndex, type.type === "large-utf8" ? 8 : 4);
      return UTF8_DECODER.decode(bytes);
    }
    case "binary":
    case "large-binary":
      return decodeVariableBytes(descriptor, buffers, physicalIndex, type.type === "large-binary" ? 8 : 4).slice();
    case "utf8-view":
      return UTF8_DECODER.decode(decodeViewBytes(descriptor, buffers, physicalIndex));
    case "binary-view":
      return decodeViewBytes(descriptor, buffers, physicalIndex).slice();
    case "fixed-size-binary": {
      const data = requiredRegion(descriptor.data ?? descriptor.values, buffers, "fixed-size binary data");
      const start = physicalIndex * type.byteWidth;
      return checkedSlice(data, start, start + type.byteWidth, "fixed-size binary data").slice();
    }
    case "decimal32":
    case "decimal64":
    case "decimal128":
    case "decimal256": {
      const width = { decimal32: 4, decimal64: 8, decimal128: 16, decimal256: 32 }[type.type];
      return Object.freeze({
        kind: "decimal",
        unscaled: readSignedLittleEndian(requiredRegion(descriptor.values, buffers, "decimal values"), physicalIndex * width, width),
        precision: type.precision,
        scale: type.scale,
      });
    }
    case "date32":
      return Object.freeze({ kind: "date32", value: readNumber(descriptor, buffers, physicalIndex, 4, "signed") });
    case "date64":
      return Object.freeze({ kind: "date64", value: readBigInt(descriptor, buffers, physicalIndex, true), unit: "millisecond" });
    case "time32":
      return Object.freeze({ kind: "time32", value: readNumber(descriptor, buffers, physicalIndex, 4, "signed"), unit: type.unit });
    case "time64":
      return Object.freeze({ kind: "time64", value: readBigInt(descriptor, buffers, physicalIndex, true), unit: type.unit });
    case "timestamp":
      return Object.freeze({
        kind: "timestamp",
        value: readBigInt(descriptor, buffers, physicalIndex, true),
        unit: type.unit,
        ...(type.timezone === undefined ? {} : { timezone: type.timezone }),
      });
    case "duration":
      return Object.freeze({ kind: "duration", value: readBigInt(descriptor, buffers, physicalIndex, true), unit: type.unit });
    case "interval":
      return decodeInterval(descriptor, buffers, physicalIndex, type.unit);
    case "list":
    case "large-list":
    case "list-view":
    case "large-list-view":
    case "map":
      return decodeListLike(descriptor, buffers, physicalIndex, type, depth);
    case "fixed-size-list": {
      const child = requiredChild(descriptor, 0, "fixed-size list");
      const start = physicalIndex * type.listSize;
      return Object.freeze(Array.from(
        { length: type.listSize },
        (_, index) => decodeNativeValue(child, start + index - (child.offset ?? 0), buffers, depth + 1),
      ));
    }
    case "struct": {
      const result: Record<string, NativeValue | null> = {};
      for (let index = 0; index < type.fields.length; index += 1) {
        const child = requiredChild(descriptor, index, "struct");
        result[type.fields[index]!.name] = decodeNativeValue(
          child,
          physicalIndex - (child.offset ?? 0),
          buffers,
          depth + 1,
        );
      }
      return Object.freeze(result);
    }
    case "union": {
      const typeIds = requiredRegion(descriptor.typeIds, buffers, "union type ids");
      if (physicalIndex >= typeIds.byteLength) {
        throw invalidArgument("Union type id is out of bounds");
      }
      const typeId = dataViewFor(typeIds).getInt8(physicalIndex);
      const fieldIndex = type.fields.findIndex((entry) => entry.typeId === typeId);
      if (fieldIndex < 0) {
        throw invalidArgument(`Union type id ${typeId} has no child`);
      }
      const child = requiredChild(descriptor, fieldIndex, "union");
      const childPhysical = type.mode === "dense"
        ? readSignedOffset(requiredRegion(descriptor.unionOffsets ?? descriptor.offsets, buffers, "union offsets"), physicalIndex, 4)
        : physicalIndex;
      return Object.freeze({
        kind: "union",
        typeId,
        value: decodeNativeValue(child, childPhysical - (child.offset ?? 0), buffers, depth + 1),
      });
    }
    case "dictionary": {
      const keys = descriptor.children?.[0] ?? descriptor;
      const dictionary = descriptor.dictionary ?? descriptor.children?.[1];
      if (!dictionary || !keys) {
        throw invalidArgument("Dictionary descriptor has no dictionary values");
      }
      const index = readIndex(keys, buffers, physicalIndex, type.indexType);
      if (index < 0 || index >= dictionary.length) {
        throw invalidArgument("Dictionary index is out of bounds");
      }
      return decodeNativeValue(dictionary, index, buffers, depth + 1);
    }
    case "run-end-encoded": {
      const runEnds = descriptor.runEnds ?? descriptor.children?.[0];
      const values = descriptor.children?.[descriptor.runEnds ? 0 : 1];
      if (!runEnds || !values) {
        throw invalidArgument("Run-end encoded descriptor is incomplete");
      }
      const logicalPosition = physicalIndex + 1;
      let run = 0;
      while (run < runEnds.length && numericIndexValue(runEnds, buffers, run) < logicalPosition) {
        run += 1;
      }
      if (run >= values.length) {
        throw invalidArgument("Run-end encoded value is out of bounds");
      }
      return decodeNativeValue(values, run, buffers, depth + 1);
    }
    case "extension":
      // unwrapExtension makes this unreachable while retaining exhaustive typing.
      throw invalidArgument("Nested extension data type could not be unwrapped");
  }
}

function decodeListLike(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  physicalIndex: number,
  type: Extract<ArrowDataType, { type: "list" | "large-list" | "list-view" | "large-list-view" | "map" }>,
  depth: number,
): NativeValue {
  const width = type.type === "large-list" || type.type === "large-list-view" ? 8 : 4;
  const offsets = requiredRegion(descriptor.offsets, buffers, "list offsets");
  const start = readSignedOffset(offsets, physicalIndex, width);
  const end = type.type === "list-view" || type.type === "large-list-view"
    ? start + readSignedOffset(requiredRegion(descriptor.sizes, buffers, "list sizes"), physicalIndex, width)
    : readSignedOffset(offsets, physicalIndex + 1, width);
  if (start < 0 || end < start) {
    throw invalidArgument("List offsets are invalid");
  }
  const child = requiredChild(descriptor, 0, type.type);
  const values: NativeListValue = Object.freeze(Array.from(
    { length: end - start },
    (_, index) => decodeNativeValue(child, start + index - (child.offset ?? 0), buffers, depth + 1),
  ));
  if (type.type !== "map") {
    return values;
  }
  return Object.freeze(values.map((entry: NativeValue | null) => {
    if (!isRecord(entry)) {
      throw invalidArgument("Map entries must decode from a struct");
    }
    const record = entry as NativeStructValue;
    const entryType = type.entries.dataType;
    const fields = entryType.type === "struct" ? entryType.fields : [];
    const keyName = fields[0]?.name ?? "key";
    const valueName = fields[1]?.name ?? "value";
    return Object.freeze({
      key: record[keyName] ?? null,
      value: record[valueName] ?? null,
    });
  }));
}

function decodeInterval(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  unit: IntervalUnit,
): IntervalValue {
  const values = requiredRegion(descriptor.values, buffers, "interval values");
  const view = dataViewFor(values);
  if (unit === "year-month") {
    ensureViewRange(view, index * 4, 4, "year-month interval");
    return Object.freeze({ kind: "interval", unit, months: view.getInt32(index * 4, true) });
  }
  if (unit === "day-time") {
    const offset = index * 8;
    ensureViewRange(view, offset, 8, "day-time interval");
    return Object.freeze({
      kind: "interval",
      unit,
      days: view.getInt32(offset, true),
      milliseconds: view.getInt32(offset + 4, true),
    });
  }
  const offset = index * 16;
  ensureViewRange(view, offset, 16, "month-day-nano interval");
  return Object.freeze({
    kind: "interval",
    unit,
    months: view.getInt32(offset, true),
    days: view.getInt32(offset + 4, true),
    nanoseconds: view.getBigInt64(offset + 8, true),
  });
}

function decodeVariableBytes(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  offsetWidth: 4 | 8,
): Uint8Array {
  const offsets = requiredRegion(descriptor.offsets, buffers, "variable offsets");
  const data = requiredRegion(descriptor.data ?? descriptor.values, buffers, "variable data");
  const start = readUnsignedOffset(offsets, index, offsetWidth);
  const end = readUnsignedOffset(offsets, index + 1, offsetWidth);
  return checkedSlice(data, start, end, "variable data");
}

function decodeViewBytes(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
): Uint8Array {
  const views = requiredRegion(descriptor.values, buffers, "view values");
  const view = dataViewFor(views);
  const offset = index * 16;
  ensureViewRange(view, offset, 16, "view value");
  const length = view.getInt32(offset, true);
  if (length < 0) {
    throw invalidArgument("View length must be non-negative");
  }
  if (length <= 12) {
    return checkedSlice(views, offset + 4, offset + 4 + length, "inline view");
  }
  const bufferIndex = view.getInt32(offset + 8, true);
  const dataOffset = view.getInt32(offset + 12, true);
  const data = descriptor.variadicBuffers?.[bufferIndex];
  if (!data || dataOffset < 0) {
    throw invalidArgument("View references an invalid variadic buffer");
  }
  return checkedSlice(regionView(data, buffers, "view data"), dataOffset, dataOffset + length, "view data");
}

function readNumber(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  width: 1 | 2 | 4,
  signedness: "signed" | "unsigned",
): number {
  const values = requiredRegion(descriptor.values, buffers, "numeric values");
  const view = dataViewFor(values);
  const offset = index * width;
  ensureViewRange(view, offset, width, "numeric value");
  if (width === 1) return signedness === "signed" ? view.getInt8(offset) : view.getUint8(offset);
  if (width === 2) return signedness === "signed" ? view.getInt16(offset, true) : view.getUint16(offset, true);
  return signedness === "signed" ? view.getInt32(offset, true) : view.getUint32(offset, true);
}

function readFloat(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  width: 4 | 8,
): number {
  const values = requiredRegion(descriptor.values, buffers, "floating-point values");
  const view = dataViewFor(values);
  const offset = index * width;
  ensureViewRange(view, offset, width, "floating-point value");
  return width === 4 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
}

function readBigInt(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  signed: boolean,
): bigint {
  const values = requiredRegion(descriptor.values, buffers, "64-bit values");
  const view = dataViewFor(values);
  const offset = index * 8;
  ensureViewRange(view, offset, 8, "64-bit value");
  return signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true);
}

function readIndex(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
  dataType: ArrowDataType,
): number {
  const type = unwrapExtension(dataType).type;
  let value: number | bigint;
  if (type === "int8") value = readNumber(descriptor, buffers, index, 1, "signed");
  else if (type === "uint8") value = readNumber(descriptor, buffers, index, 1, "unsigned");
  else if (type === "int16") value = readNumber(descriptor, buffers, index, 2, "signed");
  else if (type === "uint16") value = readNumber(descriptor, buffers, index, 2, "unsigned");
  else if (type === "int32") value = readNumber(descriptor, buffers, index, 4, "signed");
  else if (type === "uint32") value = readNumber(descriptor, buffers, index, 4, "unsigned");
  else if (type === "int64") value = readBigInt(descriptor, buffers, index, true);
  else if (type === "uint64") value = readBigInt(descriptor, buffers, index, false);
  else throw invalidArgument("Dictionary index type must be an integer");
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric)) {
    throw invalidArgument("Dictionary index exceeds the JavaScript safe integer range");
  }
  return numeric;
}

function numericIndexValue(
  descriptor: NativeColumnDescriptor,
  buffers: readonly Uint8Array[],
  index: number,
): number {
  const type = unwrapExtension(descriptor.dataType);
  return readIndex({ ...descriptor, dataType: { type: "dictionary", indexType: type, valueType: { type: "null" } } }, buffers, index, type);
}

function readSignedLittleEndian(bytes: Uint8Array, offset: number, width: number): bigint {
  const slice = checkedSlice(bytes, offset, offset + width, "signed integer");
  let value = 0n;
  for (let index = slice.byteLength - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(slice[index]!);
  }
  const sign = 1n << BigInt(width * 8 - 1);
  return (value & sign) === 0n ? value : value - (1n << BigInt(width * 8));
}

function readUnsignedOffset(bytes: Uint8Array, index: number, width: 4 | 8): number {
  const value = readOffset(bytes, index, width, false);
  if (value < 0) {
    throw invalidArgument("Offset must be non-negative");
  }
  return value;
}

function readSignedOffset(bytes: Uint8Array, index: number, width: 4 | 8): number {
  return readOffset(bytes, index, width, true);
}

function dataViewFor(bytes: Uint8Array): DataView {
  // Uint8Array.buffer is an ArrayBufferLike object (ArrayBuffer or
  // SharedArrayBuffer). The nested numeric maps avoid allocating a string key
  // on every primitive decode while preserving distinct subview boundaries.
  const backing = bytes.buffer as unknown as object;
  let byOffset = DATA_VIEW_CACHE.get(backing);
  if (byOffset === undefined) {
    byOffset = new Map();
    DATA_VIEW_CACHE.set(backing, byOffset);
  }
  let byLength = byOffset.get(bytes.byteOffset);
  if (byLength === undefined) {
    byLength = new Map();
    byOffset.set(bytes.byteOffset, byLength);
  }
  let view = byLength.get(bytes.byteLength);
  if (view === undefined) {
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    byLength.set(bytes.byteLength, view);
  }
  return view;
}

function readOffset(bytes: Uint8Array, index: number, width: 4 | 8, signed: boolean): number {
  const view = dataViewFor(bytes);
  const offset = index * width;
  ensureViewRange(view, offset, width, "offset");
  const value = width === 4
    ? signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
    : signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true);
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric)) {
    throw invalidArgument("Offset exceeds the JavaScript safe integer range");
  }
  return numeric;
}

function validAt(
  validity: BatchBufferRegion | undefined,
  index: number,
  buffers: readonly Uint8Array[],
): boolean {
  if (!validity) return true;
  const bitmap = regionView(validity, buffers, "validity bitmap");
  const bitIndex = (validity.bitOffset ?? 0) + index;
  if (bitIndex < 0 || (bitIndex >>> 3) >= bitmap.byteLength) {
    throw invalidArgument("Validity bitmap index is out of bounds");
  }
  return (bitmap[bitIndex >>> 3]! & (1 << (bitIndex & 7))) !== 0;
}

function requiredRegion(
  region: BatchBufferRegion | undefined,
  buffers: readonly Uint8Array[],
  name: string,
): Uint8Array {
  if (!region) throw invalidArgument(`${name} are missing`);
  return regionView(region, buffers, name);
}

function regionView(
  region: BatchBufferRegion,
  buffers: readonly Uint8Array[],
  name: string,
): Uint8Array {
  if (!isRecord(region) || !Number.isSafeInteger(region.buffer) || region.buffer < 0) {
    throw invalidArgument(`${name} references an invalid buffer`);
  }
  const buffer = buffers[region.buffer];
  if (!buffer) throw invalidArgument(`${name} references a missing buffer`);
  const byteOffset = region.byteOffset ?? 0;
  const byteLength = region.byteLength ?? buffer.byteLength - byteOffset;
  if (
    !Number.isSafeInteger(byteOffset)
    || byteOffset < 0
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || byteOffset + byteLength > buffer.byteLength
  ) {
    throw invalidArgument(`${name} region is outside its buffer`);
  }
  return buffer.subarray(byteOffset, byteOffset + byteLength);
}

function requiredChild(descriptor: NativeColumnDescriptor, index: number, name: string): NativeColumnDescriptor {
  const child = descriptor.children?.[index];
  if (!child) throw invalidArgument(`${name} descriptor has no child ${index}`);
  return child;
}

function checkedSlice(bytes: Uint8Array, start: number, end: number, name: string): Uint8Array {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.byteLength) {
    throw invalidArgument(`${name} slice is out of bounds`);
  }
  return bytes.subarray(start, end);
}

function ensureViewRange(view: DataView, offset: number, width: number, name: string): void {
  if (offset < 0 || offset + width > view.byteLength) {
    throw invalidArgument(`${name} is out of bounds`);
  }
}

function unwrapExtension(dataType: ArrowDataType): ArrowDataType {
  let current = dataType;
  for (let depth = 0; current.type === "extension"; depth += 1) {
    if (depth >= MAX_NESTING_DEPTH) throw invalidArgument("Extension nesting is too deep");
    current = current.storageType;
  }
  return current;
}

function freezeWireColumn(column: WireTableBatchColumn): WireTableBatchColumn {
  return Object.freeze({
    columnId: column.columnId,
    native: freezeNative(column.native),
    display: Object.freeze({
      ...column.display,
      data: freezeRegion(column.display.data),
      offsets: freezeRegion(column.display.offsets),
      ...(column.display.validity ? { validity: freezeRegion(column.display.validity) } : {}),
    }),
  });
}

function freezeNative(descriptor: NativeColumnDescriptor): NativeColumnDescriptor {
  const freezeOptionalRegion = (region: BatchBufferRegion | undefined) => region ? freezeRegion(region) : undefined;
  return Object.freeze({
    ...descriptor,
    dataType: freezeDataType(descriptor.dataType),
    ...(freezeOptionalRegion(descriptor.validity) ? { validity: freezeOptionalRegion(descriptor.validity)! } : {}),
    ...(freezeOptionalRegion(descriptor.values) ? { values: freezeOptionalRegion(descriptor.values)! } : {}),
    ...(freezeOptionalRegion(descriptor.offsets) ? { offsets: freezeOptionalRegion(descriptor.offsets)! } : {}),
    ...(freezeOptionalRegion(descriptor.sizes) ? { sizes: freezeOptionalRegion(descriptor.sizes)! } : {}),
    ...(freezeOptionalRegion(descriptor.data) ? { data: freezeOptionalRegion(descriptor.data)! } : {}),
    ...(freezeOptionalRegion(descriptor.typeIds) ? { typeIds: freezeOptionalRegion(descriptor.typeIds)! } : {}),
    ...(freezeOptionalRegion(descriptor.unionOffsets) ? { unionOffsets: freezeOptionalRegion(descriptor.unionOffsets)! } : {}),
    ...(descriptor.variadicBuffers
      ? { variadicBuffers: Object.freeze(descriptor.variadicBuffers.map(freezeRegion)) }
      : {}),
    ...(descriptor.children
      ? { children: Object.freeze(descriptor.children.map(freezeNative)) }
      : {}),
    ...(descriptor.dictionary ? { dictionary: freezeNative(descriptor.dictionary) } : {}),
    ...(descriptor.runEnds ? { runEnds: freezeNative(descriptor.runEnds) } : {}),
  });
}

function freezeRegion(region: BatchBufferRegion): BatchBufferRegion {
  return Object.freeze({ ...region });
}

function freezeDataType(dataType: ArrowDataType): ArrowDataType {
  return normalizeDataTypeUnchecked(dataType, 0);
}

function normalizeDataTypeUnchecked(value: ArrowDataType, depth: number): ArrowDataType {
  // Public construction already validates; metadata/batch normalization may
  // arrive from protocol values, so use the same validator for one canonical shape.
  return normalizeDataType(value, depth);
}

function timeUnit(value: unknown): TimeUnit {
  if (value === "second" || value === "millisecond" || value === "microsecond" || value === "nanosecond") {
    return value;
  }
  throw invalidArgument("Arrow time unit is invalid");
}

function intervalUnit(value: unknown): IntervalUnit {
  if (value === "year-month" || value === "day-time" || value === "month-day-nano") return value;
  throw invalidArgument("Arrow interval unit is invalid");
}

function decodeFloat16(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function normalizeCellLimit(value: number | undefined): number {
  const maxCells = value ?? DEFAULT_TO_ROWS_CELL_LIMIT;
  assertPositiveSafeInteger(maxCells, "maxCells");
  return maxCells;
}

function assertCellLimit(rows: number, columns: number, maxCells: number): void {
  const cellCount = rows * columns;
  if (!Number.isSafeInteger(cellCount) || cellCount > maxCells) {
    throw new TabularkError(
      "RESOURCE_LIMIT",
      `Decoding ${cellCount} cells exceeds the toRows limit of ${maxCells}`,
      {
        details: {
          resource: "row-materialization-cells",
          required: cellCount,
          available: maxCells,
          cellCount,
          maxCells,
        },
      },
    );
  }
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw invalidArgument(`${name} must be a safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  const result = integer(value, name);
  if (result <= 0) throw invalidArgument(`${name} must be positive`);
  return result;
}

function asUint8Array(value: WireBatchBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

export function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidArgument(`${name} must be a non-negative safe integer`, { name, value });
  }
}

export function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidArgument(`${name} must be a positive safe integer`, { name, value });
  }
}
