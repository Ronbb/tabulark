import { TabularkError, cancelledError, closedError, invalidArgument } from "./errors.js";
import {
  resolveOfficialAdapter,
  type AdapterDescriptor,
  type AdapterRegistration,
  type ArrowIpcAdapterOptions,
  type DelimitedAdapterOptions,
  type ExcelAdapterOptions,
  type OfficialAdapterId,
  type ParquetAdapterOptions,
} from "./adapters.js";
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  MAX_ARRAY_BUFFER_BYTES,
  ColumnarTableBatch,
  deriveMemoryBudgetLimits,
  normalizeDataType,
  normalizeMetadata,
  validateRange,
  type RangeRequest,
  type MergedCellRegion,
  type PresentationAxisEntry,
  type PresentationRange,
  type PresentationStyle,
  type SpreadsheetPresentation,
  type TablePresentation,
  type TableBatch,
  type TableCapabilities,
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
  officialAdapterManifestEntry,
  type OfficialSourceAccess,
} from "./official-adapter-manifest.js";
import {
  type BatchBacking,
  ByteLruCache,
  createBatchBacking,
  rangeCacheKey,
  rangeCacheKeyBelongsToDataset,
  rangeCacheKeyBelongsToTable,
  rangeCacheKeyMatchesVersion,
  wireBatchByteLength,
} from "./range-cache.js";
import { WorkerRpcClient, type OperationTelemetry } from "./rpc-client.js";
import {
  MAX_LARGE_SOURCE_BYTES,
  isSourceMode,
  type SourceMode,
} from "./source.js";
import {
  MAX_RANGE_SOURCE_BYTES,
  copyRangeBytes,
  isRangeSource,
  isSafeNonNegativeInteger,
  normalizeRangeSourceSnapshot,
  validateRangeSourceReader,
  type RangeSource,
  type RangeSourceReader,
} from "./range-source.js";

export type { SourceMode } from "./source.js";
export type {
  ByteRange,
  RangeSource,
  RangeSourceReader,
  RangeSourceSnapshot,
} from "./range-source.js";

const MIN_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
const LIFECYCLE_CLOSE_TIMEOUT_MS = 2_000;
const MAX_ORPHAN_HANDLES = 32;
const MAX_ORPHAN_EVENTS_PER_HANDLE = 16;
const MAX_ORPHAN_EVENTS = 256;
/** Keep diagnostics useful without allowing an untrusted source to grow memory without bound. */
const MAX_DIAGNOSTICS = 1_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_PERFORMANCE_SAMPLES = 128;
const MIN_BATCH_CACHE_ENTRY_BYTES = 4 * 1024;
const MAX_BATCH_CACHE_ENTRIES = 512;
const DISPLAY_ONLY_READ = Symbol.for("tabulark.internal.display-only-read.v1");
// The core and HTTP helper are separate bundles. A shared weak store lets both
// see the same open-options reservation without adding any observable key to
// the public RangeSourceOpenOptions object.
const RANGE_SOURCE_HOST_RESERVATION_STORE = Symbol.for(
  "tabulark.internal.range-source-reservation-store.v1",
);

interface RangeSourceHostReservations {
  reserveStaging(bytes: number, signal: AbortSignal): Promise<() => void>;
  reserveRetained(bytes: number): () => void;
}

function attachRangeSourceHostReservations<T extends object>(
  options: T,
  reservations: RangeSourceHostReservations,
): T {
  rangeSourceHostReservationStore().set(options, Object.freeze(reservations));
  return options;
}

function rangeSourceHostReservationStore(): WeakMap<object, RangeSourceHostReservations> {
  const host = globalThis as typeof globalThis & {
    [RANGE_SOURCE_HOST_RESERVATION_STORE]?: WeakMap<object, RangeSourceHostReservations>;
  };
  const existing = host[RANGE_SOURCE_HOST_RESERVATION_STORE];
  if (existing instanceof WeakMap) return existing;
  const store = new WeakMap<object, RangeSourceHostReservations>();
  Object.defineProperty(host, RANGE_SOURCE_HOST_RESERVATION_STORE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: store,
  });
  return store;
}

export interface OpenSourceOptions<Options = unknown> {
  /** One of the official descriptors registered when the engine was created. */
  readonly adapter: AdapterDescriptor<OfficialAdapterId, Options>;
  readonly adapterOptions?: Options;
  /**
   * Selects the bounded default source path or the local Blob path that may
   * address files up to 2 GiB. Defaults to `auto`.
   *
   * Large mode is reserved for local `File`/`Blob` inputs and never changes
   * ArrayBuffer staging limits.
   */
  readonly sourceMode?: SourceMode;
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

function isDisplayOnlyRead(options: ReadRangeOptions): boolean {
  return (options as ReadRangeOptions & Record<symbol, unknown>)[DISPLAY_ONLY_READ] === true;
}

export interface RuntimeProgress {
  readonly sourceHandle: string;
  readonly tableId?: string;
  readonly revision?: number;
  readonly bytesScanned: number;
  readonly rowsDiscovered: number;
  readonly done: boolean;
}

export interface SourceWarning {
  readonly handle: string;
  readonly kind: string;
  readonly message: string;
  readonly tableId?: string;
  readonly resource?: string;
  readonly requiredBytes?: number;
  readonly availableBytes?: number;
  readonly byteOffset?: number;
  /** Compatible alias used by structured diagnostics. */
  readonly sourceOffset?: number;
  readonly row?: number;
  readonly column?: number;
}

/** A safe, structured source or runtime diagnostic. */
export interface TabularkDiagnostic {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly recoverable: boolean;
  readonly resource?: string;
  readonly requiredBytes?: number;
  readonly availableBytes?: number;
  readonly sourceOffset?: number;
  readonly tableId?: string;
  readonly revision?: number;
  readonly row?: number;
  readonly column?: number;
}

/** Logical capabilities of an opened dataset. */
export interface DatasetCapabilities {
  readonly adapterId: OfficialAdapterId;
  readonly sourceAccess: OfficialSourceAccess;
  readonly progressive: boolean;
  readonly maxSourceBytes: number;
  readonly multiTable: boolean;
  readonly presentation: boolean;
  readonly typedValues: boolean;
}

/** Optional, privacy-preserving operation timing sample. */
export interface PerformanceSample {
  /** Logical operation stage; implementation and transport names are omitted. */
  readonly stage: string;
  /** Elapsed duration relative to the operation start, in milliseconds. */
  readonly durationMs: number;
  /** Bytes read from the source during this stage, when known. */
  readonly bytesRead: number;
  /** Whether the result came from a retained range cache. */
  readonly cacheHit: boolean;
  /** Peak reservation observed by the host, when known. */
  readonly peakReservationBytes: number;
  /** Number of provider range reads represented by this operation. */
  readonly sourceReads: number;
  /** Bytes served from the Worker source-range cache. */
  readonly sourceCacheHitBytes: number;
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
  getDiagnostics(): readonly TabularkDiagnostic[];
  subscribeDiagnostics(listener: (diagnostic: TabularkDiagnostic) => void): Unsubscribe;
  getCapabilities(): Readonly<DatasetCapabilities>;
  close(): Promise<void>;
}

export interface TableHandle {
  readonly metadata: Readonly<TableMetadata>;
  getPresentation(): Promise<TablePresentation | null>;
  readPresentationRange(
    request: RangeRequest,
    options?: ReadRangeOptions,
  ): Promise<PresentationRange | null>;
  readRange(request: RangeRequest, options?: ReadRangeOptions): Promise<TableBatch>;
  subscribe(listener: (event: TableEvent) => void): Unsubscribe;
  getDiagnostics(): readonly TabularkDiagnostic[];
  subscribeDiagnostics(listener: (diagnostic: TabularkDiagnostic) => void): Unsubscribe;
  getCapabilities(): Readonly<TableCapabilities>;
  close(): Promise<void>;
}

export interface TabularkEngine {
  open<Options>(source: Blob | ArrayBuffer | RangeSource, options: OpenSourceOptions<Options>): Promise<DatasetSession>;
  subscribePerformance(listener: (sample: PerformanceSample) => void): Unsubscribe;
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
  readonly sourceMode: SourceMode;
  readonly isRangeSource: boolean;
}

interface SourceReaderRecord {
  readonly handle: string;
  readonly size: number;
  readonly maxConcurrency: number;
  readonly reader: RangeSourceReader;
  readonly pending: Map<string, AbortController>;
  readonly concurrency: SourceReadConcurrencyLimiter;
  closed: boolean;
}

interface SourceStagingPermit {
  readonly release: () => void;
}

interface SourceStagingWaiter {
  readonly bytes: number;
  readonly signal: AbortSignal;
  readonly resolve: (permit: SourceStagingPermit) => void;
  readonly reject: (error: unknown) => void;
  onAbort: () => void;
}

/**
 * Aggregates transient host-side source buffers across every opened reader.
 * A per-request length check is insufficient: several readers can otherwise
 * each consume the full staging slice at once.  Waiting here keeps the bound
 * hard without making a valid adapter operation fail merely because another
 * read is currently transferring bytes.
 */
class SourceStagingLimiter {
  readonly #capacity: number;
  readonly #queue: SourceStagingWaiter[] = [];
  #used = 0;
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Number.isSafeInteger(capacity) ? capacity : 1);
  }

  acquire(bytes: number, signal: AbortSignal): Promise<SourceStagingPermit> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(new TabularkError(
        "RANGE_UNSUPPORTED",
        "The source range length is invalid",
      ));
    }
    if (bytes > this.#capacity) {
      return Promise.reject(new TabularkError(
        "RESOURCE_LIMIT",
        "The source exceeds its staging budget",
        {
          details: {
            resource: "source-staging",
            requiredBytes: bytes,
            availableBytes: this.#capacity,
          },
        },
      ));
    }
    if (this.#closed) return Promise.reject(closedError("Source staging"));
    if (signal.aborted) return Promise.reject(cancelledError());
    if (this.#used + bytes <= this.#capacity) {
      return Promise.resolve(this.#grant(bytes));
    }
    return new Promise<SourceStagingPermit>((resolve, reject) => {
      const waiter: SourceStagingWaiter = {
        bytes,
        signal,
        resolve,
        reject,
        onAbort: () => undefined,
      };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(cancelledError());
      };
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#queue.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(closedError("Source staging"));
    }
  }

  #grant(bytes: number): SourceStagingPermit {
    this.#used += bytes;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#used = Math.max(0, this.#used - bytes);
        this.#drain();
      },
    });
  }

  #drain(): void {
    if (this.#closed) return;
    for (;;) {
      let selected = -1;
      for (let index = 0; index < this.#queue.length; index += 1) {
        const waiter = this.#queue[index]!;
        if (waiter.signal.aborted) {
          this.#queue.splice(index, 1);
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.reject(cancelledError());
          index -= 1;
          continue;
        }
        if (this.#used + waiter.bytes <= this.#capacity) {
          selected = index;
          break;
        }
      }
      if (selected < 0) return;
      const waiter = this.#queue.splice(selected, 1)[0]!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.#grant(waiter.bytes));
    }
  }
}

/** Enforces a reader's advertised 1–4 provider concurrency at the broker. */
class SourceReadConcurrencyLimiter {
  readonly #limit: number;
  readonly #queue: Array<{
    readonly signal: AbortSignal;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: unknown) => void;
    onAbort: () => void;
  }> = [];
  #active = 0;
  #closed = false;

  constructor(limit: number) {
    this.#limit = Math.min(4, Math.max(1, Number.isSafeInteger(limit) ? limit : 1));
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.#closed) return Promise.reject(closedError("Range source reader"));
    if (signal.aborted) return Promise.reject(cancelledError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#grant());
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: {
        readonly signal: AbortSignal;
        readonly resolve: (release: () => void) => void;
        readonly reject: (error: unknown) => void;
        onAbort: () => void;
      } = {
        signal,
        resolve,
        reject,
        onAbort: () => undefined,
      };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(cancelledError());
      };
      entry.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(closedError("Range source reader"));
    }
  }

  #grant(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
      this.#drain();
    };
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#active < this.#limit && this.#queue.length > 0) {
      const entry = this.#queue.shift()!;
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) {
        entry.reject(cancelledError());
        continue;
      }
      this.#active += 1;
      entry.resolve(this.#grant());
    }
  }
}

interface PerformanceRequestOptions {
  readonly measure?: boolean;
  readonly onTelemetry?: (telemetry: OperationTelemetry | undefined) => void;
}

interface DatasetCapabilitySeed {
  readonly adapterId: OfficialAdapterId;
  readonly sourceAccess: OfficialSourceAccess;
  readonly progressive: boolean;
  readonly maxSourceBytes: number;
  readonly multiTable: boolean;
  readonly presentation: boolean;
  readonly typedValues: boolean;
}

interface RangeSingleflight {
  readonly key: string;
  readonly datasetHandle: string;
  readonly tableId: string;
  readonly controller: AbortController;
  readonly callers: Set<symbol>;
  promise: Promise<BatchBacking>;
  settled: boolean;
  bytesRead: number;
  peakReservationBytes: number;
  sourceReads: number;
  sourceCacheHitBytes: number;
}

class Engine implements TabularkEngine {
  readonly #rpc: WorkerRpcClient;
  readonly #rangeCache: ByteLruCache<BatchBacking>;
  readonly #rangeSingleflight = new Map<string, RangeSingleflight>();
  readonly #limits: MemoryBudgetLimits;
  readonly #maxArrayBufferBytes: number;
  readonly #adapters: ReadonlyMap<OfficialAdapterId, AdapterRegistration>;
  readonly #sourceStaging: SourceStagingLimiter;
  #retainedSourceBytes = 0;
  readonly #sourceReaders = new Map<string, SourceReaderRecord>();
  readonly #datasetSources = new Map<string, string>();
  readonly #openingSources = new Set<AbortController>();
  #nextSourceHandle = 1;
  readonly #sessions = new Map<string, DatasetSessionImpl>();
  readonly #orphanEvents = new Map<string, ProtocolEvent[]>();
  readonly #performanceListeners = new Set<(sample: PerformanceSample) => void>();
  readonly #performanceQueue: PerformanceSample[] = [];
  #orphanEventCount = 0;
  #closed = false;
  #sourceCleanupPromise: Promise<void> | undefined;

  constructor(
    rpc: WorkerRpcClient,
    limits: MemoryBudgetLimits,
    adapters: readonly AdapterRegistration[],
  ) {
    this.#rpc = rpc;
    this.#limits = limits;
    this.#sourceStaging = new SourceStagingLimiter(limits.mainThreadSourceBytes);
    this.#rangeCache = new ByteLruCache(
      Math.min(limits.mainThreadRangeCacheBytes, limits.mainThreadRetainedBytes),
      {
      maxEntries: Math.min(
        MAX_BATCH_CACHE_ENTRIES,
        Math.max(1, Math.floor(
          Math.min(limits.mainThreadRangeCacheBytes, limits.mainThreadRetainedBytes)
            / MIN_BATCH_CACHE_ENTRY_BYTES,
        )),
      ),
      minimumEntryBytes: MIN_BATCH_CACHE_ENTRY_BYTES,
      },
    );
    this.#maxArrayBufferBytes = limits.maxArrayBufferBytes;
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  subscribePerformance(listener: (sample: PerformanceSample) => void): Unsubscribe {
    if (this.#closed) {
      throw closedError("Engine");
    }
    if (typeof listener !== "function") {
      throw invalidArgument("performance listener must be a function");
    }
    this.#performanceListeners.add(listener);
    // Samples are delivered synchronously while an operation is active. Any
    // bounded queue entries are drained for a subscriber added after a turn.
    for (const sample of this.#performanceQueue.splice(0)) {
      safelyCall(listener, sample);
    }
    return () => this.#performanceListeners.delete(listener);
  }

  /** Emits a privacy-preserving sample only while at least one listener exists. */
  #emitPerformanceSample(
    stage: string,
    startedAt: number | undefined,
    options: Partial<Pick<PerformanceSample, "bytesRead" | "cacheHit" | "peakReservationBytes" | "sourceReads" | "sourceCacheHitBytes">> = {},
  ): void {
    // If no operation was being measured, avoid even taking a timestamp or
    // allocating a sample. A listener can still unsubscribe while an already
    // measured operation settles; retain that terminal sample in the bounded
    // queue until a future subscriber drains it.
    if (this.#performanceListeners.size === 0 && startedAt === undefined) {
      return;
    }
    const durationMs = startedAt === undefined
      ? 0
      : Math.max(0, finitePerformanceNow() - startedAt);
    const sample = Object.freeze({
      stage: sanitizePerformanceStage(stage),
      durationMs,
      bytesRead: nonNegativeSafeQuantity(options.bytesRead),
      cacheHit: options.cacheHit === true,
      peakReservationBytes: nonNegativeSafeQuantity(options.peakReservationBytes),
      sourceReads: nonNegativeSafeQuantity(options.sourceReads),
      sourceCacheHitBytes: nonNegativeSafeQuantity(options.sourceCacheHitBytes),
    });
    // Keep a bounded history for a listener that is temporarily reentrant or
    // detached while a request settles. No source/path/protocol data enters it.
    if (this.#performanceListeners.size === 0) {
      if (this.#performanceQueue.length >= MAX_PERFORMANCE_SAMPLES) {
        this.#performanceQueue.shift();
      }
      this.#performanceQueue.push(sample);
      return;
    }
    for (const listener of this.#performanceListeners) {
      safelyCall(listener, sample);
    }
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
    }, (message) => {
      if (engine !== undefined) {
        engine.#handleSourceBrokerMessage(message);
      }
    });
    engine = new Engine(rpc, normalized.limits, normalized.adapters);
    try {
      const hello = await rpc.request<unknown>(
        "hello",
        {
          clientName: "tabulark-js",
          adapters: normalized.adapters.map(({ id }) => Object.freeze({ id })),
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
    source: Blob | ArrayBuffer | RangeSource,
    options: OpenSourceOptions<Options>,
  ): Promise<DatasetSession> {
    this.#assertOpen();
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let bytesRead = 0;
    let peakReservationBytes = 0;
    let sourceReads = 0;
    let sourceCacheHitBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (!telemetry) return;
      // `open()` spans the source request and the table-list handshake. Each
      // private Worker telemetry envelope is per request, so add source bytes
      // rather than taking the largest individual read (which would silently
      // under-report a footer plus metadata scan).
      bytesRead = addPerformanceBytes(bytesRead, telemetry.bytesRead);
      peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
      sourceReads = addPerformanceBytes(sourceReads, telemetry.sourceReads);
      sourceCacheHitBytes = addPerformanceBytes(sourceCacheHitBytes, telemetry.sourceCacheHitBytes);
    };
    try {
      const rangeSourceInput = isRangeSource(source);
      const normalizedOptions = normalizeOpenOptions(
        options,
        this.#adapters,
        rangeSourceInput ? undefined : inferSourceName(source),
        rangeSourceInput,
      );
      // Capture the logical source length before an optional ArrayBuffer
      // transfer. Structured-cloning with a transfer list detaches the caller's
      // buffer, so reading `byteLength` after the Worker request would make the
      // capability seed disagree with the source that the Worker actually saw.
      // Keep this capture inside the validated source branches so malformed
      // JavaScript values still produce the public INVALID_ARGUMENT error.
      let sourceBytes: number;
      let sourcePayload: Blob | ArrayBuffer | Record<string, unknown> = source as Blob | ArrayBuffer;
      let sourceRecord: SourceReaderRecord | undefined;
      const transfer: Transferable[] = [];
      if (rangeSourceInput) {
        if (options.sourceMode !== undefined || options.transferInput !== undefined) {
          throw invalidArgument("sourceMode and transferInput do not apply to RangeSource inputs");
        }
        const openController = new AbortController();
        this.#openingSources.add(openController);
        const signal = combineAbortSignals(options.signal, openController.signal);
        let reader: RangeSourceReader;
        try {
          const openOptions = attachRangeSourceHostReservations({
            signal,
            maxSourceBytes: MAX_RANGE_SOURCE_BYTES,
            maxStagingBytes: sourceStagingBudget(this.#limits),
          }, {
            reserveStaging: async (bytes, reservationSignal) => {
              const permit = await this.#sourceStaging.acquire(bytes, reservationSignal);
              return permit.release;
            },
            reserveRetained: (bytes) => this.#reserveRetainedSourceBytes(bytes),
          });
          reader = await openRangeReaderWithCancellation(source, openOptions, signal);
        } catch (error) {
          if (this.#closed) throw closedError("Engine");
          if (options.signal?.aborted || openController.signal.aborted) throw cancelledError();
          throw normalizeRangeSourceOpenError(error);
        } finally {
          this.#openingSources.delete(openController);
        }
        if (this.#closed) {
          await closeRangeReaderBestEffort(reader);
          throw closedError("Engine");
        }
        if (options.signal?.aborted || openController.signal.aborted) {
          await closeRangeReaderBestEffort(reader);
          throw cancelledError();
        }
        const readerValue: unknown = reader;
        let reportedSize: unknown;
        try {
          reportedSize = isRecord(readerValue) ? readerValue.size : undefined;
        } catch {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid reader");
        }
        if (typeof reportedSize === "number" && reportedSize > MAX_RANGE_SOURCE_BYTES) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RESOURCE_LIMIT", "The range source exceeds the addressable byte limit", {
            details: {
              resource: "source-address-space",
              requiredBytes: Number.isSafeInteger(reportedSize)
                ? reportedSize
                : Number.MAX_SAFE_INTEGER,
              availableBytes: MAX_RANGE_SOURCE_BYTES,
            },
          });
        }
        if (!validateRangeSourceReader(readerValue)) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid reader");
        }
        try {
          // Snapshot validation stays on the host.  The opaque validator is
          // deliberately never serialized into the Worker descriptor.
          normalizeRangeSourceSnapshot(reader.snapshot);
        } catch (error) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid snapshot");
        }
        let readerMaxConcurrency: number | undefined;
        try {
          // Capture immutable reader facts before publishing the host handle.
          // A stateful/hostile getter must not throw after registration and
          // leave a reader that the lifecycle cleanup cannot reach.
          sourceBytes = reader.size;
          readerMaxConcurrency = reader.maxConcurrency;
        } catch {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid reader");
        }
        if (!isSafeNonNegativeInteger(sourceBytes)) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid reader");
        }
        if (readerMaxConcurrency !== undefined
          && (!Number.isSafeInteger(readerMaxConcurrency)
            || readerMaxConcurrency < 1
            || readerMaxConcurrency > 4)) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RUNTIME_FAILURE", "The range source returned an invalid reader");
        }
        if (sourceBytes > MAX_RANGE_SOURCE_BYTES) {
          await closeRangeReaderBestEffort(readerValue);
          throw new TabularkError("RESOURCE_LIMIT", "The range source exceeds the addressable byte limit", {
            details: { resource: "source-address-space", requiredBytes: sourceBytes, availableBytes: MAX_RANGE_SOURCE_BYTES },
          });
        }
        const handle = this.#allocateSourceHandle();
        sourceRecord = {
          handle,
          size: sourceBytes,
          maxConcurrency: readerMaxConcurrency ?? 1,
          reader,
          pending: new Map(),
          concurrency: new SourceReadConcurrencyLimiter(readerMaxConcurrency ?? 1),
          closed: false,
        };
        this.#sourceReaders.set(handle, sourceRecord);
        sourcePayload = Object.freeze({
          kind: "range",
          handle,
          size: sourceBytes,
          ...(readerMaxConcurrency === undefined ? {} : { maxConcurrency: readerMaxConcurrency }),
        });
      } else if (source instanceof ArrayBuffer) {
        if (normalizedOptions.sourceMode === "large") {
          throw invalidArgument("sourceMode large requires a local Blob or File source");
        }
        sourceBytes = source.byteLength;
        if (source.byteLength > this.#maxArrayBufferBytes) {
          throw new TabularkError(
            "RESOURCE_LIMIT",
            `ArrayBuffer sources larger than ${this.#maxArrayBufferBytes} bytes must be supplied as a Blob`,
            {
              details: {
                resource: "source-staging",
                requiredBytes: source.byteLength,
                availableBytes: this.#maxArrayBufferBytes,
              },
            },
          );
        }
        if (options.transferInput === true) {
          transfer.push(source);
        }
      } else if (!(source instanceof Blob)) {
        throw invalidArgument("source must be a Blob, File, or ArrayBuffer");
      } else {
        sourceBytes = source.size;
        if (options.transferInput === true) {
          throw invalidArgument("transferInput may only be true for an ArrayBuffer source");
        }
        const sourceSize = sourceBytes;
        if (
          normalizedOptions.sourceMode === "large"
          && (!Number.isSafeInteger(sourceSize) || sourceSize < 0 || sourceSize > MAX_LARGE_SOURCE_BYTES)
        ) {
          throw largeSourceLimitError(sourceSize);
        }
        if (
          (normalizedOptions.adapter.id === "tabulark:arrow-ipc"
            || normalizedOptions.adapter.id === "tabulark:excel")
          && Number.isSafeInteger(sourceSize)
          && sourceSize > MAX_LARGE_SOURCE_BYTES
        ) {
          // The range-capable Rust runtimes accept 4 GiB-1 for a remote
          // descriptor. Keep the established local Arrow/Excel Blob contract
          // at the exact 2 GiB boundary regardless of sourceMode.
          throw largeSourceLimitError(sourceSize);
        }
      }

      let dataset: { datasetHandle: string };
      try {
        const opened = await this.#rpc.request<unknown>(
          "openSource",
          {
            source: sourcePayload,
            adapterId: normalizedOptions.adapter.id,
            options: normalizedOptions.options,
            ...(normalizedOptions.isRangeSource ? {} : { sourceMode: normalizedOptions.sourceMode }),
          },
          "dataset",
          {
            ...(options.signal ? { signal: options.signal } : {}),
            transfer,
            ...(startedAt === undefined ? {} : { measure: true, onTelemetry }),
          },
        );
        if (
          !isRecord(opened)
          || typeof opened.datasetHandle !== "string"
          || opened.datasetHandle.length === 0
        ) {
          throw this.#terminateForProtocolFailure("Worker returned an invalid dataset handle");
        }
        dataset = { datasetHandle: opened.datasetHandle };
        if (sourceRecord !== undefined) {
          // The Worker now owns the dataset lifetime; retain the host reader
          // until its explicit close message or a terminal engine failure.
          sourceRecord = this.#sourceReaders.get(sourceRecord.handle);
          if (sourceRecord !== undefined) {
            this.#datasetSources.set(dataset.datasetHandle, sourceRecord.handle);
          }
        }
      } catch (error) {
        if (sourceRecord !== undefined) {
          await this.#closeSourceReader(sourceRecord.handle);
        }
        throw error;
      }

      try {
        const tableResult = await this.#rpc.request<unknown>(
          "listTables",
          { datasetHandle: dataset.datasetHandle },
          "tables",
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(startedAt === undefined ? {} : { measure: true, onTelemetry }),
          },
        );
        if (options.signal?.aborted) {
          throw cancelledError();
        }
        const tableDescriptors = normalizeDescriptors(tableResult);
        const session = new DatasetSessionImpl(
          this,
          dataset.datasetHandle,
          tableDescriptors,
          createDatasetCapabilitySeed(
            normalizedOptions.adapter.id,
            normalizedOptions.options,
            tableDescriptors,
            normalizedOptions.sourceMode,
            this.#stagedSourceLimit(normalizedOptions.adapter.id),
            normalizedOptions.isRangeSource,
          ),
        );
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
        if (sourceRecord !== undefined) {
          await this.#closeSourceReader(sourceRecord.handle);
        }
        throw terminalError ?? error;
      }
    } finally {
      this.#emitPerformanceSample("open", startedAt, {
        bytesRead,
        peakReservationBytes,
        sourceReads,
        sourceCacheHitBytes,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#sourceCleanupPromise;
      return;
    }
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    this.#closed = true;
    this.#sourceStaging.close();
    for (const controller of this.#openingSources) controller.abort();
    for (const session of this.#sessions.values()) {
      session.closeLocally();
    }
    this.#sessions.clear();
    this.#abortRangeSingleflights();
    this.#rangeCache.clear();
    this.#clearOrphanEvents();
    await this.#closeAllSourceReaders();
    try {
      await this.#rpc.shutdown(
        LIFECYCLE_CLOSE_TIMEOUT_MS,
        startedAt === undefined ? {} : { measure: true, onTelemetry },
      );
    } finally {
      // A close (including a shutdown failure) has exactly one terminal sample.
      this.#emitPerformanceSample("close", startedAt, { peakReservationBytes });
      this.#performanceListeners.clear();
    }
  }

  dispose(): Promise<void> {
    return this.close();
  }

  async openTable(session: DatasetSessionImpl, tableId: string): Promise<TableHandle> {
    this.#assertOpen();
    session.assertOpen();
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    if (!session.tables.some((table) => table.id === tableId)) {
      const error = invalidArgument(`Unknown table: ${tableId}`);
      this.#emitPerformanceSample("open-table", startedAt, { peakReservationBytes });
      throw error;
    }
    let tableHandle: string | undefined;
    try {
      const table = await this.#rpc.request<{ tableHandle: string }>(
        "openTable",
        { datasetHandle: session.handle, tableId },
        "table",
        startedAt === undefined ? {} : { measure: true, onTelemetry },
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
        startedAt === undefined ? {} : { measure: true, onTelemetry },
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
      this.#emitPerformanceSample("open-table", startedAt, { peakReservationBytes });
      return handle;
    } catch (error) {
      if (tableHandle !== undefined) {
        await this.#discardOpenedTable(tableHandle);
      }
      this.#emitPerformanceSample("open-table", startedAt, { peakReservationBytes });
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
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let bytesRead = 0;
    let cacheHit = false;
    let peakReservationBytes = 0;
    let sourceReads = 0;
    let sourceCacheHitBytes = 0;
    let flight: RangeSingleflight | undefined;
    try {
      const normalized = validateRange(request);
      if (options.signal?.aborted) {
        throw cancelledError();
      }
      const metadata = table.metadata;
      const displayOnly = isDisplayOnlyRead(options);
      const key = rangeCacheKey(
        table.datasetHandle,
        metadata.tableId,
        metadata.revision,
        metadata.schema.version,
        normalized,
        displayOnly ? "display" : undefined,
      );
      const cached = this.#rangeCache.get(key);
      if (cached) {
        cacheHit = true;
        return new ColumnarTableBatch(cached);
      }
      flight = this.#rangeSingleflight.get(key);
      if (!flight) {
        flight = this.#createRangeSingleflight(
          table,
          normalized,
          key,
          metadata.revision,
          metadata.schema.version,
          startedAt !== undefined,
          displayOnly,
        );
      }
      const backing = await this.#joinRangeSingleflight(flight, options.signal);
      bytesRead = flight.bytesRead;
      peakReservationBytes = flight.peakReservationBytes;
      sourceReads = flight.sourceReads;
      sourceCacheHitBytes = flight.sourceCacheHitBytes;
      this.#assertOpen();
      table.assertOpen();
      return new ColumnarTableBatch(backing);
    } finally {
      if (flight) {
        bytesRead = flight.bytesRead;
        peakReservationBytes = flight.peakReservationBytes;
        sourceReads = flight.sourceReads;
        sourceCacheHitBytes = flight.sourceCacheHitBytes;
      }
      this.#emitPerformanceSample("read-range", startedAt, {
        bytesRead,
        cacheHit,
        peakReservationBytes,
        sourceReads,
        sourceCacheHitBytes,
      });
    }
  }

  #createRangeSingleflight(
    table: TableHandleImpl,
    range: RangeRequest,
    key: string,
    revision: number,
    schemaVersion: number,
    measure: boolean,
    displayOnly: boolean,
  ): RangeSingleflight {
    const controller = new AbortController();
    const flight: RangeSingleflight = {
      key,
      datasetHandle: table.datasetHandle,
      tableId: table.metadata.tableId,
      controller,
      callers: new Set(),
      promise: undefined as unknown as Promise<BatchBacking>,
      settled: false,
      bytesRead: 0,
      peakReservationBytes: 0,
      sourceReads: 0,
      sourceCacheHitBytes: 0,
    };
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (!telemetry) return;
      flight.bytesRead = addPerformanceBytes(flight.bytesRead, telemetry.bytesRead);
      flight.peakReservationBytes = Math.max(
        flight.peakReservationBytes,
        telemetry.peakReservationBytes,
      );
      flight.sourceReads = addPerformanceBytes(flight.sourceReads, telemetry.sourceReads);
      flight.sourceCacheHitBytes = addPerformanceBytes(
        flight.sourceCacheHitBytes,
        telemetry.sourceCacheHitBytes,
      );
    };
    flight.promise = this.#rpc.request<WireTableBatch>(
      "readRange",
      {
        tableHandle: table.handle,
        range,
        ...(displayOnly ? { displayOnly: true } : {}),
      },
      "batch",
      {
        signal: controller.signal,
        ...(measure ? { measure: true, onTelemetry } : {}),
      },
    ).then((batch) => {
      const backing = this.#validateBatchBacking(
        batch,
        table.metadata.tableId,
        revision,
        schemaVersion,
        range,
      );
      // Incomplete batches end at a progressive indexed-prefix boundary. They
      // are valid for this instant but must not hide subsequently indexed rows.
      if (
        backing.complete
        && backing.revision === revision
        && backing.schemaVersion === schemaVersion
        && table.metadata.revision === revision
        && table.metadata.schema.version === schemaVersion
        && !table.datasetClosed
      ) {
        this.#rangeCache.set(
          key,
          backing,
          wireBatchByteLength(backing),
          this.#availableRetainedCacheBytes(),
        );
      }
      return backing;
    }).finally(() => {
      flight.settled = true;
      if (this.#rangeSingleflight.get(key) === flight) {
        this.#rangeSingleflight.delete(key);
      }
    });
    this.#rangeSingleflight.set(key, flight);
    return flight;
  }

  async #joinRangeSingleflight(
    flight: RangeSingleflight,
    signal: AbortSignal | undefined,
  ): Promise<BatchBacking> {
    if (signal?.aborted) {
      if (!flight.settled && flight.callers.size === 0) {
        if (this.#rangeSingleflight.get(flight.key) === flight) {
          this.#rangeSingleflight.delete(flight.key);
        }
        flight.controller.abort();
      }
      throw cancelledError();
    }
    const caller = Symbol("range-caller");
    flight.callers.add(caller);
    let abort: (() => void) | undefined;
    try {
      if (!signal) {
        return await flight.promise;
      }
      const cancellation = new Promise<never>((_resolve, reject) => {
        abort = () => reject(cancelledError());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return await Promise.race([flight.promise, cancellation]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      flight.callers.delete(caller);
      if (!flight.settled && flight.callers.size === 0) {
        if (this.#rangeSingleflight.get(flight.key) === flight) {
          this.#rangeSingleflight.delete(flight.key);
        }
        // WorkerRpcClient owns the one protocol cancel message. Aborting this
        // shared controller is idempotent even when several callers cancel in
        // the same task turn.
        flight.controller.abort();
      }
    }
  }

  #validateBatchBacking(
    batch: WireTableBatch,
    tableId: string,
    revision: number,
    schemaVersion: number,
    requested: RangeRequest,
  ): BatchBacking {
    if (
      !isRecord(batch)
      || batch.tableId !== tableId
      || !Number.isSafeInteger(batch.revision)
      || batch.revision < revision
      || !Number.isSafeInteger(batch.schemaVersion)
      || batch.schemaVersion < schemaVersion
      || !isReturnedRangeWithin(batch.range, requested)
    ) {
      throw this.#terminateForProtocolFailure("Worker returned a stale or out-of-range batch");
    }
    try {
      const backing = createBatchBacking(batch);
      // Validate every layout descriptor once before the backing can enter the
      // cache. Subsequent facades reuse the same inaccessible ArrayBuffers.
      new ColumnarTableBatch(backing);
      return backing;
    } catch {
      throw this.#terminateForProtocolFailure("Worker returned an invalid batch backing");
    }
  }

  async getPresentation(table: TableHandleImpl): Promise<TablePresentation | null> {
    this.#assertOpen();
    table.assertOpen();
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    try {
      const value = await this.#rpc.request<unknown>(
        "getPresentation",
        { tableHandle: table.handle },
        "presentation",
        startedAt === undefined ? {} : { measure: true, onTelemetry },
      );
      this.#assertOpen();
      table.assertOpen();
      return normalizePresentationWire(value, table.metadata);
    } finally {
      this.#emitPerformanceSample("presentation", startedAt, { peakReservationBytes });
    }
  }

  async readPresentationRange(
    table: TableHandleImpl,
    request: RangeRequest,
    options: ReadRangeOptions,
  ): Promise<PresentationRange | null> {
    this.#assertOpen();
    table.assertOpen();
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    try {
      const normalized = validateRange(request);
      if (options.signal?.aborted) {
        throw cancelledError();
      }
      const value = await this.#rpc.request<unknown>(
        "readPresentationRange",
        { tableHandle: table.handle, range: normalized },
        "presentationRange",
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(startedAt === undefined ? {} : { measure: true, onTelemetry }),
        },
      );
      this.#assertOpen();
      table.assertOpen();
      return normalizePresentationRangeWire(value, table.metadata, normalized);
    } finally {
      this.#emitPerformanceSample("presentation-range", startedAt, { peakReservationBytes });
    }
  }

  async closeTable(table: TableHandleImpl): Promise<void> {
    if (table.closed) {
      return;
    }
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    table.closeLocally();
    if (this.#closed) {
      this.#emitPerformanceSample("close-table", startedAt, { peakReservationBytes });
      return;
    }
    try {
      await this.#requestRemoteClose(
        "closeTable",
        { tableHandle: table.handle },
        startedAt === undefined ? {} : { measure: true, onTelemetry },
      );
    } finally {
      this.#emitPerformanceSample("close-table", startedAt, { peakReservationBytes });
    }
  }

  clearDatasetCache(datasetHandle: string): void {
    this.#rangeCache.deleteWhere((key) => rangeCacheKeyBelongsToDataset(key, datasetHandle));
    for (const flight of [...this.#rangeSingleflight.values()]) {
      if (flight.datasetHandle !== datasetHandle || flight.settled) continue;
      if (this.#rangeSingleflight.get(flight.key) === flight) {
        this.#rangeSingleflight.delete(flight.key);
      }
      flight.controller.abort();
    }
  }

  updateTableCacheVersion(
    datasetHandle: string,
    tableId: string,
    revision: number,
    schemaVersion: number,
  ): void {
    this.#rangeCache.deleteWhere((key) => (
      rangeCacheKeyBelongsToTable(key, datasetHandle, tableId)
      && !rangeCacheKeyMatchesVersion(key, revision, schemaVersion)
    ));
  }

  #abortRangeSingleflights(): void {
    for (const flight of this.#rangeSingleflight.values()) {
      if (!flight.settled) flight.controller.abort();
    }
    this.#rangeSingleflight.clear();
  }

  async closeSession(session: DatasetSessionImpl): Promise<void> {
    if (session.closed) {
      return;
    }
    const startedAt = this.#performanceListeners.size > 0 ? finitePerformanceNow() : undefined;
    let peakReservationBytes = 0;
    const onTelemetry = (telemetry: OperationTelemetry | undefined): void => {
      if (telemetry) peakReservationBytes = Math.max(peakReservationBytes, telemetry.peakReservationBytes);
    };
    session.closeLocally();
    if (this.#closed) {
      this.#sessions.delete(session.handle);
      await this.#closeDatasetSource(session.handle);
      this.#emitPerformanceSample("close-session", startedAt, { peakReservationBytes });
      return;
    }
    try {
      await this.#requestRemoteClose(
        "closeSource",
        { datasetHandle: session.handle },
        startedAt === undefined ? {} : { measure: true, onTelemetry },
      );
    } finally {
      this.#sessions.delete(session.handle);
      this.#deleteOrphanEvents(session.handle);
      await this.#closeDatasetSource(session.handle);
      this.#emitPerformanceSample("close-session", startedAt, { peakReservationBytes });
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw closedError("Engine");
    }
  }

  /** Mirrors the Worker's conservative auto-mode Excel source ceiling. */
  #stagedSourceLimit(adapterId: OfficialAdapterId): number {
    if (adapterId !== "tabulark:excel") {
      return this.#maxArrayBufferBytes;
    }
    const totalWeight = [...this.#adapters.values()].reduce(
      (total, adapter) => total + officialAdapterManifestEntry(adapter.id).resources.runtimeWeight,
      0,
    );
    const weight = officialAdapterManifestEntry(adapterId).resources.runtimeWeight;
    const runtimeBudget = Math.max(
      1,
      Math.floor(this.#limits.adapterRuntimePoolBytes * weight / Math.max(1, totalWeight)),
    );
    // `maxArrayBufferBytes` is the public host bound. Auto mode also respects
    // the adapter's weighted runtime budget; explicit large mode is range-backed.
    return Math.min(this.#maxArrayBufferBytes, runtimeBudget);
  }

  #allocateSourceHandle(): string {
    // This is an opaque process-local capability. It intentionally contains no
    // URL, validator, source name, or user-controlled text.
    return `s${(this.#nextSourceHandle++).toString(36)}`;
  }

  /** Shares the retained 12.5% slice between logical batches and HTTP fallback bodies. */
  #reserveRetainedSourceBytes(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TabularkError("RESOURCE_LIMIT", "The source retained-byte request is invalid", {
        details: {
          resource: "source-retained",
          requiredBytes: Number.MAX_SAFE_INTEGER,
          availableBytes: this.#availableRetainedCacheBytes(),
        },
      });
    }
    if (this.#closed) throw closedError("Engine");
    const availableBytes = this.#limits.mainThreadRetainedBytes - this.#retainedSourceBytes;
    if (bytes > availableBytes) {
      throw new TabularkError("RESOURCE_LIMIT", "The source exceeds the retained-byte budget", {
        details: { resource: "source-retained", requiredBytes: bytes, availableBytes },
      });
    }
    // Retained fallback data has a live reader and cannot be evicted. Logical
    // batches are an LRU, so reclaim those first and keep the aggregate slice
    // within the engine budget without waiting for another dataset to close.
    this.#rangeCache.trimTo(availableBytes - bytes);
    this.#retainedSourceBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#retainedSourceBytes = Math.max(0, this.#retainedSourceBytes - bytes);
    };
  }

  #availableRetainedCacheBytes(): number {
    return Math.max(0, this.#limits.mainThreadRetainedBytes - this.#retainedSourceBytes);
  }

  #handleSourceBrokerMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "source-close") {
      if (typeof value.sourceHandle === "string") {
        void this.#closeSourceReader(value.sourceHandle);
      }
      return;
    }
    if (value.type === "source-read-cancel") {
      if (typeof value.sourceHandle !== "string" || typeof value.requestId !== "string") return;
      const record = this.#sourceReaders.get(value.sourceHandle);
      record?.pending.get(value.requestId)?.abort();
      return;
    }
    if (value.type !== "source-read") return;
    const sourceHandle = value.sourceHandle;
    const requestId = value.requestId;
    const offset = value.offset;
    const length = value.length;
    if (
      typeof sourceHandle !== "string"
      || typeof requestId !== "string"
      || requestId.length === 0
      || requestId.length > 256
      || !isSafeNonNegativeInteger(offset)
      || !isSafeNonNegativeInteger(length)
    ) {
      // Without a valid pair of opaque identifiers there is no safe pending
      // entry to settle. Treat the private broker message as a protocol fault
      // instead of leaving a Worker request waiting forever.
      this.#rpc.terminate(
        new TabularkError("PROTOCOL_INCOMPATIBLE", "The Worker sent an invalid source read request"),
        true,
      );
      return;
    }
    const record = this.#sourceReaders.get(sourceHandle);
    if (record === undefined || record.closed) {
      this.#postSourceFailure(requestId, sourceHandle, offset, length, "HANDLE_CLOSED");
      return;
    }
    if (record.pending.has(requestId)) {
      this.#rpc.terminate(
        new TabularkError("PROTOCOL_INCOMPATIBLE", "The Worker reused a source request identifier"),
        true,
      );
      return;
    }
    if (
      offset > record.size
      || length > record.size - offset
    ) {
      this.#postSourceFailure(requestId, sourceHandle, offset, length, "RANGE_UNSUPPORTED");
      return;
    }
    if (length > sourceStagingBudget(this.#limits)) {
      this.#postSourceFailure(requestId, sourceHandle, offset, length, "RESOURCE_LIMIT", false, {
        resource: "source-staging",
        requiredBytes: length,
        availableBytes: sourceStagingBudget(this.#limits),
      });
      return;
    }
    const controller = new AbortController();
    record.pending.set(requestId, controller);
    this.#runSourceRead(record, requestId, sourceHandle, offset, length, controller);
  }

  /** Admits one bounded host buffer, then performs and settles the provider read. */
  #runSourceRead(
    record: SourceReaderRecord,
    requestId: string,
    sourceHandle: string,
    offset: number,
    length: number,
    controller: AbortController,
  ): void {
    void (async () => {
      let concurrencyRelease: (() => void) | undefined;
      let stagingPermit: SourceStagingPermit | undefined;
      try {
        concurrencyRelease = await record.concurrency.acquire(controller.signal);
        stagingPermit = await this.#sourceStaging.acquire(length, controller.signal);
        // A queued request may have been cancelled or its dataset may have
        // closed before staging became available. Do not invoke user code in
        // that case; the Worker-side cancellation already settled its wait.
        if (
          record.closed
          || record.pending.get(requestId) !== controller
          || controller.signal.aborted
        ) {
          return;
        }
        const value = await Promise.resolve().then(() => record.reader.read(
          { offset, length },
          { signal: controller.signal },
        ));
        // A cancelled/closed broker request no longer has a Worker waiter;
        // discard a late provider result instead of transferring bytes into
        // a dead operation or exposing a stale snapshot response.
        if (
          record.closed
          || record.pending.get(requestId) !== controller
          || controller.signal.aborted
        ) {
          return;
        }
        // Validate the provider's reported byte length before copying. A
        // hostile reader can otherwise return a very large backing buffer;
        // copying it first would temporarily exceed the aggregate staging
        // reservation even though the request itself was bounded.
        const buffer = copyExactRangeBytes(value, length);
        this.#rpc.postMessage({
          type: "source-read-result",
          requestId,
          sourceHandle,
          offset,
          length,
          buffer,
        }, [buffer]);
      } catch (error) {
        if (!record.closed && record.pending.get(requestId) === controller) {
          const normalized = normalizeSourceProviderError(error);
          this.#postSourceFailure(
            requestId,
            sourceHandle,
            offset,
            length,
            normalized.code,
            normalized.retryable,
          );
          if (normalized.code === "SOURCE_CHANGED") {
            void this.#closeSourceReader(sourceHandle);
          }
        }
      } finally {
        stagingPermit?.release();
        concurrencyRelease?.();
        if (record.pending.get(requestId) === controller) record.pending.delete(requestId);
      }
    })();
  }

  #postSourceFailure(
    requestId: unknown,
    sourceHandle: unknown,
    offset: unknown,
    length: unknown,
    code: string,
    retryable = false,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    if (typeof requestId !== "string" || typeof sourceHandle !== "string") return;
    this.#rpc.postMessage({
      type: "source-read-failure",
      requestId,
      sourceHandle,
      ...(isSafeNonNegativeInteger(offset) ? { offset } : {}),
      ...(isSafeNonNegativeInteger(length) ? { length } : {}),
      error: {
        code: sourceErrorCode(code),
        message: sourceErrorMessage(code),
        retryable,
        ...(details === undefined ? {} : { details }),
      },
    });
  }

  async #closeDatasetSource(datasetHandle: string): Promise<void> {
    const handle = this.#datasetSources.get(datasetHandle);
    if (handle !== undefined) {
      this.#datasetSources.delete(datasetHandle);
      await this.#closeSourceReader(handle);
    }
  }

  async #closeSourceReader(handle: string): Promise<void> {
    const record = this.#sourceReaders.get(handle);
    if (record === undefined || record.closed) return;
    record.closed = true;
    this.#sourceReaders.delete(handle);
    for (const controller of record.pending.values()) controller.abort();
    record.pending.clear();
    record.concurrency.close();
    await closeRangeReaderBestEffort(record.reader);
  }

  async #closeAllSourceReaders(): Promise<void> {
    if (this.#sourceCleanupPromise !== undefined) {
      await this.#sourceCleanupPromise;
      return;
    }
    this.#sourceCleanupPromise = (async () => {
      for (const controller of this.#openingSources) controller.abort();
      this.#datasetSources.clear();
      await Promise.all([...this.#sourceReaders.keys()].map((handle) => this.#closeSourceReader(handle)));
    })();
    await this.#sourceCleanupPromise;
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
    if (event.event === "runtimeError" && !event.tableHandle && session.closed) {
      // A source validator failure emits runtimeError before the Worker's
      // closed event. Release the host reader immediately even if the latter
      // is lost during Worker termination.
      void this.#closeDatasetSource(handle);
    }
    if (event.event === "closed" && !event.tableHandle && session.closed) {
      this.#sessions.delete(handle);
      this.#deleteOrphanEvents(handle);
      void this.#closeDatasetSource(handle);
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
      await this.#closeDatasetSource(datasetHandle);
    }
  }

  async #requestRemoteClose(
    op: "closeTable" | "closeSource",
    payload: unknown,
    options: PerformanceRequestOptions = {},
  ): Promise<void> {
    try {
      await this.#rpc.request(op, payload, "acknowledged", {
        timeoutMs: LIFECYCLE_CLOSE_TIMEOUT_MS,
        ...options,
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
    this.#sourceStaging.close();
    for (const controller of this.#openingSources) controller.abort();
    this.#abortRangeSingleflights();
    this.#rangeCache.clear();
    this.#clearOrphanEvents();
    void this.#closeAllSourceReaders();
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
  readonly #diagnosticListeners = new Set<(diagnostic: TabularkDiagnostic) => void>();
  readonly #diagnostics: TabularkDiagnostic[] = [];
  readonly #capabilitySeed: DatasetCapabilitySeed;
  readonly #tableHandles = new Set<TableHandleImpl>();
  #observedTypedValues: boolean | undefined;
  #observedMultiTable: boolean | undefined;
  #observedProgressive: boolean | undefined;
  closed = false;
  terminalError: TabularkError | undefined;

  constructor(
    engine: Engine,
    handle: string,
    tables: readonly TableDescriptor[],
    capabilitySeed?: DatasetCapabilitySeed,
  ) {
    this.#engine = engine;
    this.handle = handle;
    this.tables = Object.freeze(tables.map((table) => Object.freeze({ ...table })));
    this.#capabilitySeed = capabilitySeed ?? createFallbackDatasetCapabilitySeed(this.tables);
  }

  openTable(tableId: string): Promise<TableHandle> {
    return this.#engine.openTable(this, tableId);
  }

  subscribe(listener: (event: DatasetEvent) => void): Unsubscribe {
    this.assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getDiagnostics(): readonly TabularkDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  subscribeDiagnostics(listener: (diagnostic: TabularkDiagnostic) => void): Unsubscribe {
    this.assertOpen();
    if (typeof listener !== "function") {
      throw invalidArgument("diagnostic listener must be a function");
    }
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  getCapabilities(): Readonly<DatasetCapabilities> {
    const openedTables = [...this.#tableHandles];
    const typedValues = openedTables.length > 0
      ? openedTables.every((table) => table.getCapabilities().typedValues)
      : this.#observedTypedValues ?? this.#capabilitySeed.typedValues;
    const multiTable = this.tables.length > 1
      || openedTables.some((table) => table.getCapabilities().multiTable)
      || this.#observedMultiTable === true
      || this.#capabilitySeed.multiTable;
    return Object.freeze({
      ...this.#capabilitySeed,
      progressive: this.#observedProgressive ?? this.#capabilitySeed.progressive,
      typedValues,
      multiTable,
    });
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
    this.#engine.clearDatasetCache(this.handle);
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
    this.#engine.clearDatasetCache(this.handle);
    this.closed = true;
    this.terminalError = error;
    this.#recordDiagnostic(diagnosticFromError(error));
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
        this.#emit({
          type: "progress",
          progress: normalizeProgress(event.payload, event.tableId, event.revision),
        });
        break;
      case "metadata": {
        const metadata = normalizeMetadataWire(event.payload);
        this.#observedTypedValues = this.#observedTypedValues === undefined
          ? metadata.capabilities.typedValues
          : this.#observedTypedValues && metadata.capabilities.typedValues;
        if (this.#capabilitySeed.adapterId === "tabulark:arrow-ipc") {
          this.#observedProgressive = metadata.capabilities.randomAccess === "indexed-prefix";
        }
        this.#observedMultiTable = this.#observedMultiTable === true
          || metadata.capabilities.multiTable;
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
        const routedTable = event.tableHandle === undefined
          ? undefined
          : [...this.#tableHandles].find((table) => table.handle === event.tableHandle);
        this.#recordDiagnostic(diagnosticFromWarning(
          warning,
          event.tableId ?? routedTable?.metadata.tableId,
          event.revision ?? routedTable?.metadata.revision,
        ));
        this.#emit({ type: "warning", warning });
        for (const table of this.#tableHandles) {
          if (table.matchesWarning(warning) && !event.tableHandle) {
            const recordDiagnostic = event.tableId !== undefined
              && table.metadata.tableId === event.tableId;
            table.emitWarning(
              warning,
              recordDiagnostic,
              event.tableId,
              event.revision,
            );
          }
        }
        break;
      }
      case "runtimeError": {
        const error = errorFromWire(event.payload);
        if (event.tableHandle) {
          const routedTable = [...this.#tableHandles].find((table) => table.handle === event.tableHandle);
          this.#recordDiagnostic(diagnosticFromError(
            error,
            event.tableId ?? routedTable?.metadata.tableId,
            event.revision ?? routedTable?.metadata.revision,
          ));
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

  #recordDiagnostic(diagnostic: TabularkDiagnostic): void {
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) {
      this.#diagnostics.shift();
    }
    this.#diagnostics.push(diagnostic);
    for (const listener of this.#diagnosticListeners) {
      safelyCall(listener, diagnostic);
    }
  }
}

class TableHandleImpl implements TableHandle {
  readonly #engine: Engine;
  readonly #session: DatasetSessionImpl;
  readonly handle: string;
  #metadata: Readonly<TableMetadata>;
  readonly #listeners = new Set<(event: TableEvent) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: TabularkDiagnostic) => void>();
  readonly #diagnostics: TabularkDiagnostic[] = [];
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
    // Scan warnings can arrive before a caller opens a particular worksheet.
    // Seed only diagnostics explicitly routed to this logical table; a
    // dataset-level diagnostic must not be duplicated into every worksheet.
    for (const diagnostic of session.getDiagnostics()) {
      if (diagnostic.tableId === metadata.tableId) {
        this.#diagnostics.push(diagnostic);
      }
    }
  }

  get metadata(): Readonly<TableMetadata> {
    return this.#metadata;
  }

  get datasetHandle(): string {
    return this.#session.handle;
  }

  get datasetClosed(): boolean {
    return this.#session.closed;
  }

  readRange(request: RangeRequest, options: ReadRangeOptions = {}): Promise<TableBatch> {
    return this.#engine.readRange(this, request, options);
  }

  getPresentation(): Promise<TablePresentation | null> {
    return this.#engine.getPresentation(this);
  }

  readPresentationRange(
    request: RangeRequest,
    options: ReadRangeOptions = {},
  ): Promise<PresentationRange | null> {
    return this.#engine.readPresentationRange(this, request, options);
  }

  subscribe(listener: (event: TableEvent) => void): Unsubscribe {
    this.assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getDiagnostics(): readonly TabularkDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  subscribeDiagnostics(listener: (diagnostic: TabularkDiagnostic) => void): Unsubscribe {
    this.assertOpen();
    if (typeof listener !== "function") {
      throw invalidArgument("diagnostic listener must be a function");
    }
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  getCapabilities(): Readonly<TableCapabilities> {
    const capabilities = this.#metadata.capabilities;
    // Preserve logical extension flags supplied by an adapter while excluding
    // names that would expose private transport/runtime implementation state.
    const logicalExtensions = Object.fromEntries(
      Object.entries(capabilities)
        .filter(([name, value]) => !isPrivateCapabilityName(name) && isLogicalCapabilityValue(value))
        .map(([name, value]) => [name, freezeLogicalCapabilityValue(value)]),
    );
    return Object.freeze({
      ...logicalExtensions,
      randomAccess: capabilities.randomAccess,
      typedValues: capabilities.typedValues,
      search: capabilities.search,
      sort: capabilities.sort,
      filter: capabilities.filter,
      multiTable: capabilities.multiTable,
    });
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
    this.closed = true;
    this.#session.removeTableHandle(this);
    this.#emit({ type: "closed" });
  }

  failLocally(error: TabularkError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#session.removeTableHandle(this);
    this.#recordDiagnostic(diagnosticFromError(error, this.metadata.tableId, this.metadata.revision));
    this.#emit({ type: "runtimeError", error });
    this.#emit({ type: "closed" });
  }

  updateMetadata(metadata: Readonly<TableMetadata>): void {
    if (this.closed) {
      return;
    }
    this.#engine.updateTableCacheVersion(
      this.#session.handle,
      metadata.tableId,
      metadata.revision,
      metadata.schema.version,
    );
    this.#metadata = metadata;
    this.#emit({ type: "metadata", metadata });
  }

  matchesWarning(warning: SourceWarning): boolean {
    return warning.handle === this.handle || warning.handle === this.#session.handle;
  }

  emitWarning(
    warning: SourceWarning,
    recordDiagnostic = true,
    tableId = this.metadata.tableId,
    revision = this.metadata.revision,
  ): void {
    if (!this.closed) {
      if (recordDiagnostic) {
        this.#recordDiagnostic(diagnosticFromWarning(
          warning,
          tableId,
          revision,
        ));
      }
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
        this.emitWarning(
          normalizeWarning(event.payload),
          true,
          event.tableId ?? this.metadata.tableId,
          event.revision ?? this.metadata.revision,
        );
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

  #recordDiagnostic(diagnostic: TabularkDiagnostic): void {
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) {
      this.#diagnostics.shift();
    }
    this.#diagnostics.push(diagnostic);
    for (const listener of this.#diagnosticListeners) {
      safelyCall(listener, diagnostic);
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
  rangeSource = false,
): NormalizedOpenOptions {
  if (!options || typeof options !== "object") {
    throw invalidArgument("open options are required");
  }
  if (options.transferInput !== undefined && typeof options.transferInput !== "boolean") {
    throw invalidArgument("transferInput must be a boolean");
  }
  const sourceMode = options.sourceMode === undefined ? "auto" : options.sourceMode;
  if (!isSourceMode(sourceMode)) {
    throw invalidArgument("sourceMode must be auto or large");
  }
  if (rangeSource && (options.sourceMode !== undefined || options.transferInput !== undefined)) {
    throw invalidArgument("sourceMode and transferInput do not apply to RangeSource inputs");
  }
  const selected = resolveOfficialAdapter(options.adapter);
  if (!selected) {
    throw invalidArgument("adapter must be an official frozen adapter descriptor");
  }
  const registered = adapters.get(selected.id);
  if (!registered) {
    throw invalidArgument(`Adapter ${selected.id} was not registered with this engine`);
  }
  const rawOptions = options.adapterOptions;
  if (rawOptions !== undefined && (!isRecord(rawOptions) || Array.isArray(rawOptions))) {
    throw invalidArgument("adapterOptions must be an object");
  }
  let normalized: Readonly<Record<string, unknown>>;
  switch (selected.id) {
    case "tabulark:delimited":
      normalized = normalizeDelimitedOptions(
        rawOptions as DelimitedAdapterOptions | undefined,
        inferredSourceName,
      );
      break;
    case "tabulark:arrow-ipc":
      normalized = normalizeArrowOptions(
        rawOptions as ArrowIpcAdapterOptions | undefined,
        inferredSourceName,
      );
      break;
    case "tabulark:parquet":
      normalized = normalizeParquetOptions(
        rawOptions as ParquetAdapterOptions | undefined,
        inferredSourceName,
      );
      break;
    case "tabulark:excel":
      normalized = normalizeExcelOptions(
        rawOptions as ExcelAdapterOptions | undefined,
        inferredSourceName,
      );
      break;
  }
  return {
    adapter: registered,
    options: normalized,
    sourceMode,
    isRangeSource: rangeSource,
  };
}

function largeSourceLimitError(requiredBytes: unknown): TabularkError {
  // Error details cross the public JS boundary as numbers. Clamp malformed or
  // rounded Blob sizes to a safe sentinel rather than exposing an unsafe
  // quantity that could not be represented reliably by a range request.
  const required = typeof requiredBytes === "number"
    && Number.isFinite(requiredBytes)
    && requiredBytes >= 0
    ? Math.min(Math.floor(requiredBytes), Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  return new TabularkError(
    "RESOURCE_LIMIT",
    `Large source mode supports Blob inputs up to ${MAX_LARGE_SOURCE_BYTES} bytes`,
    {
      details: {
        resource: "source-staging",
        requiredBytes: required,
        availableBytes: MAX_LARGE_SOURCE_BYTES,
      },
    },
  );
}

function normalizeDelimitedOptions(
  options: DelimitedAdapterOptions | undefined,
  inferredSourceName?: string,
): Readonly<Record<string, unknown>> {
  const raw = options ?? {};
  assertManifestKeys("tabulark:delimited", raw);
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
  assertManifestKeys("tabulark:arrow-ipc", raw);
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

function normalizeParquetOptions(
  options: ParquetAdapterOptions | undefined,
  inferredSourceName?: string,
): Readonly<Record<string, unknown>> {
  const raw = options ?? {};
  assertManifestKeys("tabulark:parquet", raw);
  const sourceName = normalizeSourceName(raw.sourceName ?? inferredSourceName);
  return Object.freeze(sourceName === undefined ? {} : { sourceName });
}

function normalizeExcelOptions(
  options: ExcelAdapterOptions | undefined,
  inferredSourceName?: string,
): Readonly<Record<string, unknown>> {
  const raw = options ?? {};
  assertManifestKeys("tabulark:excel", raw);
  const format = raw.format ?? "auto";
  if (format !== "auto" && format !== "xls" && format !== "xlsx") {
    throw invalidArgument("format must be auto, xls, or xlsx");
  }
  const sourceName = normalizeSourceName(raw.sourceName ?? inferredSourceName);
  return Object.freeze({
    format,
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

function assertManifestKeys(id: OfficialAdapterId, value: object): void {
  const allowedSet = new Set(officialAdapterManifestEntry(id).options.allowedKeys);
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

function normalizePresentationWire(
  value: unknown,
  metadata: Readonly<TableMetadata>,
): TablePresentation | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || value.kind !== "spreadsheet-v1") {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned an invalid table presentation");
  }
  if (value.tableId !== metadata.tableId) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Presentation tableId does not match its table");
  }
  const visibility = value.visibility === "hidden" || value.visibility === "very-hidden"
    ? value.visibility
    : "visible";
  return Object.freeze({
    kind: "spreadsheet-v1" as const,
    tableId: metadata.tableId,
    revision: numeric(value.revision, metadata.revision),
    visibility,
    frozenRows: numeric(value.frozenRows, 0),
    frozenColumns: numeric(value.frozenColumns, 0),
    rows: normalizePresentationAxis(value.rows, "rows"),
    columns: normalizePresentationAxis(value.columns, "columns"),
    styles: normalizePresentationStyles(value.styles),
  } satisfies SpreadsheetPresentation);
}

function normalizePresentationRangeWire(
  value: unknown,
  metadata: Readonly<TableMetadata>,
  requested: RangeRequest,
): PresentationRange | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || value.kind !== "spreadsheet-v1" || value.tableId !== metadata.tableId) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Worker returned an invalid presentation range");
  }
  const range = isRecord(value.range) ? value.range : {};
  for (const key of ["rowStart", "rowCount", "columnStart", "columnCount"] as const) {
    if (range[key] !== requested[key]) {
      throw new TabularkError(
        "PROTOCOL_INCOMPATIBLE",
        "Presentation range must be aligned with its requested range",
      );
    }
  }
  if (!Array.isArray(value.styleIds) || value.styleIds.length !== requested.rowCount) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Presentation style rows do not match the range");
  }
  const styleIds = Object.freeze(value.styleIds.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== requested.columnCount) {
      throw new TabularkError(
        "PROTOCOL_INCOMPATIBLE",
        `Presentation style row ${rowIndex} does not match the range`,
      );
    }
    return Object.freeze(row.map((styleId) => (
      styleId === null || (Number.isSafeInteger(styleId) && (styleId as number) >= 0)
        ? styleId as number | null
        : invalidPresentationStyleId()
    )));
  }));
  const mergedCells = Array.isArray(value.mergedCells)
    ? Object.freeze(value.mergedCells.map((region, index) => normalizeMergedCell(region, index)))
    : Object.freeze([]);
  return Object.freeze({
    kind: "spreadsheet-v1" as const,
    tableId: metadata.tableId,
    revision: numeric(value.revision, metadata.revision),
    range: Object.freeze({ ...requested }),
    styleIds,
    mergedCells,
    rows: normalizePresentationAxis(value.rows, "rows"),
    columns: normalizePresentationAxis(value.columns, "columns"),
  });
}

function invalidPresentationStyleId(): never {
  throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Presentation style IDs must be non-negative integers or null");
}

function normalizePresentationAxis(value: unknown, name: string): readonly PresentationAxisEntry[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation ${name} must be an array`);
  }
  const seen = new Set<number>();
  return Object.freeze(value.map((entry, index) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.index) || (entry.index as number) < 0) {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation ${name}[${index}] has an invalid index`);
    }
    const axisIndex = entry.index as number;
    if (seen.has(axisIndex)) {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation ${name} contains duplicate index ${axisIndex}`);
    }
    seen.add(axisIndex);
    if (entry.size !== undefined && (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size < 0)) {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation ${name}[${index}] has an invalid size`);
    }
    if (entry.hidden !== undefined && typeof entry.hidden !== "boolean") {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation ${name}[${index}] has an invalid hidden flag`);
    }
    return Object.freeze({
      index: axisIndex,
      ...(entry.size === undefined ? {} : { size: entry.size as number }),
      ...(entry.hidden === undefined ? {} : { hidden: entry.hidden as boolean }),
    });
  }));
}

function normalizePresentationStyles(value: unknown): readonly PresentationStyle[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", "Presentation styles must be an array");
  }
  return Object.freeze(value.map((style, index) => {
    if (!isRecord(style)) {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Presentation style ${index} must be an object`);
    }
    // Copy only the stable static style vocabulary. Unknown producer fields are
    // intentionally ignored so future adapters can enrich their private wire DTO.
    return Object.freeze({
      ...(typeof style.numberFormat === "string" ? { numberFormat: style.numberFormat } : {}),
      ...(normalizePresentationFont(style.font) ? { font: normalizePresentationFont(style.font)! } : {}),
      ...(normalizePresentationColor(style.foregroundColor) ? { foregroundColor: normalizePresentationColor(style.foregroundColor)! } : {}),
      ...(normalizePresentationColor(style.backgroundColor) ? { backgroundColor: normalizePresentationColor(style.backgroundColor)! } : {}),
      ...(normalizePresentationColor(style.fillColor) ? { fillColor: normalizePresentationColor(style.fillColor)! } : {}),
      ...(normalizePresentationBorders(style.borders) ? { borders: normalizePresentationBorders(style.borders)! } : {}),
      ...(isHorizontalAlignment(style.horizontalAlignment)
        ? { horizontalAlignment: style.horizontalAlignment }
        : {}),
      ...(isVerticalAlignment(style.verticalAlignment)
        ? { verticalAlignment: style.verticalAlignment }
        : {}),
      ...(typeof style.wrapText === "boolean" ? { wrapText: style.wrapText } : {}),
    });
  }));
}

function normalizePresentationColor(value: unknown): Readonly<{ css?: string }> | undefined {
  if (!isRecord(value) || typeof value.css !== "string" || value.css.length === 0 || value.css.length > 128) {
    return undefined;
  }
  return Object.freeze({ css: value.css });
}

function normalizePresentationFont(value: unknown): PresentationStyle["font"] | undefined {
  if (!isRecord(value)) return undefined;
  const color = normalizePresentationColor(value.color);
  const size = typeof value.size === "number" && Number.isFinite(value.size) && value.size > 0
    ? value.size
    : undefined;
  const font = {
    ...(typeof value.family === "string" && value.family.length > 0 ? { family: value.family } : {}),
    ...(size === undefined ? {} : { size }),
    ...(typeof value.bold === "boolean" ? { bold: value.bold } : {}),
    ...(typeof value.italic === "boolean" ? { italic: value.italic } : {}),
    ...(typeof value.underline === "boolean" ? { underline: value.underline } : {}),
    ...(color === undefined ? {} : { color }),
  };
  return Object.keys(font).length === 0 ? undefined : Object.freeze(font);
}

function normalizePresentationBorders(value: unknown): PresentationStyle["borders"] | undefined {
  if (!isRecord(value)) return undefined;
  const sides = ["top", "right", "bottom", "left"] as const;
  const result: Record<string, unknown> = {};
  for (const side of sides) {
    const raw = value[side];
    if (!isRecord(raw)) continue;
    const style = isBorderStyle(raw.style) ? raw.style : undefined;
    const color = normalizePresentationColor(raw.color);
    if (style !== undefined || color !== undefined) {
      result[side] = Object.freeze({
        ...(style === undefined ? {} : { style }),
        ...(color === undefined ? {} : { color }),
      });
    }
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function normalizeMergedCell(value: unknown, index: number): MergedCellRegion {
  if (!isRecord(value)) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Merged cell ${index} must be an object`);
  }
  const fields = ["rowStart", "rowEnd", "columnStart", "columnEnd"] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Merged cell ${index} has an invalid ${field}`);
    }
  }
  const region = {
    rowStart: value.rowStart as number,
    rowEnd: value.rowEnd as number,
    columnStart: value.columnStart as number,
    columnEnd: value.columnEnd as number,
  };
  if (region.rowEnd <= region.rowStart || region.columnEnd <= region.columnStart) {
    throw new TabularkError("PROTOCOL_INCOMPATIBLE", `Merged cell ${index} must be non-empty`);
  }
  return Object.freeze(region);
}

function isBorderStyle(value: unknown): value is "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" {
  return value === "none" || value === "thin" || value === "medium" || value === "thick"
    || value === "dashed" || value === "dotted" || value === "double";
}

function isHorizontalAlignment(value: unknown): value is "general" | "left" | "center" | "right" | "justify" {
  return value === "general" || value === "left" || value === "center" || value === "right" || value === "justify";
}

function isVerticalAlignment(value: unknown): value is "top" | "center" | "bottom" | "justify" {
  return value === "top" || value === "center" || value === "bottom" || value === "justify";
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

function normalizeProgress(
  value: unknown,
  tableId?: string,
  revision?: number,
): RuntimeProgress {
  const raw = isRecord(value) ? value : {};
  return {
    sourceHandle: typeof raw.sourceHandle === "string" ? raw.sourceHandle : "",
    ...(typeof raw.tableId === "string" && raw.tableId.length > 0
      ? { tableId: raw.tableId }
      : typeof tableId === "string" && tableId.length > 0 ? { tableId } : {}),
    ...(Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 0
      ? { revision: raw.revision as number }
      : Number.isSafeInteger(revision) && (revision as number) >= 0
        ? { revision: revision as number }
      : {}),
    bytesScanned: numeric(raw.bytesScanned, 0),
    rowsDiscovered: numeric(raw.rowsDiscovered, 0),
    done: raw.done === true,
  };
}

function normalizeWarning(value: unknown): SourceWarning {
  const raw = isRecord(value) ? value : {};
  // Preserve the historical warning shape (including any adapter-supplied
  // integer offset); the structured diagnostic applies its own safe bounds.
  const byteOffset = Number.isSafeInteger(raw.byteOffset)
    ? raw.byteOffset as number
    : undefined;
  const sourceOffset = Number.isSafeInteger(raw.sourceOffset) && (raw.sourceOffset as number) >= 0
    ? raw.sourceOffset as number
    : undefined;
  const row = Number.isSafeInteger(raw.row) && (raw.row as number) >= 0
    ? raw.row as number
    : undefined;
  const column = Number.isSafeInteger(raw.column) && (raw.column as number) >= 0
    ? raw.column as number
    : undefined;
  const tableId = safeDiagnosticTableId(raw.tableId);
  const resource = safeDiagnosticResource(raw.resource);
  const requiredBytes = firstNonNegativeSafeInteger(raw.requiredBytes);
  const availableBytes = firstNonNegativeSafeInteger(raw.availableBytes);
  return {
    handle: typeof raw.handle === "string" ? raw.handle : "",
    kind: typeof raw.kind === "string" ? raw.kind : "warning",
    message: typeof raw.message === "string" ? raw.message : "Source warning",
    ...(tableId === undefined ? {} : { tableId }),
    ...(resource === undefined ? {} : { resource }),
    ...(requiredBytes === undefined ? {} : { requiredBytes }),
    ...(availableBytes === undefined ? {} : { availableBytes }),
    ...(byteOffset === undefined ? {} : { byteOffset }),
    ...(sourceOffset === undefined ? {} : { sourceOffset }),
    ...(row === undefined ? {} : { row }),
    ...(column === undefined ? {} : { column }),
  };
}

function diagnosticFromWarning(
  warning: SourceWarning,
  tableId?: string,
  revision?: number,
): TabularkDiagnostic {
  const byteOffset = warning.sourceOffset ?? warning.byteOffset;
  const sourceOffset = typeof byteOffset === "number" && Number.isSafeInteger(byteOffset) && byteOffset >= 0
    ? byteOffset
    : undefined;
  const warningRow = warning.row;
  const row = typeof warningRow === "number" && Number.isSafeInteger(warningRow) && warningRow >= 0
    ? warningRow
    : undefined;
  const warningColumn = warning.column;
  const column = typeof warningColumn === "number"
    && Number.isSafeInteger(warningColumn)
    && warningColumn >= 0
    ? warningColumn
    : undefined;
  const diagnosticRevision = typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : undefined;
  const code = safeDiagnosticCode(warning.kind, "SOURCE_WARNING");
  const safeTableId = safeDiagnosticTableId(tableId ?? warning.tableId);
  const resource = safeDiagnosticResource(warning.resource);
  const requiredBytes = firstNonNegativeSafeInteger(warning.requiredBytes);
  const availableBytes = firstNonNegativeSafeInteger(warning.availableBytes);
  return Object.freeze({
    code,
    severity: "warning" as const,
    // Keep the legacy warning event available to callers that need its full
    // text, but expose only a stable category sentence here. Adapter warning
    // strings can contain worksheet names or source excerpts and therefore
    // are not safe to retain in the public diagnostic snapshot.
    message: safeDiagnosticMessage(warning.message, diagnosticFallback(code, "warning"), code),
    recoverable: true,
    ...(resource === undefined ? {} : { resource }),
    ...(requiredBytes === undefined ? {} : { requiredBytes }),
    ...(availableBytes === undefined ? {} : { availableBytes }),
    ...(sourceOffset === undefined ? {} : { sourceOffset }),
    ...(safeTableId === undefined ? {} : { tableId: safeTableId }),
    ...(diagnosticRevision === undefined ? {} : { revision: diagnosticRevision }),
    ...(row === undefined ? {} : { row }),
    ...(column === undefined ? {} : { column }),
  });
}

function diagnosticFromError(
  error: TabularkError,
  tableId?: string,
  revision?: number,
): TabularkDiagnostic {
  const details = isRecord(error.details) ? error.details : {};
  const detailOffset = firstNonNegativeSafeInteger(details.sourceOffset)
    ?? firstNonNegativeSafeInteger(details.byteOffset);
  const detailRow = firstNonNegativeSafeInteger(details.row);
  const detailColumn = firstNonNegativeSafeInteger(details.column);
  const detailTableId = typeof details.tableId === "string" && details.tableId.length > 0
    ? details.tableId
    : undefined;
  const detailRevision = firstNonNegativeSafeInteger(details.revision);
  const diagnosticRevision = typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : detailRevision;
  const code = safeDiagnosticCode(error.code, "RUNTIME_FAILURE");
  const safeTableId = safeDiagnosticTableId(tableId);
  const safeDetailTableId = safeDiagnosticTableId(detailTableId);
  return Object.freeze({
    code,
    severity: "error" as const,
    message: safeErrorDiagnosticMessage(error, code),
    recoverable: error.retryable,
    ...(safeTableId !== undefined
      ? { tableId: safeTableId }
      : safeDetailTableId === undefined
        ? {}
        : { tableId: safeDetailTableId }),
    ...(detailOffset === undefined ? {} : { sourceOffset: detailOffset }),
    ...(diagnosticRevision === undefined ? {} : { revision: diagnosticRevision }),
    ...(detailRow === undefined ? {} : { row: detailRow }),
    ...(detailColumn === undefined ? {} : { column: detailColumn }),
  });
}

function safeErrorDiagnosticMessage(error: TabularkError, code: string): string {
  // Protocol/ABI details are intentionally kept out of the stable diagnostic
  // surface; callers can still inspect the original DatasetEvent error.
  return safeDiagnosticMessage(
    error.message,
    diagnosticFallback(code, "error"),
    code,
  );
}

function safeDiagnosticCode(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96);
  // Protocol/ABI names describe the private transport, not a stable source
  // diagnostic.  Keep the original TabularkError code on the compatibility
  // DatasetEvent, but collapse it before it can enter a public snapshot.
  if (normalized === "PROTOCOL_INCOMPATIBLE") return "RUNTIME_FAILURE";
  return normalized.length > 0 && SAFE_DIAGNOSTIC_CODES.has(normalized)
    ? normalized
    : fallback;
}

// Adapter-provided text is deliberately not an open-ended public code space:
// a malicious container must not smuggle a path, worksheet name, or source
// excerpt into a supposedly safe diagnostic snapshot.
const SAFE_DIAGNOSTIC_CODES = new Set([
  "SOURCE_WARNING",
  "RUNTIME_FAILURE",
  "ragged-row",
  "quote-in-unquoted-field",
  "unexpected-data-after-closing-quote",
  "unterminated-quote",
  "skipped-sheet",
  "missing-formula-cache",
  "presentation-resource-limit",
  "RESOURCE_LIMIT",
  "CANCELLED",
  "HANDLE_CLOSED",
  "RANGE_NOT_INDEXED",
  "PARSE_FAILED",
  "UNSUPPORTED_FEATURE",
  "INVALID_RANGE",
  "INVALID_ARGUMENT",
  "UNSUPPORTED_RUNTIME",
  "SOURCE_UNAVAILABLE",
  "SOURCE_CHANGED",
  "RANGE_UNSUPPORTED",
]);

function safeDiagnosticMessage(value: unknown, fallback: string, code?: string): string {
  // Only a small, code-keyed vocabulary is retained. This prevents a source
  // cell, worksheet name, path, URL, or parser buffer excerpt from entering a
  // snapshot even when an adapter sends it as its warning/error message.
  const stable = diagnosticFallback(code, "warning");
  return stable.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH ? stable : fallback;
}

function diagnosticFallback(code: string | undefined, severity: "warning" | "error"): string {
  switch (code) {
    case "ragged-row":
      return "Rows contain inconsistent field counts";
    case "quote-in-unquoted-field":
      return "A quoted value appeared in an unquoted field";
    case "unexpected-data-after-closing-quote":
      return "Unexpected data followed a closing quote";
    case "unterminated-quote":
      return "A quoted field was not terminated";
    case "skipped-sheet":
      return "A workbook sheet was skipped";
    case "missing-formula-cache":
      return "A formula has no cached result";
    case "presentation-resource-limit":
      return "Spreadsheet presentation exceeded its resource budget";
    case "RESOURCE_LIMIT":
      return "A configured resource limit was reached";
    case "CANCELLED":
      return "The operation was cancelled";
    case "HANDLE_CLOSED":
      return "The handle is closed";
    case "RANGE_NOT_INDEXED":
      return "The requested range is not indexed yet";
    case "PARSE_FAILED":
      return "The source could not be parsed";
    case "UNSUPPORTED_FEATURE":
      return "The source uses an unsupported feature";
    case "INVALID_RANGE":
      return "The requested range is invalid";
    case "INVALID_ARGUMENT":
      return "An operation argument is invalid";
    case "UNSUPPORTED_RUNTIME":
      return "The current runtime is unsupported";
    case "SOURCE_UNAVAILABLE":
      return "The source is unavailable";
    case "SOURCE_CHANGED":
      return "The source changed while it was open";
    case "RANGE_UNSUPPORTED":
      return "The source does not support the requested byte range";
    case "RUNTIME_FAILURE":
      return "The runtime reported a failure";
    default:
      return severity === "warning" ? "Source warning" : "The operation failed";
  }
}

function safeDiagnosticTableId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }
  // Table IDs are logical handles, not a channel for source names or paths.
  // Keep the stable identifier alphabet while omitting values that look like
  // filenames, URLs, or traversal fragments instead of returning a lossy copy
  // of potentially sensitive source text.
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value) ? value : undefined;
}

function safeDiagnosticResource(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 96) {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(value) ? value : undefined;
}

function createDatasetCapabilitySeed(
  adapterId: OfficialAdapterId,
  options: Readonly<Record<string, unknown>>,
  tables: readonly TableDescriptor[],
  sourceMode: SourceMode = "auto",
  stagedSourceLimit = MAX_ARRAY_BUFFER_BYTES,
  rangeSource = false,
): DatasetCapabilitySeed {
  const manifest = officialAdapterManifestEntry(adapterId);
  // `auto` is intentionally conservative: a File may resolve to an IPC file
  // (non-progressive) or a stream envelope, and the definitive metadata event
  // updates the snapshot once the adapter has inspected its magic bytes.
  const progressive = adapterId === "tabulark:delimited"
    || (adapterId === "tabulark:arrow-ipc" && options.container === "stream");
  const sourceAccess = adapterId === "tabulark:arrow-ipc" && options.container === "stream"
      ? "streaming"
      : manifest.resources.sourceAccess;
  const maxSourceBytes = rangeSource
    ? MAX_RANGE_SOURCE_BYTES
    : sourceMode === "large"
    ? MAX_LARGE_SOURCE_BYTES
    : adapterId === "tabulark:excel"
      ? stagedSourceLimit
      : adapterId === "tabulark:arrow-ipc" ? 0xffff_ffff : Number.MAX_SAFE_INTEGER;
  return Object.freeze({
    adapterId,
    sourceAccess,
    progressive,
    maxSourceBytes,
    multiTable: tables.length > 1 || adapterId === "tabulark:excel",
    presentation: manifest.resources.supportsPresentation,
    typedValues: adapterId === "tabulark:arrow-ipc" || adapterId === "tabulark:parquet",
  });
}

function createFallbackDatasetCapabilitySeed(
  tables: readonly TableDescriptor[],
): DatasetCapabilitySeed {
  return Object.freeze({
    adapterId: "tabulark:delimited",
    sourceAccess: "streaming",
    progressive: true,
    maxSourceBytes: Number.MAX_SAFE_INTEGER,
    multiTable: tables.length > 1,
    presentation: false,
    typedValues: false,
  });
}

function finitePerformanceNow(): number {
  const now = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  return Number.isFinite(now) ? now : 0;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeSafeQuantity(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function addPerformanceBytes(current: number, next: number): number {
  const value = nonNegativeFinite(current) + nonNegativeFinite(next);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function firstNonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function sanitizePerformanceStage(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 64);
  return normalized.length > 0 ? normalized : "operation";
}

function isPrivateCapabilityName(name: string): boolean {
  // Metadata is adapter-controlled input. Preserve small logical extension
  // flags (for example `customCapability`) but keep transport/runtime state,
  // source paths, and allocation details out of the stable capability view.
  return /(?:protocol|abi|layout|worker|wire|buffer|transport|runtime|module|wasm|memory|source|path|url|resource|reservation|offset|handle|request|response)/iu.test(name);
}

function isLogicalCapabilityValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value)
    && value.length <= 64
    && value.every((entry) => entry === null
      || typeof entry === "boolean"
      || typeof entry === "string"
      || (typeof entry === "number" && Number.isFinite(entry)));
}

function freezeLogicalCapabilityValue<T>(value: T): T {
  if (!Array.isArray(value)) return value;
  return Object.freeze([...value]) as T;
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

/** Sanitizes arbitrary provider failures before they cross the public boundary. */
function normalizeRangeSourceOpenError(error: unknown): TabularkError {
  const structured = rangeSourceErrorLike(error);
  if (structured !== undefined) {
    const code = sourceErrorCode(structured.code);
    if (code === "CANCELLED") return cancelledError();
    if (code === "HANDLE_CLOSED") return closedError("Range source reader");
    if (code === "SOURCE_CHANGED") {
      return new TabularkError("SOURCE_CHANGED", "The source changed while it was opening", {
        retryable: structured.retryable,
      });
    }
    if (code === "RANGE_UNSUPPORTED") {
      return new TabularkError("RANGE_UNSUPPORTED", "The source does not support the requested range", {
        retryable: structured.retryable,
      });
    }
    if (code === "RESOURCE_LIMIT") {
      return new TabularkError("RESOURCE_LIMIT", "The source exceeds its configured limit", {
        details: safeSourceLimitDetails(structured.details),
      });
    }
    if (code === "RUNTIME_FAILURE") {
      return new TabularkError("RUNTIME_FAILURE", "The source provider returned invalid bytes", {
        retryable: structured.retryable,
      });
    }
    return new TabularkError("SOURCE_UNAVAILABLE", "The source could not be opened", {
      retryable: structured.retryable,
    });
  }
  if (isAbortLikeError(error)) return cancelledError();
  return new TabularkError("SOURCE_UNAVAILABLE", "The source could not be opened", { retryable: true });
}

/**
 * RangeSource implementations may come from a separately bundled entrypoint,
 * so their TabularkError constructor does not necessarily share identity with
 * core. Capture only the constrained public fields; callers rebuild messages
 * and sanitize any retained details before exposing them.
 */
function rangeSourceErrorLike(value: unknown): {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
} | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const code = value.code;
    const retryable = value.retryable;
    if (typeof code !== "string" || typeof retryable !== "boolean") return undefined;
    return { code, retryable, details: value.details };
  } catch {
    return undefined;
  }
}

function safeSourceLimitDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return { resource: "source-staging", requiredBytes: 0, availableBytes: 0 };
  }
  const resource = typeof value.resource === "string"
    && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value.resource)
    ? value.resource
    : "source-staging";
  const requiredBytes = isSafeNonNegativeInteger(value.requiredBytes) ? value.requiredBytes : 0;
  const availableBytes = isSafeNonNegativeInteger(value.availableBytes) ? value.availableBytes : 0;
  return { resource, requiredBytes, availableBytes };
}

function isAbortLikeError(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && ((value as { name?: unknown }).name === "AbortError"
      || (value as { code?: unknown }).code === 20);
}

function numeric(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function isReturnedRangeWithin(value: unknown, requested: RangeRequest): boolean {
  if (!isRecord(value)) return false;
  const rowStart = value.rowStart;
  const rowCount = value.rowCount;
  const columnStart = value.columnStart;
  const columnCount = value.columnCount;
  return Number.isSafeInteger(rowStart)
    && rowStart === requested.rowStart
    && Number.isSafeInteger(rowCount)
    && (rowCount as number) >= 0
    && (rowCount as number) <= requested.rowCount
    && Number.isSafeInteger(columnStart)
    && columnStart === requested.columnStart
    && Number.isSafeInteger(columnCount)
    && (columnCount as number) >= 0
    && (columnCount as number) <= requested.columnCount;
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

function sourceStagingBudget(limits: MemoryBudgetLimits): number {
  return limits.mainThreadSourceBytes;
}

/**
 * Calls a provider's close hook without allowing a malformed reader (or a
 * throwing getter) to replace the structured open/cleanup result.  The
 * public contract requires close to be best-effort and idempotent; this
 * helper also covers the invalid-reader path before a typed reader exists.
 */
async function closeRangeReaderBestEffort(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  let close: unknown;
  try {
    close = (value as { close?: unknown }).close;
  } catch {
    return;
  }
  if (typeof close !== "function") return;
  let closeResult: Promise<unknown>;
  try {
    // A provider is allowed to return a Promise, but a non-cooperative close
    // must not make engine shutdown unbounded. Attach a rejection handler even
    // when the timeout wins so a late rejection cannot become unhandled.
    closeResult = Promise.resolve((close as () => unknown).call(value));
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LIFECYCLE_CLOSE_TIMEOUT_MS);
  });
  await Promise.race([closeResult.then(() => undefined, () => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * Races an open against its AbortSignal. JavaScript Promises cannot be
 * forcibly cancelled, so a late reader is closed when the provider eventually
 * resolves; this keeps cancellation prompt while preserving the exactly-once
 * reader lifecycle guarantee.
 */
function openRangeReaderWithCancellation(
  source: RangeSource,
  options: {
    readonly signal: AbortSignal;
    readonly maxSourceBytes: number;
    readonly maxStagingBytes: number;
  },
  signal: AbortSignal,
): Promise<RangeSourceReader> {
  let finished = false;
  const opening = signal.aborted
    ? Promise.reject<RangeSourceReader>(cancelledError())
    : Promise.resolve().then(() => source.open(options));
  return new Promise<RangeSourceReader>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(cancelledError());
    };
    if (signal.aborted) {
      onAbort();
      // Still attach handlers below so a provider that ignores cancellation
      // cannot produce an unhandled rejection.
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    opening.then(
      (value) => {
        if (finished) {
          void closeRangeReaderBestEffort(value);
          return;
        }
        finished = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function copyExactRangeBytes(
  value: ArrayBuffer | ArrayBufferView,
  expectedLength: number,
): ArrayBuffer {
  const actualLength = value instanceof ArrayBuffer
    ? value.byteLength
    : ArrayBuffer.isView(value)
      ? value.byteLength
      : undefined;
  if (actualLength !== expectedLength) {
    throw new TabularkError(
      "RUNTIME_FAILURE",
      "The source provider returned an invalid byte length",
    );
  }
  // The broker owns an exact ArrayBuffer returned by the provider and
  // immediately transfers it to the Worker. Reusing that allocation avoids a
  // second main-thread buffer that would temporarily double the staging
  // slice. Exact whole-buffer views can use the same ownership transfer; only
  // offset/shared views need a bounded copy.
  if (value instanceof ArrayBuffer) return value;
  if (
    value.buffer instanceof ArrayBuffer
    && value.byteOffset === 0
    && value.byteLength === value.buffer.byteLength
  ) {
    return value.buffer;
  }
  return copyRangeBytes(value);
}

function combineAbortSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first === undefined) return second;
  if (first === second) return first;
  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: readonly AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === "function") return any([first, second]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (first.aborted || second.aborted) {
    controller.abort();
  } else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function normalizeSourceProviderError(error: unknown): { code: string; retryable: boolean } {
  const structured = rangeSourceErrorLike(error);
  if (structured !== undefined) {
    const code = sourceErrorCode(structured.code);
    return { code, retryable: structured.retryable };
  }
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") {
    return { code: "CANCELLED", retryable: false };
  }
  return { code: "SOURCE_UNAVAILABLE", retryable: true };
}

function sourceErrorCode(value: unknown): string {
  return value === "SOURCE_CHANGED"
    || value === "RANGE_UNSUPPORTED"
    || value === "SOURCE_UNAVAILABLE"
    || value === "RESOURCE_LIMIT"
    || value === "CANCELLED"
    || value === "HANDLE_CLOSED"
    || value === "RUNTIME_FAILURE"
    ? value
    : "SOURCE_UNAVAILABLE";
}

function sourceErrorMessage(code: unknown): string {
  switch (sourceErrorCode(code)) {
    case "SOURCE_CHANGED": return "The source changed while it was open";
    case "RANGE_UNSUPPORTED": return "The source range is unsupported";
    case "CANCELLED": return "The source read was cancelled";
    case "HANDLE_CLOSED": return "The source is closed";
    case "RUNTIME_FAILURE": return "The source provider returned invalid bytes";
    case "RESOURCE_LIMIT": return "The source exceeds its configured limit";
    default: return "The source provider is unavailable";
  }
}

/** Creates one dedicated Worker-backed Tabulark engine. */
export function createEngine(options: EngineOptions): Promise<TabularkEngine> {
  return Engine.create(options);
}
