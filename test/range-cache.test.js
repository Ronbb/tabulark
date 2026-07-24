import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../dist/index.js";

test("range cache isolates mutable batches and clears closed table entries", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });

  let engine;
  try {
    engine = await createEngine({ memoryBudgetBytes: 8 * 1024 * 1024 });
    const worker = FakeWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), { format: "csv" });
    const table = await dataset.openTable("table-0");
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

    const first = await table.readRange(range);
    first.columns[0].data[0] = "z".charCodeAt(0);
    first.columns[0].offsets[1] = 0;
    first.columns[0].validity[0] = 0;

    const second = await table.readRange(range);
    assert.equal(worker.readRangeCount, 1, "the second read should be served by the client cache");
    assert.deepEqual(second.toRows(), [["a"]]);
    assert.notEqual(second.columns[0].data, first.columns[0].data);
    assert.notEqual(second.columns[0].offsets, first.columns[0].offsets);
    assert.notEqual(second.columns[0].validity, first.columns[0].validity);

    await table.close();
    const reopened = await dataset.openTable("table-0");
    assert.deepEqual((await reopened.readRange(range)).toRows(), [["a"]]);
    assert.equal(worker.readRangeCount, 2, "closing a table should remove its cached ranges");

    await dataset.close();
    const reopenedDataset = await engine.open(new Blob(["value\na\n"]), { format: "csv" });
    const reopenedAfterDatasetClose = await reopenedDataset.openTable("table-0");
    assert.deepEqual((await reopenedAfterDatasetClose.readRange(range)).toRows(), [["a"]]);
    assert.equal(worker.readRangeCount, 3, "closing a dataset should remove table cache entries");
  } finally {
    await engine?.close();
    if (originalWorker) {
      Object.defineProperty(globalThis, "Worker", originalWorker);
    } else {
      delete globalThis.Worker;
    }
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
    engine = await createEngine({ memoryBudgetBytes: 8 * 1024 * 1024 });
    await assert.rejects(
      engine.open(new ArrayBuffer(4 * 1024 * 1024 + 1), { format: "csv" }),
      (error) => {
        assert.equal(error.code, "RESOURCE_LIMIT");
        assert.equal(error.details.limit, 4 * 1024 * 1024);
        return true;
      },
    );

    const worker = FakeWorker.latest;
    worker.batchDataBytes = 1024 * 1024;
    const dataset = await engine.open(new Blob(["value\na\n"]), { format: "csv" });
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

class FakeWorker {
  static latest;

  readRangeCount = 0;
  batchDataBytes = 1;
  #listeners = new Map();

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

  postMessage(request) {
    let kind;
    let data;
    switch (request.op) {
      case "hello":
        kind = "hello";
        data = { protocolVersion: 1, transferableBatches: true };
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
      case "readRange":
        this.readRangeCount += 1;
        kind = "batch";
        data = batch(request.payload.range, this.batchDataBytes);
        break;
      case "cancel":
      case "closeTable":
      case "closeSource":
      case "shutdown":
        kind = "acknowledged";
        break;
      default:
        throw new Error(`Unexpected operation: ${request.op}`);
    }

    const response = {
      protocolVersion: 1,
      requestId: request.requestId,
      status: "success",
      result: data === undefined ? { kind } : { kind, data },
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners.get("message") ?? []) {
        listener({ data: response });
      }
    });
  }

  terminate() {}
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
        logicalType: "utf8",
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

function batch(range, dataBytes = 1) {
  const data = new Uint8Array(dataBytes);
  data[0] = "a".charCodeAt(0);
  return {
    tableId: "table-0",
    revision: 0,
    schemaVersion: 0,
    range: { ...range },
    columns: [{
      columnId: "c0",
      encoding: "utf8",
      data,
      offsets: new Uint32Array([0, 1]),
      validity: new Uint8Array([1]),
    }],
    complete: true,
  };
}
