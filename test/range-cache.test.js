import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, delimitedAdapter, TabularkError } from "../dist/index.js";

const createTestEngine = () => createEngine({
  adapters: [delimitedAdapter],
  memoryBudgetBytes: 8 * 1024 * 1024,
});
const csvOptions = () => ({
  adapter: delimitedAdapter,
  adapterOptions: { dialect: "csv" },
});

test("RESOURCE_LIMIT details always expose resource and required/available capacity", () => {
  const countLimit = new TabularkError("RESOURCE_LIMIT", "too many cells", {
    details: { cells: 11, maxCells: 10 },
  });
  assert.deepEqual(countLimit.details, {
    resource: "range-cells",
    required: 11,
    available: 10,
    cells: 11,
    maxCells: 10,
  });

  const byteLimit = new TabularkError("RESOURCE_LIMIT", "field too large", {
    details: { maxFieldBytes: 1024 },
  });
  assert.deepEqual(byteLimit.details, {
    resource: "field",
    requiredBytes: 1025,
    availableBytes: 1024,
    maxFieldBytes: 1024,
  });
});

test("range cache isolates mutable facades, survives table handles, and clears with its dataset", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

    const first = await table.readRange(range);
    assert.equal("buffers" in first, false, "wire buffers stay private");
    const callerRows = first.toRows();
    callerRows[0][0] = "z";

    const second = await table.readRange(range);
    assert.equal(worker.readRangeCount, 1, "the second read should be served by the client cache");
    assert.deepEqual(second.toRows(), [["a"]]);
    assert.notEqual(second, first);
    assert.notEqual(second.columns[0], first.columns[0]);

    await table.close();
    const reopened = await dataset.openTable("table-0");
    assert.deepEqual((await reopened.readRange(range)).toRows(), [["a"]]);
    assert.equal(worker.readRangeCount, 1, "a logical table cache survives a temporary handle");

    await dataset.close();
    const reopenedDataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const reopenedAfterDatasetClose = await reopenedDataset.openTable("table-0");
    assert.deepEqual((await reopenedAfterDatasetClose.readRange(range)).toRows(), [["a"]]);
    assert.equal(worker.readRangeCount, 2, "closing a dataset removes its logical table cache");
  } finally {
    await engine?.close();
    if (originalWorker) {
      Object.defineProperty(globalThis, "Worker", originalWorker);
    } else {
      delete globalThis.Worker;
    }
  }
});

test("twenty identical misses share one RPC and caller cancellation is independent", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

    const batches = await Promise.all(Array.from({ length: 20 }, () => table.readRange(range)));
    assert.equal(worker.readRangeCount, 1);
    assert.ok(batches.every((value) => value.toRows()[0][0] === "a"));

    worker.deferReads = true;
    const adjacent = { ...range, rowStart: 1 };
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = table.readRange(adjacent, { signal: first.signal });
    const retained = table.readRange(adjacent, { signal: second.signal });
    first.abort();
    await assert.rejects(cancelled, (error) => error.code === "CANCELLED");
    assert.equal(worker.cancelCount, 0, "one caller cannot cancel shared work");
    worker.flushReads();
    assert.deepEqual((await retained).toRows(), [["a"]]);

    const finalRange = { ...range, rowStart: 2 };
    const third = new AbortController();
    const fourth = new AbortController();
    const thirdRead = table.readRange(finalRange, { signal: third.signal });
    const fourthRead = table.readRange(finalRange, { signal: fourth.signal });
    third.abort();
    fourth.abort();
    await Promise.all([
      assert.rejects(thirdRead, (error) => error.code === "CANCELLED"),
      assert.rejects(fourthRead, (error) => error.code === "CANCELLED"),
    ]);
    assert.equal(worker.cancelCount, 1, "all callers cause exactly one Worker cancel");
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("metadata revision and schema changes evict older logical table backings", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };
    await table.readRange(range);
    await table.readRange(range);
    assert.equal(worker.readRangeCount, 1);

    worker.batchRevision = 1;
    worker.batchSchemaVersion = 2;
    worker.emitMetadata(1, 2);
    assert.equal(table.metadata.revision, 1);
    assert.equal(table.metadata.schema.version, 2);
    await table.readRange(range);
    await table.readRange(range);
    assert.equal(worker.readRangeCount, 2, "the updated version has one new miss then a hit");
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("small batches are charged at 4 KiB and the client cache caps entry count", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");

    // An 8 MiB engine assigns 1 MiB to the main-thread cache. The 4 KiB
    // minimum charge therefore allows 256 entries even though these batches
    // contain only a few bytes of actual backing data.
    for (let rowStart = 0; rowStart < 257; rowStart += 1) {
      await table.readRange({
        rowStart,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
    }
    await table.readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    });
    assert.equal(worker.readRangeCount, 258, "the 257th entry evicts the oldest backing");
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("client input and range-cache limits scale down with the engine budget", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    await assert.rejects(
      engine.open(new ArrayBuffer(4 * 1024 * 1024 + 1), csvOptions()),
      (error) => {
        assert.equal(error.code, "RESOURCE_LIMIT");
        assert.equal(error.details.resource, "source-staging");
        assert.equal(error.details.requiredBytes, 4 * 1024 * 1024 + 1);
        assert.equal(error.details.availableBytes, 4 * 1024 * 1024);
        return true;
      },
    );

    const worker = FakeWorker.latest;
    worker.batchDataBytes = 1024 * 1024;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 7, rowCount: 1, columnStart: 0, columnCount: 1 };
    await table.readRange(range);
    await table.readRange(range);
    assert.equal(worker.readRangeCount, 2, "a batch larger than the 1 MiB client cache is not retained");
  } finally {
    await engine?.close();
    if (originalWorker) {
      Object.defineProperty(globalThis, "Worker", originalWorker);
    } else {
      delete globalThis.Worker;
    }
  }
});

test("client never retains a batch truncated at a progressive prefix", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    worker.batchOverride = (range, readCount) => ({
      ...batch(range),
      complete: readCount > 1,
    });
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

    const prefix = await table.readRange(range);
    assert.equal(prefix.complete, false);
    const completed = await table.readRange(range);
    assert.equal(completed.complete, true);
    await table.readRange(range);
    assert.equal(worker.readRangeCount, 2, "only the complete retry may enter the client cache");
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("an invalid transferred backing is terminal protocol failure", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = FakeWorker.latest;
    worker.batchOverride = (range) => {
      const value = batch(range);
      return {
        ...value,
        columns: [{
          ...value.columns[0],
          native: {
            ...value.columns[0].native,
            data: { buffer: 99 },
          },
        }],
      };
    };
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    await assert.rejects(
      table.readRange({ rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }),
      (error) => error.code === "PROTOCOL_INCOMPATIBLE",
    );
    assert.equal(worker.terminated, true);
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("ArrayBuffer input is retained by default and detached only on explicit transfer", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const retained = new ArrayBuffer(8);
    const first = await engine.open(retained, csvOptions());
    assert.equal(retained.byteLength, 8);
    await first.close();

    const transferred = new ArrayBuffer(8);
    const second = await engine.open(transferred, { ...csvOptions(), transferInput: true });
    assert.equal(transferred.byteLength, 0);
    await second.close();

    await assert.rejects(
      engine.open(new Blob(["a"]), { ...csvOptions(), transferInput: true }),
      (error) => error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("table presentation methods expose a normalized range-aligned spreadsheet contract", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const dataset = await engine.open(new Blob(["ignored"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const presentation = await table.getPresentation();
    assert.deepEqual(presentation, {
      kind: "spreadsheet-v1",
      tableId: "table-0",
      revision: 0,
      visibility: "hidden",
      frozenRows: 1,
      frozenColumns: 0,
      rows: [{ index: 3, size: 32 }],
      columns: [{ index: 0, size: 120 }],
      styles: [{ font: { bold: true }, horizontalAlignment: "center" }],
    });

    const request = { rowStart: 3, rowCount: 1, columnStart: 0, columnCount: 1 };
    const range = await table.readPresentationRange(request);
    assert.deepEqual(range, {
      kind: "spreadsheet-v1",
      tableId: "table-0",
      revision: 0,
      range: request,
      styleIds: [[0]],
      mergedCells: [{ rowStart: 3, rowEnd: 4, columnStart: 0, columnEnd: 1 }],
      rows: [{ index: 3, size: 32 }],
      columns: [{ index: 0, size: 120 }],
    });
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("layout-v1 batches decode native recursive values separately from display text", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    FakeWorker.latest.batchOverride = typedBatch();
    const dataset = await engine.open(new Blob(["ignored"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const batch = await table.readRange({
      rowStart: 0,
      rowCount: 2,
      columnStart: 0,
      columnCount: 4,
    });

    assert.deepEqual(batch.toRows(), [
      [
        9_223_372_036_854_775_000n,
        { kind: "decimal", unscaled: 12_345n, precision: 10, scale: 2 },
        [1, 2],
        new Uint8Array([0xab, 0xcd]),
      ],
      [
        -1n,
        { kind: "decimal", unscaled: -42n, precision: 10, scale: 2 },
        [3],
        new Uint8Array([0]),
      ],
    ]);
    assert.deepEqual(batch.toDisplayRows(), [
      ["9223372036854775000", "123.45", "[1,2]", "0xabcd"],
      ["-1", "-0.42", "[3]", "0x00"],
    ]);
    const firstBinary = batch.columns[3].getValue(0);
    assert.ok(firstBinary instanceof Uint8Array);
    firstBinary[0] = 0;
    assert.deepEqual(
      batch.columns[3].getValue(0),
      new Uint8Array([0xab, 0xcd]),
      "a binary getter returns a defensive copy",
    );

    const cachedBatch = await table.readRange({
      rowStart: 0,
      rowCount: 2,
      columnStart: 0,
      columnCount: 4,
    });
    assert.equal(FakeWorker.latest.readRangeCount, 1, "the second facade uses the cached backing");
    const cachedBinary = cachedBatch.columns[3].getValue(0);
    assert.ok(cachedBinary instanceof Uint8Array);
    cachedBinary[1] = 0;
    assert.deepEqual(
      cachedBatch.columns[3].getValue(0),
      new Uint8Array([0xab, 0xcd]),
      "a cached facade cannot mutate its backing through a binary getter",
    );
    assert.deepEqual(batch.columns[3].getValue(0), new Uint8Array([0xab, 0xcd]));
    assert.equal("byteLength" in batch, false);
    assert.equal("native" in batch.columns[0], false);
    assert.equal("display" in batch.columns[0], false);
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("layout-v1 decodes recursive descriptors behind the logical batch facade", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const wire = recursiveTypedBatch();
    FakeWorker.latest.batchOverride = wire;
    const dataset = await engine.open(new Blob(["ignored"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const batch = await table.readRange({
      rowStart: 0,
      rowCount: 2,
      columnStart: 0,
      columnCount: 6,
    });

    assert.deepEqual(batch.toRows(), [
      [
        "red",
        "same",
        { kind: "union", typeId: 5, value: "branch" },
        [{ key: "a", value: 1 }, { key: "b", value: 2 }],
        11,
        { kind: "timestamp", value: 0n, unit: "microsecond", timezone: "UTC" },
      ],
      [
        "blue",
        "next",
        { kind: "union", typeId: 7, value: 42 },
        [{ key: "c", value: 3 }],
        22,
        { kind: "timestamp", value: 1_000_000n, unit: "microsecond", timezone: "UTC" },
      ],
    ]);
    assert.deepEqual(batch.toDisplayRows(), [
      ["red", "same", "branch", '{"a":1,"b":2}', "11", "1970-01-01T00:00:00.000000Z"],
      ["blue", "next", "42", '{"c":3}', "22", "1970-01-01T00:00:01.000000Z"],
    ]);
    assert.deepEqual(Object.keys(batch.columns[0]).sort(), ["columnId", "columnIndex", "rowCount"]);
    assert.equal(typeof batch.columns[0].getValue, "function");
    assert.equal(typeof batch.columns[0].getDisplayValue, "function");
    assert.equal(typeof batch.columns[0].toValues, "function");
    assert.equal(typeof batch.columns[0].toDisplayValues, "function");
    assert.equal(batch.columns[0].getValue(1), "blue");
    assert.equal(batch.columns[0].getDisplayValue(1), "blue");
    assert.deepEqual(batch.columns[3].toValues(), [
      [{ key: "a", value: 1 }, { key: "b", value: 2 }],
      [{ key: "c", value: 3 }],
    ]);
    assert.equal("buffers" in batch, false);
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

class FakeWorker {
  static latest;

  readRangeCount = 0;
  cancelCount = 0;
  deferReads = false;
  batchRevision = 0;
  batchSchemaVersion = 0;
  batchDataBytes = 1;
  batchOverride;
  terminated = false;
  #listeners = new Map();
  #deferredReads = [];

  constructor() {
    FakeWorker.latest = this;
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  postMessage(request, transfer = []) {
    if (transfer.length > 0) {
      request = structuredClone(request, { transfer });
    }
    let kind;
    let data;
    switch (request.op) {
      case "hello":
        kind = "hello";
        data = {
          protocolVersion: 4,
          adapterApiVersion: 3,
          batchLayoutVersion: 1,
          adapters: request.payload.adapters.map((adapter) => adapter.id),
          transferableBatches: true,
        };
        break;
      case "openSource":
        kind = "dataset";
        data = { datasetHandle: "d1" };
        break;
      case "listTables":
        kind = "tables";
        data = [{ id: "table-0", name: "Table 1" }];
        break;
      case "openTable":
        kind = "table";
        data = { tableHandle: "t1" };
        break;
      case "getMetadata":
        kind = "metadata";
        data = metadata();
        break;
      case "getPresentation":
        kind = "presentation";
        data = presentation();
        break;
      case "readPresentationRange":
        kind = "presentationRange";
        data = presentationRange(request.payload.range);
        break;
      case "readRange":
        this.readRangeCount += 1;
        kind = "batch";
        data = typeof this.batchOverride === "function"
          ? this.batchOverride(request.payload.range, this.readRangeCount)
          : this.batchOverride ?? batch(request.payload.range, this.batchDataBytes);
        data = {
          ...data,
          revision: this.batchRevision,
          schemaVersion: this.batchSchemaVersion,
        };
        break;
      case "cancel":
        this.cancelCount += 1;
      case "closeTable":
      case "closeSource":
      case "shutdown":
        kind = "acknowledged";
        break;
      default:
        throw new Error(`Unexpected operation: ${request.op}`);
    }

    const response = {
      protocolVersion: 4,
      requestId: request.requestId,
      status: "success",
      result: data === undefined ? { kind } : { kind, data },
    };
    if (request.op === "readRange" && this.deferReads) {
      this.#deferredReads.push(() => this.#emit(response));
      return;
    }
    queueMicrotask(() => {
      this.#emit(response);
    });
  }

  flushReads() {
    for (const respond of this.#deferredReads.splice(0)) respond();
  }

  emitMetadata(revision, schemaVersion) {
    const value = metadata();
    const payload = {
      ...value,
      revision,
      schema: { ...value.schema, version: schemaVersion },
    };
    this.#emit({
      protocolVersion: 4,
      event: "metadata",
      datasetHandle: "d1",
      tableHandle: "t1",
      tableId: "table-0",
      revision,
      payload,
    });
  }

  #emit(data) {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data });
    }
  }

  terminate() {
    this.terminated = true;
  }
}

function metadata() {
  return {
    tableId: "table-0",
    name: "Table 1",
    revision: 0,
    extent: {
      rows: { kind: "exact", value: 1 },
      columns: { kind: "exact", value: 1 },
    },
    schema: {
      version: 0,
      columns: [{
        id: "c0",
        name: "value",
        index: 0,
        dataType: { type: "utf8" },
        nullable: true,
      }],
    },
    capabilities: {
      randomAccess: "full",
      typedValues: false,
      search: false,
      sort: false,
      filter: false,
      multiTable: false,
    },
  };
}

function presentation() {
  return {
    kind: "spreadsheet-v1",
    tableId: "table-0",
    revision: 0,
    visibility: "hidden",
    frozenRows: 1,
    frozenColumns: 0,
    rows: [{ index: 3, size: 32 }],
    columns: [{ index: 0, size: 120 }],
    styles: [{ font: { bold: true }, horizontalAlignment: "center" }],
  };
}

function presentationRange(range) {
  return {
    kind: "spreadsheet-v1",
    tableId: "table-0",
    revision: 0,
    range,
    styleIds: [[0]],
    mergedCells: [{ rowStart: 3, rowEnd: 4, columnStart: 0, columnEnd: 1 }],
    rows: [{ index: 3, size: 32 }],
    columns: [{ index: 0, size: 120 }],
  };
}

function batch(range, dataBytes = 1) {
  const data = new Uint8Array(dataBytes);
  data[0] = "a".charCodeAt(0);
  return {
    layoutVersion: 1,
    tableId: "table-0",
    revision: 0,
    schemaVersion: 0,
    range: { ...range },
    buffers: [data.buffer, new Uint32Array([0, 1]).buffer, new Uint8Array([1]).buffer],
    columns: [{
      columnId: "c0",
      native: {
        dataType: { type: "utf8" },
        length: range.rowCount,
        data: { buffer: 0 },
        offsets: { buffer: 1 },
        validity: { buffer: 2 },
      },
      display: {
        encoding: "utf8",
        data: { buffer: 0 },
        offsets: { buffer: 1 },
        validity: { buffer: 2 },
      },
    }],
    complete: true,
  };
}

function typedBatch() {
  const buffers = [];
  const add = (value) => {
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return buffers.push(Uint8Array.from(bytes).buffer) - 1;
  };
  const int64 = new ArrayBuffer(16);
  const int64View = new DataView(int64);
  int64View.setBigInt64(0, 9_223_372_036_854_775_000n, true);
  int64View.setBigInt64(8, -1n, true);
  const decimals = new Uint8Array(32);
  writeSignedLittleEndian(decimals, 0, 16, 12_345n);
  writeSignedLittleEndian(decimals, 16, 16, -42n);
  const listOffsets = new Uint32Array([0, 2, 3]);
  const listValues = new Int32Array([1, 2, 3]);
  const binaryOffsets = new Uint32Array([0, 2, 3]);
  const binaryData = new Uint8Array([0xab, 0xcd, 0]);
  const validity = new Uint8Array([0b11]);

  const nativeIndexes = {
    int64: add(new Uint8Array(int64)),
    decimals: add(decimals),
    listOffsets: add(listOffsets),
    listValues: add(listValues),
    binaryOffsets: add(binaryOffsets),
    binaryData: add(binaryData),
    validity: add(validity),
  };
  const displayValues = [
    ["9223372036854775000", "-1"],
    ["123.45", "-0.42"],
    ["[1,2]", "[3]"],
    ["0xabcd", "0x00"],
  ].map((values) => displayBuffers(values, buffers, add, nativeIndexes.validity));

  return {
    layoutVersion: 1,
    tableId: "table-0",
    revision: 0,
    schemaVersion: 0,
    range: { rowStart: 0, rowCount: 2, columnStart: 0, columnCount: 4 },
    buffers,
    columns: [
      {
        columnId: "c0",
        native: {
          dataType: { type: "int64" },
          length: 2,
          validity: { buffer: nativeIndexes.validity },
          values: { buffer: nativeIndexes.int64 },
        },
        display: displayValues[0],
      },
      {
        columnId: "c1",
        native: {
          dataType: { type: "decimal128", precision: 10, scale: 2 },
          length: 2,
          validity: { buffer: nativeIndexes.validity },
          values: { buffer: nativeIndexes.decimals },
        },
        display: displayValues[1],
      },
      {
        columnId: "c2",
        native: {
          dataType: {
            type: "list",
            field: { name: "item", nullable: false, dataType: { type: "int32" } },
          },
          length: 2,
          validity: { buffer: nativeIndexes.validity },
          offsets: { buffer: nativeIndexes.listOffsets },
          children: [{
            dataType: { type: "int32" },
            length: 3,
            values: { buffer: nativeIndexes.listValues },
          }],
        },
        display: displayValues[2],
      },
      {
        columnId: "c3",
        native: {
          dataType: { type: "binary" },
          length: 2,
          validity: { buffer: nativeIndexes.validity },
          offsets: { buffer: nativeIndexes.binaryOffsets },
          data: { buffer: nativeIndexes.binaryData },
        },
        display: displayValues[3],
      },
    ],
    complete: true,
  };
}

function recursiveTypedBatch() {
  const buffers = [];
  const add = (value) => {
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return buffers.push(Uint8Array.from(bytes).buffer) - 1;
  };
  const validity = add(new Uint8Array([0b11]));

  const dictionaryValues = nativeUtf8(["red", "blue"], buffers, add);
  const dictionary = {
    dataType: { type: "utf8" },
    length: 2,
    offsets: dictionaryValues.offsets,
    data: dictionaryValues.data,
  };
  const dictionaryKeys = {
    dataType: { type: "int8" },
    length: 2,
    values: { buffer: add(new Int8Array([0, 1])) },
  };

  const runEnds = {
    dataType: { type: "int16" },
    length: 2,
    values: { buffer: add(new Int16Array([1, 2])) },
  };
  const runText = nativeUtf8(["same", "next"], buffers, add);
  const runValues = {
    dataType: { type: "utf8" },
    length: 2,
    offsets: runText.offsets,
    data: runText.data,
  };

  const unionText = nativeUtf8(["branch"], buffers, add);
  const unionString = {
    dataType: { type: "utf8" },
    length: 1,
    offsets: unionText.offsets,
    data: unionText.data,
    typeId: 5,
  };
  const unionNumber = {
    dataType: { type: "int32" },
    length: 1,
    values: { buffer: add(new Int32Array([42])) },
    typeId: 7,
  };

  const mapKeys = nativeUtf8(["a", "b", "c"], buffers, add);
  const mapStruct = {
    dataType: {
      type: "struct",
      fields: [
        { name: "key", nullable: false, dataType: { type: "utf8" } },
        { name: "value", nullable: true, dataType: { type: "int32" } },
      ],
    },
    length: 3,
    children: [
      { dataType: { type: "utf8" }, length: 3, offsets: mapKeys.offsets, data: mapKeys.data },
      { dataType: { type: "int32" }, length: 3, values: { buffer: add(new Int32Array([1, 2, 3])) } },
    ],
  };

  const timestamps = new ArrayBuffer(16);
  const timestampView = new DataView(timestamps);
  timestampView.setBigInt64(0, 0n, true);
  timestampView.setBigInt64(8, 1_000_000n, true);

  const display = [
    ["red", "blue"],
    ["same", "next"],
    ["branch", "42"],
    ['{"a":1,"b":2}', '{"c":3}'],
    ["11", "22"],
    ["1970-01-01T00:00:00.000000Z", "1970-01-01T00:00:01.000000Z"],
  ].map((values) => displayBuffers(values, buffers, add, validity));

  return {
    layoutVersion: 1,
    tableId: "table-0",
    revision: 0,
    schemaVersion: 0,
    range: { rowStart: 0, rowCount: 2, columnStart: 0, columnCount: 6 },
    buffers,
    columns: [
      {
        columnId: "dictionary",
        native: {
          dataType: {
            type: "dictionary",
            indexType: { type: "int8" },
            valueType: { type: "utf8" },
          },
          length: 2,
          validity: { buffer: validity },
          encoding: "dictionary",
          children: [dictionaryKeys, dictionary],
          dictionary,
        },
        display: display[0],
      },
      {
        columnId: "run-end",
        native: {
          dataType: {
            type: "run-end-encoded",
            runEnds: { name: "run_ends", nullable: false, dataType: { type: "int16" } },
            values: { name: "values", nullable: true, dataType: { type: "utf8" } },
          },
          length: 2,
          validity: { buffer: validity },
          encoding: "run-end-encoded",
          runEnds,
          children: [runValues],
        },
        display: display[1],
      },
      {
        columnId: "union",
        native: {
          dataType: {
            type: "union",
            mode: "dense",
            fields: [
              { typeId: 5, field: { name: "text", nullable: true, dataType: { type: "utf8" } } },
              { typeId: 7, field: { name: "number", nullable: true, dataType: { type: "int32" } } },
            ],
          },
          length: 2,
          encoding: "union",
          typeIds: { buffer: add(new Int8Array([5, 7])) },
          unionOffsets: { buffer: add(new Int32Array([0, 0])) },
          children: [unionString, unionNumber],
        },
        display: display[2],
      },
      {
        columnId: "map",
        native: {
          dataType: {
            type: "map",
            entries: {
              name: "entries",
              nullable: false,
              dataType: mapStruct.dataType,
            },
            keysSorted: false,
          },
          length: 2,
          validity: { buffer: validity },
          encoding: "list",
          offsets: { buffer: add(new Int32Array([0, 2, 3])) },
          children: [mapStruct],
        },
        display: display[3],
      },
      {
        columnId: "extension",
        native: {
          dataType: {
            type: "extension",
            name: "org.example.counter",
            metadata: "{}",
            storageType: { type: "int32" },
          },
          length: 2,
          validity: { buffer: validity },
          encoding: "fixed-width",
          values: { buffer: add(new Int32Array([11, 22])) },
        },
        display: display[4],
      },
      {
        columnId: "timestamp",
        native: {
          dataType: { type: "timestamp", unit: "microsecond", timezone: "UTC" },
          length: 2,
          validity: { buffer: validity },
          encoding: "fixed-width",
          values: { buffer: add(new Uint8Array(timestamps)) },
        },
        display: display[5],
      },
    ],
    complete: true,
  };
}

function nativeUtf8(values, buffers, add) {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const data = new Uint8Array(encoded.reduce((total, value) => total + value.byteLength, 0));
  const offsets = new Int32Array(values.length + 1);
  let cursor = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    data.set(encoded[index], cursor);
    cursor += encoded[index].byteLength;
    offsets[index + 1] = cursor;
  }
  return {
    data: { buffer: add(data) },
    offsets: { buffer: add(offsets) },
  };
}

function displayBuffers(values, buffers, add, validityIndex) {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const data = new Uint8Array(encoded.reduce((total, value) => total + value.byteLength, 0));
  const offsets = new Uint32Array(values.length + 1);
  let cursor = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    data.set(encoded[index], cursor);
    cursor += encoded[index].byteLength;
    offsets[index + 1] = cursor;
  }
  const dataIndex = add(data);
  const offsetsIndex = add(offsets);
  return {
    encoding: "utf8",
    data: { buffer: dataIndex },
    offsets: { buffer: offsetsIndex },
    validity: { buffer: validityIndex },
  };
}

function writeSignedLittleEndian(bytes, offset, width, input) {
  let value = input < 0n ? (1n << BigInt(width * 8)) + input : input;
  for (let index = 0; index < width; index += 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}
