import assert from "node:assert/strict";
import test from "node:test";

test("Worker derives Wasm limits and bounds/cancels queued range reads", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?budget-queue=${Date.now()}`);
    const wasmModuleUrl = mockWasmModuleUrl();
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 1, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      wasmModuleUrl,
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");
    assert.deepEqual(globalThis.__tabularkWasmConfigs[0], {
      memoryBudgetBytes: 8 * 1024 * 1024,
      indexBudgetBytes: 1024 * 1024,
      tileCacheBudgetBytes: 3 * 1024 * 1024,
      chunkBytes: 1024 * 1024,
      checkpointRows: 1024,
      maxFieldBytes: 256 * 1024,
      maxColumns: 16_384,
      maxRangeCells: 250_000,
      maxBatchBytes: 256 * 1024,
      maxSources: 2,
      maxActiveRanges: 2,
    });

    const source = new SlowBlob(["a"]);
    const opened = send("openSource", {
      source,
      format: "csv",
      options: { delimiter: ",", header: true, mode: "lenient" },
    });
    const datasetHandle = (await responseFor(opened)).result.data.datasetHandle;
    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;

    source.pauseSlices();
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };
    const reads = Array.from({ length: 11 }, () => send("readRange", { tableHandle, range }));
    await eventually(() => globalThis.__tabularkBeginCount === 2);
    assert.equal(globalThis.__tabularkBeginCount, 2, "only two ranges may begin at once");

    const overLimit = await responseFor(reads[10]);
    assert.equal(overLimit.status, "failure");
    assert.equal(overLimit.error.code, "RESOURCE_LIMIT");

    const cancelled = send("cancel", { targetRequestId: reads[2] });
    assert.equal((await responseFor(cancelled)).status, "success");
    const cancelledRead = await responseFor(reads[2]);
    assert.equal(cancelledRead.status, "failure");
    assert.equal(cancelledRead.error.code, "CANCELLED");

    const lateCancel = send("cancel", { targetRequestId: opened });
    assert.equal((await responseFor(lateCancel)).status, "success");
    assert.equal(globalThis.__tabularkClosedSources, 1);
    const closedDataset = send("listTables", { datasetHandle });
    const closedDatasetResponse = await responseFor(closedDataset);
    assert.equal(closedDatasetResponse.status, "failure");
    assert.equal(closedDatasetResponse.error.code, "HANDLE_CLOSED");

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Worker cancels an in-flight open and releases its source immediately", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?open-cancel=${Date.now()}`);
    const wasmModuleUrl = mockWasmModuleUrl();
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 1, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      wasmModuleUrl,
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new SlowBlob(["a"]);
    source.pauseSlices();
    const opening = send("openSource", {
      source,
      format: "csv",
      options: { delimiter: ",", header: true, mode: "lenient" },
    });
    await eventually(() => globalThis.__tabularkWasmConfigs.length === 1);

    const cancel = send("cancel", { targetRequestId: opening });
    assert.equal((await responseFor(cancel)).status, "success");
    const openingResponse = await responseFor(opening);
    assert.equal(openingResponse.status, "failure");
    assert.equal(openingResponse.error.code, "CANCELLED");
    assert.equal(globalThis.__tabularkClosedSources, 1);

    const leakedDataset = send("listTables", { datasetHandle: "d1" });
    const leakedDatasetResponse = await responseFor(leakedDataset);
    assert.equal(leakedDatasetResponse.status, "failure");
    assert.equal(leakedDatasetResponse.error.code, "HANDLE_CLOSED");
    source.resumeSlices();
  } finally {
    restoreGlobals(globals);
  }
});

test("a delayed background scan fatal closes tables and releases the source", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?background-fatal=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 1, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      wasmModuleUrl: backgroundFailureWasmModuleUrl(),
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new BackgroundFailureBlob([new Uint8Array(2 * 1024 * 1024)]);
    const opened = send("openSource", {
      source,
      format: "csv",
      options: { delimiter: ",", header: true, mode: "strict" },
    });
    const datasetHandle = (await responseFor(opened)).result.data.datasetHandle;
    await eventually(() => source.waitingForSecondSlice);

    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;
    const pendingRange = send("readRange", {
      tableHandle,
      range: { rowStart: 1_024, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    source.releaseSecondSlice();

    await eventually(() => messages.some((message) => (
      message.event === "runtimeError" && message.datasetHandle === datasetHandle
    )));
    const runtimeErrorIndex = messages.findIndex((message) => (
      message.event === "runtimeError" && message.datasetHandle === datasetHandle
    ));
    const tableClosedIndex = messages.findIndex((message) => (
      message.event === "closed" && message.tableHandle === tableHandle
    ));
    const datasetClosedIndex = messages.findIndex((message) => (
      message.event === "closed" && message.datasetHandle === datasetHandle && !message.tableHandle
    ));
    assert.ok(runtimeErrorIndex >= 0);
    assert.ok(tableClosedIndex > runtimeErrorIndex);
    assert.ok(datasetClosedIndex > tableClosedIndex);
    assert.equal(messages[runtimeErrorIndex].payload.code, "RUNTIME_FAILURE");
    assert.equal((await responseFor(pendingRange)).error.code, "RUNTIME_FAILURE");
    assert.equal(globalThis.__tabularkClosedSources, 1);

    const tableAfterFatal = send("getMetadata", { tableHandle });
    assert.equal((await responseFor(tableAfterFatal)).error.code, "HANDLE_CLOSED");
    const sourceAfterFatal = send("listTables", { datasetHandle });
    assert.equal((await responseFor(sourceAfterFatal)).error.code, "HANDLE_CLOSED");

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    assert.equal(globalThis.__tabularkClosedSources, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

class SlowBlob extends Blob {
  #paused = false;
  #resolvers = [];

  pauseSlices() {
    this.#paused = true;
  }

  resumeSlices() {
    this.#paused = false;
    for (const resolve of this.#resolvers.splice(0)) {
      resolve(new ArrayBuffer(0));
    }
  }

  slice(...args) {
    if (!this.#paused) return super.slice(...args);
    return {
      arrayBuffer: () => new Promise((resolve) => this.#resolvers.push(resolve)),
    };
  }
}

class BackgroundFailureBlob extends Blob {
  #sliceCount = 0;
  #release;
  waitingForSecondSlice = false;

  slice(...args) {
    this.#sliceCount += 1;
    if (this.#sliceCount !== 2) return super.slice(...args);
    this.waitingForSecondSlice = true;
    return {
      arrayBuffer: () => new Promise((resolve) => {
        this.#release = () => resolve(new ArrayBuffer(0));
      }),
    };
  }

  releaseSecondSlice() {
    this.#release?.();
  }
}

function mockWasmModuleUrl() {
  const source = `
    const metadata = () => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: { rows: { kind: "exact", value: 1 }, columns: { kind: "exact", value: 1 } },
      schema: { version: 0, columns: [{ id: "c0", name: "a", index: 0, logicalType: "utf8", nullable: true }] },
      capabilities: { randomAccess: "full", typedValues: false, search: false, sort: false, filter: false, multiTable: false },
    });
    const ranges = new Map();
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { globalThis.__tabularkWasmConfigs.push(config); }
      openDelimited() { return { sourceHandle: 1, table: { id: "table-0", name: "Table 1" }, metadata: metadata() }; }
      scanChunk() { return { done: true, metadata: metadata() }; }
      metadata() { return metadata(); }
      beginRange(_source, request) {
        const rangeHandle = globalThis.__tabularkBeginCount + 1;
        globalThis.__tabularkBeginCount += 1;
        ranges.set(rangeHandle, request);
        return { rangeHandle, plan: { checkpoint: { row: 0, byteOffset: 0 } } };
      }
      feedRange(rangeHandle) {
        const range = ranges.get(rangeHandle);
        return { status: "complete", batch: {
          tableId: "table-0", revision: 0, schemaVersion: 0, range, complete: true,
          columns: [{ columnId: "c0", data: new Uint8Array(), offsets: new Uint32Array(range.rowCount + 1), validity: new Uint8Array([1]) }],
        } };
      }
      cancel() {}
      closeRange() {}
      closeSource() { globalThis.__tabularkClosedSources += 1; }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function backgroundFailureWasmModuleUrl() {
  const source = `
    let scanCount = 0;
    const metadata = (rows) => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: { rows: { kind: "at-least", value: rows }, columns: { kind: "exact", value: 1 } },
      schema: { version: 0, columns: [{ id: "c0", name: "a", index: 0, logicalType: "utf8", nullable: true }] },
      capabilities: { randomAccess: "indexed-prefix", typedValues: false, search: false, sort: false, filter: false, multiTable: false },
    });
    export default async function init() {}
    export class WasmRuntime {
      openDelimited() { return { sourceHandle: 1, table: { id: "table-0", name: "Table 1" }, metadata: metadata(0) }; }
      scanChunk() {
        scanCount += 1;
        if (scanCount === 1) return { done: false, metadata: metadata(512) };
        throw new Error("synthetic delayed scan failure");
      }
      metadata() { return metadata(512); }
      closeSource() { globalThis.__tabularkClosedSources += 1; }
      beginRange() { throw new Error("not used"); }
      feedRange() { throw new Error("not used"); }
      cancel() {}
      closeRange() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

function saveGlobals(names) {
  return names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
}

function restoreGlobals(descriptors) {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
