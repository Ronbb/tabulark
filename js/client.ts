import { TabularkError, cancelledError, closedError, invalidArgument } from "./errors.js";
import {
  resolveOfficialAdapter,
  type AdapterDescriptor,
  type AdapterRegistration,
  type ArrowIpcAdapterOptions,
  type DelimitedAdapterOptions,
  type OfficialAdapterId,
} from "./adapters.js";
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  ColumnarTableBatch,
  deriveMemoryBudgetLimits,
  normalizeDataType,
  normalizeMetadata,
  validateRange,
  type RangeRequest,
  type TableBatch,
  type TableDescriptor,
  type TableMetadata,
  type WireTableBatch,
  type MemoryBudgetLimits,
} from "./model.js";
import {
  ADAPTER_API_VERSION,
  BATCH_LAYOUT_VERSION,
  PROTOCOL_VERSION,
  isRecord,
  type ProtocolEvent,
} from "./protocol.js";
import {
  ByteLruCache,
  cloneWireTableBatch,
  rangeCacheKey,
  rangeCacheKeyBelongsTo,
  wireBatchByteLength,
} from "./range-cache.js";
import { WorkerRpcClient } from "./rpc-client.js";

const MIN_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
const LIFECYCLE_CLOSE_TIMEOUT_MS = 2_000;
const MAX_ORPHAN_HANDLES = 32;
const MAX_ORPHAN_EVENTS_PER_HANDLE = 16;
const MAX_ORPHAN_EVENTS = 256;

export interface OpenSourceOptions<Options = unknown> {
  /** One of the official descriptors registered when the engine was created. */
  readonly adapter: AdapterDescriptor<OfficialAdapterId, Options>;
  readonly adapterOptions?: Options;
  /** Detaches an ArrayBuffer input. Defaults to false; Blob input cannot be transferred. */
  readonly transferInput?: boolean;
  /** Cancels opening and releases any Worker-side source created by the request. */
  readonly signal?: AbortSignal;
}

export interface EngineOptions {
  /** The engine's immutable allow-list. At least one official adapter is required. */
  readonly adapters: readonly AdapterDescriptor[];
  readonly memoryBudgetBytes?: number;
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
  readonly row?: number;
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
  open<Options>(source: Blob | ArrayBuffer, options: OpenSourceOptions<Options>): Promise<DatasetSession>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

interface NormalizedEngineOptions {
  readonly memoryBudgetBytes: number;
  readonly limits: MemoryBudgetLimits;
  readonly adapters: readonly AdapterRegistration[];
  readonly workerUrl: string;
  readonly workerName: string;
}

interface NormalizedOpenOptions {
  readonly adapter: AdapterRegistration;
  readonly options: Readonly<Record<string, unknown>>;
}

class Engine implements TabularkEngine {
  readonly #rpc: WorkerRpcClient;
  readonly #rangeCache: ByteLruCache<WireTableBatch>;
  readonly #maxArrayBufferBytes: number;
  readonly #adapters: ReadonlyMap<OfficialAdapterId, AdapterRegistration>;
  readonly #sessions = new Map<string, DatasetSessionImpl>();
  readonly #orphanEvents = new Map<string, ProtocolEvent[]>();
  #orphanEventCount = 0;
  #closed = false;

  constructor(
    rpc: WorkerRpcClient,
    limits: MemoryBudgetLimits,
    adapters: readonly AdapterRegistration[],
  ) {
    this.#rpc = rpc;
    this.#rangeCache = new ByteLruCache(limits.mainThreadRangeCacheBytes);
    this.#maxArrayBufferBytes = limits.maxArrayBufferBytes;
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
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
    engine = new Engine(rpc, normalized.limits, normalized.adapters);
    try {
      const hello = await rpc.request<unknown>(
        "hello",
        {
          clientName: "tabulark-js",
          adapters: normalized.adapters,
          memoryBudgetBytes: normalized.memoryBudgetBytes,
        },
        "hello",
      );
      const helloAdapters = isRecord(hello) && Array.isArray(hello.adapters)
        ? hello.adapters
        : undefined;
      if (
        !isRecord(hello)
        || hello.protocolVersion !== PROTOCOL_VERSION
        || hello.adapterApiVersion !== ADAPTER_API_VERSION
        || hello.batchLayoutVersion !== BATCH_LAYOUT_VERSION
        || !helloAdapters
        || helloAdapters.length !== normalized.adapters.length
        || normalized.adapters.some((adapter) => !helloAdapters.includes(adapter.id))
      ) {
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

  async open<Options>(
    source: Blob | ArrayBuffer,
    options: OpenSourceOptions<Options>,
  ): Promise<DatasetSession> {
    this.#assertOpen();
    const normalizedOptions = normalizeOpenOptions(options, this.#adapters, inferSourceName(source));
    const transfer: Transferable[] = [];
    if (source instanceof ArrayBuffer) {
      if (source.byteLength > this.#maxArrayBufferBytes) {
        throw new TabularkError(
          "RESOURCE_LIMIT",
          `ArrayBuffer sources larger than ${this.#maxArrayBufferBytes} bytes must be supplied as a Blob`,
          { details: { limit: this.#maxArrayBufferBytes, byteLength: source.byteLength } },
        );
      }
      if (options.transferInput === true) {
        transfer.push(source);
      }
    } else if (!(source instanceof Blob)) {
      throw invalidArgument("source must be a Blob, File, or ArrayBuffer");
    } else if (options.transferInput === true) {
      throw invalidArgument("transferInput may only be true for an ArrayBuffer source");
    }

    const dataset = await this.#rpc.request<{ datasetHandle: string }>(
      "openSource",
      {
        source,
        adapterId: normalizedOptions.adapter.id,
        options: normalizedOptions.options,
      },
      "dataset",
      options.signal ? { transfer, signal: options.signal } : { transfer },
    );
    if (
      !isRecord(dataset)
      || typeof dataset.datasetHandle !== "string"
      || dataset.datasetHandle.length === 0
    ) {
      throw this.#terminateForProtocolFailure("Worker returned an invalid dataset handle");
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
      if (session.closed) {
        throw session.terminalError ?? closedError("Dataset session");
      }
      return session;
    } catch (error) {
      const terminalError = this.#orphanRuntimeError(dataset.datasetHandle);
      const session = this.#sessions.get(dataset.datasetHandle);
      if (session) {
        session.closeLocally();
        this.#sessions.delete(dataset.datasetHandle);
      }
      await this.#discardOpenedDataset(dataset.datasetHandle);
      throw terminalError ?? error;
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
    this.#clearOrphanEvents();
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
    let tableHandle: string | undefined;
    try {
      const table = await this.#rpc.request<{ tableHandle: string }>(
        "openTable",
        { datasetHandle: session.handle, tableId },
        "table",
      );
      if (
        !isRecord(table)
        || typeof table.tableHandle !== "string"
        || table.tableHandle.length === 0
      ) {
        throw this.#terminateForProtocolFailure("Worker returned an invalid table handle");
      }
      tableHandle = table.tableHandle;
      const metadata = await this.#rpc.request<unknown>(
        "getMetadata",
        { tableHandle },
        "metadata",
      );
      const normalizedMetadata = normalizeMetadataWire(metadata);
      this.#assertOpen();
      session.assertOpen();
      const handle = new TableHandleImpl(
        this,
        session,
        tableHandle,
        normalizedMetadata,
      );
      session.addTableHandle(handle);
      return handle;
    } catch (error) {
      if (tableHandle !== undefined) {
        await this.#discardOpenedTable(tableHandle);
      }
      throw error;
    }
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
    this.#assertOpen();
    table.assertOpen();
    // Incomplete batches end at a progressive indexed-prefix boundary. They
    // are valid results for this instant, but caching them would hide rows
    // discovered by subsequent Arrow Stream or delimited scan progress.
    if (batch.complete) {
      const cachedBatch = cloneWireTableBatch(batch);
      this.#rangeCache.set(
        rangeCacheKey(table.handle, batch.revision, batch.schemaVersion, normalized),
        cachedBatch,
        wireBatchByteLength(cachedBatch),
      );
    }
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
    await this.#requestRemoteClose("closeTable", { tableHandle: table.handle });
  }

  clearTableCache(tableHandle: string): void {
    this.#rangeCache.deleteWhere((key) => rangeCacheKeyBelongsTo(key, tableHandle));
  }

  async closeSession(session: DatasetSessionImpl): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closeLocally();
    if (this.#closed) {
      this.#sessions.delete(session.handle);
      return;
    }
    try {
      await this.#requestRemoteClose("closeSource", { datasetHandle: session.handle });
    } finally {
      this.#sessions.delete(session.handle);
      this.#deleteOrphanEvents(session.handle);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw closedError("Engine");
    }
  }

  #handleEvent(event: ProtocolEvent): void {
    const handle = event.datasetHandle;
    if (!handle && event.event === "runtimeError") {
      this.#handleRuntimeFailure(errorFromWire(event.payload));
      return;
    }
    if (!handle) {
      return;
    }
    const session = this.#sessions.get(handle);
    if (!session) {
      this.#rememberOrphanEvent(handle, event);
      return;
    }
    session.handleEvent(event);
    if (event.event === "closed" && !event.tableHandle && session.closed) {
      this.#sessions.delete(handle);
      this.#deleteOrphanEvents(handle);
    }
  }

  #deliverOrphanEvents(session: DatasetSessionImpl): void {
    const events = this.#orphanEvents.get(session.handle);
    if (!events) {
      return;
    }
    this.#deleteOrphanEvents(session.handle);
    for (const event of events) {
      session.handleEvent(event);
    }
  }

  #orphanRuntimeError(handle: string): TabularkError | undefined {
    const event = this.#orphanEvents.get(handle)?.find((candidate) => (
      candidate.event === "runtimeError"
    ));
    return event ? errorFromWire(event.payload) : undefined;
  }

  async #discardOpenedTable(tableHandle: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.#rpc.request(
        "closeTable",
        { tableHandle },
        "acknowledged",
        { timeoutMs: LIFECYCLE_CLOSE_TIMEOUT_MS },
      );
    } catch (error) {
      if (!this.#closed) {
        this.#rpc.terminate(asTabularkError(error, "Could not release an opened table"), true);
      }
    }
  }

  async #discardOpenedDataset(datasetHandle: string): Promise<void> {
    this.#deleteOrphanEvents(datasetHandle);
    if (this.#closed) {
      return;
    }
    try {
      await this.#rpc.request(
        "closeSource",
        { datasetHandle },
        "acknowledged",
        { timeoutMs: LIFECYCLE_CLOSE_TIMEOUT_MS },
      );
    } catch (error) {
      if (!this.#closed) {
        this.#rpc.terminate(asTabularkError(error, "Could not release an opened dataset"), true);
      }
    } finally {
      // closeSource may emit a final closed event before its acknowledgement.
      // No DatasetSession will consume that event after a failed open.
      this.#deleteOrphanEvents(datasetHandle);
    }
  }

  async #requestRemoteClose(
    op: "closeTable" | "closeSource",
    payload: unknown,
  ): Promise<void> {
    try {
      await this.#rpc.request(op, payload, "acknowledged", {
        timeoutMs: LIFECYCLE_CLOSE_TIMEOUT_MS,
      });
    } catch (error) {
      if (!this.#closed) {
        this.#rpc.terminate(asTabularkError(error, `Could not complete ${op}`), true);
      }
      throw error;
    }
  }

  #terminateForProtocolFailure(message: string): TabularkError {
    const error = new TabularkError("PROTOCOL_INCOMPATIBLE", message);
    this.#rpc.terminate(error, true);
    return error;
  }

  #rememberOrphanEvent(handle: string, event: ProtocolEvent): void {
    // No caller can subscribe until open() returns, so progress, metadata, and
    // warning events observed before a DatasetSession exists have no consumer.
    // Retaining only terminal state prevents an unknown-handle event stream
    // from becoming an unbounded main-thread cache while preserving the race
    // that must not return a dead session from open().
    if (event.event !== "runtimeError" && event.event !== "closed") {
      return;
    }
    let events = this.#orphanEvents.get(handle);
    if (!events) {
      while (this.#orphanEvents.size >= MAX_ORPHAN_HANDLES) {
        this.#evictOldestOrphanHandle();
      }
      events = [];
      this.#orphanEvents.set(handle, events);
    }
    if (events.length >= MAX_ORPHAN_EVENTS_PER_HANDLE) {
      events.shift();
      this.#orphanEventCount -= 1;
    }
    while (this.#orphanEventCount >= MAX_ORPHAN_EVENTS) {
      this.#evictOldestOrphanEvent();
    }
    events.push(event);
    this.#orphanEventCount += 1;
  }

  #evictOldestOrphanEvent(): void {
    const oldest = this.#orphanEvents.entries().next().value as
      | [string, ProtocolEvent[]]
      | undefined;
    if (!oldest) {
      this.#orphanEventCount = 0;
      return;
    }
    const [handle, events] = oldest;
    events.shift();
    this.#orphanEventCount -= 1;
    if (events.length === 0) {
      this.#orphanEvents.delete(handle);
    }
  }

  #evictOldestOrphanHandle(): void {
    const handle = this.#orphanEvents.keys().next().value as string | undefined;
    if (handle !== undefined) {
      this.#deleteOrphanEvents(handle);
    }
  }

  #deleteOrphanEvents(handle: string): void {
    const events = this.#orphanEvents.get(handle);
    if (!events) {
      return;
    }
    this.#orphanEventCount -= events.length;
    this.#orphanEvents.delete(handle);
  }

  #clearOrphanEvents(): void {
    this.#orphanEvents.clear();
    this.#orphanEventCount = 0;
  }

  #handleRuntimeFailure(error: TabularkError): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rangeCache.clear();
    this.#clearOrphanEvents();
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
  terminalError: TabularkError | undefined;

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
    this.terminalError = error;
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
      case "runtimeError": {
        const error = errorFromWire(event.payload);
        if (event.tableHandle) {
          this.#emit({ type: "runtimeError", error });
        } else {
          this.failLocally(error);
        }
        break;
      }
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
        this.failLocally(errorFromWire(event.payload));
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
  if (!options || typeof options !== "object") {
    throw invalidArgument("createEngine options are required");
  }
  if ("wasmModuleUrl" in options || "workerUrl" in options) {
    throw invalidArgument("wasmModuleUrl and workerUrl were removed; register an official adapter instead");
  }
  if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
    throw invalidArgument("adapters must contain at least one official adapter descriptor");
  }
  const adapters: AdapterRegistration[] = [];
  const ids = new Set<OfficialAdapterId>();
  for (const [index, descriptor] of options.adapters.entries()) {
    const registration = resolveOfficialAdapter(descriptor);
    if (!registration) {
      throw invalidArgument(`adapters[${index}] is not an official frozen adapter descriptor`);
    }
    if (ids.has(registration.id)) {
      throw invalidArgument(`Adapter ${registration.id} is registered more than once`);
    }
    ids.add(registration.id);
    adapters.push(Object.freeze({ ...registration }));
  }
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
    adapters: Object.freeze(adapters),
    workerUrl: new URL("./worker.js", import.meta.url).href,
    workerName: options.workerName ?? "tabulark",
  };
}

function normalizeOpenOptions<Options>(
  options: OpenSourceOptions<Options>,
  adapters: ReadonlyMap<OfficialAdapterId, AdapterRegistration>,
  inferredSourceName?: string,
): NormalizedOpenOptions {
  if (!options || typeof options !== "object") {
    throw invalidArgument("open options are required");
  }
  if (options.transferInput !== undefined && typeof options.transferInput !== "boolean") {
    throw invalidArgument("transferInput must be a boolean");
  }
  const selected = resolveOfficialAdapter(options.adapter);
  if (!selected) {
    throw invalidArgument("adapter must be an official frozen adapter descriptor");
  }
  const registered = adapters.get(selected.id);
  if (!registered || registered.moduleUrl !== selected.moduleUrl) {
    throw invalidArgument(`Adapter ${selected.id} was not registered with this engine`);
  }
  const rawOptions = options.adapterOptions;
  if (rawOptions !== undefined && (!isRecord(rawOptions) || Array.isArray(rawOptions))) {
    throw invalidArgument("adapterOptions must be an object");
  }
  const normalized = selected.id === "tabulark:delimited"
    ? normalizeDelimitedOptions(rawOptions as DelimitedAdapterOptions | undefined, inferredSourceName)
    : normalizeArrowOptions(rawOptions as ArrowIpcAdapterOptions | undefined, inferredSourceName);
  return {
    adapter: registered,
    options: normalized,
  };
}

function normalizeDelimitedOptions(
  options: DelimitedAdapterOptions | undefined,
  inferredSourceName?: string,
): Readonly<Record<string, unknown>> {
  const raw = options ?? {};
  assertOnlyKeys(raw, ["dialect", "header", "mode", "delimiter", "sourceName"]);
  const dialect = raw.dialect ?? "csv";
  const header = raw.header ?? "first-row";
  const mode = raw.mode ?? "lenient";
  if (dialect !== "csv" && dialect !== "tsv") {
    throw invalidArgument("dialect must be csv or tsv");
  }
  if (header !== "first-row" && header !== "none") {
    throw invalidArgument("header must be first-row or none");
  }
  if (mode !== "lenient" && mode !== "strict") {
    throw invalidArgument("mode must be lenient or strict");
  }
  const delimiter = raw.delimiter ?? (dialect === "csv" ? "," : "\t");
  if (!isValidDelimiter(delimiter)) {
    throw invalidArgument("delimiter must be one non-NUL ASCII byte other than CR, LF, or quote");
  }
  const sourceName = normalizeSourceName(raw.sourceName ?? inferredSourceName);
  return Object.freeze({
    dialect,
    header,
    mode,
    delimiter,
    ...(sourceName === undefined ? {} : { sourceName }),
  });
}

function normalizeArrowOptions(
  options: ArrowIpcAdapterOptions | undefined,
  inferredSourceName?: string,
): Readonly<Record<string, unknown>> {
  const raw = options ?? {};
  assertOnlyKeys(raw, ["container", "sourceName"]);
  const container = raw.container ?? "auto";
  if (container !== "auto" && container !== "file" && container !== "stream") {
    throw invalidArgument("container must be auto, file, or stream");
  }
  const sourceName = normalizeSourceName(raw.sourceName ?? inferredSourceName);
  return Object.freeze({
    container,
    ...(sourceName === undefined ? {} : { sourceName }),
  });
}

function normalizeSourceName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw invalidArgument("sourceName must contain between 1 and 1024 characters");
  }
  return value;
}

function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw invalidArgument(`Unknown adapter option: ${key}`);
    }
  }
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
      ...rawCapabilities,
      randomAccess: rawCapabilities.randomAccess === "full" ? "full" : "indexed-prefix",
      typedValues: rawCapabilities.typedValues === true,
      search: rawCapabilities.search === true,
      sort: rawCapabilities.sort === true,
      filter: rawCapabilities.filter === true,
      multiTable: rawCapabilities.multiTable === true,
    },
  });
}

function normalizeColumn(value: unknown, index: number): TableMetadata["schema"]["columns"][number] {
  const raw = isRecord(value) ? value : {};
  return {
    id: typeof raw.id === "string" ? raw.id : `c${index}`,
    name: typeof raw.name === "string" ? raw.name : `column_${index + 1}`,
    index: numeric(raw.index, index),
    dataType: normalizeDataType(raw.dataType ?? { type: "unknown" }),
    nullable: raw.nullable !== false,
    ...(isRecord(raw.metadata)
      ? { metadata: Object.freeze(Object.fromEntries(
          Object.entries(raw.metadata).map(([key, entry]) => [key, String(entry)]),
        )) }
      : {}),
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
    if (
      (value.kind === "exact" || value.kind === "at-least")
      && Number.isSafeInteger(value.value)
      && (value.value as number) >= 0
    ) {
      return { kind: value.kind, value: value.value as number };
    }
  }
  return { kind: fallbackKind, value: fallbackValue };
}

function isValidDelimiter(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 1) {
    return false;
  }
  const byte = value.charCodeAt(0);
  return byte <= 0x7f && byte !== 0 && byte !== 0x0d && byte !== 0x0a && byte !== 0x22;
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
    ...(Number.isSafeInteger(raw.row) && (raw.row as number) >= 0
      ? { row: raw.row as number }
      : {}),
  };
}

function inferSourceName(source: unknown): string | undefined {
  if (typeof File !== "undefined" && source instanceof File && source.name.length > 0) {
    return source.name;
  }
  return undefined;
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

function asTabularkError(error: unknown, message: string): TabularkError {
  return error instanceof TabularkError
    ? error
    : new TabularkError("RUNTIME_FAILURE", message, { cause: error });
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
export function createEngine(options: EngineOptions): Promise<TabularkEngine> {
  return Engine.create(options);
}
