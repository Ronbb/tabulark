import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, createTableController } from "../dist/index.js";

test("open forwards AbortSignal and reclaims a source when cancellation races session delivery", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: LifecycleWorker,
  });

  let engine;
  try {
    engine = await createEngine({ memoryBudgetBytes: 8 * 1024 * 1024 });
    const worker = LifecycleWorker.latest;
    const controller = new AbortController();
    worker.afterOpenResponse = () => controller.abort();

    await assert.rejects(
      engine.open(new Blob(["value\na\n"]), { format: "csv", signal: controller.signal }),
      (error) => {
        assert.equal(error.code, "CANCELLED");
        return true;
      },
    );

    assert.deepEqual(worker.closedSources, ["d1"]);
    assert.equal(worker.requests.some((request) => request.op === "listTables"), false);

    const reopened = await engine.open(new Blob(["value\nb\n"]), { format: "csv" });
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
    engine = await createEngine({ memoryBudgetBytes: 8 * 1024 * 1024 });
    const worker = LifecycleWorker.latest;
    worker.holdOpenResponse = true;
    const controller = new AbortController();
    const opening = engine.open(new Blob(["value\na\n"]), {
      format: "csv",
      signal: controller.signal,
    });
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
      engine = await createEngine({ memoryBudgetBytes: 8 * 1024 * 1024 });
      const worker = LifecycleWorker.latest;
      const dataset = await engine.open(new Blob(["value\na\n"]), { format: "csv" });
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
      await assert.rejects(engine.open(new Blob(["value\na\n"]), { format: "csv" }), (error) => {
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
  holdOpenResponse = false;
  holdReadResponses = false;
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
    const response = responseFor(request, this);
    if (!response) {
      return;
    }
    if (request.op === "closeSource") {
      queueMicrotask(() => this.#emit("message", {
        data: {
          protocolVersion: 1,
          event: "closed",
          datasetHandle: request.payload.datasetHandle,
          payload: { handle: request.payload.datasetHandle, kind: "dataset" },
        },
      }));
    }
    queueMicrotask(() => this.#emit("message", { data: response }));
  }

  terminate() {
    this.terminated += 1;
  }

  fail(type) {
    this.#emit(type, new Event(type));
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
    protocolVersion: 1,
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
