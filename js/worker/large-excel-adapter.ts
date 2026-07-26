import { BATCH_LAYOUT_VERSION } from "../protocol.js";
import type { RangeRequest, WireTableBatch } from "../model.js";
import type {
  AxisExtent,
  MergedCellRegion,
  PresentationAxisEntry,
  PresentationStyle,
  SpreadsheetPresentation,
  SpreadsheetPresentationRange,
  TableDescriptor,
  TableMetadata,
} from "../model.js";
import { ProtocolFault } from "./worker-errors.js";

/**
 * A small, deliberately conservative XLSX adapter used by the large-file
 * prototype.  The production WASM Excel adapter stages a complete workbook;
 * this adapter instead drives a resumable range protocol.  It never receives
 * a Blob (the Worker owns the Blob), and therefore cannot accidentally call
 * `arrayBuffer()` on the source.  Every source access is represented by a
 * bounded `read-bytes` action returned from one of the operation methods.
 */

/** The large runtime is a private implementation of the official Excel ID. */
export const LARGE_EXCEL_ADAPTER_ID = "tabulark:excel" as const;

export interface LargeExcelAdapterConfig {
  /** Maximum bytes requested by one read-bytes action. */
  readonly chunkBytes?: number;
  /** Maximum tail window used to locate EOCD. */
  readonly tailBytes?: number;
  readonly maxEntries?: number;
  readonly maxCentralDirectoryBytes?: number;
  readonly maxCompressedEntryBytes?: number;
  readonly maxExpandedEntryBytes?: number;
  readonly maxTotalExpandedBytes?: number;
  readonly maxXmlBytes?: number;
  readonly maxWorksheetCells?: number;
  readonly maxRangeCells?: number;
  readonly maxColumns?: number;
  readonly maxRows?: number;
  readonly maxSheets?: number;
  readonly maxStyles?: number;
  readonly maxMergedRegions?: number;
  readonly maxLayoutEntries?: number;
  readonly maxWarnings?: number;
}

export interface ReadBytesAction {
  readonly kind: "read-bytes";
  readonly offset: number;
  readonly length: number;
}

interface LargeExcelWarning {
  readonly kind: string;
  readonly message: string;
  readonly tableId?: string;
  readonly sourceOffset?: number;
  readonly row?: number;
  readonly column?: number;
}

export interface ReadBytesStep {
  readonly kind: "read-bytes";
  readonly operationHandle: string | number;
  readonly action: ReadBytesAction;
}

export interface OpenCompleteStep {
  readonly kind: "open-complete";
  readonly sourceHandle: string;
  /** Conservative bytes retained by parsed workbook/index state. */
  readonly retainedBytes: number;
  readonly tables: readonly TableDescriptor[];
  readonly metadata: TableMetadata;
  readonly progress: Readonly<{
    readonly sourceHandle: string;
    readonly bytesScanned: number;
    readonly rowsDiscovered: number;
    readonly done: true;
  }>;
  readonly warnings: readonly LargeExcelWarning[];
}

export interface ReadCompleteStep {
  readonly kind: "read-complete";
  readonly batch: WireTableBatch;
  readonly warnings: readonly LargeExcelWarning[];
}

export type LargeExcelOpenStep = ReadBytesStep | OpenCompleteStep;
export type LargeExcelReadStep = ReadBytesStep | ReadCompleteStep;
export type LargeExcelOperationStep = LargeExcelOpenStep | LargeExcelReadStep;

interface Limits {
  readonly chunkBytes: number;
  readonly tailBytes: number;
  readonly maxEntries: number;
  readonly maxCentralDirectoryBytes: number;
  readonly maxCompressedEntryBytes: number;
  readonly maxExpandedEntryBytes: number;
  readonly maxTotalExpandedBytes: number;
  readonly maxXmlBytes: number;
  readonly maxWorksheetCells: number;
  readonly maxRangeCells: number;
  readonly maxColumns: number;
  readonly maxRows: number;
  readonly maxSheets: number;
  readonly maxStyles: number;
  readonly maxMergedRegions: number;
  readonly maxLayoutEntries: number;
  readonly maxWarnings: number;
}

const DEFAULT_LIMITS: Limits = Object.freeze({
  chunkBytes: 1 * 1024 * 1024,
  tailBytes: 128 * 1024,
  maxEntries: 16_384,
  maxCentralDirectoryBytes: 32 * 1024 * 1024,
  maxCompressedEntryBytes: 64 * 1024 * 1024,
  maxExpandedEntryBytes: 128 * 1024 * 1024,
  maxTotalExpandedBytes: 256 * 1024 * 1024,
  maxXmlBytes: 64 * 1024 * 1024,
  maxWorksheetCells: 1_000_000,
  maxRangeCells: 250_000,
  maxColumns: 16_384,
  maxRows: 1_048_576,
  maxSheets: 1_024,
  maxStyles: 16_384,
  maxMergedRegions: 100_000,
  maxLayoutEntries: 100_000,
  maxWarnings: 1_000,
});

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly crc32: number;
}

interface ExpectedRead {
  readonly offset: number;
  readonly length: number;
}

interface EntryReader {
  readonly task: EntryTask;
  readonly entry: ZipEntry;
  phase: "header" | "data";
  expected: ExpectedRead;
  dataOffset?: number;
  received: number;
  chunks: Uint8Array[];
}

type EntryKind = "workbook" | "relationships" | "styles" | "shared-strings" | "worksheet";

interface EntryTask {
  readonly kind: EntryKind;
  readonly path: string;
  readonly sheetIndex?: number;
}

interface OpenOperation {
  readonly kind: "open";
  readonly handle: number;
  readonly sourceLength: number;
  readonly limits: Limits;
  stage: "tail" | "central" | "entry";
  expected: ExpectedRead;
  tailOffset: number;
  tail?: Uint8Array;
  centralOffset?: number;
  centralSize?: number;
  centralEntries?: number;
  centralChunks: Uint8Array[];
  centralReceived: number;
  entries?: Map<string, ZipEntry>;
  tasks: EntryTask[];
  taskIndex: number;
  currentEntry: EntryReader | undefined;
  workbook?: WorkbookInfo;
  relationships?: Map<string, string>;
  styles?: PresentationStyle[];
  sharedStrings?: string[];
  sheets: SheetModel[];
  warnings: LargeExcelWarning[];
  bytesScanned: number;
  totalExpandedBytes: number;
  worksheetCells: number;
  worksheetLayoutEntries: number;
  worksheetMergedRegions: number;
}

interface ReadOperation {
  readonly kind: "read";
  readonly handle: number;
  readonly tableHandle: string;
  readonly request: RangeRequest;
  readonly expected: ExpectedRead;
  bytesScanned: number;
}

type Operation = OpenOperation | ReadOperation;

interface WorkbookSheetInfo {
  readonly id: string;
  readonly name: string;
  readonly state: "visible" | "hidden" | "very-hidden";
  readonly relationshipId: string;
  path?: string;
}

interface WorkbookInfo {
  readonly sheets: WorkbookSheetInfo[];
}

interface Cell {
  readonly value: string | null;
  readonly styleId: number;
}

interface SheetModel {
  readonly id: string;
  readonly name: string;
  readonly visibility: "visible" | "hidden" | "very-hidden";
  readonly rows: number;
  readonly columns: number;
  readonly cells: Map<string, Cell>;
  readonly rowLayout: Map<number, PresentationAxisEntry>;
  readonly columnLayout: Map<number, PresentationAxisEntry>;
  readonly mergedCells: MergedCellRegion[];
  readonly frozenRows: number;
  readonly frozenColumns: number;
  readonly styles: readonly PresentationStyle[];
}

interface SourceState {
  readonly handle: string;
  readonly sourceLength: number;
  readonly entries: ReadonlyMap<string, ZipEntry>;
  readonly sheets: readonly SheetModel[];
  readonly tables: readonly TableDescriptor[];
  readonly warnings: readonly LargeExcelWarning[];
  closed: boolean;
}

interface TableState {
  readonly handle: string;
  readonly sourceHandle: string;
  readonly sheet: SheetModel;
  closed: boolean;
}

/**
 * Range-backed XLSX runtime.  It intentionally mirrors the private adapter
 * ABI while remaining usable without wasm-bindgen in unit tests and browser
 * prototypes.
 */
export class LargeExcelAdapter {
  /** This runtime retains parsed/indexed state, never the complete source. */
  readonly retainsSourceBytes = false;
  readonly #limits: Limits;
  readonly #operations = new Map<number, Operation>();
  readonly #sources = new Map<string, SourceState>();
  readonly #tables = new Map<string, TableState>();
  #nextOperation = 1;
  #nextSource = 1;
  #nextTable = 1;
  #closed = false;

  constructor(config: LargeExcelAdapterConfig = {}) {
    this.#limits = normalizeLimits(config);
  }

  protocolVersion(): number {
    return 3;
  }

  adapterApiVersion(): number {
    return 2;
  }

  batchLayoutVersion(): number {
    return BATCH_LAYOUT_VERSION;
  }

  adapterId(): string {
    return LARGE_EXCEL_ADAPTER_ID;
  }

  beginOpen(options: unknown, sourceLength: number): LargeExcelOpenStep {
    void options;
    this.#assertOpenRuntime();
    assertSafeNonNegative(sourceLength, "sourceLength");
    if (sourceLength === 0) {
      throw fault("INVALID_ARGUMENT", "An XLSX source cannot be empty");
    }
    const handle = this.#allocateOperation();
    const tailLength = Math.min(sourceLength, this.#limits.tailBytes);
    const tailOffset = sourceLength - tailLength;
    const operation: OpenOperation = {
      kind: "open",
      handle,
      sourceLength,
      limits: this.#limits,
      stage: "tail",
      expected: { offset: tailOffset, length: tailLength },
      tailOffset,
      centralChunks: [],
      centralReceived: 0,
      tasks: [],
      taskIndex: 0,
      currentEntry: undefined,
      sheets: [],
      warnings: [],
      bytesScanned: 0,
      totalExpandedBytes: 0,
      worksheetCells: 0,
      worksheetLayoutEntries: 0,
      worksheetMergedRegions: 0,
    };
    this.#operations.set(handle, operation);
    return readBytesStep(handle, operation.expected);
  }

  continueOperation(
    operationHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): Promise<LargeExcelOperationStep> {
    void eof;
    const handle = operationNumber(operationHandle);
    const operation = this.#operations.get(handle);
    if (!operation) {
      throw fault("HANDLE_CLOSED", "The Excel operation handle is closed");
    }
    assertSafeNonNegative(absoluteOffset, "absoluteOffset");
    if (!(bytes instanceof Uint8Array)) {
      throw fault("INVALID_ARGUMENT", "continueOperation bytes must be a Uint8Array");
    }
    if (
      absoluteOffset !== operation.expected.offset
      || bytes.byteLength !== operation.expected.length
    ) {
      throw fault(
        "INVALID_ARGUMENT",
        "The supplied range does not match the pending read-bytes action",
        {
          expectedOffset: operation.expected.offset,
          actualOffset: absoluteOffset,
          expectedLength: operation.expected.length,
          actualLength: bytes.byteLength,
        },
      );
    }
    operation.bytesScanned = checkedAdd(operation.bytesScanned, bytes.byteLength, "bytesScanned");
    if (operation.kind === "read") {
      // Indexed worksheet models complete reads synchronously.  Keep this
      // branch for callers that intentionally subclass the prototype later.
      this.#operations.delete(handle);
      throw fault("PROTOCOL_INCOMPATIBLE", "A worksheet read operation has no pending range action");
    }
    return this.#continueOpen(operation, bytes);
  }

  openTable(sourceHandle: string | number, tableId: string): {
    readonly tableHandle: string;
    readonly metadata: TableMetadata;
    readonly warnings: readonly LargeExcelWarning[];
  } {
    this.#assertOpenRuntime();
    const source = this.#source(sourceHandle);
    if (typeof tableId !== "string" || tableId.length === 0) {
      throw fault("INVALID_ARGUMENT", "tableId must be a non-empty string");
    }
    const sheet = source.sheets.find((candidate) => candidate.id === tableId);
    if (!sheet) throw fault("INVALID_ARGUMENT", `Unknown worksheet ${tableId}`);
    const handle = `large-xlsx-table-${this.#nextTable++}`;
    const state: TableState = {
      handle,
      sourceHandle: source.handle,
      sheet,
      closed: false,
    };
    this.#tables.set(handle, state);
    return {
      tableHandle: handle,
      metadata: metadataForSheet(sheet),
      warnings: Object.freeze([...source.warnings]),
    };
  }

  metadata(tableHandle: string | number): TableMetadata {
    return metadataForSheet(this.#table(tableHandle).sheet);
  }

  presentation(tableHandle: string | number): SpreadsheetPresentation {
    const table = this.#table(tableHandle);
    const sheet = table.sheet;
    return Object.freeze({
      kind: "spreadsheet-v1",
      tableId: sheet.id,
      revision: 0,
      visibility: sheet.visibility,
      frozenRows: sheet.frozenRows,
      frozenColumns: sheet.frozenColumns,
      rows: Object.freeze([...sheet.rowLayout.values()]),
      columns: Object.freeze([...sheet.columnLayout.values()]),
      styles: Object.freeze(sheet.styles.map((style) => Object.freeze({ ...style }))),
    });
  }

  readPresentationRange(
    tableHandle: string | number,
    request: RangeRequest,
  ): SpreadsheetPresentationRange {
    const table = this.#table(tableHandle);
    const sheet = table.sheet;
    const requested = validateRange(request, this.#limits.maxRangeCells);
    const clipped = clipRangeToSheet(
      requested,
      sheet.rows,
      sheet.columns,
    );
    const styleIds: (number | null)[][] = [];
    // Presentation responses stay aligned to the caller's range even when
    // the requested rectangle extends beyond the indexed worksheet. Cells
    // outside the sheet simply have no style; this matches the public
    // range-alignment contract while keeping the lookup work bounded by the
    // validated request cell limit.
    for (let row = 0; row < requested.rowCount; row += 1) {
      const result: (number | null)[] = [];
      for (let column = 0; column < requested.columnCount; column += 1) {
        const rowIndex = requested.rowStart + row;
        const columnIndex = requested.columnStart + column;
        const insideSheet = rowIndex >= clipped.rowStart
          && rowIndex < clipped.rowStart + clipped.rowCount
          && columnIndex >= clipped.columnStart
          && columnIndex < clipped.columnStart + clipped.columnCount;
        const cell = insideSheet ? sheet.cells.get(cellKey(rowIndex, columnIndex)) : undefined;
        const styleId = cell?.styleId ?? 0;
        result.push(styleId > 0 && styleId < sheet.styles.length ? styleId : null);
      }
      styleIds.push(result);
    }
    const rowEnd = requested.rowStart + requested.rowCount;
    const columnEnd = requested.columnStart + requested.columnCount;
    return Object.freeze({
      kind: "spreadsheet-v1",
      tableId: sheet.id,
      revision: 0,
      range: Object.freeze({ ...requested }),
      styleIds: Object.freeze(styleIds.map((row) => Object.freeze(row))),
      mergedCells: Object.freeze(sheet.mergedCells.filter((merge) => (
        merge.rowStart < rowEnd
        && merge.rowEnd > requested.rowStart
        && merge.columnStart < columnEnd
        && merge.columnEnd > requested.columnStart
      ))),
      rows: Object.freeze([...sheet.rowLayout.values()].filter((entry) => (
        entry.index >= requested.rowStart && entry.index < rowEnd
      ))),
      columns: Object.freeze([...sheet.columnLayout.values()].filter((entry) => (
        entry.index >= requested.columnStart && entry.index < columnEnd
      ))),
    });
  }

  beginRead(tableHandle: string | number, request: RangeRequest): LargeExcelReadStep {
    const table = this.#table(tableHandle);
    const range = clipRangeToSheet(
      validateRange(request, this.#limits.maxRangeCells),
      table.sheet.rows,
      table.sheet.columns,
    );
    return {
      kind: "read-complete",
      batch: makeStringBatch(table.sheet, range),
      warnings: Object.freeze([]),
    };
  }

  /** Cancels either an open or a read operation. */
  cancel(operationHandle: string | number): boolean {
    const handle = operationNumber(operationHandle);
    return this.#operations.delete(handle);
  }

  cancelOperation(operationHandle: string | number): boolean {
    return this.cancel(operationHandle);
  }

  close(handle: string | number): boolean {
    const text = String(handle);
    if (this.#tables.has(text)) return this.closeTable(text);
    if (this.#sources.has(text)) return this.closeSource(text);
    return false;
  }

  closeTable(tableHandle: string | number): boolean {
    const key = String(tableHandle);
    const table = this.#tables.get(key);
    if (!table || table.closed) return false;
    table.closed = true;
    this.#tables.delete(key);
    return true;
  }

  closeSource(sourceHandle: string | number): boolean {
    const key = String(sourceHandle);
    const source = this.#sources.get(key);
    if (!source || source.closed) return false;
    source.closed = true;
    for (const [handle, table] of this.#tables) {
      if (table.sourceHandle === source.handle) {
        table.closed = true;
        this.#tables.delete(handle);
      }
    }
    this.#sources.delete(key);
    return true;
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#operations.clear();
    for (const table of this.#tables.values()) table.closed = true;
    for (const source of this.#sources.values()) source.closed = true;
    this.#tables.clear();
    this.#sources.clear();
  }

  async #continueOpen(operation: OpenOperation, bytes: Uint8Array): Promise<LargeExcelOpenStep> {
    if (!this.#operations.has(operation.handle)) {
      throw fault("CANCELLED", "The Excel open operation was cancelled");
    }
    if (operation.stage === "tail") {
      operation.tail = bytes.slice();
      const eocd = parseEndOfCentralDirectory(operation.tail, operation.tailOffset, operation.sourceLength);
      operation.centralOffset = eocd.offset;
      operation.centralSize = eocd.size;
      operation.centralEntries = eocd.entries;
      if (eocd.size > operation.limits.maxCentralDirectoryBytes) {
        throw resourceFault("zip-central-directory", eocd.size, operation.limits.maxCentralDirectoryBytes);
      }
      const tailStart = operation.tailOffset;
      const tailEnd = tailStart + operation.tail.byteLength;
      if (eocd.offset >= tailStart && eocd.offset + eocd.size <= tailEnd) {
        operation.centralChunks = [operation.tail.subarray(eocd.offset - tailStart, eocd.offset - tailStart + eocd.size).slice()];
        operation.centralReceived = eocd.size;
        return this.#finishCentral(operation);
      }
      operation.stage = "central";
      operation.expected = {
        offset: eocd.offset,
        length: Math.min(operation.limits.chunkBytes, eocd.size),
      };
      return readBytesStep(operation.handle, operation.expected);
    }

    if (operation.stage === "central") {
      operation.centralChunks.push(bytes.slice());
      operation.centralReceived = checkedAdd(operation.centralReceived, bytes.byteLength, "central directory bytes");
      const centralSize = operation.centralSize!;
      if (operation.centralReceived < centralSize) {
        const offset = operation.centralOffset! + operation.centralReceived;
        operation.expected = {
          offset,
          length: Math.min(operation.limits.chunkBytes, centralSize - operation.centralReceived),
        };
        return readBytesStep(operation.handle, operation.expected);
      }
      return this.#finishCentral(operation);
    }

    const reader = operation.currentEntry;
    if (!reader) throw fault("PROTOCOL_INCOMPATIBLE", "Missing pending ZIP entry read");
    if (reader.phase === "header") {
      const header = parseLocalHeader(bytes, reader.entry);
      reader.dataOffset = header.dataOffset;
      const dataEnd = checkedAdd(
        header.dataOffset,
        reader.entry.compressedSize,
        "ZIP entry data range",
      );
      if (dataEnd > operation.sourceLength) {
        throw fault("INVALID_ARGUMENT", `ZIP entry ${reader.entry.name} data lies outside the source`);
      }
      reader.phase = "data";
      if (reader.entry.compressedSize === 0) {
        return this.#finishEntry(operation, reader, new Uint8Array());
      }
      reader.expected = {
        offset: header.dataOffset,
        length: Math.min(operation.limits.chunkBytes, reader.entry.compressedSize),
      };
      operation.expected = reader.expected;
      return readBytesStep(operation.handle, reader.expected);
    }
    reader.chunks.push(bytes.slice());
    reader.received = checkedAdd(reader.received, bytes.byteLength, "ZIP entry bytes");
    if (reader.received < reader.entry.compressedSize) {
      reader.expected = {
        offset: reader.dataOffset! + reader.received,
        length: Math.min(operation.limits.chunkBytes, reader.entry.compressedSize - reader.received),
      };
      operation.expected = reader.expected;
      return readBytesStep(operation.handle, reader.expected);
    }
    const compressed = concatBytes(reader.chunks, reader.entry.compressedSize);
    const decoded = await decodeZipEntry(compressed, reader.entry, operation.limits);
    if (!this.#operations.has(operation.handle)) {
      throw fault("CANCELLED", "The Excel open operation was cancelled");
    }
    return this.#finishEntry(operation, reader, decoded);
  }

  #finishCentral(operation: OpenOperation): LargeExcelOpenStep {
    const central = concatBytes(operation.centralChunks, operation.centralSize!);
    operation.entries = parseCentralDirectory(
      central,
      operation.limits,
      operation.sourceLength,
      operation.centralEntries,
    );
    const workbookPath = findWorkbookPath(operation.entries);
    if (!workbookPath) throw fault("UNSUPPORTED_FEATURE", "XLSX workbook.xml entry is missing");
    operation.tasks = [{ kind: "workbook", path: workbookPath }];
    operation.taskIndex = 0;
    operation.stage = "entry";
    return this.#advanceOpen(operation);
  }

  #advanceOpen(operation: OpenOperation): LargeExcelOpenStep {
    for (;;) {
      if (operation.currentEntry) {
        throw fault("PROTOCOL_INCOMPATIBLE", "ZIP entry reader is still active");
      }
      const task = operation.tasks[operation.taskIndex++];
      if (!task) return this.#completeOpen(operation);
      const entry = operation.entries!.get(task.path);
      if (!entry) {
        if (task.kind === "workbook") {
          throw fault("UNSUPPORTED_FEATURE", `Required XLSX entry ${task.path} is missing`);
        }
        continue;
      }
      const handle = operation.handle;
      const expected = { offset: entry.localHeaderOffset, length: 30 };
      operation.currentEntry = {
        task,
        entry,
        phase: "header",
        expected,
        received: 0,
        chunks: [],
      };
      operation.expected = expected;
      return readBytesStep(handle, expected);
    }
  }

  #finishEntry(operation: OpenOperation, reader: EntryReader, decoded: Uint8Array): LargeExcelOpenStep {
    operation.currentEntry = undefined;
    const xml = reader.task.kind === "styles" || reader.task.kind === "shared-strings" || reader.task.kind === "workbook" || reader.task.kind === "relationships" || reader.task.kind === "worksheet"
      ? decodeXml(decoded, operation.limits.maxXmlBytes)
      : "";
    switch (reader.task.kind) {
      case "workbook":
        operation.workbook = parseWorkbook(xml, operation.limits.maxSheets);
        const relsPath = workbookRelationshipsPath(reader.task.path);
        operation.tasks = [{ kind: "relationships", path: relsPath }];
        operation.taskIndex = 0;
        break;
      case "relationships":
        operation.relationships = parseRelationships(
          xml,
          reader.task.path,
          operation.limits.maxSheets,
        );
        this.#scheduleWorkbookParts(operation);
        break;
      case "styles":
        operation.styles = parseStyles(xml, operation.limits.maxStyles);
        break;
      case "shared-strings":
        operation.sharedStrings = parseSharedStrings(xml, operation.limits);
        break;
      case "worksheet": {
        const sheet = operation.workbook!.sheets[reader.task.sheetIndex!];
        if (!sheet) throw fault("PROTOCOL_INCOMPATIBLE", "Worksheet index is invalid");
        // Apply workbook-wide remaining capacity while parsing this sheet so
        // a later worksheet cannot temporarily allocate another full per-sheet
        // allowance before the aggregate check below rejects it.
        const worksheetLimits: Limits = {
          ...operation.limits,
          maxWorksheetCells: operation.limits.maxWorksheetCells - operation.worksheetCells,
          maxLayoutEntries: operation.limits.maxLayoutEntries - operation.worksheetLayoutEntries,
          maxMergedRegions: operation.limits.maxMergedRegions - operation.worksheetMergedRegions,
        };
        const model = parseWorksheet(
          xml,
          sheet,
          operation.styles ?? defaultStyles(),
          operation.sharedStrings ?? [],
          worksheetLimits,
          operation.warnings,
        );
        operation.worksheetCells = checkedAdd(
          operation.worksheetCells,
          model.cells.size,
          "workbook worksheet cell count",
        );
        if (operation.worksheetCells > operation.limits.maxWorksheetCells) {
          throw resourceFault(
            "workbook-worksheet-cell-count",
            operation.worksheetCells,
            operation.limits.maxWorksheetCells,
          );
        }
        operation.worksheetLayoutEntries = checkedAdd(
          operation.worksheetLayoutEntries,
          model.rowLayout.size + model.columnLayout.size,
          "workbook worksheet layout count",
        );
        if (operation.worksheetLayoutEntries > operation.limits.maxLayoutEntries) {
          throw resourceFault(
            "workbook-worksheet-layout-count",
            operation.worksheetLayoutEntries,
            operation.limits.maxLayoutEntries,
          );
        }
        operation.worksheetMergedRegions = checkedAdd(
          operation.worksheetMergedRegions,
          model.mergedCells.length,
          "workbook merged-region count",
        );
        if (operation.worksheetMergedRegions > operation.limits.maxMergedRegions) {
          throw resourceFault(
            "workbook-merged-region-count",
            operation.worksheetMergedRegions,
            operation.limits.maxMergedRegions,
          );
        }
        operation.sheets.push(model);
        break;
      }
    }
    return this.#advanceOpen(operation);
  }

  #scheduleWorkbookParts(operation: OpenOperation): void {
    const workbook = operation.workbook!;
    const entries = operation.entries!;
    const relationships = operation.relationships ?? new Map<string, string>();
    for (const sheet of workbook.sheets) {
      const path = relationships.get(sheet.relationshipId);
      if (path) {
        sheet.path = path;
      }
    }
    const tasks: EntryTask[] = [];
    const stylesPath = entries.has("xl/styles.xml") ? "xl/styles.xml" : undefined;
    const sharedPath = entries.has("xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : undefined;
    if (stylesPath) tasks.push({ kind: "styles", path: stylesPath });
    if (sharedPath) tasks.push({ kind: "shared-strings", path: sharedPath });
    for (const [index, sheet] of workbook.sheets.entries()) {
      if (!sheet.path) continue;
      tasks.push({ kind: "worksheet", path: sheet.path, sheetIndex: index });
    }
    if (tasks.length === 0) throw fault("UNSUPPORTED_FEATURE", "Workbook contains no worksheet parts");
    operation.tasks = tasks;
    operation.taskIndex = 0;
  }

  #completeOpen(operation: OpenOperation): OpenCompleteStep {
    if (!operation.workbook || operation.sheets.length === 0) {
      throw fault("UNSUPPORTED_FEATURE", "Workbook contains no readable worksheets");
    }
    // Relationship order is workbook order; skipped unsupported sheets are
    // still represented as descriptors when their XML was readable.
    const sheets = operation.sheets;
    const sourceHandle = `large-xlsx-source-${this.#nextSource++}`;
    const tables = Object.freeze(sheets.map((sheet) => Object.freeze({
      id: sheet.id,
      name: sheet.name,
      visibility: sheet.visibility,
    })));
    const retainedBytes = estimateRetainedWorkbookBytes(
      operation.entries!,
      sheets,
      operation.warnings,
    );
    const source: SourceState = {
      handle: sourceHandle,
      sourceLength: operation.sourceLength,
      entries: operation.entries!,
      sheets: Object.freeze([...sheets]),
      tables,
      warnings: Object.freeze([...operation.warnings]),
      closed: false,
    };
    this.#sources.set(sourceHandle, source);
    this.#operations.delete(operation.handle);
    const first = sheets[0]!;
    return {
      kind: "open-complete",
      sourceHandle,
      retainedBytes,
      tables,
      metadata: metadataForSheet(first),
      progress: Object.freeze({
        sourceHandle,
        bytesScanned: operation.bytesScanned,
        rowsDiscovered: sheets.reduce((max, sheet) => Math.max(max, sheet.rows), 0),
        done: true,
      }),
      warnings: Object.freeze([...operation.warnings]),
    };
  }

  #source(handle: string | number): SourceState {
    const key = String(handle);
    const source = this.#sources.get(key);
    if (!source || source.closed) throw fault("HANDLE_CLOSED", "The Excel source is closed");
    return source;
  }

  #table(handle: string | number): TableState {
    const key = String(handle);
    const table = this.#tables.get(key);
    if (!table || table.closed) throw fault("HANDLE_CLOSED", "The Excel table is closed");
    this.#source(table.sourceHandle);
    return table;
  }

  #allocateOperation(): number {
    if (this.#nextOperation > Number.MAX_SAFE_INTEGER) {
      throw fault("RESOURCE_LIMIT", "Excel operation handle space exhausted");
    }
    return this.#nextOperation++;
  }

  #assertOpenRuntime(): void {
    if (this.#closed) throw fault("HANDLE_CLOSED", "The Excel adapter is shut down");
  }
}

/** Convenient factory for callers that prefer a function over `new`. */
export function createLargeExcelAdapter(config: LargeExcelAdapterConfig = {}): LargeExcelAdapter {
  return new LargeExcelAdapter(config);
}

/** ABI-oriented alias used by prototype Worker registration experiments. */
export const LargeExcelRuntime = LargeExcelAdapter;

function estimateRetainedWorkbookBytes(
  entries: ReadonlyMap<string, ZipEntry>,
  sheets: readonly SheetModel[],
  warnings: readonly LargeExcelWarning[],
): number {
  let bytes = 4_096;
  const add = (value: number, name: string): void => {
    bytes = checkedAdd(bytes, value, name);
  };
  for (const entry of entries.values()) {
    add(192 + entry.name.length * 2, "retained ZIP index bytes");
  }
  const countedStyles = new Set<readonly PresentationStyle[]>();
  for (const sheet of sheets) {
    add(1_024 + (sheet.id.length + sheet.name.length) * 2, "retained worksheet bytes");
    for (const [key, cell] of sheet.cells) {
      add(
        192 + key.length * 2 + (cell.value?.length ?? 0) * 2,
        "retained worksheet cell bytes",
      );
    }
    add(sheet.rowLayout.size * 112, "retained row layout bytes");
    add(sheet.columnLayout.size * 112, "retained column layout bytes");
    add(sheet.mergedCells.length * 80, "retained merged-region bytes");
    if (!countedStyles.has(sheet.styles)) {
      countedStyles.add(sheet.styles);
      for (const style of sheet.styles) {
        add(160 + JSON.stringify(style).length * 2, "retained worksheet style bytes");
      }
    }
  }
  for (const warning of warnings) {
    add(
      128
        + warning.kind.length * 2
        + warning.message.length * 2
        + (warning.tableId?.length ?? 0) * 2,
      "retained warning bytes",
    );
  }
  return bytes;
}

function normalizeLimits(config: LargeExcelAdapterConfig): Limits {
  const value = (candidate: number | undefined, fallback: number, name: string): number => {
    const result = candidate ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0) {
      throw fault("INVALID_ARGUMENT", `${name} must be a positive safe integer`);
    }
    return result;
  };
  const limits: Limits = {
    chunkBytes: value(config.chunkBytes, DEFAULT_LIMITS.chunkBytes, "chunkBytes"),
    tailBytes: value(config.tailBytes, DEFAULT_LIMITS.tailBytes, "tailBytes"),
    maxEntries: value(config.maxEntries, DEFAULT_LIMITS.maxEntries, "maxEntries"),
    maxCentralDirectoryBytes: value(config.maxCentralDirectoryBytes, DEFAULT_LIMITS.maxCentralDirectoryBytes, "maxCentralDirectoryBytes"),
    maxCompressedEntryBytes: value(config.maxCompressedEntryBytes, DEFAULT_LIMITS.maxCompressedEntryBytes, "maxCompressedEntryBytes"),
    maxExpandedEntryBytes: value(config.maxExpandedEntryBytes, DEFAULT_LIMITS.maxExpandedEntryBytes, "maxExpandedEntryBytes"),
    maxTotalExpandedBytes: value(config.maxTotalExpandedBytes, DEFAULT_LIMITS.maxTotalExpandedBytes, "maxTotalExpandedBytes"),
    maxXmlBytes: value(config.maxXmlBytes, DEFAULT_LIMITS.maxXmlBytes, "maxXmlBytes"),
    maxWorksheetCells: value(config.maxWorksheetCells, DEFAULT_LIMITS.maxWorksheetCells, "maxWorksheetCells"),
    maxRangeCells: value(config.maxRangeCells, DEFAULT_LIMITS.maxRangeCells, "maxRangeCells"),
    maxColumns: value(config.maxColumns, DEFAULT_LIMITS.maxColumns, "maxColumns"),
    maxRows: value(config.maxRows, DEFAULT_LIMITS.maxRows, "maxRows"),
    maxSheets: value(config.maxSheets, DEFAULT_LIMITS.maxSheets, "maxSheets"),
    maxStyles: value(config.maxStyles, DEFAULT_LIMITS.maxStyles, "maxStyles"),
    maxMergedRegions: value(config.maxMergedRegions, DEFAULT_LIMITS.maxMergedRegions, "maxMergedRegions"),
    maxLayoutEntries: value(config.maxLayoutEntries, DEFAULT_LIMITS.maxLayoutEntries, "maxLayoutEntries"),
    maxWarnings: value(config.maxWarnings, DEFAULT_LIMITS.maxWarnings, "maxWarnings"),
  };
  if (limits.tailBytes < 22) throw fault("INVALID_ARGUMENT", "tailBytes must be at least 22");
  return Object.freeze(limits);
}

function readBytesStep(handle: number, expected: ExpectedRead): ReadBytesStep {
  return Object.freeze({
    kind: "read-bytes",
    operationHandle: handle,
    action: Object.freeze({ kind: "read-bytes", offset: expected.offset, length: expected.length }),
  });
}

function fault(code: string, message: string, details?: unknown): ProtocolFault {
  return new ProtocolFault(code, message, false, details);
}

function resourceFault(resource: string, requiredBytes: number, availableBytes: number): ProtocolFault {
  const safeQuantity = (value: number): number => (
    Number.isFinite(value) && value >= 0
      ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER
  );
  return new ProtocolFault(
    "RESOURCE_LIMIT",
    `${resource} exceeds the configured bound`,
    false,
    {
      resource,
      requiredBytes: safeQuantity(requiredBytes),
      availableBytes: safeQuantity(availableBytes),
    },
  );
}

function assertSafeNonNegative(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw fault("INVALID_ARGUMENT", `${name} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, name: string): number {
  if (
    !Number.isSafeInteger(left)
    || !Number.isSafeInteger(right)
    || left < 0
    || right < 0
    || right > Number.MAX_SAFE_INTEGER - left
  ) {
    throw fault("RESOURCE_LIMIT", `${name} exceeds safe integer range`);
  }
  return left + right;
}

function operationNumber(value: string | number): number {
  if (typeof value === "number") {
    assertSafeNonNegative(value, "operationHandle");
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw fault("INVALID_ARGUMENT", "operationHandle must be a numeric handle");
}

function validateRange(value: RangeRequest, maxCells: number): RangeRequest {
  if (!value || typeof value !== "object") throw fault("INVALID_RANGE", "Range must be an object");
  const range = {
    rowStart: value.rowStart,
    rowCount: value.rowCount,
    columnStart: value.columnStart,
    columnCount: value.columnCount,
  };
  for (const [name, entry] of Object.entries(range)) assertSafeNonNegative(entry, name);
  if (
    range.rowCount > Number.MAX_SAFE_INTEGER - range.rowStart
    || range.columnCount > Number.MAX_SAFE_INTEGER - range.columnStart
  ) {
    throw fault("INVALID_RANGE", "Range end exceeds safe integer range");
  }
  const cells = range.rowCount * range.columnCount;
  if (
    range.rowCount > maxCells
    || range.columnCount > maxCells
    || !Number.isSafeInteger(cells)
    || cells > maxCells
  ) {
    const required = Number.isSafeInteger(cells)
      ? Math.max(cells, range.rowCount, range.columnCount)
      : Number.MAX_SAFE_INTEGER;
    throw resourceFault("range-cells", required, maxCells);
  }
  return Object.freeze(range);
}

function clipRangeToSheet(
  range: RangeRequest,
  rows: number,
  columns: number,
): RangeRequest {
  const rowStart = Math.min(range.rowStart, rows);
  const columnStart = Math.min(range.columnStart, columns);
  return Object.freeze({
    rowStart,
    rowCount: Math.min(range.rowCount, rows - rowStart),
    columnStart,
    columnCount: Math.min(range.columnCount, columns - columnStart),
  });
}

interface EndOfCentralDirectory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

function parseEndOfCentralDirectory(
  tail: Uint8Array,
  tailOffset: number,
  sourceLength: number,
): EndOfCentralDirectory {
  // EOCD may be followed by a 64 KiB comment.  Search backwards and verify
  // the comment length so a signature embedded in XML/comment data is not
  // mistaken for the actual record.
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (u32(tail, index) !== 0x0605_4b50) continue;
    const commentLength = u16(tail, index + 20);
    if (index + 22 + commentLength !== tail.byteLength) continue;
    if (u16(tail, index + 4) !== 0 || u16(tail, index + 6) !== 0) {
      throw fault("UNSUPPORTED_FEATURE", "Multi-disk ZIP archives are unsupported");
    }
    const entries16 = u16(tail, index + 10);
    const size32 = u32(tail, index + 12);
    const offset32 = u32(tail, index + 16);
    if (entries16 === 0xffff || size32 === 0xffff_ffff || offset32 === 0xffff_ffff) {
      return parseZip64EndOfCentralDirectory(tail, tailOffset, index, sourceLength);
    }
    const end = checkedAdd(offset32, size32, "ZIP central directory range");
    if (end > sourceLength) {
      throw fault("INVALID_ARGUMENT", "ZIP central directory lies outside the source");
    }
    return { offset: offset32, size: size32, entries: entries16 };
  }
  throw fault("INVALID_ARGUMENT", "ZIP end-of-central-directory record was not found");
}

function parseZip64EndOfCentralDirectory(
  tail: Uint8Array,
  tailOffset: number,
  eocdIndex: number,
  sourceLength: number,
): EndOfCentralDirectory {
  // A ZIP64 locator immediately precedes the legacy EOCD.  Requiring the
  // locator to be adjacent prevents accepting a stray ZIP64 signature from
  // untrusted comment/XML bytes.
  const locator = eocdIndex - 20;
  if (locator < 0 || u32(tail, locator) !== 0x0706_4b50) {
    throw fault("INVALID_ARGUMENT", "ZIP64 end-of-central-directory locator is missing");
  }
  if (u32(tail, locator + 4) !== 0 || u32(tail, locator + 16) !== 1) {
    throw fault("UNSUPPORTED_FEATURE", "Multi-disk ZIP64 archives are unsupported");
  }
  const recordOffset = u64(tail, locator + 8);
  const recordIndex = recordOffset - tailOffset;
  if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || recordIndex + 56 > tail.byteLength) {
    throw fault("INVALID_ARGUMENT", "ZIP64 end-of-central-directory record is outside the tail window");
  }
  if (u32(tail, recordIndex) !== 0x0606_4b50) {
    throw fault("INVALID_ARGUMENT", "ZIP64 end-of-central-directory record is invalid");
  }
  const recordSize = u64(tail, recordIndex + 4);
  if (recordSize < 44 || recordIndex + 12 + recordSize > tail.byteLength) {
    throw fault("INVALID_ARGUMENT", "ZIP64 end-of-central-directory record is truncated");
  }
  if (u32(tail, recordIndex + 16) !== 0 || u32(tail, recordIndex + 20) !== 0) {
    throw fault("UNSUPPORTED_FEATURE", "Multi-disk ZIP64 archives are unsupported");
  }
  const entriesDisk = u64(tail, recordIndex + 24);
  const entries = u64(tail, recordIndex + 32);
  const size = u64(tail, recordIndex + 40);
  const offset = u64(tail, recordIndex + 48);
  if (entriesDisk !== entries) {
    throw fault("UNSUPPORTED_FEATURE", "Split ZIP64 central directories are unsupported");
  }
  const end = checkedAdd(offset, size, "ZIP64 central directory range");
  if (end > sourceLength) {
    throw fault("INVALID_ARGUMENT", "ZIP64 central directory lies outside the source");
  }
  return { offset, size, entries };
}

function parseCentralDirectory(
  bytes: Uint8Array,
  limits: Limits,
  sourceLength: number,
  expectedEntries?: number,
): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let offset = 0;
  let totalExpanded = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 46 || u32(bytes, offset) !== 0x0201_4b50) {
      throw fault("INVALID_ARGUMENT", "ZIP central directory contains an invalid entry");
    }
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const crc32 = u32(bytes, offset + 16);
    let compressedSize = u32(bytes, offset + 20);
    let uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localHeaderOffset32 = u32(bytes, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) throw fault("INVALID_ARGUMENT", "ZIP central directory entry is truncated");
    if (entries.size >= limits.maxEntries) {
      throw resourceFault("zip-entry-count", entries.size + 1, limits.maxEntries);
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    validateZipPath(name);
    if (entries.has(name)) throw fault("INVALID_ARGUMENT", `ZIP contains duplicate entry ${name}`);
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    let localHeaderOffset = localHeaderOffset32;
    if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff || localHeaderOffset32 === 0xffff_ffff) {
      const zip64 = parseZip64Extra(extra, compressedSize === 0xffff_ffff, uncompressedSize === 0xffff_ffff, localHeaderOffset32 === 0xffff_ffff);
      if (compressedSize === 0xffff_ffff) compressedSize = zip64.compressedSize;
      if (uncompressedSize === 0xffff_ffff) uncompressedSize = zip64.uncompressedSize;
      if (localHeaderOffset32 === 0xffff_ffff) localHeaderOffset = zip64.localHeaderOffset;
    }
    if (flags & 0x0001) throw fault("UNSUPPORTED_FEATURE", `Encrypted ZIP entry ${name} is unsupported`);
    if (method !== 0 && method !== 8) throw fault("UNSUPPORTED_FEATURE", `ZIP compression method ${method} is unsupported`);
    if (compressedSize > limits.maxCompressedEntryBytes) {
      throw resourceFault("zip-compressed-entry", compressedSize, limits.maxCompressedEntryBytes);
    }
    if (uncompressedSize > limits.maxExpandedEntryBytes) {
      throw resourceFault("zip-expanded-entry", uncompressedSize, limits.maxExpandedEntryBytes);
    }
    totalExpanded = checkedAdd(totalExpanded, uncompressedSize, "ZIP expansion");
    if (totalExpanded > limits.maxTotalExpandedBytes) {
      throw resourceFault("zip-total-expansion", totalExpanded, limits.maxTotalExpandedBytes);
    }
    const dataEnd = checkedAdd(localHeaderOffset, 30, "ZIP local header offset");
    if (dataEnd > sourceLength) throw fault("INVALID_ARGUMENT", `ZIP entry ${name} lies outside the source`);
    entries.set(name, Object.freeze({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32,
    }));
    offset = end;
  }
  if (offset !== bytes.byteLength) throw fault("INVALID_ARGUMENT", "ZIP central directory has trailing bytes");
  if (entries.size === 0) throw fault("UNSUPPORTED_FEATURE", "ZIP contains no entries");
  if (expectedEntries !== undefined && entries.size !== expectedEntries) {
    throw fault("INVALID_ARGUMENT", "ZIP central directory entry count does not match EOCD");
  }
  return entries;
}

interface Zip64ExtraValues {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function parseZip64Extra(
  extra: Uint8Array,
  needCompressed: boolean,
  needUncompressed: boolean,
  needOffset: boolean,
): Zip64ExtraValues {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = u16(extra, offset);
    const size = u16(extra, offset + 2);
    offset += 4;
    if (offset + size > extra.byteLength) break;
    if (id !== 0x0001) {
      offset += size;
      continue;
    }
    let cursor = offset;
    const read = (): number => {
      if (cursor + 8 > offset + size) throw fault("INVALID_ARGUMENT", "ZIP64 extra field is truncated");
      const value = u64(extra, cursor);
      cursor += 8;
      return value;
    };
    const uncompressedSize = needUncompressed ? read() : 0;
    const compressedSize = needCompressed ? read() : 0;
    const localHeaderOffset = needOffset ? read() : 0;
    return { compressedSize, uncompressedSize, localHeaderOffset };
  }
  throw fault("UNSUPPORTED_FEATURE", "ZIP64 entry metadata is missing");
}

function parseLocalHeader(bytes: Uint8Array, entry: ZipEntry): { readonly dataOffset: number } {
  if (bytes.byteLength < 30 || u32(bytes, 0) !== 0x0403_4b50) {
    throw fault("INVALID_ARGUMENT", `ZIP local header for ${entry.name} is invalid`);
  }
  const flags = u16(bytes, 6);
  const method = u16(bytes, 8);
  const nameLength = u16(bytes, 26);
  const extraLength = u16(bytes, 28);
  if (method !== entry.method || (flags & 0x0001) !== 0) {
    throw fault("INVALID_ARGUMENT", `ZIP local header for ${entry.name} does not match its central entry`);
  }
  const dataOffset = checkedAdd(entry.localHeaderOffset, 30 + nameLength + extraLength, "ZIP entry data offset");
  return { dataOffset };
}

function decodeZipEntry(bytes: Uint8Array, entry: ZipEntry, limits: Limits): Uint8Array {
  let decoded: Uint8Array;
  if (entry.method === 0) {
    if (bytes.byteLength !== entry.uncompressedSize) {
      throw fault("INVALID_ARGUMENT", `Stored ZIP entry ${entry.name} has an invalid size`);
    }
    // `bytes` is already an operation-local copy assembled from bounded
    // chunks; avoid a second full-entry allocation before XML parsing.
    decoded = bytes;
  } else {
    decoded = inflateRaw(bytes, entry.uncompressedSize, limits.maxExpandedEntryBytes);
    if (decoded.byteLength !== entry.uncompressedSize) {
      throw fault("INVALID_ARGUMENT", `Deflated ZIP entry ${entry.name} has an invalid size`);
    }
  }
  if (crc32(decoded) !== entry.crc32) {
    throw fault("INVALID_ARGUMENT", `ZIP entry ${entry.name} failed its CRC check`);
  }
  return decoded;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb8_8320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function findWorkbookPath(entries: ReadonlyMap<string, ZipEntry>): string | undefined {
  if (entries.has("xl/workbook.xml")) return "xl/workbook.xml";
  for (const name of entries.keys()) {
    if (/^xl\/workbook\.xml$/i.test(name)) return name;
  }
  return undefined;
}

function workbookRelationshipsPath(workbookPath: string): string {
  const slash = workbookPath.lastIndexOf("/");
  const directory = slash >= 0 ? workbookPath.slice(0, slash) : "";
  const file = slash >= 0 ? workbookPath.slice(slash + 1) : workbookPath;
  return `${directory}/_rels/${file}.rels`.replace(/^\//, "");
}

function parseWorkbook(xml: string, maxSheets: number): WorkbookInfo {
  const sheets: WorkbookSheetInfo[] = [];
  const sheetPattern = /<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)(?:\/?>)/g;
  for (const match of xml.matchAll(sheetPattern)) {
    if (sheets.length >= maxSheets) {
      throw resourceFault("worksheet-count", sheets.length + 1, maxSheets);
    }
    const attrs = parseAttributes(match[1] ?? "");
    const name = attrs.name ?? `Sheet ${sheets.length + 1}`;
    const relationshipId = attrs["r:id"] ?? attrs.id ?? "";
    const rawState = attrs.state;
    const state = rawState === "hidden"
      ? "hidden"
      : rawState === "veryHidden" || rawState === "very-hidden"
        ? "very-hidden"
        : "visible";
    sheets.push({
      id: `sheet-${sheets.length}`,
      name,
      state,
      relationshipId,
    });
  }
  if (sheets.length === 0) throw fault("UNSUPPORTED_FEATURE", "Workbook contains no worksheets");
  return { sheets };
}

function parseRelationships(
  xml: string,
  relationshipPath: string,
  maxRelationships: number,
): Map<string, string> {
  const result = new Map<string, string>();
  const base = relationshipPath.slice(0, relationshipPath.lastIndexOf("/_rels/"));
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*?)(?:\/?>)/g;
  for (const match of xml.matchAll(pattern)) {
    const attrs = parseAttributes(match[1] ?? "");
    const id = attrs.Id ?? attrs.id;
    const target = attrs.Target;
    if (!id || !target) continue;
    const type = attrs.Type ?? "";
    if (!/\/worksheet$/i.test(type) && !type.includes("/worksheet")) continue;
    if (result.size >= maxRelationships && !result.has(id)) {
      throw resourceFault("worksheet-relationship-count", result.size + 1, maxRelationships);
    }
    result.set(id, resolveZipPath(base, target));
  }
  return result;
}

function resolveZipPath(baseDirectory: string, target: string): string {
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) || target.startsWith("\\")) {
    throw fault("UNSUPPORTED_FEATURE", "External ZIP relationships are unsupported");
  }
  const source = target.startsWith("/") ? target.slice(1) : `${baseDirectory}/${target}`;
  const parts: string[] = [];
  for (const part of source.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw fault("INVALID_ARGUMENT", "ZIP relationship escapes its package root");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const result = parts.join("/");
  validateZipPath(result);
  return result;
}

function validateZipPath(name: string): void {
  if (
    name.length === 0
    || name.startsWith("/")
    || name.includes("\\")
    || name.split("/").some((part) => part === "..")
    || /[\u0000-\u001f]/.test(name)
  ) {
    throw fault("INVALID_ARGUMENT", `Unsafe ZIP path ${JSON.stringify(name)}`);
  }
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  // XLSX package names are UTF-8 when the general-purpose UTF-8 flag is set;
  // the fallback is intentionally UTF-8 as modern OOXML producers use it.
  void utf8;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseZip64Number(bytes: Uint8Array, offset: number): number {
  return u64(bytes, offset);
}

function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw fault("INVALID_ARGUMENT", "ZIP integer is out of bounds");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw fault("INVALID_ARGUMENT", "ZIP integer is out of bounds");
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! * 0x1_000_000)
  ) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw fault("INVALID_ARGUMENT", "ZIP64 integer is out of bounds");
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]!) << BigInt(index * 8);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw fault("RESOURCE_LIMIT", "ZIP64 offset exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function concatBytes(chunks: readonly Uint8Array[], expectedLength: number): Uint8Array {
  const result = new Uint8Array(expectedLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > result.byteLength) throw fault("INVALID_ARGUMENT", "Byte chunks exceed expected length");
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedLength) throw fault("INVALID_ARGUMENT", "Byte chunks are incomplete");
  return result;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

/** Synchronous, bounded RFC 1951 inflater for ZIP method 8 entries. */
function inflateRaw(bytes: Uint8Array, expectedSize: number, maxOutput: number): Uint8Array {
  if (expectedSize > maxOutput) throw resourceFault("zip-expanded-entry", expectedSize, maxOutput);
  // The central directory has already authenticated the declared expanded
  // size against the zip-bomb bound. Allocate exactly that bounded size so a
  // tiny entry never reserves the full parser ceiling.
  const output = new Uint8Array(expectedSize);
  let outputLength = 0;
  const reader = new DeflateBitReader(bytes);
  let final = false;
  while (!final) {
    final = reader.readBits(1) === 1;
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      reader.alignByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if (((length ^ 0xffff) & 0xffff) !== complement) throw fault("INVALID_ARGUMENT", "Invalid stored DEFLATE block");
      if (outputLength + length > expectedSize) {
        throw fault("INVALID_ARGUMENT", "DEFLATE output exceeds the ZIP entry size");
      }
      if (!reader.canReadBytes(length)) {
        throw fault("INVALID_ARGUMENT", "Truncated stored DEFLATE block");
      }
      output.set(reader.readBytes(length), outputLength);
      outputLength += length;
      continue;
    }
    if (blockType === 3) throw fault("INVALID_ARGUMENT", "Reserved DEFLATE block type");
    const trees = blockType === 1
      ? { literal: fixedLiteralTree(), distance: fixedDistanceTree() }
      : readDynamicTrees(reader);
    const literal = trees.literal;
    const distance = trees.distance;
    for (;;) {
      const symbol = literal.decode(reader);
      if (symbol < 256) {
        if (outputLength >= expectedSize) {
          throw fault("INVALID_ARGUMENT", "DEFLATE output exceeds the ZIP entry size");
        }
        output[outputLength++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      if (symbol < 257 || symbol > 285) throw fault("INVALID_ARGUMENT", "Invalid DEFLATE length symbol");
      const lengthIndex = symbol - 257;
      const lengthBase = DEFLATE_LENGTH_BASE[lengthIndex]!;
      const length = lengthBase + reader.readBits(DEFLATE_LENGTH_EXTRA[lengthIndex]!);
      const distanceSymbol = distance.decode(reader);
      if (distanceSymbol < 0 || distanceSymbol >= DEFLATE_DISTANCE_BASE.length) {
        throw fault("INVALID_ARGUMENT", "Invalid DEFLATE distance symbol");
      }
      const distanceBase = DEFLATE_DISTANCE_BASE[distanceSymbol]!;
      const distanceValue = distanceBase + reader.readBits(DEFLATE_DISTANCE_EXTRA[distanceSymbol]!);
      if (distanceValue <= 0 || distanceValue > outputLength) throw fault("INVALID_ARGUMENT", "DEFLATE distance exceeds output");
      if (outputLength + length > expectedSize) {
        throw fault("INVALID_ARGUMENT", "DEFLATE output exceeds the ZIP entry size");
      }
      for (let index = 0; index < length; index += 1) {
        output[outputLength] = output[outputLength - distanceValue]!;
        outputLength += 1;
      }
    }
  }
  if (outputLength !== expectedSize) throw fault("INVALID_ARGUMENT", "DEFLATE output size does not match the ZIP entry");
  // The output buffer was allocated at the declared (and bounded) size, and
  // the exact-size check above proves it is fully populated. Returning it
  // directly avoids briefly retaining two copies of a decompressed entry.
  return output;
}

const DEFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
] as const;

const DEFLATE_LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;

const DEFLATE_DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
  12289, 16385, 24577,
] as const;

const DEFLATE_DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;

class DeflateBitReader {
  readonly #bytes: Uint8Array;
  #offset = 0;
  #bits = 0;
  #bitCount = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  readBits(count: number): number {
    if (count < 0 || count > 24) throw fault("INVALID_ARGUMENT", "Invalid DEFLATE bit count");
    while (this.#bitCount < count) {
      if (this.#offset >= this.#bytes.byteLength) throw fault("INVALID_ARGUMENT", "Truncated DEFLATE stream");
      this.#bits |= this.#bytes[this.#offset++]! << this.#bitCount;
      this.#bitCount += 8;
    }
    const mask = count === 0 ? 0 : (1 << count) - 1;
    const result = this.#bits & mask;
    this.#bits >>>= count;
    this.#bitCount -= count;
    return result;
  }

  alignByte(): void {
    const discard = this.#bitCount & 7;
    if (discard > 0) this.readBits(discard);
  }

  canReadBytes(length: number): boolean {
    return this.#offset + length <= this.#bytes.byteLength && this.#bitCount === 0;
  }

  readBytes(length: number): Uint8Array {
    if (!this.canReadBytes(length)) throw fault("INVALID_ARGUMENT", "Truncated stored DEFLATE block");
    const result = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }
}

class HuffmanTree {
  readonly #byLength: ReadonlyMap<number, ReadonlyMap<number, number>>;
  readonly #maxLength: number;

  constructor(lengths: readonly number[]) {
    const counts = new Array<number>(16).fill(0);
    let maxLength = 0;
    for (const length of lengths) {
      if (!Number.isInteger(length) || length < 0 || length > 15) throw fault("INVALID_ARGUMENT", "Invalid DEFLATE code length");
      if (length > 0) {
        counts[length] = counts[length]! + 1;
        maxLength = Math.max(maxLength, length);
      }
    }
    let code = 0;
    const nextCode = new Array<number>(16).fill(0);
    for (let bits = 1; bits <= 15; bits += 1) {
      code = (code + counts[bits - 1]!) << 1;
      nextCode[bits] = code;
    }
    const maps = new Map<number, Map<number, number>>();
    for (let symbol = 0; symbol < lengths.length; symbol += 1) {
      const length = lengths[symbol]!;
      if (length === 0) continue;
      const canonical = nextCode[length]!;
      nextCode[length] = canonical + 1;
      const reversed = reverseBits(canonical, length);
      let map = maps.get(length);
      if (!map) {
        map = new Map<number, number>();
        maps.set(length, map);
      }
      if (map.has(reversed)) throw fault("INVALID_ARGUMENT", "DEFLATE tree contains duplicate codes");
      map.set(reversed, symbol);
    }
    this.#byLength = maps;
    this.#maxLength = maxLength;
  }

  decode(reader: DeflateBitReader): number {
    let code = 0;
    for (let length = 1; length <= this.#maxLength; length += 1) {
      code |= reader.readBits(1) << (length - 1);
      const symbol = this.#byLength.get(length)?.get(code);
      if (symbol !== undefined) return symbol;
    }
    throw fault("INVALID_ARGUMENT", "DEFLATE code is not in its Huffman tree");
  }
}

function reverseBits(value: number, width: number): number {
  let result = 0;
  for (let index = 0; index < width; index += 1) {
    result = (result << 1) | ((value >>> index) & 1);
  }
  return result;
}

let CACHED_FIXED_LITERAL: HuffmanTree | undefined;
let CACHED_FIXED_DISTANCE: HuffmanTree | undefined;

function fixedLiteralTree(): HuffmanTree {
  if (!CACHED_FIXED_LITERAL) {
    const lengths = new Array<number>(288).fill(0);
    for (let symbol = 0; symbol <= 143; symbol += 1) lengths[symbol] = 8;
    for (let symbol = 144; symbol <= 255; symbol += 1) lengths[symbol] = 9;
    for (let symbol = 256; symbol <= 279; symbol += 1) lengths[symbol] = 7;
    for (let symbol = 280; symbol <= 287; symbol += 1) lengths[symbol] = 8;
    CACHED_FIXED_LITERAL = new HuffmanTree(lengths);
  }
  return CACHED_FIXED_LITERAL;
}

function fixedDistanceTree(): HuffmanTree {
  if (!CACHED_FIXED_DISTANCE) CACHED_FIXED_DISTANCE = new HuffmanTree(new Array<number>(32).fill(5));
  return CACHED_FIXED_DISTANCE;
}

function readDynamicTrees(reader: DeflateBitReader): { readonly literal: HuffmanTree; readonly distance: HuffmanTree } {
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeLengthCount = reader.readBits(4) + 4;
  if (literalCount > 286 || distanceCount > 32 || codeLengthCount > 19) throw fault("INVALID_ARGUMENT", "Invalid DEFLATE dynamic tree sizes");
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codeLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeLengthCount; index += 1) codeLengths[order[index]!] = reader.readBits(3);
  const codeTree = new HuffmanTree(codeLengths);
  const allLengths: number[] = [];
  const total = literalCount + distanceCount;
  while (allLengths.length < total) {
    const symbol = codeTree.decode(reader);
    if (symbol <= 15) {
      allLengths.push(symbol);
    } else if (symbol === 16) {
      if (allLengths.length === 0) throw fault("INVALID_ARGUMENT", "Invalid DEFLATE repeat code");
      const repeat = reader.readBits(2) + 3;
      const previous = allLengths[allLengths.length - 1]!;
      for (let index = 0; index < repeat; index += 1) allLengths.push(previous);
    } else if (symbol === 17) {
      const repeat = reader.readBits(3) + 3;
      for (let index = 0; index < repeat; index += 1) allLengths.push(0);
    } else if (symbol === 18) {
      const repeat = reader.readBits(7) + 11;
      for (let index = 0; index < repeat; index += 1) allLengths.push(0);
    } else {
      throw fault("INVALID_ARGUMENT", "Invalid DEFLATE code-length symbol");
    }
    if (allLengths.length > total) throw fault("INVALID_ARGUMENT", "DEFLATE code-length repeat exceeds tree size");
  }
  const literalLengths = allLengths.slice(0, literalCount);
  const distanceLengths = allLengths.slice(literalCount);
  if (literalLengths[256] === 0) throw fault("INVALID_ARGUMENT", "DEFLATE literal tree has no end-of-block code");
  return { literal: new HuffmanTree(literalLengths), distance: new HuffmanTree(distanceLengths) };
}


function decodeXml(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) throw resourceFault("xml-entry", bytes.byteLength, maxBytes);
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // External entities and DTDs are not needed by OOXML and are a common XML
  // expansion attack surface.  Reject them before any regex-based parsing.
  if (/<\!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw fault("UNSUPPORTED_FEATURE", "External XML entities and doctypes are unsupported");
  }
  return xml.replace(/^\uFEFF/, "");
}

function parseAttributes(fragment: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/g;
  for (const match of fragment.matchAll(pattern)) {
    const key = match[1];
    if (!key) continue;
    result[key] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return result;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity.toLowerCase() === "amp") return "&";
    if (entity.toLowerCase() === "lt") return "<";
    if (entity.toLowerCase() === "gt") return ">";
    if (entity.toLowerCase() === "quot") return '"';
    if (entity.toLowerCase() === "apos") return "'";
    const numeric = entity.toLowerCase().startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : whole;
  });
}

function elementBody(fragment: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, "i");
  return pattern.exec(fragment)?.[1];
}

interface ElementMatch {
  readonly attrs: Record<string, string>;
  readonly body: string;
  readonly rawAttributes: string;
}

/** Returns bounded opening attributes and body text for simple XML elements. */
function elementMatches(fragment: string, tag: string, maxCount = Number.MAX_SAFE_INTEGER): ElementMatch[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>)`,
    "gi",
  );
  const result: ElementMatch[] = [];
  for (const match of fragment.matchAll(pattern)) {
    if (result.length >= maxCount) {
      throw resourceFault(`xml-${tag}-count`, result.length + 1, maxCount);
    }
    result.push({
      rawAttributes: match[1] ?? "",
      attrs: parseAttributes(match[1] ?? ""),
      body: match[2] ?? "",
    });
  }
  return result;
}

function elementBodies(fragment: string, tag: string, maxCount = Number.MAX_SAFE_INTEGER): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, "gi");
  const result: string[] = [];
  for (const match of fragment.matchAll(pattern)) {
    if (result.length >= maxCount) {
      throw resourceFault(`xml-${tag}-count`, result.length + 1, maxCount);
    }
    result.push(match[1] ?? "");
  }
  return result;
}

function elementAttributes(fragment: string, tag: string, maxCount = Number.MAX_SAFE_INTEGER): Record<string, string>[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b([^>]*?)(?:\\/>|>)`, "gi");
  const result: Record<string, string>[] = [];
  for (const match of fragment.matchAll(pattern)) {
    if (result.length >= maxCount) {
      throw resourceFault(`xml-${tag}-count`, result.length + 1, maxCount);
    }
    result.push(parseAttributes(match[1] ?? ""));
  }
  return result;
}

function textValue(fragment: string | undefined): string {
  if (!fragment) return "";
  const pattern = /<(?:(?:[A-Za-z_][\w.-]*):)?t\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z_][\w.-]*):)?t\s*>/gi;
  let value = "";
  let matched = false;
  for (const match of fragment.matchAll(pattern)) {
    matched = true;
    value += decodeXmlEntities(match[1] ?? "");
  }
  return matched ? value : decodeXmlEntities(fragment.replace(/<[^>]+>/g, ""));
}

function parseStyles(xml: string, maxStyles: number): PresentationStyle[] {
  const fonts: PresentationStyle["font"][] = [];
  const fills: PresentationStyle["backgroundColor"][] = [];
  const borders: PresentationStyle["borders"][] = [];
  const numFormats = new Map<number, string>();
  const numFormatAttributes = elementAttributes(elementBody(xml, "numFmts") ?? "", "numFmt", maxStyles);
  for (const attrs of numFormatAttributes) {
    const id = parseInteger(attrs.numFmtId);
    if (id !== undefined && attrs.formatCode !== undefined) numFormats.set(id, attrs.formatCode);
  }
  const builtinFormats = new Map<number, string>([
    [0, "General"], [1, "0"], [2, "0.00"], [9, "0%"], [10, "0.00%"], [14, "mm-dd-yy"],
  ]);
  const fontMatches = elementMatches(elementBody(xml, "fonts") ?? "", "font", maxStyles);
  for (const match of fontMatches) {
    const body = match.body;
    const name = elementAttributes(body, "name", 1)[0]?.val;
    const size = parseNumber(elementAttributes(body, "sz", 1)[0]?.val);
    const color = colorFromAttributes(elementAttributes(body, "color", 1)[0]);
    fonts.push({
      ...(name === undefined && size === undefined && color === undefined ? {} : {
        ...(name === undefined ? {} : { family: name }),
        ...(size === undefined ? {} : { size }),
        ...(elementBody(body, "b") !== undefined ? { bold: true } : {}),
        ...(elementBody(body, "i") !== undefined ? { italic: true } : {}),
        ...(elementBody(body, "u") !== undefined ? { underline: true } : {}),
        ...(color === undefined ? {} : { color: { css: color } }),
      }),
    });
  }
  const fillMatches = elementMatches(elementBody(xml, "fills") ?? "", "fill", maxStyles);
  for (const match of fillMatches) {
    const attrs = elementMatches(match.body, "fgColor", 1)[0]?.attrs;
    const color = colorFromAttributes(attrs);
    fills.push(color === undefined ? undefined : { css: color });
  }
  const borderMatches = elementMatches(elementBody(xml, "borders") ?? "", "border", maxStyles);
  for (const match of borderMatches) {
    const body = match.body;
    const sides: Record<string, unknown> = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const sideMatch = elementMatches(body, side, 1)[0];
      const attrs = sideMatch?.attrs;
      const style = attrs?.style;
      const color = colorFromAttributes(
        sideMatch === undefined ? undefined : elementMatches(sideMatch.body, "color", 1)[0]?.attrs,
      );
      if (style !== undefined || color !== undefined) {
        sides[side] = {
          ...(style === undefined ? {} : { style: normalizeBorderStyle(style) }),
          ...(color === undefined ? {} : { color: { css: color } }),
        };
      }
    }
    borders.push(Object.keys(sides).length === 0 ? undefined : sides as PresentationStyle["borders"]);
  }
  const cellXfs = elementBody(xml, "cellXfs") ?? "";
  const styles: PresentationStyle[] = [];
  const cellXfMatches = elementMatches(cellXfs, "xf", maxStyles);
  for (const match of cellXfMatches) {
    const attrs = match.attrs;
    const numFmtId = parseInteger(attrs.numFmtId) ?? 0;
    const fontId = parseInteger(attrs.fontId) ?? 0;
    const fillId = parseInteger(attrs.fillId) ?? 0;
    const borderId = parseInteger(attrs.borderId) ?? 0;
    const alignmentBody = elementBody(match.body, "alignment")
      ?? elementMatches(match.body, "alignment", 1)[0]?.rawAttributes;
    const alignment = alignmentBody ? parseAttributes(alignmentBody) : {};
    const style: Record<string, unknown> = {};
    const numberFormat = numFormats.get(numFmtId) ?? builtinFormats.get(numFmtId);
    if (numberFormat !== undefined) style.numberFormat = numberFormat;
    if (fonts[fontId] !== undefined) style.font = fonts[fontId];
    if (fills[fillId] !== undefined) style.backgroundColor = fills[fillId];
    if (borders[borderId] !== undefined) style.borders = borders[borderId];
    if (alignment.horizontal === "left" || alignment.horizontal === "center" || alignment.horizontal === "right" || alignment.horizontal === "justify") {
      style.horizontalAlignment = alignment.horizontal;
    }
    if (alignment.vertical === "top" || alignment.vertical === "center" || alignment.vertical === "bottom" || alignment.vertical === "justify") {
      style.verticalAlignment = alignment.vertical;
    }
    if (alignment.wrapText === "1" || alignment.wrapText === "true") style.wrapText = true;
    styles.push(style as PresentationStyle);
  }
  return styles.length > 0 ? styles : defaultStyles();
}

function colorFromAttributes(attrs: Record<string, string> | undefined): string | undefined {
  if (!attrs) return undefined;
  const raw = attrs.rgb ?? attrs.srgbClr ?? attrs.val;
  if (!raw) return undefined;
  if (/^[0-9a-f]{8}$/i.test(raw)) return `#${raw.slice(2)}`;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  return undefined;
}

function normalizeBorderStyle(value: string): PresentationStyle["borders"] extends infer _ ? "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" : never {
  if (value === "thin" || value === "medium" || value === "thick" || value === "dashed" || value === "dotted" || value === "double") return value;
  return "none";
}

function parseSharedStrings(xml: string, limits: Limits): string[] {
  const strings: string[] = [];
  const bodies = elementBodies(xml, "si", limits.maxWorksheetCells);
  for (const body of bodies) strings.push(textValue(body));
  return strings;
}

function defaultStyles(): PresentationStyle[] {
  return [{}];
}

function parseWorksheet(
  xml: string,
  sheet: WorkbookSheetInfo,
  styles: readonly PresentationStyle[],
  sharedStrings: readonly string[],
  limits: Limits,
  warnings: LargeExcelWarning[],
): SheetModel {
  const dimensionAttrs = elementAttributes(xml, "dimension", 1)[0];
  const dimension = dimensionAttrs?.ref ? parseCellRange(dimensionAttrs.ref) : undefined;
  let rows = dimension?.rowEnd ?? 0;
  let columns = dimension?.columnEnd ?? 0;
  if (rows > limits.maxRows || columns > limits.maxColumns) {
    throw resourceFault("worksheet-dimensions", Math.max(rows, columns), Math.max(limits.maxRows, limits.maxColumns));
  }
  // A worksheet dimension is an extent declaration, not an instruction to
  // materialize every cell in that rectangle.  Large/sparse workbooks often
  // declare the full spreadsheet grid (for example XFD1048576) while only a
  // small indexed prefix is populated.  Bound the actual indexed cells below
  // instead of rejecting a valid sparse declaration based on rows*columns.
  const cells = new Map<string, Cell>();
  const rowLayout = new Map<number, PresentationAxisEntry>();
  const columnLayout = new Map<number, PresentationAxisEntry>();
  const mergedCells: MergedCellRegion[] = [];
  let frozenRows = 0;
  let frozenColumns = 0;

  const columnAttributes = elementAttributes(xml, "col", limits.maxLayoutEntries);
  let columnLayoutAssignments = 0;
  for (const attrs of columnAttributes) {
    const min = parseInteger(attrs.min);
    const max = parseInteger(attrs.max) ?? min;
    if (min === undefined || max === undefined || min <= 0 || max < min) continue;
    for (let column = min - 1; column < max && column < limits.maxColumns; column += 1) {
      columnLayoutAssignments += 1;
      if (columnLayoutAssignments > limits.maxLayoutEntries) {
        throw resourceFault(
          "worksheet-column-layout-work",
          columnLayoutAssignments,
          limits.maxLayoutEntries,
        );
      }
      const width = parseNumber(attrs.width);
      const size = width === undefined ? undefined : Math.max(1, width * 7 + 5);
      if (!columnLayout.has(column) && columnLayout.size >= limits.maxLayoutEntries) {
        throw resourceFault("worksheet-column-layout-count", columnLayout.size + 1, limits.maxLayoutEntries);
      }
      columnLayout.set(column, {
        index: column,
        ...(size === undefined ? {} : { size }),
        ...(attrs.hidden === "1" || attrs.hidden === "true" ? { hidden: true } : {}),
      });
    }
  }
  for (const attrs of elementAttributes(xml, "pane", limits.maxLayoutEntries)) {
    if (attrs.state !== "frozen" && attrs.state !== "split" && attrs.ySplit === undefined && attrs.xSplit === undefined) continue;
    frozenRows = Math.max(frozenRows, parseInteger(attrs.ySplit) ?? 0);
    frozenColumns = Math.max(frozenColumns, parseInteger(attrs.xSplit) ?? 0);
  }
  const mergeAttributes = elementAttributes(xml, "mergeCell", limits.maxMergedRegions);
  for (const attrs of mergeAttributes) {
    const range = attrs.ref ? parseCellRange(attrs.ref) : undefined;
    if (!range) continue;
    if (
      range.rowEnd > limits.maxRows
      || range.columnEnd > limits.maxColumns
    ) {
      throw resourceFault(
        "worksheet-merge-dimensions",
        Math.max(range.rowEnd, range.columnEnd),
        Math.max(limits.maxRows, limits.maxColumns),
      );
    }
    mergedCells.push({
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      columnStart: range.columnStart,
      columnEnd: range.columnEnd,
    });
  }
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*?)(?:>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row\s*>|\/>)\s*/gi;
  for (const match of xml.matchAll(rowPattern)) {
    const attrs = parseAttributes(match[1] ?? "");
    const rowNumber = parseInteger(attrs.r) ?? (rows > 0 ? 1 : 0);
    if (rowNumber <= 0) continue;
    if (rowNumber > limits.maxRows) {
      throw resourceFault("worksheet-row-coordinate", rowNumber, limits.maxRows);
    }
    const rowIndex = rowNumber - 1;
    rows = Math.max(rows, rowNumber);
    const height = parseNumber(attrs.ht);
    const size = height === undefined ? undefined : Math.max(1, height * 4 / 3);
    if (size !== undefined || attrs.hidden === "1" || attrs.hidden === "true") {
      if (!rowLayout.has(rowIndex) && rowLayout.size >= limits.maxLayoutEntries) {
        throw resourceFault("worksheet-row-layout-count", rowLayout.size + 1, limits.maxLayoutEntries);
      }
      rowLayout.set(rowIndex, {
        index: rowIndex,
        ...(size === undefined ? {} : { size }),
        ...(attrs.hidden === "1" || attrs.hidden === "true" ? { hidden: true } : {}),
      });
    }
    const body = match[2] ?? "";
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c\s*>|\/>)\s*/gi;
    for (const cellMatch of body.matchAll(cellPattern)) {
      const cellAttrs = parseAttributes(cellMatch[1] ?? "");
      const reference = cellAttrs.r ? parseCellRef(cellAttrs.r) : undefined;
      if (!reference) continue;
      if (reference.row >= limits.maxRows || reference.column >= limits.maxColumns) {
        // An explicit cell coordinate outside the configured worksheet bounds
        // is data, not merely a sparse dimension declaration.  Silently
        // dropping it would make a successful preview look complete while
        // hiding source rows/columns; fail deterministically instead.
        throw resourceFault(
          "worksheet-cell-coordinate",
          Math.max(reference.row + 1, reference.column + 1),
          Math.max(limits.maxRows, limits.maxColumns),
        );
      }
      rows = Math.max(rows, reference.row + 1);
      columns = Math.max(columns, reference.column + 1);
      if (cells.size >= limits.maxWorksheetCells && !cells.has(cellKey(reference.row, reference.column))) {
        throw resourceFault("worksheet-indexed-cells", cells.size + 1, limits.maxWorksheetCells);
      }
      const bodyText = cellMatch[2] ?? "";
      const type = cellAttrs.t ?? "";
      const value = parseCellValue(
        bodyText,
        type,
        sharedStrings,
        warnings,
        limits.maxWarnings,
        sheet.id,
        reference.row,
        reference.column,
      );
      const styleId = parseInteger(cellAttrs.s) ?? 0;
      cells.set(cellKey(reference.row, reference.column), { value, styleId });
    }
  }
  // Do not spread a potentially large sparse index into Math.max(): the
  // argument list itself is an unbounded allocation and can overflow the JS
  // call stack before the indexed-cell limit has a chance to apply.
  if (rows === 0 || columns === 0) {
    for (const key of cells.keys()) {
      const comma = key.indexOf(",");
      const row = Number(key.slice(0, comma));
      const column = Number(key.slice(comma + 1));
      if (rows === 0) rows = Math.max(rows, row + 1);
      if (columns === 0) columns = Math.max(columns, column + 1);
    }
  }
  if (rows === 0) rows = dimension?.rowEnd ?? 0;
  if (columns === 0) columns = dimension?.columnEnd ?? 0;
  if (rows > limits.maxRows || columns > limits.maxColumns) throw resourceFault("worksheet-dimensions", Math.max(rows, columns), Math.max(limits.maxRows, limits.maxColumns));
  return Object.freeze({
    id: sheet.id,
    name: sheet.name,
    visibility: sheet.state,
    rows,
    columns,
    cells,
    rowLayout,
    columnLayout,
    mergedCells,
    frozenRows,
    frozenColumns,
    styles,
  });
}

function parseCellValue(
  body: string,
  type: string,
  sharedStrings: readonly string[],
  warnings: LargeExcelWarning[],
  maxWarnings: number,
  tableId: string,
  row: number,
  column: number,
): string | null {
  if (type === "inlineStr") {
    const inline = elementBody(body, "is");
    return inline === undefined ? textValue(body) : textValue(inline);
  }
  const valueBody = elementBody(body, "v");
  const value = valueBody === undefined ? undefined : decodeXmlEntities(valueBody.replace(/<[^>]+>/g, ""));
  if (type === "s") {
    const index = value === undefined ? -1 : Number.parseInt(value, 10);
    return Number.isSafeInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index]! : null;
  }
  if (type === "b") return value === undefined ? null : value === "1" ? "TRUE" : "FALSE";
  if (type === "e") return value ?? null;
  if (value !== undefined && value.length > 0) return value;
  if (elementBody(body, "f") !== undefined) {
    if (warnings.length < maxWarnings) {
      warnings.push(Object.freeze({
        kind: "missing-formula-cache",
        message: "A formula has no cached value and is represented as null",
        tableId,
        row,
        column,
      }));
    }
  }
  return null;
}

interface CellRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

function parseCellRange(value: string): CellRange | undefined {
  const pieces = value.split(":");
  const first = parseCellRef(pieces[0] ?? "");
  const second = parseCellRef(pieces[1] ?? pieces[0] ?? "");
  if (!first || !second) return undefined;
  return {
    rowStart: Math.min(first.row, second.row),
    rowEnd: Math.max(first.row, second.row) + 1,
    columnStart: Math.min(first.column, second.column),
    columnEnd: Math.max(first.column, second.column) + 1,
  };
}

function parseCellRef(value: string): { readonly row: number; readonly column: number } | undefined {
  const match = /^\$?([A-Za-z]{1,4})\$?(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const letters = match[1]!.toUpperCase();
  let column = 0;
  for (const character of letters) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(row) || row <= 0 || column <= 0) return undefined;
  return { row: row - 1, column: column - 1 };
}

function cellKey(row: number, column: number): string {
  return `${row},${column}`;
}

function metadataForSheet(sheet: SheetModel): TableMetadata {
  const columns = Array.from({ length: sheet.columns }, (_, index) => ({
    id: `c${index}`,
    name: columnName(index),
    index,
    dataType: { type: "utf8" as const },
    nullable: true,
  }));
  const rows: AxisExtent = { kind: "exact", value: sheet.rows };
  const columnExtent: AxisExtent = { kind: "exact", value: sheet.columns };
  return Object.freeze({
    tableId: sheet.id,
    name: sheet.name,
    revision: 0,
    extent: Object.freeze({ rows: Object.freeze(rows), columns: Object.freeze(columnExtent) }),
    schema: Object.freeze({ version: 0, columns: Object.freeze(columns.map((column) => Object.freeze(column))) }),
    capabilities: Object.freeze({
      randomAccess: "full",
      typedValues: false,
      search: false,
      sort: false,
      filter: false,
      multiTable: true,
    }),
  });
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function makeStringBatch(sheet: SheetModel, range: RangeRequest): WireTableBatch {
  const buffers: ArrayBuffer[] = [];
  const columns = [] as WireTableBatch["columns"][number][];
  for (let columnOffset = 0; columnOffset < range.columnCount; columnOffset += 1) {
    const values: (string | null)[] = [];
    for (let rowOffset = 0; rowOffset < range.rowCount; rowOffset += 1) {
      values.push(sheet.cells.get(cellKey(range.rowStart + rowOffset, range.columnStart + columnOffset))?.value ?? null);
    }
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets = new Uint32Array(values.length + 1);
    const validity = new Uint8Array(Math.ceil(values.length / 8));
    let byteLength = 0;
    for (const [index, value] of values.entries()) {
      if (value !== null) {
        const encoded = encoder.encode(value);
        chunks.push(encoded);
        byteLength += encoded.byteLength;
        validity[index >>> 3] = validity[index >>> 3]! | (1 << (index & 7));
      }
      offsets[index + 1] = byteLength;
    }
    const data = concatBytes(chunks, byteLength);
    const dataBuffer = copyArrayBuffer(data);
    const offsetsBuffer = copyArrayBuffer(new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength));
    const validityBuffer = copyArrayBuffer(validity);
    const dataIndex = buffers.push(dataBuffer) - 1;
    const offsetsIndex = buffers.push(offsetsBuffer) - 1;
    const validityIndex = buffers.push(validityBuffer) - 1;
    const native = {
      encoding: "variable-width",
      dataType: { type: "utf8" as const },
      length: range.rowCount,
      values: { buffer: dataIndex, byteOffset: 0, byteLength: data.byteLength },
      offsets: { buffer: offsetsIndex, byteOffset: 0, byteLength: offsets.byteLength },
      validity: { buffer: validityIndex, byteOffset: 0, byteLength: validity.byteLength },
    };
    // The private wire contract labels the source layout as
    // `variable-width`; the Worker normalizes it to the public `utf8` view.
    const display = {
      encoding: "variable-width" as const,
      values: { buffer: dataIndex, byteOffset: 0, byteLength: data.byteLength },
      offsets: { buffer: offsetsIndex, byteOffset: 0, byteLength: offsets.byteLength },
      validity: { buffer: validityIndex, byteOffset: 0, byteLength: validity.byteLength },
    };
    columns.push({
      columnId: `c${range.columnStart + columnOffset}`,
      native,
      // This is the private adapter wire shape; the Worker validates and
      // converts it to the public DisplayColumnDescriptor before publication.
      display: display as unknown as WireTableBatch["columns"][number]["display"],
    });
  }
  return {
    layoutVersion: BATCH_LAYOUT_VERSION,
    tableId: sheet.id,
    revision: 0,
    schemaVersion: 0,
    range: Object.freeze({ ...range }),
    buffers,
    columns,
    complete: true,
  };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
