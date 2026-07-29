/// <reference lib="webworker" />

import {
  ADAPTER_API_VERSION,
  BATCH_LAYOUT_VERSION,
  PROTOCOL_VERSION,
  isRecord,
  type Operation,
  type ProtocolEvent,
  type ProtocolRequest,
  type ProtocolResponse,
} from "./protocol.js";
import type {
  RangeRequest,
  ReturnedRange,
  TableDescriptor,
  TableMetadata,
  NativeColumnDescriptor,
  DisplayColumnDescriptor,
  WireTableBatch,
} from "./model.js";
import {
  ColumnarTableBatch,
  deriveMemoryBudgetLimits,
  MemoryReservationLedger,
  normalizeDataType,
  MAX_RANGE_CELLS,
  MAX_ACTIVE_RANGES,
  MAX_RANGE_WAITERS,
  type MemoryBudgetLimits,
  type MemoryReservation,
} from "./model.js";
import {
  AsyncPermitQueue,
  PermitQueueFullError,
} from "./range-cache.js";
import {
  WasmAdapter,
  type AdapterActionResult,
  type AdapterOperationStep,
  type AdapterReadAction,
  type AdapterRuntime,
} from "./worker/wasm-adapter.js";
import { ProtocolFault, serializeFault } from "./worker/worker-errors.js";
import {
  isOfficialAdapterId,
  officialAdapterModuleUrl,
  officialAdapterManifestEntry,
  type OfficialAdapterId,
} from "./official-adapter-manifest.js";
import {
  MAX_LARGE_SOURCE_BYTES,
  isSourceMode,
  type SourceMode,
} from "./source.js";
import { BlobSourceAccessor } from "./worker/blob-source-accessor.js";
import type {
  SourceAccessor,
  SourceReadOptions,
} from "./worker/source-accessor.js";

const CHUNK_BYTES = 1024 * 1024;
const MAX_RANGE_SOURCE_BYTES = 0xffff_ffff;
// wasm32 address arithmetic and Rust `usize` cap one Blob source below 4 GiB.
// This is a format-addressability bound, not an allocation reservation: Arrow
// File opens retain only footer/index state and fetch bounded blocks on demand.
const MAX_ARROW_SOURCE_BYTES = MAX_RANGE_SOURCE_BYTES;
const INITIAL_READ_LIMIT_BYTES = 8 * CHUNK_BYTES;
const INITIAL_ROW_TARGET = 256;
const MAX_IN_FLIGHT_RANGES = MAX_ACTIVE_RANGES + MAX_RANGE_WAITERS;
// The public engine rejects budgets below 8 MiB. Keep direct low-budget
// protocol fixtures compatible with the historical Worker harness while the
// supported browser path uses the explicit 75/12.5/12.5 split.
const MIN_SPLIT_BUDGET_BYTES = 8 * 1024 * 1024;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
type RangeSourceRuntime = typeof import("./worker-range-source.js");
type SourceBroker = InstanceType<RangeSourceRuntime["WorkerSourceBroker"]>;
let sourceBroker: SourceBroker | undefined;
let rangeSourceRuntimePromise: Promise<RangeSourceRuntime> | undefined;

interface DatasetState {
  readonly handle: string;
  readonly openRequestId: string;
  readonly source: SourceAccessor;
  readonly adapterId: OfficialAdapterId;
  readonly adapter: AdapterRuntime;
  readonly sourceHandle: string | number;
  tables: readonly TableDescriptor[];
  metadata: TableMetadata;
  scanOffset: number;
  scanDone: boolean;
  scanError?: ProtocolFault;
  scanPromise?: Promise<void>;
  /** Pending adapter-v3 open step owned by the background indexer. */
  scanStep?: AdapterOperationStep;
  scanOperationHandle?: string | number;
  pendingProgress?: ScanProgress;
  closed: boolean;
  eventsReady: boolean;
  readonly pendingWarnings: unknown[];
  readonly waiters: Set<() => void>;
  /** Releases the engine-wide source slot exactly once. */
  readonly releaseSourceSlot: () => void;
}

interface ScanProgress {
  readonly bytesScanned: number;
  readonly rowsDiscovered: number;
  readonly done: boolean;
}

interface PublishedOpenStep {
  readonly step: AdapterOperationStep;
  readonly payload: Record<string, unknown>;
}

interface OpenTableState {
  readonly handle: string;
  readonly datasetHandle: string;
  readonly tableId: string;
  readonly adapterTableHandle: string | number;
  metadata: TableMetadata;
  closed: boolean;
}

interface ActiveOpenRequest {
  readonly requestId: string;
  readonly kind: "open";
  datasetHandle?: string;
  adapter?: AdapterRuntime;
  operationHandle?: string | number;
  operationRevision?: number;
  cancelled: boolean;
  readonly cancellation: RequestCancellation;
}

interface ActiveRangeRequest {
  readonly requestId: string;
  readonly kind: "range";
  readonly datasetHandle: string;
  readonly tableHandle: string;
  cancelled: boolean;
  failure?: ProtocolFault;
  adapter?: AdapterRuntime;
  operationHandle?: string | number;
  operationRevision?: number;
  readonly cancellation: RequestCancellation;
}

interface ActiveAsyncRequest {
  readonly requestId: string;
  readonly kind: "async";
  readonly datasetHandle: string;
  /** Existing public table handle, absent while openTable is still pending. */
  readonly tableHandle?: string;
  cancelled: boolean;
  failure?: ProtocolFault;
  adapter?: AdapterRuntime;
  operationHandle?: string | number;
  operationRevision?: number;
  readonly cancellation: RequestCancellation;
}

type ActiveRequest = ActiveOpenRequest | ActiveRangeRequest | ActiveAsyncRequest;

interface RequestCancellation {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface HelloPayload {
  readonly adapters: readonly HelloAdapterPayload[];
  readonly memoryBudgetBytes: number;
}

interface HelloAdapterPayload {
  readonly id: OfficialAdapterId;
}

interface AdapterRegistrationPayload {
  readonly id: OfficialAdapterId;
  readonly moduleUrl: string;
}

interface ReservedBlobRead {
  readonly buffer: ArrayBuffer;
  readonly release: () => void;
}

/** Private, opt-in counters used to populate the stable host performance view. */
interface OperationMeasurement {
  bytesRead: number;
  peakReservationBytes: number;
  sourceReads: number;
  sourceCacheHitBytes: number;
}

interface OpenSourcePayload {
  readonly source: Blob | ArrayBuffer | RemoteSourcePayload;
  readonly adapterId: OfficialAdapterId;
  readonly options: Record<string, unknown>;
  readonly sourceMode?: SourceMode;
  readonly transferInput?: boolean;
}

interface RemoteSourcePayload {
  readonly kind: "range";
  readonly handle: string;
  readonly size: number;
  readonly maxConcurrency?: number;
}

let shuttingDown = false;
let nextDatasetHandle = 1;
let nextTableHandle = 1;
let memoryLimits: MemoryBudgetLimits | undefined;
let memoryLedger: MemoryReservationLedger | undefined;
let peakReservationBytes = 0;
const activeMeasurements = new Set<OperationMeasurement>();
let sourceSlotsInUse = 0;
let rangeRequestsInFlight = 0;
let adapterRegistrations = new Map<string, AdapterRegistrationPayload>();
const adapterLoads = new Map<string, Promise<WasmAdapter>>();
const loadedAdapters = new Map<string, WasmAdapter>();
const adapterRuntimeReservations = new Map<string, MemoryReservation>();
const datasets = new Map<string, DatasetState>();
const tables = new Map<string, OpenTableState>();
const activeRequests = new Map<string, ActiveRequest>();
const openedDatasetsByRequest = new Map<string, string>();
const rangePermits = new AsyncPermitQueue(MAX_ACTIVE_RANGES, MAX_RANGE_WAITERS);

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (sourceBroker?.handle(event.data)) {
    return;
  }
  void dispatch(event.data);
});

function loadRangeSourceRuntime(): Promise<RangeSourceRuntime> {
  if (rangeSourceRuntimePromise !== undefined) return rangeSourceRuntimePromise;
  const loading = import("./worker-range-source.js").catch((error) => {
    rangeSourceRuntimePromise = undefined;
    throw new ProtocolFault(
      "RUNTIME_FAILURE",
      "Failed to initialize the range source runtime",
      false,
      undefined,
      error,
    );
  });
  rangeSourceRuntimePromise = loading;
  return loading;
}

function requireSourceBroker(runtime: RangeSourceRuntime): SourceBroker {
  sourceBroker ??= new runtime.WorkerSourceBroker(scope);
  return sourceBroker;
}

async function dispatch(value: unknown): Promise<void> {
  if (!isRequest(value)) {
    return;
  }

  const request = value;
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    postFailure(
      request.requestId,
      new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `Worker protocol ${PROTOCOL_VERSION} cannot serve protocol ${String(request.protocolVersion)}`,
      ),
    );
    return;
  }

  const measurement = (request as ProtocolRequest & { measure?: unknown }).measure === true
    ? { bytesRead: 0, peakReservationBytes: 0, sourceReads: 0, sourceCacheHitBytes: 0 }
    : undefined;
  if (measurement) {
    activeMeasurements.add(measurement);
  }
  try {
    const result = await runOperation(request, measurement);
    try {
      postSuccess(
        request.requestId,
        result.kind,
        result.data,
        result.transfer,
        measurementTelemetry(measurement),
      );
    } finally {
      result.release?.();
    }
    if (request.op === "listTables") {
      flushPendingDatasetEvents(request.payload);
    }
    if (request.op === "shutdown") {
      setTimeout(() => scope.close(), 0);
    }
  } catch (error) {
    postFailure(request.requestId, error, measurementTelemetry(measurement));
  } finally {
    if (measurement) {
      activeMeasurements.delete(measurement);
    }
  }
}

async function runOperation(
  request: ProtocolRequest,
  measurement?: OperationMeasurement,
): Promise<{
  kind: Parameters<typeof postSuccess>[1];
  data?: unknown;
  transfer?: Transferable[];
  release?: () => void;
}> {
  switch (request.op) {
    case "hello":
      return { kind: "hello", data: await hello(request.payload) };
    case "openSource":
      return {
        kind: "dataset",
        data: await openSource(request.requestId, request.payload, measurement),
      };
    case "listTables":
      return { kind: "tables", data: listTables(request.payload) };
    case "openTable":
      return { kind: "table", data: await openTable(request.requestId, request.payload) };
    case "getMetadata":
      return { kind: "metadata", data: await getMetadata(request.requestId, request.payload) };
    case "getPresentation":
      return { kind: "presentation", data: await getPresentation(request.requestId, request.payload) };
    case "readPresentationRange":
      return {
        kind: "presentationRange",
        data: await readPresentationRange(request.requestId, request.payload),
      };
    case "readRange":
      return readRange(request.requestId, request.payload, measurement);
    case "cancel":
      cancel(request.payload);
      return { kind: "acknowledged" };
    case "closeTable":
      closeTable(request.payload);
      return { kind: "acknowledged" };
    case "closeSource":
      closeSource(request.payload);
      return { kind: "acknowledged" };
    case "shutdown":
      await shutdown();
      return { kind: "acknowledged" };
    default:
      throw new ProtocolFault("INVALID_ARGUMENT", `Unknown operation: ${String(request.op)}`);
  }
}

async function hello(value: unknown): Promise<unknown> {
  const payload = expectRecord(value, "hello payload") as unknown as HelloPayload;
  if (!Number.isSafeInteger(payload.memoryBudgetBytes) || payload.memoryBudgetBytes <= 0) {
    throw new ProtocolFault("INVALID_ARGUMENT", "memoryBudgetBytes must be a positive safe integer");
  }
  if (!Array.isArray(payload.adapters) || payload.adapters.length === 0) {
    throw new ProtocolFault("INVALID_ARGUMENT", "hello adapters must be a non-empty array");
  }
  const registrations = new Map<string, AdapterRegistrationPayload>();
  for (const entry of payload.adapters) {
    if (
      !isRecord(entry)
      || !isOfficialAdapterId(entry.id)
      || Object.keys(entry).some((key) => key !== "id")
    ) {
      throw new ProtocolFault("INVALID_ARGUMENT", "hello contains an invalid official adapter");
    }
    if (registrations.has(entry.id)) {
      throw new ProtocolFault("INVALID_ARGUMENT", `Adapter ${entry.id} is registered more than once`);
    }
    registrations.set(entry.id, Object.freeze({
      id: entry.id,
      moduleUrl: adapterModuleUrl(entry.id),
    }));
  }

  if (memoryLimits) {
    const sameIds = registrations.size === adapterRegistrations.size
      && [...registrations.keys()].every((id) => adapterRegistrations.has(id));
    if (payload.memoryBudgetBytes !== memoryLimits.memoryBudgetBytes || !sameIds) {
      throw new ProtocolFault(
        "INVALID_ARGUMENT",
        "The Worker hello handshake cannot be reconfigured after initialization",
      );
    }
    return helloResult();
  }

  const limits = deriveMemoryBudgetLimits(payload.memoryBudgetBytes);
  adapterRegistrations = registrations;
  memoryLimits = limits;
  // The ledger accounts only for Worker-owned allocations.  Main-thread
  // source staging and retained batches have their own 12.5% slices, so using
  // the full engine budget here would silently defeat the cross-thread cap.
  // The source-range LRU is bounded independently by
  // `sourceRangeCacheBytes`; reserve that slice up front instead of allowing
  // the general Worker ledger and the LRU to each consume the full 75% share.
  // This keeps the advertised engine budget a real cross-thread ceiling even
  // when both datasets fill their range caches while adapter work is active.
  const workerLedgerBytes = payload.memoryBudgetBytes < MIN_SPLIT_BUDGET_BYTES
    ? payload.memoryBudgetBytes
    : Math.max(1, limits.workerBudgetBytes - limits.sourceRangeCacheBytes);
  memoryLedger = new MemoryReservationLedger(workerLedgerBytes);
  peakReservationBytes = 0;
  return helloResult();
}

function helloResult(): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    adapterApiVersion: ADAPTER_API_VERSION,
    batchLayoutVersion: BATCH_LAYOUT_VERSION,
    adapters: Object.freeze([...adapterRegistrations.keys()]),
    transferableBatches: true,
  };
}

function createActiveOpenRequest(requestId: string): ActiveOpenRequest {
  return {
    requestId,
    kind: "open",
    cancelled: false,
    cancellation: createRequestCancellation(),
  };
}

function createActiveAsyncRequest(
  requestId: string,
  datasetHandle: string,
  tableHandle?: string,
): ActiveAsyncRequest {
  return {
    requestId,
    kind: "async",
    datasetHandle,
    ...(tableHandle === undefined ? {} : { tableHandle }),
    cancelled: false,
    cancellation: createRequestCancellation(),
  };
}

function createRequestCancellation(): RequestCancellation {
  let resolveCancellation!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  return { promise, resolve: resolveCancellation };
}

async function openSource(
  requestId: string,
  value: unknown,
  measurement?: OperationMeasurement,
): Promise<unknown> {
  const active = createActiveOpenRequest(requestId);
  activeRequests.set(requestId, active);
  let dataset: DatasetState | undefined;
  let sourceHandle: string | number | undefined;
  let source: SourceAccessor | undefined;
  let releaseSourceSlot: (() => void) | undefined;
  let opened = false;

  try {
    const limits = requireMemoryLimits();
    const payload = expectRecord(value, "openSource payload") as unknown as OpenSourcePayload;
    if (!isOfficialAdapterId(payload.adapterId)) {
      throw new ProtocolFault("INVALID_ARGUMENT", "openSource adapterId is not registered");
    }
    // Every official runtime must honor the hello-time adapter allow-list so a
    // raw Worker caller cannot bypass engine registration.
    if (!adapterRegistrations.has(payload.adapterId)) {
      throw new ProtocolFault("INVALID_ARGUMENT", `Adapter ${payload.adapterId} is not registered`);
    }
    if (!isRecord(payload.options) || Array.isArray(payload.options)) {
      throw new ProtocolFault("INVALID_ARGUMENT", "openSource options must be an object");
    }
    const remoteSource = isRecord(payload.source) && payload.source.kind === "range";
    if (remoteSource) {
      // Range readers own their source policy, so local-only sourceMode/
      // transferInput cannot silently alter it. Validator identity remains on
      // the host and is never serialized into this descriptor.
      if (payload.sourceMode !== undefined || payload.transferInput !== undefined) {
        throw new ProtocolFault(
          "INVALID_ARGUMENT",
          "sourceMode and transferInput do not apply to range sources",
        );
      }
      const rangeRuntime = await loadRangeSourceRuntime();
      const validateDescriptor: (candidate: unknown) => asserts candidate is RemoteSourcePayload =
        rangeRuntime.validateRangeDescriptor;
      validateDescriptor(payload.source);
      source = new rangeRuntime.RangeSourceAccessor(
        payload.source,
        requireSourceBroker(rangeRuntime),
        sourceRangeCacheBudget(limits),
        limits.mainThreadSourceBytes,
      );
    } else {
      const sourceMode = payload.sourceMode === undefined ? "auto" : payload.sourceMode;
      if (!isSourceMode(sourceMode)) {
        throw new ProtocolFault("INVALID_ARGUMENT", "openSource sourceMode must be auto or large");
      }
      let local: Blob;
      if (typeof Blob !== "undefined" && payload.source instanceof Blob) {
        local = payload.source;
      } else if (payload.source instanceof ArrayBuffer) {
        if (sourceMode === "large") {
          throw new ProtocolFault(
            "INVALID_ARGUMENT",
            "sourceMode large requires a local Blob or File source",
          );
        }
        if (payload.source.byteLength > limits.maxArrayBufferBytes) {
          throw new ProtocolFault(
            "RESOURCE_LIMIT",
            `ArrayBuffer sources larger than ${limits.maxArrayBufferBytes} bytes must be supplied as a Blob`,
            false,
            {
              resource: "source-staging",
              requiredBytes: payload.source.byteLength,
              availableBytes: limits.maxArrayBufferBytes,
            },
          );
        }
        local = new Blob([payload.source]);
      } else {
        throw new ProtocolFault("INVALID_ARGUMENT", "source must be a Blob, ArrayBuffer, or range source");
      }
      assertSourceSize(local, sourceMode);
      assertLocalAdapterSourceSize(local, payload.adapterId);
      source = new BlobSourceAccessor(local);
    }
    // The accessor is definitely initialized by one of the branches above.
    const sourceAccessor = source;
    if (!sourceAccessor) {
      throw new ProtocolFault("INVALID_ARGUMENT", "openSource source is invalid");
    }
    releaseSourceSlot = reserveSourceSlot();

    // Auto mode retains its conservative staging ceiling. Explicit large mode
    // is range-backed by the Rust Excel runtime for both XLS and XLSX.
    if (
      sourceAccessor.kind === "blob"
      && payload.sourceMode !== "large"
      && payload.adapterId === "tabulark:excel"
      && sourceAccessor.size > adapterRuntimeBudget("tabulark:excel", limits)
    ) {
      throw new ProtocolFault(
        "RESOURCE_LIMIT",
        "Excel auto mode exceeds the source staging limit; use a local Blob with sourceMode: large",
        false,
        {
          resource: "source-staging",
          requiredBytes: sourceAccessor.size,
          availableBytes: adapterRuntimeBudget("tabulark:excel", limits),
        },
      );
    }

    const runtime = await awaitOperationStep(loadAdapter(payload.adapterId), active);
    active.adapter = runtime;

    const beginningOpen = Promise.resolve().then(() =>
      runtime.beginOpen(adapterOpenOptions(payload, limits), sourceAccessor.size),
    );
    // An async adapter can publish its operation/source handles after the
    // cancellation race has already completed. Reclaim those late handles
    // instead of leaving private adapter state unreachable by this request.
    void beginningOpen.then(
      (lateStep) => {
        if (active.cancelled) cleanupLateAdapterStep(runtime, lateStep, true);
      },
      () => {},
    );
    const initialStep = await awaitOperationStep(beginningOpen, active);
    const publishedOpen = await runOpenUntilPublished(
      runtime,
      sourceAccessor,
      initialStep,
      active,
      payload.adapterId,
      measurement,
    );
    const openRaw = publishedOpen.payload;
    const progressiveOpen = publishedOpen.step.kind === "progress";
    if (openRaw.sourceHandle === undefined || openRaw.sourceHandle === null) {
      throw new ProtocolFault("RUNTIME_FAILURE", "Adapter open did not return a sourceHandle");
    }
    sourceHandle = operationHandle(openRaw.sourceHandle, "sourceHandle");
    throwIfCancelled(active);
    const datasetHandle = `d${nextDatasetHandle++}`;
    const initialMetadata = normalizeMetadata(
      openRaw.metadata,
      normalizeDescriptor(openRaw.table, 0),
    );
    const initialTables = normalizeDescriptors(
      Array.isArray(openRaw.tables) ? openRaw.tables : undefined,
      openRaw.table,
      initialMetadata,
    );
    const openedDataset: DatasetState = {
      handle: datasetHandle,
      openRequestId: requestId,
      source: sourceAccessor,
      adapterId: payload.adapterId,
      adapter: runtime,
      sourceHandle,
      tables: initialTables,
      metadata: initialMetadata,
      scanOffset: progressiveOpen ? 0 : sourceAccessor.size,
      scanDone: !progressiveOpen,
      closed: false,
      eventsReady: false,
      pendingWarnings: progressiveOpen
        ? []
        : Array.isArray(openRaw.warnings) ? [...openRaw.warnings] : [],
      waiters: new Set(),
      releaseSourceSlot,
    };
    dataset = openedDataset;
    datasets.set(datasetHandle, openedDataset);
    releaseSourceSlot = undefined;
    active.datasetHandle = datasetHandle;

    if (progressiveOpen) {
      applyProgressiveOpenStep(openedDataset, publishedOpen.step, false);
      await scanInitialPrefix(openedDataset, active);
      throwIfCancelled(active);
      delete active.operationHandle;
      if (!openedDataset.scanDone) {
        openedDataset.scanPromise = scanOpenToEnd(openedDataset);
      } else {
        openedDataset.pendingProgress = scanProgress(openedDataset);
      }
    }

    openedDatasetsByRequest.set(requestId, datasetHandle);
    opened = true;
    return { datasetHandle };
  } finally {
    activeRequests.delete(requestId);
    if (!opened) {
      if (dataset && !dataset.closed) {
        closeDatasetState(dataset, false);
      } else if (!dataset && sourceHandle !== undefined) {
        try {
          active.adapter?.closeSource(sourceHandle);
        } catch {
          // Preserve the original open or cancellation failure.
        }
      }
      if (!dataset) {
        source?.close();
      }
    }
    releaseSourceSlot?.();
  }
}

function adapterOpenOptions(
  payload: OpenSourcePayload,
  limits: MemoryBudgetLimits,
): Readonly<Record<string, unknown>> {
  const sourceName = typeof payload.options.sourceName === "string" && payload.options.sourceName.length > 0
    ? payload.options.sourceName
    : undefined;
  if (payload.adapterId === "tabulark:delimited") {
    const delimiter = payload.options.delimiter;
    const header = payload.options.header;
    const mode = payload.options.mode;
    if (!isValidDelimiter(delimiter)) {
      throw new ProtocolFault(
        "INVALID_ARGUMENT",
        "Delimited adapter delimiter must be one non-NUL ASCII byte other than CR, LF, or quote",
      );
    }
    if (header !== "first-row" && header !== "none") {
      throw new ProtocolFault("INVALID_ARGUMENT", "Delimited adapter header must be first-row or none");
    }
    if (mode !== "lenient" && mode !== "strict") {
      throw new ProtocolFault("INVALID_ARGUMENT", "Delimited adapter mode must be lenient or strict");
    }
    return Object.freeze({
      delimiter,
      header: header === "first-row",
      mode,
      checkpointInterval: 1_024,
      tableName: sourceName ?? "Table 1",
      limits: Object.freeze({
        maxFieldBytes: limits.maxFieldBytes,
        maxColumns: 16_384,
        maxCellsPerRange: 250_000,
        maxBatchBytes: limits.maxBatchBytes,
        maxDiagnostics: 1_000,
      }),
    });
  }

  if (payload.adapterId === "tabulark:arrow-ipc") {
    const container = payload.options.container;
    if (container !== "auto" && container !== "file" && container !== "stream") {
      throw new ProtocolFault("INVALID_ARGUMENT", "Arrow adapter container must be auto, file, or stream");
    }
    return Object.freeze({
      container,
      tableName: sourceName ?? "Arrow IPC",
      limits: Object.freeze({
        maxSourceBytes: MAX_ARROW_SOURCE_BYTES,
        maxDecodedBytes: limits.operationBudgetBytes,
        maxOutputBytes: limits.maxBatchBytes,
        maxMetadataBytes: limits.maxFieldBytes,
        maxBlockBytes: Math.min(
          64 * 1024 * 1024,
          Math.max(1, Math.floor(limits.operationBudgetBytes / 4)),
        ),
        streamChunkBytes: Math.min(
          32 * 1024,
          Math.max(1, Math.floor(limits.operationBudgetBytes / 16)),
        ),
        maxFields: 16_384,
        maxNestingDepth: 64,
        maxRangeCells: 250_000,
        maxDisplayCellBytes: Math.min(
          1024 * 1024,
          Math.max(1, Math.floor(limits.operationBudgetBytes / 16)),
        ),
      }),
    });
  }

  if (payload.adapterId === "tabulark:parquet") {
    return Object.freeze({
      sourceName: sourceName ?? "Parquet",
    });
  }

  const format = payload.options.format;
  if (format !== "auto" && format !== "xls" && format !== "xlsx") {
    throw new ProtocolFault("INVALID_ARGUMENT", "Excel adapter format must be auto, xls, or xlsx");
  }
  return Object.freeze({
    format,
    ...(sourceName === undefined ? {} : { sourceName }),
  });
}

function listTables(value: unknown): unknown {
  const payload = expectRecord(value, "listTables payload");
  const dataset = requireDataset(payload.datasetHandle);
  return dataset.tables;
}

async function openTable(requestId: string, value: unknown): Promise<unknown> {
  const payload = expectRecord(value, "openTable payload");
  const dataset = requireDataset(payload.datasetHandle);
  if (typeof payload.tableId !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "tableId must be a string");
  }
  if (!dataset.tables.some((table) => table.id === payload.tableId)) {
    throw new ProtocolFault("INVALID_ARGUMENT", `Unknown table: ${payload.tableId}`);
  }

  const active = createActiveAsyncRequest(requestId, dataset.handle);
  active.adapter = dataset.adapter;
  activeRequests.set(requestId, active);
  let adapterTableHandle: string | number | undefined;
  let adapterTableClosed = false;
  let published = false;
  const warnings: unknown[] = [];
  const closeAdapterTable = (handle: string | number): void => {
    if (adapterTableClosed) return;
    adapterTableClosed = true;
    try {
      dataset.adapter.closeTable(handle);
    } catch {
      // The dataset/source close remains authoritative and idempotent.
    }
  };

  try {
    // Keep a late cleanup attached to the adapter promise. Cancellation wins
    // the public race immediately, but an asynchronous host can still finish
    // constructing its private table afterwards.
    const opening = Promise.resolve().then(() =>
      dataset.adapter.beginOpenTable(dataset.sourceHandle, payload.tableId as string),
    );
    void opening.then(
      (lateResult) => {
        if (
          !active.cancelled
          && !dataset.closed
          && datasets.get(dataset.handle) === dataset
          && !shuttingDown
        ) {
          return;
        }
        cleanupLateAdapterStep(dataset.adapter, lateResult, false);
        const lateHandle = adapterTableHandleFromOpenResult(lateResult);
        if (lateHandle !== undefined) closeAdapterTable(lateHandle);
      },
      () => {},
    );

    const initial = await awaitOperationStep(opening, active);
    const completed = await runAdapterValueOperation(
      dataset.adapter,
      dataset.source,
      initial,
      active,
      dataset.adapterId,
      "open-table",
    );
    assertAsyncRequestOpen(active, dataset);
    const result = completed.table;
    const raw = isRecord(result) ? result : {};
    appendOperationWarnings(warnings, completed, raw);
    adapterTableHandle = operationHandle(
      raw.tableHandle ?? raw.handle ?? result,
      "openTable tableHandle",
    );
    const descriptor = dataset.tables.find((candidate) => candidate.id === payload.tableId)
      ?? { id: payload.tableId as string, name: payload.tableId as string };
    let metadataValue = raw.metadata;
    if (metadataValue === undefined) {
      const metadataInitial = await beginTrackedAdapterOperation(
        dataset.adapter,
        active,
        () => dataset.adapter.beginMetadata(adapterTableHandle!),
      );
      const metadataCompleted = await runAdapterValueOperation(
        dataset.adapter,
        dataset.source,
        metadataInitial,
        active,
        dataset.adapterId,
        "metadata",
      );
      appendOperationWarnings(warnings, metadataCompleted);
      metadataValue = metadataCompleted.metadata;
    }
    assertAsyncRequestOpen(active, dataset);
    const metadata = normalizeMetadata(metadataValue, descriptor);
    const tableHandle = `t${nextTableHandle++}`;
    const openedTableState: OpenTableState = {
      handle: tableHandle,
      datasetHandle: dataset.handle,
      tableId: payload.tableId,
      adapterTableHandle,
      metadata,
      closed: false,
    };
    tables.set(tableHandle, openedTableState);
    published = true;
    emitWarnings(dataset, warnings, {
      tableHandle,
      tableId: payload.tableId as string,
      revision: metadata.revision,
    });
    return {
      id: payload.tableId,
      name: dataset.tables.find((candidate) => candidate.id === payload.tableId)?.name ?? payload.tableId,
      tableHandle,
    };
  } finally {
    activeRequests.delete(requestId);
    if (!published && adapterTableHandle !== undefined) {
      closeAdapterTable(adapterTableHandle);
    }
  }
}

async function getMetadata(requestId: string, value: unknown): Promise<unknown> {
  const payload = expectRecord(value, "getMetadata payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  const active = createActiveAsyncRequest(requestId, dataset.handle, table.handle);
  active.adapter = dataset.adapter;
  activeRequests.set(requestId, active);
  try {
    const initial = await beginTrackedAdapterOperation(
      dataset.adapter,
      active,
      () => dataset.adapter.beginMetadata(table.adapterTableHandle),
    );
    const completed = await runAdapterValueOperation(
      dataset.adapter,
      dataset.source,
      initial,
      active,
      dataset.adapterId,
      "metadata",
    );
    assertAsyncRequestOpen(active, dataset, table);
    const metadata = normalizeMetadata(
      completed.metadata,
      { id: table.tableId, name: table.metadata.name },
    );
    table.metadata = metadata;
    emitOperationWarnings(dataset, completed, table);
    return metadata;
  } finally {
    activeRequests.delete(requestId);
  }
}

async function getPresentation(requestId: string, value: unknown): Promise<unknown> {
  const payload = expectRecord(value, "getPresentation payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  const active = createActiveAsyncRequest(requestId, dataset.handle, table.handle);
  active.adapter = dataset.adapter;
  activeRequests.set(requestId, active);
  try {
    const initial = await beginTrackedAdapterOperation(
      dataset.adapter,
      active,
      () => dataset.adapter.beginPresentation(table.adapterTableHandle),
    );
    const completed = await runAdapterValueOperation(
      dataset.adapter,
      dataset.source,
      initial,
      active,
      dataset.adapterId,
      "presentation",
    );
    assertAsyncRequestOpen(active, dataset, table);
    const presentation = normalizePresentationResult(completed.presentation, table);
    emitOperationWarnings(dataset, completed, table);
    return presentation;
  } finally {
    activeRequests.delete(requestId);
  }
}

async function readPresentationRange(requestId: string, value: unknown): Promise<unknown> {
  const payload = expectRecord(value, "readPresentationRange payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  const range = normalizeRange(payload.range);
  const active = createActiveAsyncRequest(requestId, dataset.handle, table.handle);
  active.adapter = dataset.adapter;
  activeRequests.set(requestId, active);
  try {
    const initial = await beginTrackedAdapterOperation(
      dataset.adapter,
      active,
      () => dataset.adapter.beginPresentationRange(table.adapterTableHandle, range),
    );
    const completed = await runAdapterValueOperation(
      dataset.adapter,
      dataset.source,
      initial,
      active,
      dataset.adapterId,
      "presentation-range",
    );
    assertAsyncRequestOpen(active, dataset, table);
    const presentation = normalizePresentationRangeResult(completed.presentation, table, range);
    emitOperationWarnings(dataset, completed, table);
    return presentation;
  } finally {
    activeRequests.delete(requestId);
  }
}

function normalizePresentationResult(value: unknown, table: OpenTableState): unknown {
  if (value === null || value === undefined) return null;
  const raw = expectRecord(value, "table presentation");
  if (raw.kind !== "spreadsheet-v1") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter returned an unknown presentation kind");
  }
  if (raw.tableId !== undefined && raw.tableId !== table.tableId) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter presentation belongs to another table");
  }
  return {
    ...raw,
    kind: "spreadsheet-v1",
    tableId: table.tableId,
    revision: numberOr(raw.revision, table.metadata.revision),
  };
}

function normalizePresentationRangeResult(
  value: unknown,
  table: OpenTableState,
  requested: RangeRequest,
): unknown {
  if (value === null || value === undefined) return null;
  const raw = expectRecord(value, "presentation range");
  if (raw.kind !== "spreadsheet-v1") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter returned an unknown presentation range kind");
  }
  if (raw.tableId !== undefined && raw.tableId !== table.tableId) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter presentation range belongs to another table");
  }
  const range = isRecord(raw.range) ? normalizeRange(raw.range) : requested;
  if (
    range.rowStart !== requested.rowStart
    || range.rowCount !== requested.rowCount
    || range.columnStart !== requested.columnStart
    || range.columnCount !== requested.columnCount
  ) {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      "Adapter presentation range is not aligned with the requested range",
    );
  }
  return {
    ...raw,
    kind: "spreadsheet-v1",
    tableId: table.tableId,
    revision: numberOr(raw.revision, table.metadata.revision),
    range,
  };
}

function applyProgressiveOpenStep(
  dataset: DatasetState,
  step: AdapterOperationStep,
  emitEvents: boolean,
): void {
  const value = operationPayload(step, "adapter open progress");
  if (value.operationKind !== "open") {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      "Adapter changed the operation kind while scanning a source",
    );
  }
  const sourceHandle = operationHandle(value.sourceHandle, "sourceHandle");
  if (sourceHandle !== dataset.sourceHandle) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter open changed its sourceHandle");
  }
  const metadata = normalizeMetadata(value.metadata, dataset.tables[0]);
  const progress = value.progress === undefined && step.kind === "complete"
    ? Object.freeze({
        bytesScanned: dataset.source.size,
        rowsDiscovered: discoveredRows(metadata),
        done: true,
      })
    : normalizeOpenProgress(value.progress, dataset.source.size);
  if (progress.bytesScanned < dataset.scanOffset) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan bytes regressed");
  }

  const previousMetadata = JSON.stringify(dataset.metadata);
  const tableDescriptors = normalizeDescriptors(
    Array.isArray(value.tables) ? value.tables : undefined,
    value.table,
    metadata,
  );
  const complete = step.kind === "complete";
  if (complete !== progress.done) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter completion and progress disagree");
  }
  if (progress.rowsDiscovered !== discoveredRows(metadata)) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter progress and metadata row counts disagree");
  }

  if (!progress.done && step.kind === "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan completed before progress reached EOF");
  }
  if (progress.done && step.kind !== "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Completed adapter scan returned another read action");
  }

  dataset.metadata = metadata;
  dataset.tables = tableDescriptors;
  dataset.scanOffset = progress.bytesScanned;
  dataset.scanDone = progress.done;
  if (step.kind !== "complete") {
    dataset.scanOperationHandle = step.operationHandle;
    dataset.scanStep = step;
  } else {
    delete dataset.scanOperationHandle;
    delete dataset.scanStep;
  }

  if (emitEvents && dataset.eventsReady && JSON.stringify(metadata) !== previousMetadata) {
    emitMetadataUpdate(dataset);
  }
  const warnings = Array.isArray(value.warnings)
    ? value.warnings
    : value.warning === undefined ? [] : [value.warning];
  if (!emitEvents || !dataset.eventsReady) {
    dataset.pendingWarnings.push(...warnings);
  } else {
    emitWarnings(dataset, warnings);
  }
  if (emitEvents) {
    publishScanProgress(dataset);
  }
  notifyScanWaiters(dataset);
}

async function scanInitialPrefix(dataset: DatasetState, active: ActiveOpenRequest): Promise<void> {
  while (
    !dataset.closed
    && !dataset.scanDone
    && dataset.scanOffset < Math.min(dataset.source.size, INITIAL_READ_LIMIT_BYTES)
    && discoveredRows(dataset.metadata) < INITIAL_ROW_TARGET
  ) {
    await scanOpenNextChunk(dataset, active, false);
  }
  if (!dataset.closed && dataset.source.size === 0 && !dataset.scanDone) {
    await scanOpenNextChunk(dataset, active, false);
  }
  throwIfCancelled(active);
  if (dataset.closed) {
    throw new ProtocolFault("HANDLE_CLOSED", "The source was closed while opening");
  }
}

async function scanOpenToEnd(dataset: DatasetState): Promise<void> {
  try {
    while (!dataset.closed && !dataset.scanDone) {
      await scanOpenNextChunk(dataset, undefined, true);
    }
  } catch (error) {
    if (dataset.closed) {
      return;
    }
    const failure = error instanceof ProtocolFault
      ? error
      : sourceFailureFault(error)
        ?? new ProtocolFault("RUNTIME_FAILURE", "Background source scanning failed", false, undefined, error);
    dataset.scanError = failure;
    dataset.scanDone = true;
    notifyScanWaiters(dataset);
    try {
      emit({
        event: "runtimeError",
        datasetHandle: dataset.handle,
        tableId: dataset.metadata.tableId,
        revision: dataset.metadata.revision,
        payload: serializeFault(failure, "Background source scanning failed"),
      });
    } finally {
      // A delayed scan failure is terminal for this source but must not poison
      // another loaded adapter or a separate source in the same engine.
      closeDatasetState(dataset, true, failure);
    }
  }
}

async function scanOpenNextChunk(
  dataset: DatasetState,
  active: ActiveOpenRequest | undefined,
  emitEvents: boolean,
): Promise<void> {
  if (dataset.closed || dataset.scanDone) {
    return;
  }
  const step = dataset.scanStep;
  if (!step) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan has no pending read action");
  }
  dataset.scanOperationHandle = step.operationHandle;
  if (active) {
    active.operationHandle = step.operationHandle;
    active.operationRevision = step.operationRevision;
    throwIfCancelled(active);
  }
  let next = await advanceAdapterOperationStep(
    dataset.adapter,
    dataset.source,
    step,
    active,
    dataset.adapterId,
  );
  while (!dataset.closed && next.kind === "pending") {
    next = await advanceAdapterOperationStep(
      dataset.adapter,
      dataset.source,
      next,
      active,
      dataset.adapterId,
    );
  }
  if (dataset.closed) {
    return;
  }
  if (next.kind !== "progress" && next.kind !== "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan did not publish progress");
  }
  applyProgressiveOpenStep(dataset, next, emitEvents);
  if (active) {
    active.operationHandle = dataset.scanOperationHandle;
    if (dataset.scanStep) active.operationRevision = dataset.scanStep.operationRevision;
    else delete active.operationRevision;
  }
}

function normalizeOpenProgress(value: unknown, sourceSize: number): ScanProgress {
  const raw = expectRecord(value, "adapter scan progress");
  const bytesScanned = nonNegativeSafeInteger(raw.bytesScanned, "progress bytesScanned");
  const rowsDiscovered = nonNegativeSafeInteger(raw.rowsDiscovered, "progress rowsDiscovered");
  if (bytesScanned > sourceSize || typeof raw.done !== "boolean") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Delimited scan progress is invalid");
  }
  return Object.freeze({ bytesScanned, rowsDiscovered, done: raw.done });
}

function discoveredRows(metadata: TableMetadata): number {
  return metadata.extent.rows.kind === "unknown" ? 0 : metadata.extent.rows.value;
}

function scanProgress(dataset: DatasetState): ScanProgress {
  return Object.freeze({
    bytesScanned: dataset.scanOffset,
    rowsDiscovered: discoveredRows(dataset.metadata),
    done: dataset.scanDone,
  });
}

function publishScanProgress(dataset: DatasetState): void {
  const progress = scanProgress(dataset);
  if (!dataset.eventsReady) {
    dataset.pendingProgress = progress;
    return;
  }
  emit({
    event: "progress",
    datasetHandle: dataset.handle,
    tableId: dataset.metadata.tableId,
    revision: dataset.metadata.revision,
    payload: {
      sourceHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      revision: dataset.metadata.revision,
      ...progress,
    },
  });
}

function emitMetadataUpdate(dataset: DatasetState): void {
  emit({
    event: "metadata",
    datasetHandle: dataset.handle,
    tableId: dataset.metadata.tableId,
    revision: dataset.metadata.revision,
    payload: dataset.metadata,
  });
  for (const table of tables.values()) {
    if (
      table.datasetHandle === dataset.handle
      && table.tableId === dataset.metadata.tableId
      && !table.closed
    ) {
      table.metadata = dataset.metadata;
      emit({
        event: "metadata",
        datasetHandle: dataset.handle,
        tableHandle: table.handle,
        tableId: table.tableId,
        revision: dataset.metadata.revision,
        payload: dataset.metadata,
      });
    }
  }
}

async function waitUntilIndexed(
  dataset: DatasetState,
  request: RangeRequest,
  active: ActiveRangeRequest,
): Promise<void> {
  if (request.rowCount === 0) {
    return;
  }
  while (!dataset.scanDone && discoveredRows(dataset.metadata) <= request.rowStart) {
    throwIfCancelled(active);
    await new Promise<void>((resolve) => dataset.waiters.add(resolve));
  }
  throwIfCancelled(active);
  if (dataset.scanError) {
    throw dataset.scanError;
  }
}

function notifyScanWaiters(dataset: DatasetState): void {
  const waiters = [...dataset.waiters];
  dataset.waiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

async function readRange(
  requestId: string,
  value: unknown,
  measurement?: OperationMeasurement,
): Promise<{
  kind: "batch";
  data: WireTableBatch;
  transfer: Transferable[];
  release?: () => void;
}> {
  const payload = expectRecord(value, "readRange payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  const runtime = dataset.adapter;
  const request = normalizeRange(payload.range);
  if (payload.displayOnly !== undefined && typeof payload.displayOnly !== "boolean") {
    throw new ProtocolFault(
      "INVALID_ARGUMENT",
      "readRange displayOnly must be a boolean when supplied",
    );
  }
  const displayOnly = payload.displayOnly === true;
  if (rangeRequestsInFlight >= MAX_IN_FLIGHT_RANGES) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `The engine may have at most ${MAX_IN_FLIGHT_RANGES} in-flight range requests`,
      false,
      {
        resource: "range-request-slots",
        required: rangeRequestsInFlight + 1,
        available: MAX_IN_FLIGHT_RANGES,
        maxActiveRanges: MAX_ACTIVE_RANGES,
        maxRangeWaiters: MAX_RANGE_WAITERS,
      },
    );
  }
  rangeRequestsInFlight += 1;
  const active: ActiveRequest = {
    requestId,
    kind: "range",
    datasetHandle: dataset.handle,
    tableHandle: table.handle,
    adapter: runtime,
    cancelled: false,
    cancellation: createRequestCancellation(),
  };
  activeRequests.set(requestId, active);

  let releasePermit: (() => void) | undefined;
  try {
    await waitUntilIndexed(dataset, request, active);
    throwIfCancelled(active);
    try {
      releasePermit = await rangePermits.acquire(requestId);
    } catch (error) {
      if (error instanceof PermitQueueFullError) {
        throw new ProtocolFault(
          "RESOURCE_LIMIT",
          `The range queue may contain at most ${error.maxWaiters} waiters`,
          false,
          {
            resource: "range-waiter-slots",
            required: error.maxWaiters + 1,
            available: error.maxWaiters,
            maxActiveRanges: MAX_ACTIVE_RANGES,
            maxRangeWaiters: error.maxWaiters,
          },
        );
      }
      throw error;
    }
    throwIfCancelled(active);
    const beginningRead = Promise.resolve().then(() =>
      runtime.beginRead(
        table.adapterTableHandle,
        displayOnly ? { ...request, displayOnly: true } : request,
      ),
    );
    void beginningRead.then(
      (lateStep) => {
        if (active.cancelled) cleanupLateAdapterStep(runtime, lateStep, false);
      },
      () => {},
    );
    const initialRead = await awaitOperationStep(beginningRead, active);
    const rawBatch = await runAdapterOperation(
      runtime,
      dataset.source,
      initialRead,
      active,
      dataset.adapterId,
      measurement,
    );

    throwIfCancelled(active);
    const rawBatchBytes = rawBatchByteLength(rawBatch);
    const batchReservation = reserveMemory("batch", rawBatchBytes);
    let batch: WireTableBatch;
    try {
      batch = copyBatch(rawBatch, table, dataset, request);
    } catch (error) {
      batchReservation.release();
      throw error;
    }
    const transfer = collectBatchTransfers(batch);
    return { kind: "batch", data: batch, transfer, release: batchReservation.release };
  } finally {
    activeRequests.delete(requestId);
    releasePermit?.();
    rangeRequestsInFlight -= 1;
  }
}

function cancel(value: unknown): unknown {
  const payload = expectRecord(value, "cancel payload");
  if (typeof payload.targetRequestId !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "cancel targetRequestId must be a string");
  }
  const active = activeRequests.get(payload.targetRequestId);
  if (active) {
    cancelActive(active);
    return { cancelled: true };
  }
  const datasetHandle = openedDatasetsByRequest.get(payload.targetRequestId);
  if (!datasetHandle) {
    return { cancelled: false };
  }
  const dataset = datasets.get(datasetHandle);
  if (!dataset || dataset.closed) {
    openedDatasetsByRequest.delete(payload.targetRequestId);
    return { cancelled: false };
  }
  closeDatasetState(dataset, false);
  return { cancelled: true };
}

function closeTable(value: unknown): unknown {
  const payload = expectRecord(value, "closeTable payload");
  if (typeof payload.tableHandle !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "tableHandle must be a string");
  }
  const table = tables.get(payload.tableHandle);
  if (!table || table.closed) {
    return { closed: true };
  }
  closeTableState(table, true);
  return { closed: true };
}

function closeSource(value: unknown): unknown {
  const payload = expectRecord(value, "closeSource payload");
  if (typeof payload.datasetHandle !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "datasetHandle must be a string");
  }
  const dataset = datasets.get(payload.datasetHandle);
  if (!dataset || dataset.closed) {
    return { closed: true };
  }
  closeDatasetState(dataset, true);
  return { closed: true };
}

async function shutdown(): Promise<unknown> {
  if (shuttingDown) {
    return { closed: true };
  }
  shuttingDown = true;
  const shutdownFailure = new ProtocolFault(
    "HANDLE_CLOSED",
    "The Worker runtime is not available",
  );
  // This includes opens that have not published a dataset yet and asynchronous
  // table/presentation calls that are not represented in the table map.
  for (const active of [...activeRequests.values()]) {
    cancelActive(active, shutdownFailure);
  }
  for (const dataset of [...datasets.values()]) {
    closeDatasetState(dataset, false, shutdownFailure);
  }
  sourceBroker?.shutdown();
  for (const adapter of loadedAdapters.values()) {
    adapter.dispose?.();
  }
  for (const reservation of adapterRuntimeReservations.values()) {
    reservation.release();
  }
  adapterRuntimeReservations.clear();
  loadedAdapters.clear();
  adapterLoads.clear();
  adapterRegistrations.clear();
  return { closed: true };
}

function reserveSourceSlot(): () => void {
  const limits = requireMemoryLimits();
  if (sourceSlotsInUse >= limits.maxSources) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `The engine may retain at most ${limits.maxSources} sources or in-flight opens`,
      false,
      {
        resource: "source-slots",
        required: sourceSlotsInUse + 1,
        available: limits.maxSources,
        maxSources: limits.maxSources,
      },
    );
  }
  sourceSlotsInUse += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    sourceSlotsInUse -= 1;
  };
}

/**
 * Source bytes are a soft Worker cache, never an unbounded second staging
 * area. Newer memory-limit structs may expose a dedicated budget; older
 * handshakes derive one conservatively from the operation slice.
 */
function sourceRangeCacheBudget(limits: MemoryBudgetLimits): number {
  // The range cache is scoped to a dataset/accessor, while the budget is
  // engine-wide.  Reserve an equal slice for the maximum concurrently live
  // sources so two readers cannot multiply the advertised cache allowance.
  return Math.max(1, Math.floor(limits.sourceRangeCacheBytes / Math.max(1, limits.maxSources)));
}

/**
 * Validates the source length before adapter startup. Blob sizes are exposed as
 * JavaScript numbers, while adapter offsets cross a wasm boundary; rejecting
 * non-safe lengths here prevents a rounded value from turning into a bogus
 * range or EOF marker. Large mode adds the explicit 2 GiB host contract.
 */
function assertSourceSize(source: Blob, sourceMode: SourceMode): void {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      "The source size exceeds the JavaScript safe integer range",
      false,
      {
        resource: "source-staging",
        // Keep the serialized detail itself safe even when a host-provided
        // Blob reports Infinity or a value above Number.MAX_SAFE_INTEGER.
        requiredBytes: Number.isFinite(size) && size >= 0
          ? Math.min(Math.floor(size), Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER,
        availableBytes: Number.MAX_SAFE_INTEGER,
      },
    );
  }
  if (sourceMode === "large" && size > MAX_LARGE_SOURCE_BYTES) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `Large source mode supports Blob inputs up to ${MAX_LARGE_SOURCE_BYTES} bytes`,
      false,
      {
        resource: "source-staging",
        requiredBytes: size,
        availableBytes: MAX_LARGE_SOURCE_BYTES,
      },
    );
  }
}

/** Keeps local Arrow/Excel behavior independent from the remote u32 range cap. */
function assertLocalAdapterSourceSize(source: Blob, adapterId: OfficialAdapterId): void {
  if (adapterId !== "tabulark:arrow-ipc" && adapterId !== "tabulark:excel") return;
  if (source.size <= MAX_LARGE_SOURCE_BYTES) return;
  throw new ProtocolFault(
    "RESOURCE_LIMIT",
    `Local ${adapterId === "tabulark:excel" ? "Excel" : "Arrow IPC"} sources support at most ${MAX_LARGE_SOURCE_BYTES} bytes`,
    false,
    {
      resource: "source-staging",
      requiredBytes: source.size,
      availableBytes: MAX_LARGE_SOURCE_BYTES,
    },
  );
}

/** Returns an exact, safe end offset or `undefined` for an invalid range. */
function checkedSourceRangeEnd(
  offset: number,
  length: number,
  sourceLength: number,
): number | undefined {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || !Number.isSafeInteger(sourceLength)
    || sourceLength < 0
    || offset > sourceLength
    || length > sourceLength - offset
  ) {
    return undefined;
  }
  return offset + length;
}

function awaitOperationStep<T>(operation: Promise<T>, active: ActiveRequest): Promise<T> {
  return Promise.race([
    operation,
    active.cancellation.promise.then<never>(() => {
      throw new ProtocolFault(
        "CANCELLED",
        active.kind === "open"
          ? "The open request was cancelled"
          : active.kind === "range"
            ? "The range request was cancelled"
            : "The asynchronous table request was cancelled",
      );
    }),
  ]);
}

/**
 * Starts one of the ABI-v3 table operations while retaining a late-result
 * cleanup. Cancellation can win before an async adapter publishes its first
 * operation handle; when that handle eventually arrives it must still be
 * reclaimed exactly once.
 */
function beginTrackedAdapterOperation(
  adapter: AdapterRuntime,
  active: ActiveAsyncRequest,
  begin: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const beginning = Promise.resolve().then(begin);
  void beginning.then(
    (lateStep) => {
      if (active.cancelled) cleanupLateAdapterStep(adapter, lateStep, false);
    },
    () => {},
  );
  return awaitOperationStep(beginning, active);
}

function assertAsyncRequestOpen(
  active: ActiveAsyncRequest,
  dataset: DatasetState,
  table?: OpenTableState,
): void {
  throwIfCancelled(active);
  if (
    shuttingDown
    || dataset.closed
    || datasets.get(dataset.handle) !== dataset
    || (
      table !== undefined
      && (table.closed || tables.get(table.handle) !== table)
    )
  ) {
    throw new ProtocolFault("HANDLE_CLOSED", "The table or dataset is closed");
  }
}

function adapterTableHandleFromOpenResult(value: unknown): string | number | undefined {
  const raw = isRecord(value) ? value : {};
  const payload = isRecord(raw.payload) ? raw.payload : raw;
  const table = isRecord(payload.table) ? payload.table : payload;
  try {
    return operationHandle(table.tableHandle ?? table.handle ?? value, "openTable tableHandle");
  } catch {
    return undefined;
  }
}

function cleanupLateAdapterStep(
  adapter: AdapterRuntime,
  value: unknown,
  closeSource: boolean,
): void {
  const raw = isRecord(value) ? value : {};
  const payload = isRecord(raw.payload) ? raw.payload : raw;
  if (raw.operationHandle !== undefined && raw.operationHandle !== null) {
    try {
      adapter.cancelOperation(operationHandle(raw.operationHandle, "operationHandle"));
    } catch {
      // Cancellation is best effort after the owning request has terminated.
    }
  }
  if (closeSource && payload.sourceHandle !== undefined && payload.sourceHandle !== null) {
    try {
      adapter.closeSource(operationHandle(payload.sourceHandle, "sourceHandle"));
    } catch {
      // A late, malformed or already-closed source cannot be retained here.
    }
  }
}

function flushPendingDatasetEvents(value: unknown): void {
  const payload = isRecord(value) ? value : {};
  if (typeof payload.datasetHandle !== "string") {
    return;
  }
  const dataset = datasets.get(payload.datasetHandle);
  if (!dataset || dataset.closed || dataset.eventsReady) {
    return;
  }
  dataset.eventsReady = true;
  emitWarnings(dataset, dataset.pendingWarnings.splice(0));
  if (dataset.pendingProgress) {
    const progress = dataset.pendingProgress;
    delete dataset.pendingProgress;
    emit({
      event: "progress",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      revision: dataset.metadata.revision,
      payload: {
        sourceHandle: dataset.handle,
        tableId: dataset.metadata.tableId,
        revision: dataset.metadata.revision,
        ...progress,
      },
    });
  }
}

interface WarningScope {
  readonly tableHandle?: string;
  readonly tableId?: string;
  readonly revision?: number;
}

function appendOperationWarnings(
  target: unknown[],
  ...payloads: readonly unknown[]
): void {
  const seen = new Set(target);
  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const warnings = Array.isArray(payload.warnings)
      ? payload.warnings
      : payload.warning === undefined ? [] : [payload.warning];
    for (const warning of warnings) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      target.push(warning);
    }
  }
}

function emitOperationWarnings(
  dataset: DatasetState,
  payload: Record<string, unknown>,
  table: OpenTableState,
): void {
  const warnings: unknown[] = [];
  appendOperationWarnings(warnings, payload);
  emitWarnings(dataset, warnings, {
    tableHandle: table.handle,
    tableId: table.tableId,
    revision: table.metadata.revision,
  });
}

function emitWarnings(
  dataset: DatasetState,
  warnings: readonly unknown[],
  scope: WarningScope = {},
): void {
  for (const warning of warnings) {
    const raw = isRecord(warning) ? warning : undefined;
    const warningTableId = typeof scope.tableId === "string"
      && dataset.tables.some((table) => table.id === scope.tableId)
      ? scope.tableId
      : typeof raw?.tableId === "string"
      && dataset.tables.some((table) => table.id === raw.tableId)
      ? raw.tableId
      : dataset.metadata.tableId;
    emit({
      event: "warning",
      datasetHandle: dataset.handle,
      ...(scope.tableHandle === undefined ? {} : { tableHandle: scope.tableHandle }),
      tableId: warningTableId,
      ...(scope.revision === undefined ? {} : { revision: scope.revision }),
      payload: {
        ...(raw ?? { kind: "warning", message: String(warning) }),
        handle: scope.tableHandle ?? dataset.handle,
        tableId: warningTableId,
      },
    });
  }
}

function cancelActive(active: ActiveRequest, failure?: ProtocolFault): void {
  if (active.cancelled) {
    if (active.kind !== "open" && active.failure === undefined && failure !== undefined) {
      active.failure = failure;
    }
    return;
  }
  active.cancelled = true;
  if (active.kind === "open" && active.datasetHandle) {
    const dataset = datasets.get(active.datasetHandle);
    // Initial progressive scanning briefly exposes the same private handle
    // through both owners. Transfer cancellation to the dataset close path so
    // a non-idempotent adapter still observes exactly one cancelOperation.
    if (
      dataset
      && active.operationHandle !== undefined
      && dataset.scanOperationHandle === active.operationHandle
    ) {
      delete active.operationHandle;
    }
  }
  cancelOwnedOperation(active);
  active.cancellation.resolve();
  if (active.kind === "open") {
    if (active.datasetHandle) {
      const dataset = datasets.get(active.datasetHandle);
      if (dataset && !dataset.closed) {
        closeDatasetState(dataset, false);
      }
    }
    return;
  }
  if (failure !== undefined) {
    active.failure = failure;
  }
  if (active.kind === "async") return;
  rangePermits.cancel(
    active.requestId,
    failure ?? new ProtocolFault("CANCELLED", "The range request was cancelled"),
  );
  const dataset = datasets.get(active.datasetHandle);
  if (dataset) {
    notifyScanWaiters(dataset);
  }
}

function throwIfCancelled(active: ActiveRequest): void {
  if (active.cancelled) {
    if (active.kind !== "open" && active.failure !== undefined) {
      throw active.failure;
    }
    throw new ProtocolFault(
      "CANCELLED",
      active.kind === "open"
        ? "The open request was cancelled"
        : active.kind === "range"
          ? "The range request was cancelled"
          : "The asynchronous table request was cancelled",
    );
  }
}

function closeTableState(
  table: OpenTableState,
  emitEvent: boolean,
  failure?: ProtocolFault,
): void {
  table.closed = true;
  for (const active of activeRequests.values()) {
    if (active.kind !== "open" && active.tableHandle === table.handle) {
      cancelActive(active, failure);
    }
  }
  tables.delete(table.handle);
  const dataset = datasets.get(table.datasetHandle);
  if (dataset) {
    try {
      dataset.adapter.closeTable(table.adapterTableHandle);
    } catch {
      // A close notification remains idempotent if the adapter already closed it.
    }
  }
  if (emitEvent) {
    emit({
      event: "closed",
      datasetHandle: table.datasetHandle,
      tableHandle: table.handle,
      tableId: table.tableId,
      revision: table.metadata.revision,
      payload: { handle: table.handle, kind: "table" },
    });
  }
}

function closeDatasetState(
  dataset: DatasetState,
  emitEvent: boolean,
  failure?: ProtocolFault,
): void {
  dataset.closed = true;
  dataset.pendingWarnings.length = 0;
  delete dataset.pendingProgress;
  openedDatasetsByRequest.delete(dataset.openRequestId);
  notifyScanWaiters(dataset);
  if (dataset.scanOperationHandle !== undefined) {
    const scanOperationHandle = dataset.scanOperationHandle;
    delete dataset.scanOperationHandle;
    delete dataset.scanStep;
    // During the initial progressive prefix the open request and dataset
    // temporarily reference the same private operation. The dataset takes it
    // here before active requests are cancelled below.
    for (const active of activeRequests.values()) {
      if (
        active.kind === "open"
        && active.datasetHandle === dataset.handle
        && active.operationHandle === scanOperationHandle
      ) {
        delete active.operationHandle;
      }
    }
    try {
      dataset.adapter.cancelOperation(scanOperationHandle);
    } catch {
      // closeSource below remains authoritative and idempotent.
    }
  }
  for (const table of [...tables.values()]) {
    if (table.datasetHandle === dataset.handle) {
      closeTableState(table, emitEvent, failure);
    }
  }
  for (const active of activeRequests.values()) {
    if (active.datasetHandle === dataset.handle) {
      cancelActive(active, failure);
    }
  }
  datasets.delete(dataset.handle);
  dataset.releaseSourceSlot();
  try {
    dataset.adapter.closeSource(dataset.sourceHandle);
  } catch {
    // close() is intentionally idempotent and best effort.
  }
  try {
    dataset.source.close();
  } catch {
    // Provider cleanup is best effort after the adapter/source handles close.
  }
  if (emitEvent) {
    emit({
      event: "closed",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      revision: dataset.metadata.revision,
      payload: { handle: dataset.handle, kind: "source" },
    });
  }
}

/** A validator change invalidates every operation and reader for that dataset. */
function terminateDatasetForSourceFailure(
  source: SourceAccessor,
  failure: ProtocolFault,
): void {
  for (const dataset of [...datasets.values()]) {
    if (dataset.closed || dataset.source !== source) continue;
    try {
      emit({
        event: "runtimeError",
        datasetHandle: dataset.handle,
        tableId: dataset.metadata.tableId,
        revision: dataset.metadata.revision,
        payload: serializeFault(failure, "The source provider failed"),
      });
    } catch {
      // Closing remains authoritative if event delivery itself fails.
    }
    closeDatasetState(dataset, true, failure);
  }
}

function copyBatch(
  value: unknown,
  table: OpenTableState,
  dataset: DatasetState,
  request: RangeRequest,
): WireTableBatch {
  const raw = expectRecord(value, "range batch");
  if (!Array.isArray(raw.columns)) {
    throw new ProtocolFault("RUNTIME_FAILURE", "Range batch columns must be an array");
  }
  const rawRange = isRecord(raw.range) ? raw.range : {};
  const range: ReturnedRange = {
    rowStart: numberOr(rawRange.rowStart, request.rowStart),
    rowCount: numberOr(rawRange.rowCount, 0),
    columnStart: numberOr(rawRange.columnStart, request.columnStart),
    columnCount: numberOr(rawRange.columnCount, raw.columns.length),
  };
  if (raw.layoutVersion !== BATCH_LAYOUT_VERSION) {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      `Adapter returned batch layout ${String(raw.layoutVersion)}; expected ${BATCH_LAYOUT_VERSION}`,
    );
  }
  const buffers = adoptTransferBufferPool(raw.buffers);
  const columns = raw.columns.map((column, index) =>
    copyGenericColumn(column, range.rowCount, index));
  const batch: WireTableBatch = {
    layoutVersion: BATCH_LAYOUT_VERSION,
    tableId: typeof raw.tableId === "string" ? raw.tableId : table.tableId,
    revision: numberOr(raw.revision, table.metadata.revision),
    schemaVersion: numberOr(raw.schemaVersion, table.metadata.schema.version),
    range,
    buffers,
    columns,
    complete: raw.complete !== false,
  };
  // The Worker validates all descriptor boundaries before caching or transfer.
  new ColumnarTableBatch(batch);
  return batch;
}

function rawBatchByteLength(value: unknown): number {
  const raw = expectRecord(value, "range batch");
  if (!Array.isArray(raw.buffers)) {
    throw new ProtocolFault("RUNTIME_FAILURE", "Layout-v1 batch buffers must be an array");
  }
  let total = 0;
  for (const [index, buffer] of raw.buffers.entries()) {
    const bytes = buffer instanceof ArrayBuffer
      ? buffer.byteLength
      : ArrayBuffer.isView(buffer) ? buffer.byteLength : undefined;
    if (bytes === undefined) {
      throw new ProtocolFault("RUNTIME_FAILURE", `batch buffer ${index} must be a Uint8Array`);
    }
    total += bytes;
    if (!Number.isSafeInteger(total)) {
      throw new ProtocolFault(
        "RESOURCE_LIMIT",
        "Batch buffers exceed the safe integer range",
        false,
        {
          resource: "batch",
          requiredBytes: total,
          availableBytes: Number.MAX_SAFE_INTEGER,
        },
      );
    }
  }
  return total;
}

/**
 * Adopts adapter-produced output buffers without another JS-to-JS copy.
 * ABI-v3 requires each pool entry to own its complete, independently
 * transferable ArrayBuffer; Rust creates that backing during its sole
 * WASM-to-JS output copy.
 */
function adoptTransferBufferPool(value: unknown): ArrayBuffer[] {
  if (!Array.isArray(value)) {
    throw new ProtocolFault("RUNTIME_FAILURE", "Layout-v1 batch buffers must be an array");
  }
  const seen = new Set<ArrayBuffer>();
  return value.map((entry, index) => {
    const backing = entry instanceof ArrayBuffer
      ? entry
      : ArrayBuffer.isView(entry)
        && entry.buffer instanceof ArrayBuffer
        && entry.byteOffset === 0
        && entry.byteLength === entry.buffer.byteLength
        ? entry.buffer
        : undefined;
    if (!backing) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `batch buffer ${index} must own a complete transferable ArrayBuffer`,
      );
    }
    if (seen.has(backing)) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `batch buffer ${index} aliases another pool entry`,
      );
    }
    seen.add(backing);
    return backing;
  });
}

function copyGenericColumn(
  value: unknown,
  rows: number,
  index: number,
): WireTableBatch["columns"][number] {
  const raw = expectRecord(value, "batch column");
  return Object.freeze({
    columnId: typeof raw.columnId === "string" ? raw.columnId : `c${index}`,
    native: copyNativeDescriptor(raw.native, rows, 0),
    display: copyDisplayDescriptor(raw.display),
  });
}

function copyNativeDescriptor(value: unknown, fallbackLength: number, depth: number): NativeColumnDescriptor {
  if (depth >= 64) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      "Native descriptor nesting may not exceed 64",
      false,
      { resource: "descriptor-nesting", required: depth + 1, available: 64 },
    );
  }
  const raw = expectRecord(value, "native column descriptor");
  const encoding = typeof raw.encoding === "string" ? raw.encoding : "";
  const common = {
    ...(encoding.length === 0 ? {} : { encoding }),
    dataType: raw.dataType as NativeColumnDescriptor["dataType"],
    length: numberOr(raw.length, fallbackLength),
    ...(raw.validity === undefined ? {} : { validity: copyRegion(raw.validity, "validity") }),
  } satisfies Pick<NativeColumnDescriptor, "dataType" | "length"> & Partial<NativeColumnDescriptor>;
  switch (encoding) {
    case "null":
      return Object.freeze(common);
    case "bitmap":
      return Object.freeze({ ...common, values: copyRegion(raw.values, "bitmap values") });
    case "fixed-width":
      return Object.freeze({ ...common, values: copyRegion(raw.values, "fixed-width values") });
    case "variable-width":
      return Object.freeze({
        ...common,
        offsets: copyRegion(raw.offsets, "variable-width offsets"),
        data: copyRegion(raw.values, "variable-width values"),
      });
    case "view":
      return Object.freeze({
        ...common,
        values: copyRegion(raw.views, "view records"),
        variadicBuffers: Object.freeze(
          (Array.isArray(raw.buffers) ? raw.buffers : []).map((entry) => copyRegion(entry, "view buffer")),
        ),
      });
    case "list":
      return Object.freeze({
        ...common,
        offsets: copyRegion(raw.offsets, "list offsets"),
        children: Object.freeze([copyNativeDescriptor(raw.values, 0, depth + 1)]),
      });
    case "list-view":
      return Object.freeze({
        ...common,
        offsets: copyRegion(raw.offsets, "list-view offsets"),
        sizes: copyRegion(raw.sizes, "list-view sizes"),
        children: Object.freeze([copyNativeDescriptor(raw.values, 0, depth + 1)]),
      });
    case "fixed-size-list":
      return Object.freeze({
        ...common,
        children: Object.freeze([copyNativeDescriptor(raw.values, 0, depth + 1)]),
      });
    case "struct":
      return Object.freeze({
        ...common,
        children: Object.freeze(
          (Array.isArray(raw.fields) ? raw.fields : []).map((field) => copyNativeDescriptor(field, 0, depth + 1)),
        ),
      });
    case "union": {
      const fields = Array.isArray(raw.fields) ? raw.fields : [];
      return Object.freeze({
        ...common,
        // ArrayLayout is an internally tagged Rust enum. Its variant names are
        // kebab-cased, while fields inside struct variants retain their Rust
        // snake_case names unless they are explicitly renamed. Accept both
        // spellings so this generic copier remains compatible with the exact
        // serde-wasm-bindgen envelope as well as canonical JS fixtures.
        typeIds: copyRegion(raw.typeIds ?? raw.type_ids, "union type ids"),
        ...(raw.offsets === undefined ? {} : { unionOffsets: copyRegion(raw.offsets, "union offsets") }),
        children: Object.freeze(fields.map((field) => {
          const entry = expectRecord(field, "union child");
          return Object.freeze({
            ...copyNativeDescriptor(entry.values, 0, depth + 1),
            typeId: numberOr(entry.typeId, 0),
          });
        })),
      });
    }
    case "dictionary":
      return Object.freeze({
        ...common,
        children: Object.freeze([
          copyNativeDescriptor(raw.keys, common.length, depth + 1),
          copyNativeDescriptor(raw.values, 0, depth + 1),
        ]),
        dictionary: copyNativeDescriptor(raw.values, 0, depth + 1),
      });
    case "run-end-encoded":
      return Object.freeze({
        ...common,
        runEnds: copyNativeDescriptor(raw.runEnds ?? raw.run_ends, 0, depth + 1),
        children: Object.freeze([copyNativeDescriptor(raw.values, 0, depth + 1)]),
      });
    default:
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `Adapter returned an unknown native array encoding: ${encoding || "<missing>"}`,
      );
  }
}

function copyDisplayDescriptor(value: unknown): DisplayColumnDescriptor {
  const raw = expectRecord(value, "display column descriptor");
  if (raw.encoding !== "variable-width") {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      "Adapter display columns must use the UTF-8 variable-width layout",
    );
  }
  return Object.freeze({
    encoding: "utf8",
    data: copyRegion(raw.values, "display values"),
    offsets: copyRegion(raw.offsets, "display offsets"),
    ...(raw.validity === undefined ? {} : { validity: copyRegion(raw.validity, "display validity") }),
  });
}

function copyRegion(
  value: unknown,
  name: string,
): { buffer: number; byteOffset?: number; byteLength?: number; bitOffset?: number } {
  const wrapper = expectRecord(value, `${name} region`);
  const raw = isRecord(wrapper.buffer) ? wrapper.buffer : wrapper;
  if (!Number.isSafeInteger(raw.buffer) || (raw.buffer as number) < 0) {
    throw new ProtocolFault("RUNTIME_FAILURE", `${name} region has an invalid buffer index`);
  }
  return Object.freeze({
    buffer: raw.buffer as number,
    ...(raw.byteOffset === undefined ? {} : { byteOffset: numberOr(raw.byteOffset, 0) }),
    ...(raw.byteLength === undefined ? {} : { byteLength: numberOr(raw.byteLength, 0) }),
    ...(wrapper.bitOffset === undefined ? {} : { bitOffset: numberOr(wrapper.bitOffset, 0) }),
  });
}

function collectBatchTransfers(batch: WireTableBatch): Transferable[] {
  const transfers = new Set<ArrayBuffer>();
  for (const buffer of batch.buffers) {
    transfers.add(buffer instanceof ArrayBuffer ? buffer : buffer.buffer as ArrayBuffer);
  }
  return [...transfers];
}

function normalizeMetadata(value: unknown, fallback?: TableDescriptor): TableMetadata {
  const raw = isRecord(value) ? value : {};
  const rawExtent = isRecord(raw.extent) ? raw.extent : {};
  const rawSchema = isRecord(raw.schema) ? raw.schema : {};
  const columns = Array.isArray(rawSchema.columns)
    ? rawSchema.columns.map((column, index) => normalizeColumn(column, index))
    : [];
  return {
    tableId: typeof raw.tableId === "string" ? raw.tableId : fallback?.id ?? "table-0",
    name: typeof raw.name === "string" ? raw.name : fallback?.name ?? "Table 1",
    revision: numberOr(raw.revision, 0),
    extent: {
      rows: normalizeAxis(rawExtent.rows, "at-least", 0),
      columns: normalizeAxis(rawExtent.columns, "exact", columns.length),
    },
    schema: {
      version: numberOr(rawSchema.version, 0),
      columns,
    },
    capabilities: isRecord(raw.capabilities)
      ? {
          ...raw.capabilities,
          randomAccess: raw.capabilities.randomAccess === "full" ? "full" : "indexed-prefix",
          typedValues: raw.capabilities.typedValues === true,
          search: raw.capabilities.search === true,
          sort: raw.capabilities.sort === true,
          filter: raw.capabilities.filter === true,
          multiTable: raw.capabilities.multiTable === true,
        }
      : {
          randomAccess: "indexed-prefix",
          typedValues: false,
          search: false,
          sort: false,
          filter: false,
          multiTable: false,
        },
  };
}

function normalizeColumn(value: unknown, index: number): TableMetadata["schema"]["columns"][number] {
  const raw = isRecord(value) ? value : {};
  return {
    id: typeof raw.id === "string" ? raw.id : `c${index}`,
    name: typeof raw.name === "string" ? raw.name : `column_${index + 1}`,
    index: numberOr(raw.index, index),
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

function normalizeDescriptors(
  value: readonly unknown[] | undefined,
  single: unknown,
  metadata: TableMetadata,
): readonly TableDescriptor[] {
  const candidates = Array.isArray(value) && value.length > 0 ? value : single === undefined ? [] : [single];
  const descriptors = candidates.map((entry, index) => normalizeDescriptor(entry, index));
  return descriptors.length > 0 ? descriptors : [{ id: metadata.tableId, name: metadata.name }];
}

function normalizeDescriptor(value: unknown, index: number): TableDescriptor {
  const raw = isRecord(value) ? value : {};
  return {
    id: typeof raw.id === "string" ? raw.id : `table-${index}`,
    name: typeof raw.name === "string" ? raw.name : `Table ${index + 1}`,
  };
}

function normalizeRange(value: unknown): RangeRequest {
  const raw = expectRecord(value, "range request");
  const request = {
    rowStart: raw.rowStart,
    rowCount: raw.rowCount,
    columnStart: raw.columnStart,
    columnCount: raw.columnCount,
  };
  for (const [name, field] of Object.entries(request)) {
    if (!Number.isSafeInteger(field) || (field as number) < 0) {
      throw new ProtocolFault("INVALID_RANGE", `${name} must be a non-negative safe integer`);
    }
  }
  const rowStart = request.rowStart as number;
  const rowCount = request.rowCount as number;
  const columnStart = request.columnStart as number;
  const columnCount = request.columnCount as number;
  if (
    rowCount > Number.MAX_SAFE_INTEGER - rowStart
    || columnCount > Number.MAX_SAFE_INTEGER - columnStart
  ) {
    throw new ProtocolFault("INVALID_RANGE", "Range end exceeds the JavaScript safe integer range");
  }
  // Keep this guard in the Worker as well as in the public model validator:
  // protocol callers and adapter-produced presentation ranges do not pass
  // through the client-side `validateRange` helper.
  if (
    rowCount > MAX_RANGE_CELLS
    || columnCount > MAX_RANGE_CELLS
    || (rowCount !== 0 && columnCount > Math.floor(MAX_RANGE_CELLS / rowCount))
  ) {
    const cells = rowCount * columnCount;
    const required = Number.isSafeInteger(cells)
      ? Math.max(cells, rowCount, columnCount)
      : Number.MAX_SAFE_INTEGER;
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `A range may contain at most ${MAX_RANGE_CELLS} cells`,
      false,
      {
        resource: "range-cells",
        required,
        available: MAX_RANGE_CELLS,
        cells: Number.isSafeInteger(cells) ? cells : Number.MAX_SAFE_INTEGER,
        limit: MAX_RANGE_CELLS,
      },
    );
  }
  return request as RangeRequest;
}

function numberOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function adapterModuleUrl(id: OfficialAdapterId): string {
  const testUrls = (globalThis as unknown as {
    readonly __tabularkTestOnlyAdapterModuleUrls?: Readonly<Record<string, unknown>>;
  }).__tabularkTestOnlyAdapterModuleUrls;
  const testUrl = testUrls?.[id];
  // This hook is Worker-global rather than protocol-visible. It lets
  // same-realm tests substitute bindings without accepting caller URLs.
  return typeof testUrl === "string" && testUrl.length > 0
    ? testUrl
    : officialAdapterModuleUrl(id);
}

async function loadAdapter(id: string): Promise<WasmAdapter> {
  if (shuttingDown) {
    throw new ProtocolFault("HANDLE_CLOSED", "The Worker runtime is not available");
  }
  const registration = adapterRegistrations.get(id);
  if (!registration) {
    throw new ProtocolFault("INVALID_ARGUMENT", `Adapter ${id} is not registered`);
  }
  const existing = adapterLoads.get(id);
  if (existing) return existing;
  const limits = requireMemoryLimits();
  if (!isOfficialAdapterId(id)) {
    throw new ProtocolFault("INVALID_ARGUMENT", `Adapter ${id} is not official`);
  }
  const runtimeBudgetBytes = adapterRuntimeBudget(id, limits);
  const reservation = reserveMemory("adapter-runtime", runtimeBudgetBytes);
  adapterRuntimeReservations.set(id, reservation);
  const loading = WasmAdapter.load(registration.moduleUrl, registration.id, {
    memoryBudgetBytes: runtimeBudgetBytes,
    indexBudgetBytes: Math.min(limits.indexBudgetBytes, Math.floor(runtimeBudgetBytes / 2)),
    tileCacheBudgetBytes: Math.min(limits.adapterTileCacheBudgetBytes, Math.floor(runtimeBudgetBytes / 2)),
    chunkBytes: Math.min(CHUNK_BYTES, limits.operationBudgetBytes),
    checkpointRows: 1_024,
    maxFieldBytes: limits.maxFieldBytes,
    maxColumns: 16_384,
    maxRangeCells: 250_000,
    maxBatchBytes: limits.maxBatchBytes,
    maxSources: limits.maxSources,
    maxActiveRanges: limits.maxActiveRanges,
  }).then((loaded) => {
    if (shuttingDown) {
      loaded.dispose();
      throw new ProtocolFault("HANDLE_CLOSED", "The Worker runtime is not available");
    }
    loadedAdapters.set(id, loaded);
    return loaded;
  }).catch((error) => {
    adapterLoads.delete(id);
    loadedAdapters.delete(id);
    adapterRuntimeReservations.get(id)?.release();
    adapterRuntimeReservations.delete(id);
    throw error;
  });
  adapterLoads.set(id, loading);
  return loading;
}

function adapterRuntimeBudget(id: OfficialAdapterId, limits: MemoryBudgetLimits): number {
  const registrations = [...adapterRegistrations.keys()].filter(isOfficialAdapterId);
  const totalWeight = registrations.reduce(
    (total, adapterId) => total + officialAdapterManifestEntry(adapterId).resources.runtimeWeight,
    0,
  );
  const weight = officialAdapterManifestEntry(id).resources.runtimeWeight;
  return Math.max(1, Math.floor(limits.adapterRuntimePoolBytes * weight / Math.max(1, totalWeight)));
}

function operationResource(id: OfficialAdapterId): "source-staging" | "compressed-page" {
  return id === "tabulark:parquet" ? "compressed-page" : "source-staging";
}

function operationReadLimit(_id: OfficialAdapterId, limits: MemoryBudgetLimits): number {
  return limits.operationBudgetBytes;
}

function reserveOperationMemory(id: OfficialAdapterId, bytes: number): MemoryReservation {
  return reserveMemory(operationResource(id), bytes);
}

function reserveMemory(
  resource: Parameters<MemoryReservationLedger["reserve"]>[0],
  bytes: number,
): MemoryReservation {
  const ledger = requireMemoryLedger();
  const reservation = ledger.reserve(resource, bytes);
  peakReservationBytes = Math.max(peakReservationBytes, ledger.usedBytes);
  for (const measurement of activeMeasurements) {
    measurement.peakReservationBytes = Math.max(
      measurement.peakReservationBytes,
      ledger.usedBytes,
    );
  }
  return reservation;
}

/**
 * Drives an open only until it either completes or publishes a readable
 * indexed prefix. Unlike a range operation, a published open keeps ownership
 * of its operation handle so the dataset can continue indexing in background.
 */
async function runOpenUntilPublished(
  adapter: AdapterRuntime,
  source: SourceAccessor,
  initial: unknown,
  active: ActiveOpenRequest,
  adapterId: OfficialAdapterId,
  measurement?: OperationMeasurement,
): Promise<PublishedOpenStep> {
  let step = expectAdapterOperationStep(initial, "adapter open result");
  let complete = false;
  let published = false;
  try {
    for (;;) {
      throwIfCancelled(active);
      active.operationHandle = step.operationHandle;
      active.operationRevision = step.operationRevision;
      if (step.kind === "progress") {
        const payload = operationPayload(step, "adapter open progress");
        if (payload.operationKind !== "open") {
          throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter published progress for another operation");
        }
        published = true;
        return Object.freeze({
          step,
          payload,
        });
      }
      if (step.kind === "complete") {
        complete = true;
        delete active.operationHandle;
        delete active.operationRevision;
        const payload = operationPayload(step, "adapter open completion");
        if (payload.operationKind !== "open") {
          throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter completed another operation during open");
        }
        return Object.freeze({
          step,
          payload,
        });
      }
      step = await advanceAdapterOperationStep(
        adapter,
        source,
        step,
        active,
        adapterId,
        measurement,
      );
    }
  } finally {
    if (!complete && !published && active.operationHandle !== undefined) {
      cancelOwnedOperation(active, adapter);
    }
  }
}

async function runAdapterOperation(
  adapter: AdapterRuntime,
  source: SourceAccessor,
  initial: unknown,
  active: ActiveOpenRequest | ActiveRangeRequest,
  adapterId: OfficialAdapterId,
  measurement?: OperationMeasurement,
): Promise<unknown> {
  let step = expectAdapterOperationStep(initial, "adapter range result");
  let complete = false;
  try {
    for (;;) {
      throwIfCancelled(active);
      active.operationHandle = step.operationHandle;
      active.operationRevision = step.operationRevision;
      if (step.kind === "complete") {
        complete = true;
        delete active.operationHandle;
        delete active.operationRevision;
        const payload = operationPayload(step, "adapter range completion");
        if (payload.operationKind !== "read") {
          throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter completed another operation during read");
        }
        return payload.batch ?? payload;
      }
      step = await advanceAdapterOperationStep(
        adapter,
        source,
        step,
        active,
        adapterId,
        measurement,
      );
    }
  } catch (error) {
    closeDatasetForSourceFailure(active, error);
    throw error;
  } finally {
    if (!complete && active.operationHandle !== undefined) {
      cancelOwnedOperation(active, adapter);
    }
  }
}

async function runAdapterValueOperation(
  adapter: AdapterRuntime,
  source: SourceAccessor,
  initial: unknown,
  active: ActiveAsyncRequest,
  adapterId: OfficialAdapterId,
  operationKind: string,
): Promise<Record<string, unknown>> {
  let step = expectAdapterOperationStep(initial, `adapter ${operationKind} result`);
  let complete = false;
  try {
    for (;;) {
      throwIfCancelled(active);
      active.adapter = adapter;
      active.operationHandle = step.operationHandle;
      active.operationRevision = step.operationRevision;
      if (step.kind === "complete") {
        complete = true;
        delete active.operationHandle;
        delete active.operationRevision;
        const payload = operationPayload(step, `adapter ${operationKind} completion`);
        if (payload.operationKind !== operationKind) {
          throw new ProtocolFault(
            "PROTOCOL_INCOMPATIBLE",
            `Adapter completed ${String(payload.operationKind)} while ${operationKind} was active`,
          );
        }
        return payload;
      }
      step = await advanceAdapterOperationStep(
        adapter,
        source,
        step,
        active,
        adapterId,
      );
    }
  } catch (error) {
    closeDatasetForSourceFailure(active, error);
    throw error;
  } finally {
    if (!complete && active.operationHandle !== undefined) {
      cancelOwnedOperation(active, adapter);
    }
  }
}

async function advanceAdapterOperationStep(
  adapter: AdapterRuntime,
  source: SourceAccessor,
  value: AdapterOperationStep,
  active: ActiveOpenRequest | ActiveRangeRequest | ActiveAsyncRequest | undefined,
  adapterId: OfficialAdapterId,
  measurement?: OperationMeasurement,
): Promise<AdapterOperationStep> {
  const step = expectAdapterOperationStep(value, "adapter operation step");
  if (step.kind === "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "A completed adapter operation was continued");
  }
  if (active) {
    active.operationHandle = step.operationHandle;
    active.operationRevision = step.operationRevision;
    throwIfCancelled(active);
  }

  const limits = requireMemoryLimits();
  const readLimit = operationReadLimit(adapterId, limits);
  let totalBytes = 0;
  const ranges = step.actions.map((action) => {
    const end = checkedSourceRangeEnd(action.offset, action.length, source.size);
    totalBytes += action.length;
    if (!Number.isSafeInteger(totalBytes) || end === undefined) {
      throw new ProtocolFault(
        "RESOURCE_LIMIT",
        "Adapter source action exceeds the source or safe integer range",
        false,
        {
          resource: operationResource(adapterId),
          requiredBytes: Number.isSafeInteger(totalBytes) ? totalBytes : Number.MAX_SAFE_INTEGER,
          availableBytes: readLimit,
          offset: action.offset,
          sourceLength: source.size,
        },
      );
    }
    return Object.freeze({ action, end });
  });
  if (totalBytes > readLimit) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      "Adapter operation actions exceed the operation memory budget",
      false,
      {
        resource: operationResource(adapterId),
        requiredBytes: totalBytes,
        availableBytes: readLimit,
        actionCount: ranges.length,
      },
    );
  }

  const reads: ReservedBlobRead[] = [];
  const reservations: Array<MemoryReservation | undefined> = [];
  const results: AdapterActionResult[] = [];
  try {
    if (ranges.length === 0) {
      const yielded = new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      if (active) await awaitOperationStep(yielded, active);
      else await yielded;
    } else {
      // Reserve every action before issuing provider work. If admission fails
      // halfway through, the already-acquired leases are released below.
      try {
        for (const { action } of ranges) {
          reservations.push(reserveOperationMemory(adapterId, action.length));
        }
      } catch (error) {
        for (const reservation of reservations) reservation?.release();
        reservations.length = 0;
        throw error;
      }

      const cancellation = active?.cancellation.promise;
      const sourceOptions: SourceReadOptions = {
        ...(cancellation === undefined ? {} : { cancellation }),
        onProviderRead: (bytes) => recordSourceProviderRead(measurement, bytes),
        onCacheHit: (bytes) => recordSourceCacheHit(measurement, bytes),
      };
      let sourceBytes: readonly ArrayBuffer[];
      try {
        sourceBytes = source.kind === "range" && source.readMany !== undefined
          ? await source.readMany(
            ranges.map(({ action, end }) => ({ offset: action.offset, end })),
            sourceOptions,
          )
          : await readLocalActions(source, ranges, sourceOptions, reservations);
      } catch (error) {
        const failure = sourceFailureFault(error);
        if (failure !== undefined && failure.code !== "CANCELLED") {
          terminateDatasetForSourceFailure(source, failure);
        }
        throw error;
      }
      if (sourceBytes.length !== ranges.length) {
        throw new ProtocolFault("RUNTIME_FAILURE", "The source accessor returned an invalid action count");
      }
      for (let index = 0; index < ranges.length; index += 1) {
        const { action, end } = ranges[index]!;
        const buffer = sourceBytes[index]!;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== action.length) {
          throw new ProtocolFault("RUNTIME_FAILURE", "The source accessor returned an invalid bounded length");
        }
        const reservation = reservations[index];
        if (reservation === undefined) {
          throw new ProtocolFault("CANCELLED", "The source read was cancelled");
        }
        const read: ReservedBlobRead = Object.freeze({
          buffer,
          release: reservation.release,
        });
        reads.push(read);
        const bytes = new Uint8Array(read.buffer);
        results.push(Object.freeze({
          actionIndex: action.actionIndex,
          offset: action.offset,
          bytes,
          eof: end === source.size,
        }));
        if (active) throwIfCancelled(active);
      }
      // Ownership moved into `reads`; the finally block releases each lease.
      reservations.length = 0;
    }
    const continuation = Promise.resolve().then(() => adapter.continueOperation(
      step.operationHandle,
      step.operationRevision,
      results,
    ));
    const rawNext = active
      ? await awaitOperationStep(continuation, active)
      : await continuation;
    const next = expectAdapterOperationStep(rawNext, "adapter continuation result");
    if (
      next.operationHandle !== step.operationHandle
      || next.operationRevision !== step.operationRevision + 1
    ) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        "Adapter continuation returned a missing, duplicate, or stale operation revision",
      );
    }
    if (active) {
      active.operationRevision = next.operationRevision;
    }
    return next;
  } finally {
    for (const read of reads) read.release();
    for (const reservation of reservations) reservation?.release();
  }
}

async function readLocalActions(
  source: SourceAccessor,
  ranges: readonly Readonly<{ action: AdapterReadAction; end: number }>[],
  options: SourceReadOptions,
  reservations: Array<MemoryReservation | undefined>,
): Promise<readonly ArrayBuffer[]> {
  const output: ArrayBuffer[] = new Array(ranges.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const states = ranges.map(() => ({ settled: false, detached: false }));
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= ranges.length) return;
      const { action } = ranges[index]!;
      const state = states[index]!;
      const reservation = reservations[index];
      const perRead: SourceReadOptions = {
        ...options,
        onSettled: () => {
          state.settled = true;
          if (state.detached) reservation?.release();
          options.onSettled?.();
        },
      };
      try {
        output[index] = await source.read(action.offset, action.length, perRead);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ranges.length) }, worker));
  if (failed) {
    // Any early failure (not only cancellation) may leave sibling Blob reads
    // running. Detach unsettled leases from the operation's finally block and
    // release them only when the accessor's onSettled hook fires; otherwise a
    // short provider failure would make the Worker ledger under-count bytes
    // still retained by a pending read.
    for (let index = 0; index < states.length; index += 1) {
      if (states[index]!.settled) continue;
      const reservation = reservations[index];
      if (reservation === undefined) continue;
      reservations[index] = undefined;
      states[index]!.detached = true;
    }
    throw firstError;
  }
  return output;
}

function expectAdapterOperationStep(value: unknown, name: string): AdapterOperationStep {
  const raw = expectRecord(value, name);
  if (raw.kind !== "pending" && raw.kind !== "progress" && raw.kind !== "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} has an invalid kind`);
  }
  const handle = operationHandle(raw.operationHandle, `${name} operationHandle`);
  const revision = nonNegativeSafeInteger(raw.operationRevision, `${name} operationRevision`);
  if (revision === 0) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} operationRevision must be positive`);
  }
  if (!Array.isArray(raw.actions) || raw.actions.length > 32) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} may request at most 32 ranges`);
  }
  const indexes = new Set<number>();
  const actions = raw.actions.map((value, index): AdapterReadAction => {
    const action = expectRecord(value, `${name} action ${index}`);
    if (action.kind !== "read-bytes") {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} requested an unsupported action`);
    }
    const actionIndex = nonNegativeSafeInteger(action.actionIndex, `${name} actionIndex`);
    if (actionIndex > 0xffff_ffff || indexes.has(actionIndex)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} action indexes must be unique u32 values`);
    }
    indexes.add(actionIndex);
    const offset = nonNegativeSafeInteger(action.offset, `${name} action offset`);
    const length = nonNegativeSafeInteger(action.length, `${name} action length`);
    return Object.freeze({ kind: "read-bytes", actionIndex, offset, length });
  });
  const cooperativeYield = raw.cooperativeYield === true;
  if (raw.kind === "complete" && (actions.length !== 0 || cooperativeYield)) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} completion requested more work`);
  }
  if (raw.kind !== "complete" && actions.length === 0 && !cooperativeYield) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} omitted both actions and a yield`);
  }
  if (actions.length !== 0 && cooperativeYield) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} combined actions and a yield`);
  }
  return Object.freeze({
    kind: raw.kind,
    operationHandle: handle,
    operationRevision: revision,
    actions: Object.freeze(actions),
    cooperativeYield,
    ...adapterStepPayload(raw),
  });
}

function adapterStepPayload(raw: Record<string, unknown>): Readonly<{ payload?: unknown }> {
  if (raw.payload !== undefined) return Object.freeze({ payload: raw.payload });
  const payload = Object.fromEntries(Object.entries(raw).filter(([key]) => (
    key !== "kind"
    && key !== "operationHandle"
    && key !== "operationRevision"
    && key !== "actions"
    && key !== "cooperativeYield"
  )));
  return Object.keys(payload).length === 0
    ? Object.freeze({})
    : Object.freeze({ payload: Object.freeze(payload) });
}

function operationPayload(
  step: AdapterOperationStep,
  name: string,
): Record<string, unknown> {
  return expectRecord(step.payload, `${name} payload`);
}

function cancelOwnedOperation(
  active: ActiveRequest,
  adapter = active.adapter,
): void {
  const handle = active.operationHandle;
  if (handle === undefined) return;
  // Take ownership before invoking an adapter: cancellation failures and
  // outer finally blocks must not retry a non-idempotent private operation.
  delete active.operationHandle;
  delete active.operationRevision;
  try {
    adapter?.cancelOperation(handle);
  } catch {
    // The request loop still observes the cancelled flag/original failure.
  }
}

function closeDatasetForSourceFailure(active: ActiveRequest, error: unknown): void {
  if (!("datasetHandle" in active) || active.datasetHandle === undefined) return;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code !== "SOURCE_CHANGED") {
    return;
  }
  const dataset = datasets.get(active.datasetHandle);
  if (dataset && !dataset.closed) {
    closeDatasetState(dataset, true, sourceFailureFault(error));
  }
}

/** Rebuilds faults thrown by the lazily bundled range runtime locally. */
function sourceFailureFault(error: unknown): ProtocolFault | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  const code = error.code;
  if (code !== "SOURCE_CHANGED"
    && code !== "SOURCE_UNAVAILABLE"
    && code !== "RANGE_UNSUPPORTED"
    && code !== "RUNTIME_FAILURE"
    && code !== "RESOURCE_LIMIT"
    && code !== "HANDLE_CLOSED"
    && code !== "CANCELLED"
    && code !== "PROTOCOL_INCOMPATIBLE") {
    return undefined;
  }
  if (error instanceof ProtocolFault) return error;
  return new ProtocolFault(
    code,
    sourceFailureMessage(code),
    error.retryable === true,
    code === "RESOURCE_LIMIT" ? error.details : undefined,
  );
}

function sourceFailureMessage(code: string): string {
  switch (code) {
    case "SOURCE_CHANGED": return "The source changed while it was open";
    case "RANGE_UNSUPPORTED": return "The source range is unsupported";
    case "RUNTIME_FAILURE": return "The source provider returned invalid bytes";
    case "RESOURCE_LIMIT": return "The source exceeds its configured limit";
    case "HANDLE_CLOSED": return "The source is closed";
    case "CANCELLED": return "The source read was cancelled";
    case "PROTOCOL_INCOMPATIBLE": return "The source broker protocol is incompatible";
    default: return "The source provider is unavailable";
  }
}

function operationHandle(value: unknown, name: string): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} must be a handle`);
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireMemoryLimits(): MemoryBudgetLimits {
  if (!memoryLimits) {
    throw new ProtocolFault("HANDLE_CLOSED", "The Worker runtime is not available");
  }
  return memoryLimits;
}

function requireMemoryLedger(): MemoryReservationLedger {
  if (!memoryLedger) {
    throw new ProtocolFault("HANDLE_CLOSED", "The Worker memory ledger is not available");
  }
  return memoryLedger;
}

function requireDataset(value: unknown): DatasetState {
  if (typeof value !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "datasetHandle must be a string");
  }
  const dataset = datasets.get(value);
  if (!dataset || dataset.closed) {
    throw new ProtocolFault("HANDLE_CLOSED", "The dataset is closed");
  }
  return dataset;
}

function requireTable(value: unknown): OpenTableState {
  if (typeof value !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "tableHandle must be a string");
  }
  const table = tables.get(value);
  if (!table || table.closed) {
    throw new ProtocolFault("HANDLE_CLOSED", "The table is closed");
  }
  return table;
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolFault("INVALID_ARGUMENT", `${name} must be an object`);
  }
  return value;
}

function isRequest(value: unknown): value is ProtocolRequest {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.op === "string" &&
    "payload" in value
  );
}

function postSuccess(
  requestId: string,
  kind:
    | "hello"
    | "dataset"
    | "tables"
    | "table"
    | "metadata"
    | "presentation"
    | "presentationRange"
    | "batch"
    | "acknowledged",
  data: unknown,
  transfer: Transferable[] = [],
  telemetry?: Readonly<{
    bytesRead: number;
    peakReservationBytes: number;
    sourceReads: number;
    sourceCacheHitBytes: number;
  }>,
): void {
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: "success",
    result: {
      ...(data === undefined ? { kind } : { kind, data }),
      ...(telemetry === undefined ? {} : { telemetry }),
    },
  };
  scope.postMessage(response, transfer);
}

function postFailure(
  requestId: string,
  error: unknown,
  telemetry?: Readonly<{
    bytesRead: number;
    peakReservationBytes: number;
    sourceReads: number;
    sourceCacheHitBytes: number;
  }>,
): void {
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: "failure",
    error: serializeFault(error, "Worker operation failed"),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
  scope.postMessage(response);
}

function recordSourceRead(measurement: OperationMeasurement | undefined, bytes: number): void {
  if (!measurement || !Number.isSafeInteger(bytes) || bytes < 0) {
    return;
  }
  measurement.bytesRead = Math.min(Number.MAX_SAFE_INTEGER, measurement.bytesRead + bytes);
}

function recordSourceProviderRead(measurement: OperationMeasurement | undefined, bytes: number): void {
  if (!measurement || !Number.isSafeInteger(bytes) || bytes < 0) return;
  measurement.bytesRead = Math.min(Number.MAX_SAFE_INTEGER, measurement.bytesRead + bytes);
  measurement.sourceReads = Math.min(Number.MAX_SAFE_INTEGER, measurement.sourceReads + 1);
}

function recordSourceCacheHit(measurement: OperationMeasurement | undefined, bytes: number): void {
  if (!measurement || !Number.isSafeInteger(bytes) || bytes < 0) return;
  measurement.sourceCacheHitBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    measurement.sourceCacheHitBytes + bytes,
  );
}

function measurementTelemetry(
  measurement: OperationMeasurement | undefined,
): Readonly<{
  bytesRead: number;
  peakReservationBytes: number;
  sourceReads: number;
  sourceCacheHitBytes: number;
}> | undefined {
  if (!measurement) {
    return undefined;
  }
  return Object.freeze({
    bytesRead: measurement.bytesRead,
    peakReservationBytes: measurement.peakReservationBytes,
    sourceReads: measurement.sourceReads,
    sourceCacheHitBytes: measurement.sourceCacheHitBytes,
  });
}

function emit(
  event: Omit<ProtocolEvent, "protocolVersion">,
): void {
  scope.postMessage({ protocolVersion: PROTOCOL_VERSION, ...event });
}

// Keep the operation type checked even though dispatch validates it at runtime.
const _operations: readonly Operation[] = [
  "hello",
  "openSource",
  "listTables",
  "openTable",
  "getMetadata",
  "getPresentation",
  "readPresentationRange",
  "readRange",
  "cancel",
  "closeTable",
  "closeSource",
  "shutdown",
];
void _operations;
