import assert from "node:assert/strict";
import test from "node:test";

test("Worker hello validates registrations atomically and permits a corrected retry", async () => {
  const worker = await workerHarness("hello-atomic");
  try {
    const failed = worker.send("hello", {
      adapters: [
        { id: "tabulark:delimited", moduleUrl: "data:text/javascript,export default function(){}" },
      ],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    const failedResponse = await worker.responseFor(failed);
    assert.equal(failedResponse.status, "failure");
    assert.equal(failedResponse.error.code, "INVALID_ARGUMENT");

    const retried = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    const retriedResponse = await worker.responseFor(retried);
    assert.equal(retriedResponse.status, "success");
    assert.deepEqual(retriedResponse.result.data.adapters, ["tabulark:delimited"]);

    const injectedAfterInitialization = worker.send("hello", {
      adapters: [{
        id: "tabulark:delimited",
        moduleUrl: "data:text/javascript,throw new Error('must not load')",
      }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    const injectedResponse = await worker.responseFor(injectedAfterInitialization);
    assert.equal(injectedResponse.status, "failure");
    assert.equal(injectedResponse.error.code, "INVALID_ARGUMENT");

    const idempotent = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(idempotent)).status, "success");
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker rejects a source range whose safe offset plus length would overflow the source", async () => {
  const worker = await workerHarness("source-range-overflow");
  testAdapter("tabulark:delimited", overflowingRangeModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");

    const opened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const response = await worker.responseFor(opened);
    assert.equal(response.status, "failure");
    assert.equal(response.error.code, "RESOURCE_LIMIT");
    assert.equal(response.error.details.resource, "source-staging");
    assert.equal(response.error.details.offset, Number.MAX_SAFE_INTEGER);
    assert.equal(response.error.details.sourceLength, 8);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker rejects a logical range whose end exceeds the JavaScript safe integer range", async () => {
  const worker = await workerHarness("logical-range-overflow");
  testAdapter("tabulark:delimited", boundaryModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");
    const opened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(opened)).result.data.datasetHandle;
    const openedTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await worker.responseFor(openedTable)).result.data.tableHandle;
    const range = worker.send("readRange", {
      tableHandle,
      range: {
        rowStart: Number.MAX_SAFE_INTEGER,
        rowCount: 1,
        columnStart: 0,
        columnCount: 0,
      },
    });
    const response = await worker.responseFor(range);
    assert.equal(response.status, "failure");
    assert.equal(response.error.code, "INVALID_RANGE");
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker bounds zero-height and zero-width ranges by axis as well as cell product", async () => {
  const worker = await workerHarness("logical-range-axis-limit");
  testAdapter("tabulark:delimited", boundaryModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");
    const opened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(opened)).result.data.datasetHandle;
    const openedTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await worker.responseFor(openedTable)).result.data.tableHandle;
    const range = worker.send("readRange", {
      tableHandle,
      range: {
        rowStart: 0,
        rowCount: 0,
        columnStart: 0,
        columnCount: Number.MAX_SAFE_INTEGER,
      },
    });
    const response = await worker.responseFor(range);
    assert.equal(response.status, "failure");
    assert.equal(response.error.code, "RESOURCE_LIMIT");
    assert.equal(response.error.details.resource, "range-cells");
    assert.equal(response.error.details.available, 250_000);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker disposes a constructed runtime when ABI validation fails", async () => {
  const worker = await workerHarness("abi-dispose", [
    "__tabularkInvalidAbiShutdowns",
    "__tabularkInvalidAbiFrees",
  ]);
  Object.defineProperties(globalThis, {
    __tabularkInvalidAbiShutdowns: { configurable: true, writable: true, value: 0 },
    __tabularkInvalidAbiFrees: { configurable: true, writable: true, value: 0 },
  });

  try {
    const hello = worker.send("hello", {
      adapters: [testAdapter("tabulark:delimited", invalidAbiModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");

    const opened = worker.send("openSource", {
      source: new Blob(["value"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const openedResponse = await worker.responseFor(opened);
    assert.equal(openedResponse.status, "failure");
    assert.equal(openedResponse.error.code, "PROTOCOL_INCOMPATIBLE");
    assert.equal(globalThis.__tabularkInvalidAbiShutdowns, 1);
    assert.equal(globalThis.__tabularkInvalidAbiFrees, 1);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker rejects structural delimiters and normalizes untrusted metadata", async () => {
  const worker = await workerHarness("metadata-boundaries", ["__tabularkBoundaryBeginOpens"]);
  Object.defineProperty(globalThis, "__tabularkBoundaryBeginOpens", {
    configurable: true,
    writable: true,
    value: 0,
  });

  try {
    const hello = worker.send("hello", {
      adapters: [testAdapter("tabulark:delimited", boundaryModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");

    for (const delimiter of ["\0", "\r", "\n", "\""]) {
      const opened = worker.send("openSource", {
        source: new Blob(["value"]),
        adapterId: "tabulark:delimited",
        options: { delimiter, header: "first-row", mode: "strict" },
      });
      const response = await worker.responseFor(opened);
      assert.equal(response.status, "failure");
      assert.equal(response.error.code, "INVALID_ARGUMENT");
    }
    assert.equal(globalThis.__tabularkBoundaryBeginOpens, 0);

    const opened = worker.send("openSource", {
      source: new Blob(["value"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(opened)).result.data.datasetHandle;
    const openedTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await worker.responseFor(openedTable)).result.data.tableHandle;
    const metadataRequest = worker.send("getMetadata", { tableHandle });
    const metadata = (await worker.responseFor(metadataRequest)).result.data;

    assert.deepEqual(metadata.extent, {
      rows: { kind: "at-least", value: 0 },
      columns: { kind: "exact", value: 1 },
    });
    assert.deepEqual(metadata.capabilities, {
      randomAccess: "indexed-prefix",
      typedValues: false,
      search: false,
      sort: false,
      filter: false,
      multiTable: false,
      customCapability: "preserved",
    });
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker closes an adapter table that finishes opening after its dataset is closed", async () => {
  const worker = await workerHarness("async-open-close", ["__tabularkAsyncLifecycle"]);
  const lifecycle = deferredLifecycle();
  Object.defineProperty(globalThis, "__tabularkAsyncLifecycle", {
    configurable: true,
    writable: true,
    value: lifecycle,
  });
  testAdapter("tabulark:delimited", asyncLifecycleModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");
    const opened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(opened)).result.data.datasetHandle;

    const openingTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    await lifecycle.waitFor("openTable");
    const closing = worker.send("closeSource", { datasetHandle });
    assert.equal((await worker.responseFor(closing)).status, "success");
    const cancelled = await worker.responseFor(openingTable);
    assert.equal(cancelled.status, "failure");
    assert.equal(cancelled.error.code, "CANCELLED");

    lifecycle.openTable.resolve({ tableHandle: 42, metadata: lifecycle.metadataValue });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(lifecycle.closedTables, [42]);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker cancels pending metadata and presentation calls when a table closes", async () => {
  const worker = await workerHarness("async-table-close", ["__tabularkAsyncLifecycle"]);
  const lifecycle = deferredLifecycle();
  Object.defineProperty(globalThis, "__tabularkAsyncLifecycle", {
    configurable: true,
    writable: true,
    value: lifecycle,
  });
  testAdapter("tabulark:delimited", asyncLifecycleModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");
    const opened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(opened)).result.data.datasetHandle;
    lifecycle.openTable.resolve({ tableHandle: 42, metadata: lifecycle.metadataValue });
    const openedTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await worker.responseFor(openedTable)).result.data.tableHandle;

    const metadata = worker.send("getMetadata", { tableHandle });
    const presentation = worker.send("getPresentation", { tableHandle });
    const presentationRange = worker.send("readPresentationRange", {
      tableHandle,
      range: { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    await Promise.all([
      lifecycle.waitFor("metadata"),
      lifecycle.waitFor("presentation"),
      lifecycle.waitFor("presentationRange"),
    ]);

    const closing = worker.send("closeTable", { tableHandle });
    assert.equal((await worker.responseFor(closing)).status, "success");
    for (const requestId of [metadata, presentation, presentationRange]) {
      const response = await worker.responseFor(requestId);
      assert.equal(response.status, "failure");
      assert.equal(response.error.code, "CANCELLED");
    }
    assert.deepEqual(lifecycle.closedTables, [42]);

    lifecycle.metadata.resolve(lifecycle.metadataValue);
    lifecycle.presentation.resolve(null);
    lifecycle.presentationRange.resolve(null);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker reclaims operation handles returned after beginOpen and beginRead cancellation", async () => {
  const worker = await workerHarness("late-begin-handles", ["__tabularkLateOperations"]);
  const lifecycle = lateOperationLifecycle();
  Object.defineProperty(globalThis, "__tabularkLateOperations", {
    configurable: true,
    writable: true,
    value: lifecycle,
  });
  testAdapter("tabulark:delimited", lateOperationModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");

    const opening = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    await lifecycle.waitFor("beginOpen");
    const cancelOpen = worker.send("cancel", { targetRequestId: opening });
    assert.equal((await worker.responseFor(cancelOpen)).status, "success");
    assert.equal((await worker.responseFor(opening)).error.code, "CANCELLED");
    lifecycle.beginOpen.resolve({
      kind: "open-progress",
      operationHandle: 77,
      sourceHandle: 66,
      action: { kind: "read-bytes", offset: 0, length: 1 },
      tables: [{ id: "table-0", name: "Late operation table" }],
      metadata: lifecycle.metadataValue,
      progress: { bytesScanned: 0, rowsDiscovered: 0, done: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(lifecycle.cancelledOperations, [77]);
    assert.deepEqual(lifecycle.closedSources, [66]);

    lifecycle.delayOpen = false;
    const reopened = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await worker.responseFor(reopened)).result.data.datasetHandle;
    const openingTable = worker.send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await worker.responseFor(openingTable)).result.data.tableHandle;
    const reading = worker.send("readRange", {
      tableHandle,
      range: { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    await lifecycle.waitFor("beginRead");
    const cancelRead = worker.send("cancel", { targetRequestId: reading });
    assert.equal((await worker.responseFor(cancelRead)).status, "success");
    assert.equal((await worker.responseFor(reading)).error.code, "CANCELLED");
    lifecycle.beginRead.resolve({
      kind: "read-bytes",
      operationHandle: 88,
      action: { kind: "read-bytes", offset: 0, length: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(lifecycle.cancelledOperations, [77, 88]);
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

test("Worker disposes an adapter that finishes loading after shutdown", async () => {
  const worker = await workerHarness("late-adapter-load", ["__tabularkLateAdapterLoad"]);
  let resolveLoad;
  const lifecycle = {
    started: false,
    promise: new Promise((resolve) => { resolveLoad = resolve; }),
    constructed: 0,
    shutdowns: 0,
    frees: 0,
  };
  Object.defineProperty(globalThis, "__tabularkLateAdapterLoad", {
    configurable: true,
    writable: true,
    value: lifecycle,
  });
  testAdapter("tabulark:delimited", lateAdapterLoadModuleUrl());
  try {
    const hello = worker.send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await worker.responseFor(hello)).status, "success");
    const opening = worker.send("openSource", {
      source: new Blob(["value\n1\n"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    for (let attempt = 0; attempt < 200 && !lifecycle.started; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(lifecycle.started, true);

    const shutdown = worker.send("shutdown", {});
    assert.equal((await worker.responseFor(shutdown)).status, "success");
    assert.equal((await worker.responseFor(opening)).error.code, "CANCELLED");
    resolveLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      { constructed: lifecycle.constructed, shutdowns: lifecycle.shutdowns, frees: lifecycle.frees },
      { constructed: 1, shutdowns: 1, frees: 1 },
    );
  } finally {
    await worker.shutdown();
    worker.restore();
  }
});

async function workerHarness(name, extraGlobals = []) {
  const saved = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkTestOnlyAdapterModuleUrls",
    ...extraGlobals,
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: {
      configurable: true,
      value: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
    },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
  });
  await import(`../dist/worker.js?${name}-${Date.now()}-${Math.random()}`);

  let nextRequest = 1;
  const send = (op, payload) => {
    const requestId = `r${nextRequest++}`;
    const request = { protocolVersion: 3, requestId, op, payload };
    for (const listener of listeners) listener({ data: request });
    return requestId;
  };
  const responseFor = async (requestId) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = messages.find((message) => message.requestId === requestId);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`No response for ${requestId}`);
  };
  return {
    send,
    responseFor,
    async shutdown() {
      const requestId = send("shutdown", {});
      const response = await responseFor(requestId);
      assert.equal(response.status, "success");
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    restore() {
      restoreGlobals(saved);
    },
  };
}

function invalidAbiModuleUrl() {
  const source = `
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 1; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {}
      continueOperation() {}
      openTable() {}
      metadata() {}
      presentation() { return null; }
      readPresentationRange() { return null; }
      beginRead() {}
      cancelOperation() {}
      closeTable() {}
      closeSource() {}
      shutdown() { globalThis.__tabularkInvalidAbiShutdowns += 1; }
      free() { globalThis.__tabularkInvalidAbiFrees += 1; }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function boundaryModuleUrl() {
  const source = `
    const metadata = () => ({
      tableId: "table-0",
      name: "Boundary table",
      revision: 0,
      extent: {
        rows: { kind: "exact", value: -1 },
        columns: { kind: "at-least", value: -2 },
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
        randomAccess: "untrusted",
        typedValues: "yes",
        search: 1,
        sort: null,
        filter: {},
        multiTable: "true",
        customCapability: "preserved",
      },
    });
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 3; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {
        globalThis.__tabularkBoundaryBeginOpens += 1;
        return {
          kind: "open-complete",
          sourceHandle: 1,
          tables: [{ id: "table-0", name: "Boundary table" }],
          metadata: metadata(),
        };
      }
      continueOperation() {}
      openTable() { return { tableHandle: 2, metadata: metadata() }; }
      metadata() { return metadata(); }
      presentation() { return null; }
      readPresentationRange() { return null; }
      beginRead() {}
      cancelOperation() {}
      closeTable() {}
      closeSource() {}
      shutdown() {}
      free() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function overflowingRangeModuleUrl() {
  const source = `
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 3; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {
        return {
          kind: "read-bytes",
          operationHandle: 1,
          action: { kind: "read-bytes", offset: Number.MAX_SAFE_INTEGER, length: 1 },
        };
      }
      continueOperation() {}
      openTable() {}
      metadata() {}
      presentation() { return null; }
      readPresentationRange() { return null; }
      beginRead() {}
      cancelOperation() {}
      closeTable() {}
      closeSource() {}
      shutdown() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function asyncLifecycleModuleUrl() {
  const source = `
    const lifecycle = () => globalThis.__tabularkAsyncLifecycle;
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 3; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {
        return {
          kind: "open-complete",
          sourceHandle: 1,
          tables: [{ id: "table-0", name: "Async table" }],
          metadata: lifecycle().metadataValue,
        };
      }
      continueOperation() {}
      openTable() {
        lifecycle().started.add("openTable");
        return lifecycle().openTable.promise;
      }
      metadata() {
        lifecycle().started.add("metadata");
        return lifecycle().metadata.promise;
      }
      presentation() {
        lifecycle().started.add("presentation");
        return lifecycle().presentation.promise;
      }
      readPresentationRange() {
        lifecycle().started.add("presentationRange");
        return lifecycle().presentationRange.promise;
      }
      beginRead() {}
      cancelOperation() {}
      closeTable(handle) { lifecycle().closedTables.push(handle); }
      closeSource() {}
      shutdown() {}
      free() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function lateOperationModuleUrl() {
  const source = `
    const lifecycle = () => globalThis.__tabularkLateOperations;
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 3; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {
        lifecycle().started.add("beginOpen");
        if (lifecycle().delayOpen) return lifecycle().beginOpen.promise;
        return {
          kind: "open-complete",
          sourceHandle: 1,
          tables: [{ id: "table-0", name: "Late operation table" }],
          metadata: lifecycle().metadataValue,
        };
      }
      continueOperation() {}
      openTable() { return { tableHandle: 2, metadata: lifecycle().metadataValue }; }
      metadata() { return lifecycle().metadataValue; }
      presentation() { return null; }
      readPresentationRange() { return null; }
      beginRead() {
        lifecycle().started.add("beginRead");
        return lifecycle().beginRead.promise;
      }
      cancelOperation(handle) { lifecycle().cancelledOperations.push(handle); }
      closeTable() {}
      closeSource(handle) { lifecycle().closedSources.push(handle); }
      shutdown() {}
      free() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function lateAdapterLoadModuleUrl() {
  const source = `
    const lifecycle = () => globalThis.__tabularkLateAdapterLoad;
    export default async function init() {
      lifecycle().started = true;
      await lifecycle().promise;
    }
    export class WasmRuntime {
      constructor() { lifecycle().constructed += 1; }
      protocolVersion() { return 3; }
      adapterApiVersion() { return 2; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {}
      continueOperation() {}
      openTable() {}
      metadata() {}
      presentation() { return null; }
      readPresentationRange() { return null; }
      beginRead() {}
      cancelOperation() {}
      closeTable() {}
      closeSource() {}
      shutdown() { lifecycle().shutdowns += 1; }
      free() { lifecycle().frees += 1; }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function deferredLifecycle() {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const started = new Set();
  return {
    started,
    closedTables: [],
    metadataValue: {
      tableId: "table-0",
      name: "Async table",
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
      capabilities: {},
    },
    openTable: deferred(),
    metadata: deferred(),
    presentation: deferred(),
    presentationRange: deferred(),
    async waitFor(name) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (started.has(name)) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`Async adapter method ${name} did not start`);
    },
  };
}

function lateOperationLifecycle() {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const started = new Set();
  return {
    delayOpen: true,
    started,
    cancelledOperations: [],
    closedSources: [],
    metadataValue: {
      tableId: "table-0",
      name: "Late operation table",
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
      capabilities: {},
    },
    beginOpen: deferred(),
    beginRead: deferred(),
    async waitFor(name) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (started.has(name)) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`Async adapter method ${name} did not start`);
    },
  };
}

function testAdapter(id, moduleUrl) {
  const urls = globalThis.__tabularkTestOnlyAdapterModuleUrls ?? {};
  Object.defineProperty(globalThis, "__tabularkTestOnlyAdapterModuleUrls", {
    configurable: true,
    writable: true,
    value: { ...urls, [id]: moduleUrl },
  });
  return { id };
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
