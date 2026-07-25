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
  normalizeDataType,
  MAX_ACTIVE_RANGES,
  MAX_RANGE_WAITERS,
  type MemoryBudgetLimits,
} from "./model.js";
import {
  AsyncPermitQueue,
  ByteLruCache,
  PermitQueueFullError,
  cloneWireTableBatch,
  rangeCacheKey,
  wireBatchByteLength,
} from "./range-cache.js";
import { WasmAdapter } from "./worker/wasm-adapter.js";
import { ProtocolFault, serializeFault } from "./worker/worker-errors.js";

const CHUNK_BYTES = 1024 * 1024;
// wasm32 address arithmetic and Rust `usize` cap one Blob source below 4 GiB.
// This is a format-addressability bound, not an allocation reservation: Arrow
// File opens retain only footer/index state and fetch bounded blocks on demand.
const MAX_ARROW_SOURCE_BYTES = 0xffff_ffff;
const INITIAL_READ_LIMIT_BYTES = 8 * CHUNK_BYTES;
const INITIAL_ROW_TARGET = 256;
const MAX_IN_FLIGHT_RANGES = MAX_ACTIVE_RANGES + MAX_RANGE_WAITERS;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

interface DatasetState {
  readonly handle: string;
  readonly openRequestId: string;
  readonly source: Blob;
  readonly adapterId: "tabulark:delimited" | "tabulark:arrow-ipc";
  readonly adapter: WasmAdapter;
  readonly sourceHandle: string | number;
  tables: readonly TableDescriptor[];
  metadata: TableMetadata;
  scanOffset: number;
  scanDone: boolean;
  scanError?: ProtocolFault;
  scanPromise?: Promise<void>;
  /** Pending adapter-v1 open action owned by the background indexer. */
  scanStep?: Record<string, unknown>;
  scanOperationHandle?: string | number;
  pendingProgress?: ScanProgress;
  closed: boolean;
  eventsReady: boolean;
  readonly pendingWarnings: unknown[];
  readonly waiters: Set<() => void>;
  readonly rangeCache: ByteLruCache<WireTableBatch>;
  /** Releases the engine-wide source slot exactly once. */
  readonly releaseSourceSlot: () => void;
}

interface ScanProgress {
  readonly bytesScanned: number;
  readonly rowsDiscovered: number;
  readonly done: boolean;
}

interface OpenTableState {
  readonly handle: string;
  readonly datasetHandle: string;
  readonly tableId: string;
  readonly adapterTableHandle: string | number;
  closed: boolean;
}

interface ActiveOpenRequest {
  readonly requestId: string;
  readonly kind: "open";
  datasetHandle?: string;
  adapter?: WasmAdapter;
  operationHandle?: string | number;
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
  adapter?: WasmAdapter;
  operationHandle?: string | number;
  readonly cancellation: RequestCancellation;
}

type ActiveRequest = ActiveOpenRequest | ActiveRangeRequest;

interface RequestCancellation {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface HelloPayload {
  readonly adapters: readonly AdapterRegistrationPayload[];
  readonly memoryBudgetBytes: number;
}

interface AdapterRegistrationPayload {
  readonly id: "tabulark:delimited" | "tabulark:arrow-ipc";
  readonly moduleUrl: string;
}

interface OpenSourcePayload {
  readonly source: Blob | ArrayBuffer;
  readonly adapterId: "tabulark:delimited" | "tabulark:arrow-ipc";
  readonly options: Record<string, unknown>;
}

let shuttingDown = false;
let nextDatasetHandle = 1;
let nextTableHandle = 1;
let rangeCacheBudgetBytes = 0;
let memoryLimits: MemoryBudgetLimits | undefined;
let sourceSlotsInUse = 0;
let rangeRequestsInFlight = 0;
let adapterRegistrations = new Map<string, AdapterRegistrationPayload>();
const adapterLoads = new Map<string, Promise<WasmAdapter>>();
const loadedAdapters = new Map<string, WasmAdapter>();
const datasets = new Map<string, DatasetState>();
const tables = new Map<string, OpenTableState>();
const activeRequests = new Map<string, ActiveRequest>();
const openedDatasetsByRequest = new Map<string, string>();
const rangePermits = new AsyncPermitQueue(MAX_ACTIVE_RANGES, MAX_RANGE_WAITERS);

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
});

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

  try {
    const result = await runOperation(request);
    postSuccess(request.requestId, result.kind, result.data, result.transfer);
    if (request.op === "listTables") {
      flushPendingDatasetEvents(request.payload);
    }
    if (request.op === "shutdown") {
      setTimeout(() => scope.close(), 0);
    }
  } catch (error) {
    postFailure(request.requestId, error);
  }
}

async function runOperation(
  request: ProtocolRequest,
): Promise<{ kind: Parameters<typeof postSuccess>[1]; data?: unknown; transfer?: Transferable[] }> {
  switch (request.op) {
    case "hello":
      return { kind: "hello", data: await hello(request.payload) };
    case "openSource":
      return { kind: "dataset", data: await openSource(request.requestId, request.payload) };
    case "listTables":
      return { kind: "tables", data: listTables(request.payload) };
    case "openTable":
      return { kind: "table", data: openTable(request.payload) };
    case "getMetadata":
      return { kind: "metadata", data: getMetadata(request.payload) };
    case "readRange":
      return readRange(request.requestId, request.payload);
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
      shutdown();
      return { kind: "acknowledged" };
    default:
      throw new ProtocolFault("INVALID_ARGUMENT", `Unknown operation: ${String(request.op)}`);
  }
}

async function hello(value: unknown): Promise<unknown> {
  if (memoryLimits) {
    return helloResult();
  }
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
      || (entry.id !== "tabulark:delimited" && entry.id !== "tabulark:arrow-ipc")
      || typeof entry.moduleUrl !== "string"
      || entry.moduleUrl.length === 0
    ) {
      throw new ProtocolFault("INVALID_ARGUMENT", "hello contains an invalid official adapter");
    }
    if (registrations.has(entry.id)) {
      throw new ProtocolFault("INVALID_ARGUMENT", `Adapter ${entry.id} is registered more than once`);
    }
    registrations.set(entry.id, Object.freeze({ id: entry.id, moduleUrl: entry.moduleUrl }));
  }

  const limits = deriveMemoryBudgetLimits(payload.memoryBudgetBytes);
  adapterRegistrations = registrations;
  memoryLimits = limits;
  rangeCacheBudgetBytes = limits.workerDatasetRangeCacheBytes;
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

function createRequestCancellation(): RequestCancellation {
  let resolveCancellation!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  return { promise, resolve: resolveCancellation };
}

async function openSource(requestId: string, value: unknown): Promise<unknown> {
  const active = createActiveOpenRequest(requestId);
  activeRequests.set(requestId, active);
  let dataset: DatasetState | undefined;
  let sourceHandle: string | number | undefined;
  let releaseSourceSlot: (() => void) | undefined;
  let opened = false;

  try {
    const limits = requireMemoryLimits();
    const payload = expectRecord(value, "openSource payload") as unknown as OpenSourcePayload;
    if (payload.adapterId !== "tabulark:delimited" && payload.adapterId !== "tabulark:arrow-ipc") {
      throw new ProtocolFault("INVALID_ARGUMENT", "openSource adapterId is not registered");
    }
    if (!isRecord(payload.options) || Array.isArray(payload.options)) {
      throw new ProtocolFault("INVALID_ARGUMENT", "openSource options must be an object");
    }
    let source: Blob;
    if (payload.source instanceof Blob) {
      source = payload.source;
    } else if (payload.source instanceof ArrayBuffer) {
      if (payload.source.byteLength > limits.maxArrayBufferBytes) {
        throw new ProtocolFault(
          "RESOURCE_LIMIT",
          `ArrayBuffer sources larger than ${limits.maxArrayBufferBytes} bytes must be supplied as a Blob`,
        );
      }
      source = new Blob([payload.source]);
    } else {
      throw new ProtocolFault("INVALID_ARGUMENT", "source must be a Blob or ArrayBuffer");
    }
    releaseSourceSlot = reserveSourceSlot();

    const runtime = await awaitOperationStep(loadAdapter(payload.adapterId), active);
    active.adapter = runtime;

    const initialStep = runtime.beginOpen(adapterOpenOptions(payload, limits), source.size);
    const openRaw = await runOpenUntilPublished(runtime, source, initialStep, active);
    const progressiveOpen = isProgressiveOpenStep(openRaw);
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
      source,
      adapterId: payload.adapterId,
      adapter: runtime,
      sourceHandle,
      tables: initialTables,
      metadata: initialMetadata,
      scanOffset: progressiveOpen ? 0 : source.size,
      scanDone: !progressiveOpen,
      closed: false,
      eventsReady: false,
      pendingWarnings: progressiveOpen
        ? []
        : Array.isArray(openRaw.warnings) ? [...openRaw.warnings] : [],
      waiters: new Set(),
      rangeCache: new ByteLruCache(rangeCacheBudgetBytes),
      releaseSourceSlot,
    };
    dataset = openedDataset;
    datasets.set(datasetHandle, openedDataset);
    releaseSourceSlot = undefined;
    active.datasetHandle = datasetHandle;

    if (progressiveOpen) {
      applyProgressiveOpenStep(openedDataset, openRaw, false);
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
      releaseSourceSlot?.();
    }
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
      // Keep every Arrow sublimit derived from the engine budget. Omitting
      // these fields lets serde fill ArrowIpcLimits with its 256 MiB defaults;
      // that makes a valid low-budget engine (the 8 MiB minimum in particular)
      // fail validation before it can read a single IPC byte.
      maxBlockBytes: Math.min(
        64 * 1024 * 1024,
        Math.max(1, Math.floor(limits.operationBudgetBytes / 4)),
      ),
      streamChunkBytes: Math.min(
        1024 * 1024,
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

function listTables(value: unknown): unknown {
  const payload = expectRecord(value, "listTables payload");
  const dataset = requireDataset(payload.datasetHandle);
  return dataset.tables;
}

function openTable(value: unknown): unknown {
  const payload = expectRecord(value, "openTable payload");
  const dataset = requireDataset(payload.datasetHandle);
  if (typeof payload.tableId !== "string") {
    throw new ProtocolFault("INVALID_ARGUMENT", "tableId must be a string");
  }
  if (!dataset.tables.some((table) => table.id === payload.tableId)) {
    throw new ProtocolFault("INVALID_ARGUMENT", `Unknown table: ${payload.tableId}`);
  }

  const tableHandle = `t${nextTableHandle++}`;
  const result = dataset.adapter.openTable(dataset.sourceHandle, payload.tableId);
  const raw = isRecord(result) ? result : {};
  const adapterTableHandle = operationHandle(
    raw.tableHandle ?? raw.handle ?? result,
    "openTable tableHandle",
  );
  tables.set(tableHandle, {
    handle: tableHandle,
    datasetHandle: dataset.handle,
    tableId: payload.tableId,
    adapterTableHandle,
    closed: false,
  });
  return {
    id: payload.tableId,
    name: dataset.tables.find((descriptor) => descriptor.id === payload.tableId)?.name ?? payload.tableId,
    tableHandle,
  };
}

function getMetadata(value: unknown): unknown {
  const payload = expectRecord(value, "getMetadata payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  return normalizeMetadata(
    dataset.adapter.metadata(table.adapterTableHandle),
    { id: table.tableId, name: dataset.metadata.name },
  );
}

/** Adapter ABI v1 may publish a readable indexed prefix beside its next byte action. */
function isProgressiveOpenStep(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.action)) {
    return false;
  }
  return value.action.kind === "read-bytes"
    && value.sourceHandle !== undefined
    && value.metadata !== undefined
    && isRecord(value.progress);
}

function applyProgressiveOpenStep(
  dataset: DatasetState,
  value: Record<string, unknown>,
  emitEvents: boolean,
): void {
  const sourceHandle = operationHandle(value.sourceHandle, "sourceHandle");
  if (sourceHandle !== dataset.sourceHandle) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter open changed its sourceHandle");
  }
  const progress = normalizeOpenProgress(value.progress, dataset.source.size);
  if (progress.bytesScanned < dataset.scanOffset) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan bytes regressed");
  }

  const previousMetadata = JSON.stringify(dataset.metadata);
  const metadata = normalizeMetadata(value.metadata, dataset.tables[0]);
  const tableDescriptors = normalizeDescriptors(
    Array.isArray(value.tables) ? value.tables : undefined,
    value.table,
    metadata,
  );
  const complete = value.status === "complete";
  if (complete !== progress.done) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter completion and progress disagree");
  }
  if (progress.rowsDiscovered !== discoveredRows(metadata)) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter progress and metadata row counts disagree");
  }

  const action = isRecord(value.action) ? value.action : undefined;
  if (!progress.done && !action) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan returned neither progress action nor completion");
  }
  if (progress.done && action) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Completed adapter scan returned another read action");
  }
  if (
    action
    && nonNegativeSafeInteger(action.offset, "read-bytes offset") !== progress.bytesScanned
  ) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action does not begin at the scanned prefix");
  }

  dataset.metadata = metadata;
  dataset.tables = tableDescriptors;
  dataset.scanOffset = progress.bytesScanned;
  dataset.scanDone = progress.done;
  if (action) {
    dataset.scanOperationHandle = operationHandle(value.operationHandle, "operationHandle");
    dataset.scanStep = value;
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
      : new ProtocolFault("RUNTIME_FAILURE", "Background source scanning failed", false, undefined, error);
    dataset.scanError = failure;
    dataset.scanDone = true;
    delete dataset.scanStep;
    delete dataset.scanOperationHandle;
    notifyScanWaiters(dataset);
    try {
      emit({
        event: "runtimeError",
        datasetHandle: dataset.handle,
        tableId: dataset.metadata.tableId,
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
  const action = isRecord(step.action) ? step.action : undefined;
  if (!action || action.kind !== "read-bytes") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter scan requested an unsupported action");
  }
  const operation = operationHandle(step.operationHandle, "operationHandle");
  const offset = nonNegativeSafeInteger(action.offset, "read-bytes offset");
  const length = nonNegativeSafeInteger(action.length, "read-bytes length");
  const limits = requireMemoryLimits();
  if (
    length > limits.operationBudgetBytes
    || !Number.isSafeInteger(offset + length)
    || offset + length > dataset.source.size
  ) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      "Adapter scan read-bytes action exceeds the source or engine memory budget",
      false,
      { offset, length, sourceLength: dataset.source.size, limit: limits.operationBudgetBytes },
    );
  }
  dataset.scanOperationHandle = operation;
  if (active) {
    active.operationHandle = operation;
    throwIfCancelled(active);
  }
  const read = dataset.source.slice(offset, offset + length).arrayBuffer();
  const bytes = new Uint8Array(active
    ? await awaitOperationStep(read, active)
    : await read);
  if (dataset.closed) {
    return;
  }
  if (active) {
    throwIfCancelled(active);
  }
  const next = expectRecord(
    dataset.adapter.continueOperation(operation, offset, bytes, offset + length >= dataset.source.size),
    "adapter scan result",
  );
  if (dataset.closed) {
    return;
  }
  applyProgressiveOpenStep(dataset, next, emitEvents);
  if (active) {
    active.operationHandle = dataset.scanOperationHandle;
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
    payload: {
      sourceHandle: dataset.handle,
      ...progress,
    },
  });
}

function emitMetadataUpdate(dataset: DatasetState): void {
  emit({
    event: "metadata",
    datasetHandle: dataset.handle,
    tableId: dataset.metadata.tableId,
    payload: dataset.metadata,
  });
  for (const table of tables.values()) {
    if (table.datasetHandle === dataset.handle && !table.closed) {
      emit({
        event: "metadata",
        datasetHandle: dataset.handle,
        tableHandle: table.handle,
        tableId: table.tableId,
        payload: { ...dataset.metadata, tableId: table.tableId },
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
): Promise<{ kind: "batch"; data: WireTableBatch; transfer: Transferable[] }> {
  const payload = expectRecord(value, "readRange payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
  const runtime = dataset.adapter;
  const request = normalizeRange(payload.range);
  const key = rangeCacheKey(
    table.tableId,
    dataset.metadata.revision,
    dataset.metadata.schema.version,
    request,
  );
  const cached = dataset.rangeCache.get(key);
  if (cached) {
    const batch = cloneWireTableBatch(cached);
    return { kind: "batch", data: batch, transfer: collectBatchTransfers(batch) };
  }
  if (rangeRequestsInFlight >= MAX_IN_FLIGHT_RANGES) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `The engine may have at most ${MAX_IN_FLIGHT_RANGES} in-flight range requests`,
      false,
      { maxActiveRanges: MAX_ACTIVE_RANGES, maxRangeWaiters: MAX_RANGE_WAITERS },
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
          { maxActiveRanges: MAX_ACTIVE_RANGES, maxRangeWaiters: error.maxWaiters },
        );
      }
      throw error;
    }
    throwIfCancelled(active);
    const rawBatch = await runAdapterOperation(
      runtime,
      dataset.source,
      runtime.beginRead(table.adapterTableHandle, request),
      active,
    );

    throwIfCancelled(active);
    const batch = copyBatch(rawBatch, table, dataset, request);
    // A range truncated at the current indexed prefix must be re-read after
    // the Stream grows; retaining it under the original request would turn a
    // transient prefix boundary into a stale permanent cache hit.
    if (batch.complete) {
      const cachedBatch = cloneWireTableBatch(batch);
      dataset.rangeCache.set(
        rangeCacheKey(table.tableId, batch.revision, batch.schemaVersion, request),
        cachedBatch,
        wireBatchByteLength(cachedBatch),
      );
    }
    const transfer = collectBatchTransfers(batch);
    return { kind: "batch", data: batch, transfer };
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

function shutdown(): unknown {
  if (shuttingDown) {
    return { closed: true };
  }
  shuttingDown = true;
  for (const dataset of [...datasets.values()]) {
    closeDatasetState(dataset, false);
  }
  for (const adapter of loadedAdapters.values()) {
    adapter.dispose();
  }
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
      { maxSources: limits.maxSources },
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

function awaitOperationStep<T>(operation: Promise<T>, active: ActiveRequest): Promise<T> {
  return Promise.race([
    operation,
    active.cancellation.promise.then<never>(() => {
      throw new ProtocolFault(
        "CANCELLED",
        active.kind === "open" ? "The open request was cancelled" : "The range request was cancelled",
      );
    }),
  ]);
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
      payload: {
        sourceHandle: dataset.handle,
        ...progress,
      },
    });
  }
}

function emitWarnings(dataset: DatasetState, warnings: readonly unknown[]): void {
  for (const warning of warnings) {
    emit({
      event: "warning",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      payload: {
        handle: dataset.handle,
        ...(isRecord(warning) ? warning : { kind: "warning", message: String(warning) }),
      },
    });
  }
}

function cancelActive(active: ActiveRequest, failure?: ProtocolFault): void {
  if (active.cancelled) {
    if (active.kind === "range" && active.failure === undefined && failure !== undefined) {
      active.failure = failure;
    }
    return;
  }
  active.cancelled = true;
  if (active.operationHandle !== undefined) {
    try {
      active.adapter?.cancelOperation(active.operationHandle);
    } catch {
      // The request loop still observes the cancelled flag.
    }
  }
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
    if (active.kind === "range" && active.failure !== undefined) {
      throw active.failure;
    }
    throw new ProtocolFault(
      "CANCELLED",
      active.kind === "open" ? "The open request was cancelled" : "The range request was cancelled",
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
    if (active.kind === "range" && active.tableHandle === table.handle) {
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
  dataset.rangeCache.clear();
  notifyScanWaiters(dataset);
  if (dataset.scanOperationHandle !== undefined) {
    try {
      dataset.adapter.cancelOperation(dataset.scanOperationHandle);
    } catch {
      // closeSource below remains authoritative and idempotent.
    }
    delete dataset.scanOperationHandle;
    delete dataset.scanStep;
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
  if (emitEvent) {
    emit({
      event: "closed",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      payload: { handle: dataset.handle, kind: "source" },
    });
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
  const buffers = copyBufferPool(raw.buffers);
  const columns = raw.columns.map((column, index) =>
    copyGenericColumn(column, range.rowCount, index));
  const batch: WireTableBatch = {
    layoutVersion: BATCH_LAYOUT_VERSION,
    tableId: typeof raw.tableId === "string" ? raw.tableId : table.tableId,
    revision: numberOr(raw.revision, dataset.metadata.revision),
    schemaVersion: numberOr(raw.schemaVersion, dataset.metadata.schema.version),
    range,
    buffers,
    columns,
    complete: raw.complete !== false,
  };
  // The Worker validates all descriptor boundaries before caching or transfer.
  new ColumnarTableBatch(batch);
  return batch;
}

function copyBufferPool(value: unknown): ArrayBuffer[] {
  if (!Array.isArray(value)) {
    throw new ProtocolFault("RUNTIME_FAILURE", "Layout-v1 batch buffers must be an array");
  }
  return value.map((entry, index) => copyBytes(entry, `batch buffer ${index}`).buffer as ArrayBuffer);
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
    throw new ProtocolFault("RESOURCE_LIMIT", "Native descriptor nesting may not exceed 64");
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

function copyBytes(value: unknown, name: string): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return Uint8Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new ProtocolFault("RUNTIME_FAILURE", `${name} must be a Uint8Array`);
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
  return request as RangeRequest;
}

function numberOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
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
  const loading = WasmAdapter.load(registration.moduleUrl, registration.id, {
    memoryBudgetBytes: limits.adapterRuntimeBudgetBytes,
    indexBudgetBytes: limits.indexBudgetBytes,
    tileCacheBudgetBytes: limits.adapterTileCacheBudgetBytes,
    chunkBytes: Math.min(CHUNK_BYTES, limits.operationBudgetBytes),
    checkpointRows: 1_024,
    maxFieldBytes: limits.maxFieldBytes,
    maxColumns: 16_384,
    maxRangeCells: 250_000,
    maxBatchBytes: limits.maxBatchBytes,
    maxSources: limits.maxSources,
    maxActiveRanges: limits.maxActiveRanges,
  }).then((loaded) => {
    loadedAdapters.set(id, loaded);
    return loaded;
  }).catch((error) => {
    adapterLoads.delete(id);
    loadedAdapters.delete(id);
    throw error;
  });
  adapterLoads.set(id, loading);
  return loading;
}

/**
 * Drives an open only until it either completes or publishes a readable
 * indexed prefix. Unlike a range operation, a published open keeps ownership
 * of its operation handle so the dataset can continue indexing in background.
 */
async function runOpenUntilPublished(
  adapter: WasmAdapter,
  source: Blob,
  initial: unknown,
  active: ActiveOpenRequest,
): Promise<Record<string, unknown>> {
  let step = initial;
  let complete = false;
  let published = false;
  try {
    for (;;) {
      throwIfCancelled(active);
      const raw = expectRecord(step, "adapter open result");
      if (isProgressiveOpenStep(raw)) {
        published = true;
        return raw;
      }
      const action = isRecord(raw.action) ? raw.action : undefined;
      if (!action) {
        if (raw.status !== "complete") {
          throw new ProtocolFault(
            "PROTOCOL_INCOMPATIBLE",
            "Adapter open returned neither a read action, an indexed prefix, nor completion",
          );
        }
        complete = true;
        delete active.operationHandle;
        return raw;
      }
      if (action.kind !== "read-bytes") {
        throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter requested an unsupported action");
      }
      active.operationHandle = operationHandle(raw.operationHandle, "operationHandle");
      const offset = nonNegativeSafeInteger(action.offset, "read-bytes offset");
      const length = nonNegativeSafeInteger(action.length, "read-bytes length");
      const limits = requireMemoryLimits();
      if (
        length > limits.operationBudgetBytes
        || !Number.isSafeInteger(offset + length)
        || offset + length > source.size
      ) {
        throw new ProtocolFault(
          "RESOURCE_LIMIT",
          "Adapter read-bytes action exceeds the source or engine memory budget",
          false,
          { offset, length, sourceLength: source.size, limit: limits.operationBudgetBytes },
        );
      }
      const read = source.slice(offset, offset + length).arrayBuffer();
      const bytes = new Uint8Array(await awaitOperationStep(read, active));
      throwIfCancelled(active);
      step = adapter.continueOperation(
        active.operationHandle,
        offset,
        bytes,
        offset + length >= source.size,
      );
    }
  } finally {
    if (!complete && !published && active.operationHandle !== undefined) {
      try {
        adapter.cancelOperation(active.operationHandle);
      } catch {
        // Preserve the open failure while still making cleanup best effort.
      }
      delete active.operationHandle;
    }
  }
}

async function runAdapterOperation(
  adapter: WasmAdapter,
  source: Blob,
  initial: unknown,
  active: ActiveOpenRequest | ActiveRangeRequest,
): Promise<unknown> {
  let step = initial;
  let complete = false;
  try {
    for (;;) {
      throwIfCancelled(active);
      const raw = expectRecord(step, "adapter operation result");
      const action = isRecord(raw.action) ? raw.action : undefined;
      if (!action) {
        if (raw.status !== "complete") {
          throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter returned neither a read action nor completion");
        }
        complete = true;
        delete active.operationHandle;
        return raw.batch ?? step;
      }
      if (action.kind !== "read-bytes") {
        throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter requested an unsupported action");
      }
      active.operationHandle = operationHandle(raw.operationHandle, "operationHandle");
      const offset = nonNegativeSafeInteger(action.offset, "read-bytes offset");
      const length = nonNegativeSafeInteger(action.length, "read-bytes length");
      const limits = requireMemoryLimits();
      if (
        length > limits.operationBudgetBytes
        || !Number.isSafeInteger(offset + length)
        || offset + length > source.size
      ) {
        throw new ProtocolFault(
          "RESOURCE_LIMIT",
          "Adapter read-bytes action exceeds the source or engine memory budget",
          false,
          { offset, length, sourceLength: source.size, limit: limits.operationBudgetBytes },
        );
      }
      const read = source.slice(offset, offset + length).arrayBuffer();
      const bytes = new Uint8Array(await awaitOperationStep(read, active));
      throwIfCancelled(active);
      step = adapter.continueOperation(
        active.operationHandle,
        offset,
        bytes,
        offset + length >= source.size,
      );
    }
  } finally {
    if (!complete && active.operationHandle !== undefined) {
      try {
        adapter.cancelOperation(active.operationHandle);
      } catch {
        // Preserve the operation failure while still making cleanup best effort.
      }
      delete active.operationHandle;
    }
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
  kind: "hello" | "dataset" | "tables" | "table" | "metadata" | "batch" | "acknowledged",
  data: unknown,
  transfer: Transferable[] = [],
): void {
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: "success",
    result: data === undefined ? { kind } : { kind, data },
  };
  scope.postMessage(response, transfer);
}

function postFailure(requestId: string, error: unknown): void {
  const response: ProtocolResponse = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: "failure",
    error: serializeFault(error, "Worker operation failed"),
  };
  scope.postMessage(response);
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
  "readRange",
  "cancel",
  "closeTable",
  "closeSource",
  "shutdown",
];
void _operations;
