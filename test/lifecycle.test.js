import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, delimitedAdapter } from "../dist/index.js";
import { createTableController } from "../dist/experimental.js";

const createTestEngine = () => createEngine({
  adapters: [delimitedAdapter],
  memoryBudgetBytes: 8 * 1024 * 1024,
});
const csvOptions = (extra = {}) => ({
  adapter: delimitedAdapter,
  adapterOptions: { dialect: "csv" },
  ...extra,
});

test("open forwards AbortSignal and reclaims a source when cancellation races session delivery", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const controller = new AbortController();
    worker.afterOpenResponse = () => controller.abort();

    await assert.rejects(
      engine.open(new Blob(["value\na\n"]), csvOptions({ signal: controller.signal })),
      (error) => {
        assert.equal(error.code, "CANCELLED");
        return true;
      },
    );

    assert.deepEqual(worker.closedSources, ["d1"]);
    assert.equal(worker.requests.some((request) => request.op === "listTables"), false);

    const reopened = await engine.open(new Blob(["value\nb\n"]), csvOptions());
    const table = await reopened.openTable("table-0");
    await table.close();
    await reopened.close();
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("open cancellation sends a Worker cancel while openSource is still pending", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.holdOpenResponse = true;
    const controller = new AbortController();
    const opening = engine.open(new Blob(["value\na\n"]), csvOptions({ signal: controller.signal }));
    await waitFor(() => worker.requests.some((request) => request.op === "openSource"));
    const openRequest = worker.requests.find((request) => request.op === "openSource");
    controller.abort();

    await assert.rejects(opening, (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    });
    await waitFor(() => worker.requests.some((request) => request.op === "cancel"));
    assert.equal(
      worker.requests.find((request) => request.op === "cancel").payload.targetRequestId,
      openRequest.requestId,
    );
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("a background scan fatal closes its dataset, table, and controller exactly once", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  let controller;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    const table = await dataset.openTable("table-0");
    const datasetEvents = [];
    const tableEvents = [];
    dataset.subscribe((event) => datasetEvents.push(event.type));
    table.subscribe((event) => tableEvents.push(event.type));
    controller = createTableController(table);

    worker.failBackgroundScan("d1", "t1");

    assert.deepEqual(datasetEvents, ["runtimeError", "closed"]);
    assert.deepEqual(tableEvents, ["runtimeError", "closed"]);
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(worker.closedSources.filter((handle) => handle === "d1").length, 1);
    await assert.rejects(dataset.openTable("table-0"), (error) => error.code === "HANDLE_CLOSED");
    await assert.rejects(table.readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    }), (error) => error.code === "HANDLE_CLOSED");
  } finally {
    controller?.dispose();
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("openTable rolls back a remote table when metadata validation fails", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    worker.metadataOverride = {};

    await assert.rejects(dataset.openTable("table-0"), (error) => {
      assert.equal(error.code, "PROTOCOL_INCOMPATIBLE");
      return true;
    });
    await waitFor(() => worker.closedTables.includes("t1"));

    worker.metadataOverride = undefined;
    const reopened = await dataset.openTable("table-0");
    await reopened.close();
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("metadata normalization excludes negative extents and canonicalizes capabilities", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    worker.metadataOverride = {
      ...metadata(),
      extent: {
        rows: { kind: "exact", value: -1 },
        columns: { kind: "at-least", value: -2 },
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
    };

    const table = await dataset.openTable("table-0");
    assert.deepEqual(table.metadata.extent, {
      rows: { kind: "at-least", value: 0 },
      columns: { kind: "exact", value: 1 },
    });
    assert.deepEqual(table.metadata.capabilities, {
      randomAccess: "indexed-prefix",
      typedValues: false,
      search: false,
      sort: false,
      filter: false,
      multiTable: false,
      customCapability: "preserved",
    });
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("malformed Worker protocol messages fail pending work and terminate the Worker", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.malformedResponseOp = "listTables";

    await assert.rejects(engine.open(new Blob(["value\na\n"]), csvOptions()), (error) => {
      assert.equal(error.code, "PROTOCOL_INCOMPATIBLE");
      return true;
    });
    assert.equal(worker.terminated, 1);
    assert.equal(worker.requests.some((request) => request.op === "closeSource"), false);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("protocol-v1 Worker responses are explicitly rejected", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });
  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.v1ResponseOp = "listTables";
    await assert.rejects(engine.open(new Blob(["value\na\n"]), csvOptions()), (error) => {
      assert.equal(error.code, "PROTOCOL_INCOMPATIBLE");
      return true;
    });
    assert.equal(worker.terminated, 1);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("dataset events without routing fail pending work and terminate the Worker", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.malformedEventBeforeListTables = true;

    await assert.rejects(engine.open(new Blob(["value\na\n"]), csvOptions()), (error) => {
      assert.equal(error.code, "PROTOCOL_INCOMPATIBLE");
      return true;
    });
    assert.equal(worker.terminated, 1);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("open preserves a background fatal that arrives before listTables completes", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.failBeforeListTables = true;

    await assert.rejects(engine.open(new Blob(["value\na\n"]), csvOptions()), (error) => {
      assert.equal(error.code, "PARSE_FAILED");
      assert.equal(error.message, "Synthetic pre-session scan failure");
      return true;
    });
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("dataset.close tolerates a delayed acknowledgement from a healthy Worker", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    worker.delayCloseSourceMs = 750;

    await dataset.close();
    assert.equal(worker.terminated, 0);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("engine.close terminates an unresponsive Worker within a bounded wait", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    worker.holdShutdownResponse = true;
    const startedAt = Date.now();
    await engine.close();
    assert.ok(Date.now() - startedAt < 4_000);
    assert.equal(worker.terminated, 1);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("dataset.close terminates an unresponsive Worker within a bounded wait", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createTestEngine();
    const worker = LifecycleWorker.latest;
    const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
    worker.holdCloseSourceResponse = true;
    const startedAt = Date.now();
    await assert.rejects(dataset.close(), (error) => error.code === "RUNTIME_FAILURE");
    assert.ok(Date.now() - startedAt < 4_000);
    assert.equal(worker.terminated, 1);
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

for (const eventType of ["error", "messageerror"]) {
  test(`Worker ${eventType} closes live sessions and surfaces a terminal controller error`, async () => {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: LifecycleWorker,
    });

    let engine;
    let controller;
    try {
      engine = await createTestEngine();
      const worker = LifecycleWorker.latest;
      const dataset = await engine.open(new Blob(["value\na\n"]), csvOptions());
      const table = await dataset.openTable("table-0");
      const datasetEvents = [];
      const tableEvents = [];
      dataset.subscribe((event) => datasetEvents.push(event.type));
      controller = createTableController(table);
      const controllerStates = [];
      controller.subscribe((snapshot) => controllerStates.push(snapshot.status));
      table.subscribe((event) => tableEvents.push(event.type));

      worker.holdReadResponses = true;
      const pendingRead = table.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      await waitFor(() => worker.requests.some((request) => request.op === "readRange"));
      worker.fail(eventType);

      await assert.rejects(pendingRead, (error) => {
        assert.equal(error.code, "RUNTIME_FAILURE");
        return true;
      });
      assert.deepEqual(datasetEvents, ["runtimeError", "closed"]);
      assert.deepEqual(tableEvents, ["runtimeError", "closed"]);
      assert.ok(controllerStates.includes("error"));
      assert.equal(controller.getSnapshot().status, "error");
      assert.throws(
        () => controller.updateViewport({ width: 100, height: 100 }),
        (error) => error.code === "HANDLE_CLOSED",
      );
      assert.equal(worker.terminated, 1);

      await assert.rejects(dataset.openTable("table-0"), (error) => {
        assert.equal(error.code, "HANDLE_CLOSED");
        return true;
      });
      await assert.rejects(table.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      }), (error) => {
        assert.equal(error.code, "HANDLE_CLOSED");
        return true;
      });
      await assert.rejects(engine.open(new Blob(["value\na\n"]), csvOptions()), (error) => {
        assert.equal(error.code, "HANDLE_CLOSED");
        return true;
      });
    } finally {
      controller?.dispose();
      await engine?.close();
      restoreWorker(originalWorker);
    }
  });
}

class LifecycleWorker {
  static latest;

  #listeners = new Map();
  requests = [];
  closedSources = [];
  closedTables = [];
  holdOpenResponse = false;
  holdReadResponses = false;
  holdShutdownResponse = false;
  holdCloseSourceResponse = false;
  delayCloseSourceMs = 0;
  metadataOverride;
  malformedResponseOp;
  v1ResponseOp;
  malformedEventBeforeListTables = false;
  failBeforeListTables = false;
  afterOpenResponse;
  terminated = 0;

  constructor() {
    LifecycleWorker.latest = this;
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
    this.requests.push(request);
    if (request.op === "openSource" && this.holdOpenResponse) {
      return;
    }
    if (request.op === "readRange" && this.holdReadResponses) {
      return;
    }
    if (request.op === "shutdown" && this.holdShutdownResponse) {
      return;
    }
    if (request.op === "closeSource" && this.holdCloseSourceResponse) {
      return;
    }
    if (request.op === this.malformedResponseOp) {
      queueMicrotask(() => this.#emit("message", {
        data: {
          protocolVersion: 4,
          requestId: request.requestId,
          status: "success",
        },
      }));
      return;
    }
    if (request.op === this.v1ResponseOp) {
      const response = responseFor(request, this);
      response.protocolVersion = 1;
      queueMicrotask(() => this.#emit("message", { data: response }));
      return;
    }
    if (request.op === "listTables" && this.malformedEventBeforeListTables) {
      queueMicrotask(() => this.#emit("message", {
        data: {
          protocolVersion: 4,
          event: "warning",
          payload: {
            handle: request.payload.datasetHandle,
            kind: "synthetic-warning",
            message: "This event intentionally omits datasetHandle",
          },
        },
      }));
      return;
    }
    if (request.op === "listTables" && this.failBeforeListTables) {
      queueMicrotask(() => {
        this.#emit("message", {
          data: {
            protocolVersion: 4,
            event: "runtimeError",
            datasetHandle: request.payload.datasetHandle,
            payload: {
              code: "PARSE_FAILED",
              message: "Synthetic pre-session scan failure",
              retryable: false,
            },
          },
        });
        this.#emit("message", {
          data: {
            protocolVersion: 4,
            event: "closed",
            datasetHandle: request.payload.datasetHandle,
            payload: { handle: request.payload.datasetHandle, kind: "source" },
          },
        });
        this.#emit("message", {
          data: {
            protocolVersion: 4,
            requestId: request.requestId,
            status: "failure",
            error: {
              code: "HANDLE_CLOSED",
              message: "The source is closed",
              retryable: false,
            },
          },
        });
      });
      return;
    }
    const response = responseFor(request, this);
    if (!response) {
      return;
    }
    if (request.op === "closeSource") {
      queueMicrotask(() => this.#emit("message", {
        data: {
          protocolVersion: 4,
          event: "closed",
          datasetHandle: request.payload.datasetHandle,
          payload: { handle: request.payload.datasetHandle, kind: "dataset" },
        },
      }));
    }
    if (request.op === "closeTable") {
      this.closedTables.push(request.payload.tableHandle);
    }
    const emitResponse = () => this.#emit("message", { data: response });
    if (request.op === "closeSource" && this.delayCloseSourceMs > 0) {
      setTimeout(emitResponse, this.delayCloseSourceMs);
    } else {
      queueMicrotask(emitResponse);
    }
  }

  terminate() {
    this.terminated += 1;
  }

  fail(type) {
    this.#emit(type, new Event(type));
  }

  failBackgroundScan(datasetHandle, tableHandle) {
    this.closedSources.push(datasetHandle);
    this.#emit("message", {
      data: {
        protocolVersion: 4,
        event: "runtimeError",
        datasetHandle,
        payload: {
          code: "PARSE_FAILED",
          message: "Synthetic delayed scan failure",
          retryable: false,
        },
      },
    });
    this.#emit("message", {
      data: {
        protocolVersion: 4,
        event: "closed",
        datasetHandle,
        tableHandle,
        tableId: "table-0",
        payload: { handle: tableHandle, kind: "table" },
      },
    });
    this.#emit("message", {
      data: {
        protocolVersion: 4,
        event: "closed",
        datasetHandle,
        tableId: "table-0",
        payload: { handle: datasetHandle, kind: "source" },
      },
    });
  }

  #emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
    if (type === "message" && event.data?.requestId && event.data.result?.kind === "dataset") {
      this.afterOpenResponse?.();
    }
  }
}

function responseFor(request, worker) {
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
      data = worker.metadataOverride ?? metadata();
      break;
    case "closeSource":
      worker.closedSources.push(request.payload.datasetHandle);
      kind = "acknowledged";
      break;
    case "cancel":
    case "closeTable":
    case "shutdown":
      kind = "acknowledged";
      break;
    default:
      return undefined;
  }
  return {
    protocolVersion: 4,
    requestId: request.requestId,
    status: "success",
    result: data === undefined ? { kind } : { kind, data },
  };
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

function restoreWorker(originalWorker) {
  if (originalWorker) {
    Object.defineProperty(globalThis, "Worker", originalWorker);
  } else {
    delete globalThis.Worker;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}
