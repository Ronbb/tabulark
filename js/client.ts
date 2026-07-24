import { TabularkError, cancelledError, closedError, invalidArgument } from "./errors.js";
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  ColumnarTableBatch,
  deriveMemoryBudgetLimits,
  normalizeMetadata,
  validateRange,
  type RangeRequest,
  type TableBatch,
  type TableDescriptor,
  type TableMetadata,
  type WireTableBatch,
  type MemoryBudgetLimits,
} from "./model.js";
import { PROTOCOL_VERSION, isRecord, type ProtocolEvent } from "./protocol.js";
import {
  ByteLruCache,
  cloneWireTableBatch,
  rangeCacheKey,
  rangeCacheKeyBelongsTo,
  wireBatchByteLength,
} from "./range-cache.js";
import { WorkerRpcClient } from "./rpc-client.js";

const MIN_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;

export type DelimitedFormat = "csv" | "tsv";
export type HeaderMode = "first-row" | "none";
export type ParseMode = "lenient" | "strict";

export interface OpenSourceOptions {
  /** The format is explicit; automatic format detection is intentionally absent. */
  readonly format: DelimitedFormat;
  readonly header?: HeaderMode;
  readonly mode?: ParseMode;
  /** One ASCII delimiter byte. Defaults to comma or tab from format. */
  readonly delimiter?: string;
  /** Cancels opening and releases any Worker-side source created by the request. */
  readonly signal?: AbortSignal;
}

export interface EngineOptions {
  readonly memoryBudgetBytes?: number;
  /** Advanced override for a separately hosted wasm-bindgen module. */
  readonly wasmModuleUrl?: string | URL;
  /** Advanced override for a separately hosted Tabulark module Worker. */
  readonly workerUrl?: string | URL;
  readonly workerName?: string;
}

export interface ReadRangeOptions {
  readonly signal?: AbortSignal;
}

export interface RuntimeProgress {
  readonly sourceHandle: string;
  readonly bytesScanned: number;
  readonly rowsDiscovered: number;
  readonly done: boolean;
}

export interface SourceWarning {
  readonly handle: string;
  readonly kind: string;
  readonly message: string;
  readonly byteOffset?: number;
}

export type DatasetEvent =
  | Readonly<{ type: "progress"; progress: RuntimeProgress }>
  | Readonly<{ type: "metadata"; metadata: Readonly<TableMetadata> }>
  | Readonly<{ type: "warning"; warning: SourceWarning }>
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "runtimeError"; error: TabularkError }>;

export type TableEvent = Exclude<DatasetEvent, Readonly<{ type: "progress" }>>;

export type Unsubscribe = () => void;

export interface DatasetSession {
  readonly tables: readonly Readonly<TableDescriptor>[];
  openTable(tableId: string): Promise<TableHandle>;
  subscribe(listener: (event: DatasetEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface TableHandle {
  readonly metadata: Readonly<TableMetadata>;
  readRange(request: RangeRequest, options?: ReadRangeOptions): Promise<TableBatch>;
  subscribe(listener: (event: TableEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface TabularkEngine {
  open(source: Blob | ArrayBuffer, options: OpenSourceOptions): Promise<DatasetSession>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

interface NormalizedEngineOptions {
  readonly memoryBudgetBytes: number;
  readonly limits: MemoryBudgetLimits;
  readonly wasmModuleUrl: string;
  readonly workerUrl: string;
  readonly workerName: string;
}

interface NormalizedOpenOptions {
  readonly format: DelimitedFormat;
  readonly options: Readonly<{
    header: HeaderMode;
    mode: ParseMode;
    delimiter: string;
    sourceName?: string;
  }>;
}

class Engine implements TabularkEngine {
  readonly #rpc: WorkerRpcClient;
  readonly #rangeCache: ByteLruCache<WireTableBatch>;
  readonly #maxArrayBufferBytes: number;
  readonly #sessions = new Map<string, DatasetSessionImpl>();
  readonly #orphanEvents = new Map<string, ProtocolEvent[]>();
  #closed = false;

  constructor(rpc: WorkerRpcClient, limits: MemoryBudgetLimits) {
    this.#rpc = rpc;
    this.#rangeCache = new ByteLruCache(limits.mainThreadRangeCacheBytes);
    this.#maxArrayBufferBytes = limits.maxArrayBufferBytes;
  }

  static async create(options: EngineOptions): Promise<Engine> {
    const normalized = normalizeEngineOptions(options);
    if (
      typeof Worker === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined"
    ) {
      throw new TabularkError(
        "UNSUPPORTED_RUNTIME",
        "Tabulark createEngine() requires a browser with module Worker and Blob support",
      );
    }

    let engine: Engine | undefined;
    const worker = new Worker(normalized.workerUrl, {
      type: "module",
      name: normalized.workerName,
    });
    const rpc = new WorkerRpcClient(worker, (event) => {
      if (engine !== undefined) {
        engine.#handleEvent(event);
      }
    }, (error) => {
      if (engine !== undefined) {
        engine.#handleRuntimeFailure(error);
      }
    });
    engine = new Engine(rpc, normalized.limits);
    try {
      const hello = await rpc.request<unknown>(
        "hello",
        {
          clientName: "tabulark-js",
          wasmModuleUrl: normalized.wasmModuleUrl,
          memoryBudgetBytes: normalized.memoryBudgetBytes,
        },
        "hello",
      );
      if (!isRecord(hello) || hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new TabularkError(
          "PROTOCOL_INCOMPATIBLE",
          "The Worker did not accept the current Tabulark protocol version",
        );
      }
      return engine;
    } catch (error) {
      rpc.terminate();
      throw error;
    }
  }

  async open(source: Blob | ArrayBuffer, options: OpenSourceOptions): Promise<DatasetSession> {
    this.#assertOpen();
    const normalizedOptions = normalizeOpenOptions(options);
    const transfer: Transferable[] = [];
    if (source instanceof ArrayBuffer) {
      if (source.byteLength > this.#maxArrayBufferBytes) {
        throw new TabularkError(
          "RESOURCE_LIMIT",
          `ArrayBuffer sources larger than ${this.#maxArrayBufferBytes} bytes must be supplied as a Blob`,
          { details: { limit: this.#maxArrayBufferBytes, byteLength: source.byteLength } },
        );
      }
      transfer.push(source);
    } else if (!(source instanceof Blob)) {
      throw invalidArgument("source must be a Blob, File, or ArrayBuffer");
    }

    const dataset = await this.#rpc.request<{ datasetHandle: string }>(
      "openSource",
      {
        source,
        format: normalizedOptions.format,
        options: normalizedOptions.options,
      },
      "dataset",
      options.signal ? { transfer, signal: options.signal } : { transfer },
    );
    if (!isRecord(dataset) || typeof dataset.datasetHandle !== "string") {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned an invalid dataset handle");
    }

    try {
      const tableResult = await this.#rpc.request<unknown>(
        "listTables",
        { datasetHandle: dataset.datasetHandle },
        "tables",
        options.signal ? { signal: options.signal } : {},
      );
      if (options.signal?.aborted) {
        throw cancelledError();
      }
      const tableDescriptors = normalizeDescriptors(tableResult);
      const session = new DatasetSessionImpl(this, dataset.datasetHandle, tableDescriptors);
      this.#sessions.set(dataset.datasetHandle, session);
      this.#deliverOrphanEvents(session);
      return session;
    } catch (error) {
      await this.#discardOpenedDataset(dataset.datasetHandle);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.closeLocally();
    }
    this.#sessions.clear();
    this.#rangeCache.clear();
    await this.#rpc.shutdown();
  }

  dispose(): Promise<void> {
    return this.close();
  }

  async openTable(session: DatasetSessionImpl, tableId: string): Promise<TableHandle> {
    this.#assertOpen();
    session.assertOpen();
    if (!session.tables.some((table) => table.id === tableId)) {
      throw invalidArgument(`Unknown table: ${tableId}`);
    }
    const table = await this.#rpc.request<{ tableHandle: string }>(
      "openTable",
      { datasetHandle: session.handle, tableId },
      "table",
    );
    if (!isRecord(table) || typeof table.tableHandle !== "string") {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned an invalid table handle");
    }
    const metadata = await this.#rpc.request<unknown>(
      "getMetadata",
      { tableHandle: table.tableHandle },
      "metadata",
    );
    const handle = new TableHandleImpl(
      this,
      session,
      table.tableHandle,
      normalizeMetadataWire(metadata),
    );
    if (session.closed) {
      await this.closeTable(handle);
      throw closedError("Dataset session");
    }
    session.addTableHandle(handle);
    return handle;
  }

  async readRange(
    table: TableHandleImpl,
    request: RangeRequest,
    options: ReadRangeOptions,
  ): Promise<TableBatch> {
    this.#assertOpen();
    table.assertOpen();
    const normalized = validateRange(request);
    if (options.signal?.aborted) {
      throw cancelledError();
    }
    const metadata = table.metadata;
    const key = rangeCacheKey(
      table.handle,
      metadata.revision,
      metadata.schema.version,
      normalized,
    );
    const cached = this.#rangeCache.get(key);
    if (cached) {
      return new ColumnarTableBatch(cloneWireTableBatch(cached));
    }
    const batch = await this.#rpc.request<WireTableBatch>(
      "readRange",
      { tableHandle: table.handle, range: normalized },
      "batch",
      options.signal ? { signal: options.signal } : {},
    );
    const cachedBatch = cloneWireTableBatch(batch);
    this.#rangeCache.set(
      rangeCacheKey(table.handle, batch.revision, batch.schemaVersion, normalized),
      cachedBatch,
      wireBatchByteLength(cachedBatch),
    );
    return new ColumnarTableBatch(batch);
  }

  async closeTable(table: TableHandleImpl): Promise<void> {
    if (table.closed) {
      return;
    }
    table.closeLocally();
    if (this.#closed) {
      return;
    }
    await this.#rpc.request("closeTable", { tableHandle: table.handle }, "acknowledged");
  }

  clearTableCache(tableHandle: string): void {
    this.#rangeCache.deleteWhere((key) => rangeCacheKeyBelongsTo(key, tableHandle));
  }

  async closeSession(session: DatasetSessionImpl): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closeLocally();
    this.#sessions.delete(session.handle);
    if (this.#closed) {
      return;
    }
    await this.#rpc.request("closeSource", { datasetHandle: session.handle }, "acknowledged");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw closedError("Engine");
    }
  }

  #handleEvent(event: ProtocolEvent): void {
    const handle = event.datasetHandle ?? event.tableHandle ?? event.requestId;
    if (!handle && event.event === "runtimeError") {
      this.#handleRuntimeFailure(errorFromWire(event.payload));
      return;
    }
    if (!handle) {
      return;
    }
    const session = this.#sessions.get(handle);
    if (!session) {
      const events = this.#orphanEvents.get(handle) ?? [];
      events.push(event);
      this.#orphanEvents.set(handle, events);
      return;
    }
    session.handleEvent(event);
  }

  #deliverOrphanEvents(session: DatasetSessionImpl): void {
    const events = this.#orphanEvents.get(session.handle);
    if (!events) {
      return;
    }
    this.#orphanEvents.delete(session.handle);
    for (const event of events) {
      session.handleEvent(event);
    }
  }

  async #discardOpenedDataset(datasetHandle: string): Promise<void> {
    this.#orphanEvents.delete(datasetHandle);
    if (this.#closed) {
      return;
    }
    try {
      await this.#rpc.request(
        "closeSource",
        { datasetHandle },
        "acknowledged",
      );
    } catch {
      // The original open failure remains authoritative. A failed Worker owns no live resources.
    } finally {
      // closeSource may emit a final closed event before its acknowledgement.
      // No DatasetSession will consume that event after a failed open.
      this.#orphanEvents.delete(datasetHandle);
    }
  }

  #handleRuntimeFailure(error: TabularkError): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rangeCache.clear();
    this.#orphanEvents.clear();
    for (const session of this.#sessions.values()) {
      session.failLocally(error);
    }
    this.#sessions.clear();
  }
}

class DatasetSessionImpl implements DatasetSession {
  readonly #engine: Engine;
  readonly handle: string;
  readonly tables: readonly Readonly<TableDescriptor>[];
  readonly #listeners = new Set<(event: DatasetEvent) => void>();
  readonly #tableHandles = new Set<TableHandleImpl>();
  closed = false;

  constructor(engine: Engine, handle: string, tables: readonly TableDescriptor[]) {
    this.#engine = engine;
    this.handle = handle;
    this.tables = Object.freeze(tables.map((table) => Object.freeze({ ...table })));
  }

  openTable(tableId: string): Promise<TableHandle> {
    return this.#engine.openTable(this, tableId);
  }

  subscribe(listener: (event: DatasetEvent) => void): Unsubscribe {
    this.assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): Promise<void> {
    return this.#engine.closeSession(this);
  }

  assertOpen(): void {
    if (this.closed) {
      throw closedError("Dataset session");
    }
  }

  addTableHandle(handle: TableHandleImpl): void {
    this.#tableHandles.add(handle);
  }

  removeTableHandle(handle: TableHandleImpl): void {
    this.#tableHandles.delete(handle);
  }

  closeLocally(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const table of this.#tableHandles) {
      table.closeLocally();
    }
    this.#tableHandles.clear();
    this.#emit({ type: "closed" });
  }

  failLocally(error: TabularkError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#emit({ type: "runtimeError", error });
    for (const table of [...this.#tableHandles]) {
      table.failLocally(error);
    }
    this.#tableHandles.clear();
    this.#emit({ type: "closed" });
  }

  handleEvent(event: ProtocolEvent): void {
    if (this.closed && event.event !== "closed") {
      return;
    }
    switch (event.event) {
      case "progress":
        this.#emit({ type: "progress", progress: normalizeProgress(event.payload) });
        break;
      case "metadata": {
        const metadata = normalizeMetadataWire(event.payload);
        this.#emit({ type: "metadata", metadata });
        if (!event.tableHandle) {
          for (const table of this.#tableHandles) {
            if (table.metadata.tableId === metadata.tableId) {
              table.updateMetadata(metadata);
            }
          }
        }
        break;
      }
      case "warning": {
        const warning = normalizeWarning(event.payload);
        this.#emit({ type: "warning", warning });
        for (const table of this.#tableHandles) {
          if (table.matchesWarning(warning)) {
            table.emitWarning(warning);
          }
        }
        break;
      }
      case "runtimeError":
        this.#emit({ type: "runtimeError", error: errorFromWire(event.payload) });
        break;
      case "closed":
        if (!event.tableHandle) {
          this.closeLocally();
        }
        break;
    }
    if (event.tableHandle) {
      for (const table of this.#tableHandles) {
        if (table.handle === event.tableHandle) {
          table.handleEvent(event);
        }
      }
    }
  }

  #emit(event: DatasetEvent): void {
    for (const listener of this.#listeners) {
      safelyCall(listener, event);
    }
  }
}

class TableHandleImpl implements TableHandle {
  readonly #engine: Engine;
  readonly #session: DatasetSessionImpl;
  readonly handle: string;
  #metadata: Readonly<TableMetadata>;
  readonly #listeners = new Set<(event: TableEvent) => void>();
  closed = false;

  constructor(
    engine: Engine,
    session: DatasetSessionImpl,
    handle: string,
    metadata: Readonly<TableMetadata>,
  ) {
    this.#engine = engine;
    this.#session = session;
    this.handle = handle;
    this.#metadata = metadata;
  }

  get metadata(): Readonly<TableMetadata> {
    return this.#metadata;
  }

  readRange(request: RangeRequest, options: ReadRangeOptions = {}): Promise<TableBatch> {
    return this.#engine.readRange(this, request, options);
  }

  subscribe(listener: (event: TableEvent) => void): Unsubscribe {
    this.assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): Promise<void> {
    return this.#engine.closeTable(this);
  }

  assertOpen(): void {
    if (this.closed) {
      throw closedError("Table handle");
    }
  }

  closeLocally(): void {
    if (this.closed) {
      return;
    }
    this.#engine.clearTableCache(this.handle);
    this.closed = true;
    this.#session.removeTableHandle(this);
    this.#emit({ type: "closed" });
  }

  failLocally(error: TabularkError): void {
    if (this.closed) {
      return;
    }
    this.#engine.clearTableCache(this.handle);
    this.closed = true;
    this.#session.removeTableHandle(this);
    this.#emit({ type: "runtimeError", error });
    this.#emit({ type: "closed" });
  }

  updateMetadata(metadata: Readonly<TableMetadata>): void {
    if (this.closed) {
      return;
    }
    this.#metadata = metadata;
    this.#emit({ type: "metadata", metadata });
  }

  matchesWarning(warning: SourceWarning): boolean {
    return warning.handle === this.handle || warning.handle === this.#session.handle;
  }

  emitWarning(warning: SourceWarning): void {
    if (!this.closed) {
      this.#emit({ type: "warning", warning });
    }
  }

  handleEvent(event: ProtocolEvent): void {
    if (this.closed && event.event !== "closed") {
      return;
    }
    switch (event.event) {
      case "metadata":
        this.updateMetadata(normalizeMetadataWire(event.payload));
        break;
      case "warning":
        this.emitWarning(normalizeWarning(event.payload));
        break;
      case "runtimeError":
        this.#emit({ type: "runtimeError", error: errorFromWire(event.payload) });
        break;
      case "closed":
        this.closeLocally();
        break;
      case "progress":
        break;
    }
  }

  #emit(event: TableEvent): void {
    for (const listener of this.#listeners) {
      safelyCall(listener, event);
    }
  }
}

function normalizeEngineOptions(options: EngineOptions): NormalizedEngineOptions {
  const memoryBudgetBytes = options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES;
  if (!Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes <= 0) {
    throw invalidArgument("memoryBudgetBytes must be a positive safe integer");
  }
  if (memoryBudgetBytes < MIN_MEMORY_BUDGET_BYTES) {
    throw invalidArgument(
      `memoryBudgetBytes must be at least ${MIN_MEMORY_BUDGET_BYTES} bytes`,
      { minimum: MIN_MEMORY_BUDGET_BYTES, memoryBudgetBytes },
    );
  }
  return {
    memoryBudgetBytes,
    limits: deriveMemoryBudgetLimits(memoryBudgetBytes),
    wasmModuleUrl: resolveUrl(
      options.wasmModuleUrl,
      new URL("./wasm/tabulark.js", import.meta.url).href,
    ),
    workerUrl: resolveUrl(options.workerUrl, new URL("./worker.js", import.meta.url).href),
    workerName: options.workerName ?? "tabulark",
  };
}

function normalizeOpenOptions(options: OpenSourceOptions): NormalizedOpenOptions {
  if (!options || (options.format !== "csv" && options.format !== "tsv")) {
    throw invalidArgument("format must be either csv or tsv");
  }
  const header = options.header ?? "first-row";
  const mode = options.mode ?? "lenient";
  if (header !== "first-row" && header !== "none") {
    throw invalidArgument("header must be first-row or none");
  }
  if (mode !== "lenient" && mode !== "strict") {
    throw invalidArgument("mode must be lenient or strict");
  }
  const delimiter = options.delimiter ?? (options.format === "csv" ? "," : "\t");
  if (delimiter.length !== 1 || delimiter.charCodeAt(0) > 0x7f) {
    throw invalidArgument("delimiter must contain exactly one ASCII byte");
  }
  return {
    format: options.format,
    options: Object.freeze({ header, mode, delimiter }),
  };
}

function normalizeDescriptors(value: unknown): readonly TableDescriptor[] {
  if (!Array.isArray(value)) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned invalid table descriptors");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
      throw new TabularkError(
        "PROTOCOL_INCOMPATIBLE",
        `Worker returned an invalid table descriptor at index ${index}`,
      );
    }
    return { id: entry.id, name: entry.name };
  });
}

function normalizeMetadataWire(value: unknown): Readonly<TableMetadata> {
  if (!isRecord(value) || typeof value.tableId !== "string" || typeof value.name !== "string") {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned invalid table metadata");
  }
  const rawExtent = isRecord(value.extent) ? value.extent : {};
  const rawSchema = isRecord(value.schema) ? value.schema : {};
  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const columns = Array.isArray(rawSchema.columns)
    ? rawSchema.columns.map((column, index) => normalizeColumn(column, index))
    : [];
  return normalizeMetadata({
    tableId: value.tableId,
    name: value.name,
    revision: numeric(value.revision, 0),
    extent: {
      rows: normalizeAxis(rawExtent.rows, "at-least", 0),
      columns: normalizeAxis(rawExtent.columns, "exact", columns.length),
    },
    schema: { version: numeric(rawSchema.version, 0), columns },
    capabilities: {
      randomAccess: rawCapabilities.randomAccess === "full" ? "full" : "indexed-prefix",
      typedValues: rawCapabilities.typedValues === true,
      search: rawCapabilities.search === true,
      sort: rawCapabilities.sort === true,
      filter: rawCapabilities.filter === true,
      multiTable: rawCapabilities.multiTable === true,
      ...rawCapabilities,
    },
  });
}

function normalizeColumn(value: unknown, index: number): TableMetadata["schema"]["columns"][number] {
  const raw = isRecord(value) ? value : {};
  return {
    id: typeof raw.id === "string" ? raw.id : `c${index}`,
    name: typeof raw.name === "string" ? raw.name : `column_${index + 1}`,
    index: numeric(raw.index, index),
    logicalType: typeof raw.logicalType === "string"
      ? raw.logicalType as TableMetadata["schema"]["columns"][number]["logicalType"]
      : "utf8",
    nullable: raw.nullable !== false,
    ...(isRecord(raw.extensions) ? { extensions: raw.extensions } : {}),
  };
}

function normalizeAxis(
  value: unknown,
  fallbackKind: "exact" | "at-least",
  fallbackValue: number,
): TableMetadata["extent"]["rows"] {
  if (isRecord(value)) {
    if (value.kind === "unknown") {
      return { kind: "unknown" };
    }
    if ((value.kind === "exact" || value.kind === "at-least") && Number.isSafeInteger(value.value)) {
      return { kind: value.kind, value: value.value as number };
    }
  }
  return { kind: fallbackKind, value: fallbackValue };
}

function normalizeProgress(value: unknown): RuntimeProgress {
  const raw = isRecord(value) ? value : {};
  return {
    sourceHandle: typeof raw.sourceHandle === "string" ? raw.sourceHandle : "",
    bytesScanned: numeric(raw.bytesScanned, 0),
    rowsDiscovered: numeric(raw.rowsDiscovered, 0),
    done: raw.done === true,
  };
}

function normalizeWarning(value: unknown): SourceWarning {
  const raw = isRecord(value) ? value : {};
  return {
    handle: typeof raw.handle === "string" ? raw.handle : "",
    kind: typeof raw.kind === "string" ? raw.kind : "warning",
    message: typeof raw.message === "string" ? raw.message : "Source warning",
    ...(Number.isSafeInteger(raw.byteOffset) ? { byteOffset: raw.byteOffset as number } : {}),
  };
}

function errorFromWire(value: unknown): TabularkError {
  if (isRecord(value) && typeof value.code === "string" && typeof value.message === "string") {
    return TabularkError.fromSerialized({
      code: value.code,
      message: value.message,
      retryable: value.retryable === true,
      ...(value.details === undefined ? {} : { details: value.details }),
    });
  }
  return new TabularkError("RUNTIME_FAILURE", "The Worker reported a runtime failure");
}

function resolveUrl(value: string | URL | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  return typeof value === "string" ? new URL(value, import.meta.url).href : value.href;
}

function numeric(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function safelyCall<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch (error) {
    if (typeof reportError === "function") {
      reportError(error);
    }
  }
}

/** Creates one dedicated Worker-backed Tabulark engine. */
export function createEngine(options: EngineOptions = {}): Promise<TabularkEngine> {
  return Engine.create(options);
}
