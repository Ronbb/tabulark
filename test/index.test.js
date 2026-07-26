import assert from "node:assert/strict";
import test from "node:test";

import * as stable from "../dist/index.js";
import * as arrow from "../dist/arrow.js";
import * as parquet from "../dist/parquet.js";
import * as excel from "../dist/excel.js";
import * as experimental from "../dist/experimental.js";

const { createEngine, delimitedAdapter } = stable;

test("stable and experimental runtime exports match the 0.1 API snapshot", () => {
  assert.deepEqual(Object.keys(stable).sort(), [
    "TabularkError",
    "createCanvasTableView",
    "createEngine",
    "delimitedAdapter",
  ]);
  assert.deepEqual(Object.keys(arrow).sort(), ["arrowIpcAdapter"]);
  assert.deepEqual(Object.keys(parquet).sort(), ["parquetAdapter"]);
  assert.deepEqual(Object.keys(excel).sort(), ["excelAdapter"]);
  assert.deepEqual(Object.keys(experimental).sort(), [
    "CanvasTablePainter",
    "DEFAULT_CANVAS_TABLE_THEME",
    "DEFAULT_COLUMN_WIDTH",
    "DEFAULT_HEADER_HEIGHT",
    "DEFAULT_MAX_COLUMN_WIDTH",
    "DEFAULT_MIN_COLUMN_WIDTH",
    "DEFAULT_OVERSCAN_COLUMNS",
    "DEFAULT_OVERSCAN_ROWS",
    "DEFAULT_ROW_HEADER_WIDTH",
    "DEFAULT_ROW_HEIGHT",
    "DEFAULT_SCROLL_PIXEL_LIMIT",
    "axisIndexAtOffset",
    "axisPosition",
    "axisSize",
    "cellRect",
    "clampCell",
    "columnHeaderRect",
    "containsCell",
    "createScrollAxis",
    "createSparseAxisGeometry",
    "createSelection",
    "createTableController",
    "createTableLayout",
    "hitTest",
    "logicalToPhysicalOffset",
    "moveCell",
    "nextVisibleAxisIndex",
    "physicalToLogicalOffset",
    "rowHeaderRect",
    "selectionRange",
    "selectionRect",
  ].sort());
  for (const leaked of [
    "PROTOCOL_VERSION",
    "ADAPTER_API_VERSION",
    "BATCH_LAYOUT_VERSION",
    "ColumnarTableBatch",
    "createTableController",
  ]) {
    assert.equal(leaked in stable, false, `${leaked} must not leak from the stable root`);
  }
});

test("rejects engine creation outside a browser", async () => {
  await assert.rejects(createEngine({ adapters: [delimitedAdapter] }), (error) => {
    assert.equal(error.code, "UNSUPPORTED_RUNTIME");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("validates the engine memory budget before runtime startup", async () => {
  await assert.rejects(createEngine({ adapters: [delimitedAdapter], memoryBudgetBytes: 0 }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
});

test("requires a unique immutable official adapter allow-list", async () => {
  assert.equal(Object.isFrozen(delimitedAdapter), true);
  assert.equal(delimitedAdapter.id, "tabulark:delimited");

  await assert.rejects(createEngine({ adapters: [] }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
  await assert.rejects(
    createEngine({ adapters: [delimitedAdapter, delimitedAdapter] }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /more than once/);
      return true;
    },
  );
  await assert.rejects(
    createEngine({ adapters: [Object.freeze({ id: "tabulark:delimited", kind: "official" })] }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("official adapter IDs select fixed manifest artifacts across all stable entrypoints", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: AdapterCaptureWorker,
  });
  const marker = Symbol.for("tabulark.official-adapter.v2");
  const injectedUrl = "data:text/javascript,throw new Error('injected')";
  const forgedDelimited = Object.freeze({
    id: "tabulark:delimited",
    kind: "official",
    moduleUrl: injectedUrl,
    [marker]: Object.freeze({ id: "tabulark:delimited", moduleUrl: injectedUrl }),
  });

  let engine;
  try {
    engine = await createEngine({
      adapters: [forgedDelimited, arrow.arrowIpcAdapter, parquet.parquetAdapter, excel.excelAdapter],
    });
    const hello = AdapterCaptureWorker.latest.requests.find((request) => request.op === "hello");
    assert.ok(hello);
    assert.deepEqual(hello.payload.adapters.map((adapter) => adapter.id), [
      "tabulark:delimited",
      "tabulark:arrow-ipc",
      "tabulark:parquet",
      "tabulark:excel",
    ]);
    assert.equal(hello.payload.adapters.every((adapter) => Object.keys(adapter).length === 1), true);
    assert.equal(hello.payload.adapters.some((adapter) => "moduleUrl" in adapter), false);
    assert.equal(JSON.stringify(hello.payload).includes(injectedUrl), false);
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("delimited options reject structural CSV bytes as delimiters", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: AdapterCaptureWorker,
  });

  let engine;
  try {
    engine = await createEngine({ adapters: [delimitedAdapter] });
    for (const delimiter of ["\0", "\r", "\n", "\""]) {
      await assert.rejects(
        engine.open(new Blob(["value"]), {
          adapter: delimitedAdapter,
          adapterOptions: { dialect: "csv", delimiter },
        }),
        (error) => {
          assert.equal(error.code, "INVALID_ARGUMENT");
          assert.match(error.message, /non-NUL ASCII byte/);
          return true;
        },
      );
    }
    assert.equal(
      AdapterCaptureWorker.latest.requests.some((request) => request.op === "openSource"),
      false,
    );
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

class AdapterCaptureWorker {
  static latest;
  requests = [];
  #listeners = new Map();

  constructor() {
    AdapterCaptureWorker.latest = this;
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
    const kind = request.op === "hello" ? "hello" : "acknowledged";
    const data = request.op === "hello"
      ? {
          protocolVersion: 4,
          adapterApiVersion: 3,
          batchLayoutVersion: 1,
          adapters: request.payload.adapters.map((adapter) => adapter.id),
          transferableBatches: true,
        }
      : undefined;
    queueMicrotask(() => {
      const response = {
        protocolVersion: 4,
        requestId: request.requestId,
        status: "success",
        result: data === undefined ? { kind } : { kind, data },
      };
      for (const listener of this.#listeners.get("message") ?? []) {
        listener({ data: response });
      }
    });
  }

  terminate() {}
}
