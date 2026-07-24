/// <reference lib="webworker" />

import {
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
  WireTableBatch,
  WireUtf8Column,
} from "./model.js";
import {
  deriveMemoryBudgetLimits,
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
import { WasmAdapter, type WasmRangeStart, type WasmScanUpdate } from "./worker/wasm-adapter.js";
import { ProtocolFault, serializeFault } from "./worker/worker-errors.js";

const CHUNK_BYTES = 1024 * 1024;
const INITIAL_READ_LIMIT_BYTES = 8 * CHUNK_BYTES;
const INITIAL_ROW_TARGET = 256;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

interface DatasetState {
  readonly handle: string;
  readonly openRequestId: string;
  readonly source: Blob;
  readonly sourceHandle: string | number;
  tables: readonly TableDescriptor[];
  metadata: TableMetadata;
  scanOffset: number;
  scanDone: boolean;
  scanError?: ProtocolFault;
  scanPromise?: Promise<void>;
  closed: boolean;
  readonly waiters: Set<() => void>;
  readonly rangeCache: ByteLruCache<WireTableBatch>;
}

interface OpenTableState {
  readonly handle: string;
  readonly datasetHandle: string;
  readonly tableId: string;
  closed: boolean;
}

interface ActiveOpenRequest {
  readonly requestId: string;
  readonly kind: "open";
  datasetHandle?: string;
  cancelled: boolean;
  readonly cancellation: OpenCancellation;
}

interface ActiveRangeRequest {
  readonly requestId: string;
  readonly kind: "range";
  readonly datasetHandle: string;
  readonly tableHandle: string;
  cancelled: boolean;
  cursorHandle?: string | number;
}

type ActiveRequest = ActiveOpenRequest | ActiveRangeRequest;

interface OpenCancellation {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface HelloPayload {
  readonly wasmModuleUrl: string;
  readonly memoryBudgetBytes: number;
}

interface OpenSourcePayload {
  readonly source: Blob | ArrayBuffer;
  readonly format: "csv" | "tsv";
  readonly options: Record<string, unknown>;
}

let adapter: WasmAdapter | undefined;
let shuttingDown = false;
let nextDatasetHandle = 1;
let nextTableHandle = 1;
let rangeCacheBudgetBytes = 0;
let memoryLimits: MemoryBudgetLimits | undefined;
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
  if (adapter) {
    return helloResult();
  }
  const payload = expectRecord(value, "hello payload") as unknown as HelloPayload;
  if (typeof payload.wasmModuleUrl !== "string" || payload.wasmModuleUrl.length === 0) {
    throw new ProtocolFault("INVALID_ARGUMENT", "wasmModuleUrl must be a non-empty string");
  }
  if (!Number.isSafeInteger(payload.memoryBudgetBytes) || payload.memoryBudgetBytes <= 0) {
    throw new ProtocolFault("INVALID_ARGUMENT", "memoryBudgetBytes must be a positive safe integer");
  }

  const limits = deriveMemoryBudgetLimits(payload.memoryBudgetBytes);
  adapter = await WasmAdapter.load(payload.wasmModuleUrl, {
    memoryBudgetBytes: payload.memoryBudgetBytes,
    indexBudgetBytes: limits.indexBudgetBytes,
    tileCacheBudgetBytes: limits.workerRangeCacheBytes,
    chunkBytes: CHUNK_BYTES,
    checkpointRows: 1_024,
    maxFieldBytes: limits.maxFieldBytes,
    maxColumns: 16_384,
    maxRangeCells: 250_000,
    maxBatchBytes: limits.maxBatchBytes,
    maxSources: limits.maxSources,
    maxActiveRanges: limits.maxActiveRanges,
  });
  memoryLimits = limits;
  rangeCacheBudgetBytes = limits.workerDatasetRangeCacheBytes;
  return helloResult();
}

function helloResult(): unknown {
  return { protocolVersion: PROTOCOL_VERSION, transferableBatches: true };
}

function createActiveOpenRequest(requestId: string): ActiveOpenRequest {
  let resolveCancellation!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  return {
    requestId,
    kind: "open",
    cancelled: false,
    cancellation: { promise, resolve: resolveCancellation },
  };
}

async function openSource(requestId: string, value: unknown): Promise<unknown> {
  const active = createActiveOpenRequest(requestId);
  activeRequests.set(requestId, active);
  let dataset: DatasetState | undefined;
  let sourceHandle: string | number | undefined;
  let opened = false;

  try {
    const runtime = requireAdapter();
    const limits = requireMemoryLimits();
    const payload = expectRecord(value, "openSource payload") as unknown as OpenSourcePayload;
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

    const openResult = runtime.openDelimited({
      delimiter: payload.options.delimiter ?? (payload.format === "csv" ? "," : "\t"),
      header: payload.options.header !== "none",
      mode: payload.options.mode ?? "lenient",
      checkpointInterval: 1024,
      tableName: typeof payload.options.sourceName === "string"
        ? payload.options.sourceName
        : "Table 1",
      limits: {
        maxFieldBytes: limits.maxFieldBytes,
        maxColumns: 16_384,
        maxCellsPerRange: 250_000,
        maxBatchBytes: limits.maxBatchBytes,
        maxDiagnostics: 1_000,
      },
    });
    if (openResult.sourceHandle === undefined || openResult.sourceHandle === null) {
      throw new ProtocolFault("RUNTIME_FAILURE", "openDelimited did not return a sourceHandle");
    }
    sourceHandle = openResult.sourceHandle;
    throwIfCancelled(active);

    const datasetHandle = `d${nextDatasetHandle++}`;
    const initialMetadata = normalizeMetadata(
      openResult.metadata,
      normalizeDescriptor(openResult.table, 0),
    );
    const initialTables = normalizeDescriptors(openResult.tables, openResult.table, initialMetadata);
    dataset = {
      handle: datasetHandle,
      openRequestId: requestId,
      source,
      sourceHandle: openResult.sourceHandle,
      tables: initialTables,
      metadata: initialMetadata,
      scanOffset: 0,
      scanDone: false,
      closed: false,
      waiters: new Set(),
      rangeCache: new ByteLruCache(rangeCacheBudgetBytes),
    };
    datasets.set(datasetHandle, dataset);
    active.datasetHandle = datasetHandle;

    await scanInitialPrefix(dataset, active);
    throwIfCancelled(active);

    dataset.scanPromise = scanToEnd(dataset);
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
          requireAdapter().closeSource(sourceHandle);
        } catch {
          // Preserve the original open or cancellation failure.
        }
      }
    }
  }
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
  tables.set(tableHandle, {
    handle: tableHandle,
    datasetHandle: dataset.handle,
    tableId: payload.tableId,
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
  return { ...dataset.metadata, tableId: table.tableId };
}

async function readRange(
  requestId: string,
  value: unknown,
): Promise<{ kind: "batch"; data: WireTableBatch; transfer: Transferable[] }> {
  const runtime = requireAdapter();
  const payload = expectRecord(value, "readRange payload");
  const table = requireTable(payload.tableHandle);
  const dataset = requireDataset(table.datasetHandle);
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
  const active: ActiveRequest = {
    requestId,
    kind: "range",
    datasetHandle: dataset.handle,
    tableHandle: table.handle,
    cancelled: false,
  };
  activeRequests.set(requestId, active);

  let start: WasmRangeStart | undefined;
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
    start = runtime.beginRange(dataset.sourceHandle, request);
    active.cursorHandle = start.cursorHandle;

    let rawBatch = start.batch;
    if (!start.done) {
      if (start.cursorHandle === undefined || start.cursorHandle === null) {
        throw new ProtocolFault("RUNTIME_FAILURE", "beginRange did not return a cursorHandle");
      }
      let offset = start.byteOffset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > dataset.source.size) {
        throw new ProtocolFault("RUNTIME_FAILURE", "beginRange returned an invalid byteOffset");
      }

      for (;;) {
        throwIfCancelled(active);
        if (dataset.closed || table.closed) {
          throw new ProtocolFault("HANDLE_CLOSED", "The table was closed during range reading");
        }
        const end = Math.min(offset + CHUNK_BYTES, dataset.source.size);
        const bytes = new Uint8Array(await dataset.source.slice(offset, end).arrayBuffer());
        throwIfCancelled(active);
        const eof = end >= dataset.source.size;
        const update = runtime.feedRange(start.cursorHandle, offset, bytes, eof);
        if (update.done) {
          rawBatch = update.batch;
          break;
        }
        if (eof) {
          throw new ProtocolFault("PARSE_FAILED", "The range cursor reached EOF without a batch");
        }
        const nextOffset = update.nextByteOffset ?? end;
        if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > dataset.source.size) {
          throw new ProtocolFault("RUNTIME_FAILURE", "feedRange returned an invalid nextByteOffset");
        }
        offset = nextOffset;
      }
    }

    throwIfCancelled(active);
    const batch = copyBatch(rawBatch, table, dataset, request);
    const cachedBatch = cloneWireTableBatch(batch);
    dataset.rangeCache.set(
      rangeCacheKey(table.tableId, batch.revision, batch.schemaVersion, request),
      cachedBatch,
      wireBatchByteLength(cachedBatch),
    );
    const transfer = collectBatchTransfers(batch);
    return { kind: "batch", data: batch, transfer };
  } finally {
    activeRequests.delete(requestId);
    releasePermit?.();
    if (start?.cursorHandle !== undefined && start.cursorHandle !== null) {
      try {
        runtime.closeRange(start.cursorHandle);
      } catch {
        // Closing is best effort after the request already has a terminal state.
      }
    }
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
  adapter?.dispose();
  adapter = undefined;
  return { closed: true };
}

async function scanInitialPrefix(dataset: DatasetState, active: ActiveOpenRequest): Promise<void> {
  while (
    !dataset.closed &&
    !dataset.scanDone &&
    dataset.scanOffset < Math.min(dataset.source.size, INITIAL_READ_LIMIT_BYTES) &&
    discoveredRows(dataset.metadata) < INITIAL_ROW_TARGET
  ) {
    throwIfCancelled(active);
    await awaitOpenStep(scanNextChunk(dataset, false), active);
  }
  if (!dataset.closed && dataset.source.size === 0 && !dataset.scanDone) {
    await awaitOpenStep(scanNextChunk(dataset, false), active);
  }
  throwIfCancelled(active);
  if (dataset.closed) {
    throw new ProtocolFault("HANDLE_CLOSED", "The source was closed while opening");
  }
}

function awaitOpenStep<T>(operation: Promise<T>, active: ActiveOpenRequest): Promise<T> {
  return Promise.race([
    operation,
    active.cancellation.promise.then<never>(() => {
      throw new ProtocolFault("CANCELLED", "The open request was cancelled");
    }),
  ]);
}

async function scanToEnd(dataset: DatasetState): Promise<void> {
  try {
    while (!dataset.scanDone && !dataset.closed) {
      await scanNextChunk(dataset, true);
    }
  } catch (error) {
    dataset.scanError = error instanceof ProtocolFault
      ? error
      : new ProtocolFault("RUNTIME_FAILURE", "Background source scanning failed", false, undefined, error);
    dataset.scanDone = true;
    notifyScanWaiters(dataset);
    emit({
      event: "runtimeError",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      payload: serializeFault(dataset.scanError, "Background source scanning failed"),
    });
  }
}

async function scanNextChunk(dataset: DatasetState, emitEvents: boolean): Promise<void> {
  if (dataset.closed || dataset.scanDone) {
    return;
  }
  const runtime = requireAdapter();
  const offset = dataset.scanOffset;
  const end = Math.min(offset + CHUNK_BYTES, dataset.source.size);
  const bytes = new Uint8Array(await dataset.source.slice(offset, end).arrayBuffer());
  if (dataset.closed) {
    return;
  }
  const eof = end >= dataset.source.size;
  const update = runtime.scanChunk(dataset.sourceHandle, offset, bytes, eof);
  dataset.scanOffset = end;
  dataset.scanDone = eof || update.done === true;
  applyScanUpdate(dataset, update, emitEvents);

  if (emitEvents) {
    emit({
      event: "progress",
      datasetHandle: dataset.handle,
      tableId: dataset.metadata.tableId,
      payload: {
        sourceHandle: dataset.handle,
        bytesScanned: dataset.scanOffset,
        rowsDiscovered: discoveredRows(dataset.metadata),
        done: dataset.scanDone,
      },
    });
  }
  notifyScanWaiters(dataset);
}

function applyScanUpdate(
  dataset: DatasetState,
  update: WasmScanUpdate,
  emitEvents: boolean,
): void {
  const previous = JSON.stringify(dataset.metadata);
  const rawMetadata = update.metadata ?? requireAdapter().metadata(dataset.sourceHandle);
  dataset.metadata = normalizeMetadata(rawMetadata, dataset.tables[0]);
  dataset.tables = dataset.tables.map((table, index) =>
    index === 0 ? { id: dataset.metadata.tableId, name: dataset.metadata.name } : table,
  );

  if (emitEvents && JSON.stringify(dataset.metadata) !== previous) {
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

  const warnings = update.warnings ?? (update.warning === undefined ? [] : [update.warning]);
  if (emitEvents) {
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
}

async function waitUntilIndexed(
  dataset: DatasetState,
  request: RangeRequest,
  active: ActiveRequest,
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

function cancelActive(active: ActiveRequest): void {
  if (active.cancelled) {
    return;
  }
  active.cancelled = true;
  if (active.kind === "open") {
    active.cancellation.resolve();
    if (active.datasetHandle) {
      const dataset = datasets.get(active.datasetHandle);
      if (dataset && !dataset.closed) {
        closeDatasetState(dataset, false);
      }
    }
    return;
  }
  rangePermits.cancel(
    active.requestId,
    new ProtocolFault("CANCELLED", "The range request was cancelled"),
  );
  if (active.cursorHandle !== undefined) {
    try {
      requireAdapter().cancel(active.cursorHandle);
    } catch {
      // The request loop still observes the cancelled flag.
    }
  }
  const dataset = datasets.get(active.datasetHandle);
  if (dataset) {
    notifyScanWaiters(dataset);
  }
}

function throwIfCancelled(active: ActiveRequest): void {
  if (active.cancelled) {
    throw new ProtocolFault(
      "CANCELLED",
      active.kind === "open" ? "The open request was cancelled" : "The range request was cancelled",
    );
  }
}

function closeTableState(table: OpenTableState, emitEvent: boolean): void {
  table.closed = true;
  for (const active of activeRequests.values()) {
    if (active.kind === "range" && active.tableHandle === table.handle) {
      cancelActive(active);
    }
  }
  tables.delete(table.handle);
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

function closeDatasetState(dataset: DatasetState, emitEvent: boolean): void {
  dataset.closed = true;
  openedDatasetsByRequest.delete(dataset.openRequestId);
  dataset.rangeCache.clear();
  notifyScanWaiters(dataset);
  for (const table of [...tables.values()]) {
    if (table.datasetHandle === dataset.handle) {
      closeTableState(table, emitEvent);
    }
  }
  for (const active of activeRequests.values()) {
    if (active.datasetHandle === dataset.handle) {
      cancelActive(active);
    }
  }
  datasets.delete(dataset.handle);
  try {
    requireAdapter().closeSource(dataset.sourceHandle);
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
  const columns = raw.columns.map((column, index) => copyColumn(column, range.rowCount, index));
  return {
    tableId: typeof raw.tableId === "string" ? raw.tableId : table.tableId,
    revision: numberOr(raw.revision, dataset.metadata.revision),
    schemaVersion: numberOr(raw.schemaVersion, dataset.metadata.schema.version),
    range,
    columns,
    complete: raw.complete !== false,
  };
}

function copyColumn(value: unknown, rows: number, index: number): WireUtf8Column {
  const raw = expectRecord(value, "UTF-8 column");
  const data = copyUint8(raw.data, "column data");
  const offsets = copyUint32(raw.offsets, "column offsets");
  const validity = raw.validity === undefined
    ? new Uint8Array(Math.ceil(rows / 8)).fill(0xff)
    : copyUint8(raw.validity, "column validity");
  return {
    columnId: typeof raw.columnId === "string" ? raw.columnId : `c${index}`,
    encoding: "utf8",
    data,
    offsets,
    validity,
  };
}

function copyUint8(value: unknown, name: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  throw new ProtocolFault("RUNTIME_FAILURE", `${name} must be a Uint8Array`);
}

function copyUint32(value: unknown, name: string): Uint32Array {
  if (value instanceof Uint32Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint32Array(value);
  }
  if (Array.isArray(value)) {
    return Uint32Array.from(value as number[]);
  }
  throw new ProtocolFault("RUNTIME_FAILURE", `${name} must be a Uint32Array`);
}

function collectBatchTransfers(batch: WireTableBatch): Transferable[] {
  const transfers: Transferable[] = [];
  for (const column of batch.columns) {
    transfers.push(
      (column.data as Uint8Array).buffer,
      (column.offsets as Uint32Array).buffer,
      (column.validity as Uint8Array).buffer,
    );
  }
  return transfers;
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
          randomAccess: raw.capabilities.randomAccess === "full" ? "full" : "indexed-prefix",
          typedValues: raw.capabilities.typedValues === true,
          search: raw.capabilities.search === true,
          sort: raw.capabilities.sort === true,
          filter: raw.capabilities.filter === true,
          multiTable: raw.capabilities.multiTable === true,
          ...raw.capabilities,
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

function discoveredRows(metadata: TableMetadata): number {
  return metadata.extent.rows.kind === "unknown" ? 0 : metadata.extent.rows.value;
}

function numberOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function requireAdapter(): WasmAdapter {
  if (!adapter || shuttingDown) {
    throw new ProtocolFault("HANDLE_CLOSED", "The Worker runtime is not available");
  }
  return adapter;
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
