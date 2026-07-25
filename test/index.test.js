import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  MAX_ARRAY_BUFFER_BYTES,
  MAX_RANGE_CELLS,
  PROJECT_STATUS,
  PROTOCOL_VERSION,
  createEngine,
  createTableShape,
  delimitedAdapter,
} from "../dist/index.js";
import { arrowIpcAdapter } from "../dist/arrow.js";

test("exports the pre-alpha project status", () => {
  assert.equal(PROJECT_STATUS, "pre-alpha");
});

test("creates immutable table shape metadata", () => {
  const shape = createTableShape(12, 4);

  assert.deepEqual(shape, { rows: 12, columns: 4 });
  assert.equal(Object.isFrozen(shape), true);
});

test("rejects invalid dimensions", () => {
  assert.throws(() => createTableShape(-1, 4), RangeError);
  assert.throws(() => createTableShape(1.5, 4), RangeError);
  assert.throws(() => createTableShape(Number.MAX_SAFE_INTEGER + 1, 4), RangeError);
});

test("exports the protocol-v2 limits and version", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(DEFAULT_MEMORY_BUDGET_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_ARRAY_BUFFER_BYTES, 128 * 1024 * 1024);
  assert.equal(MAX_RANGE_CELLS, 250_000);
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
    createEngine({
      adapters: [Object.freeze({
        id: "tabulark:delimited",
        adapterApiVersion: 1,
        kind: "official",
      })],
    }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("official adapter IDs select fixed artifacts across root and arrow entrypoints", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: AdapterCaptureWorker,
  });
  const marker = Symbol.for("tabulark.official-adapter.v1");
  const injectedUrl = "data:text/javascript,throw new Error('injected')";
  const forgedDelimited = Object.freeze({
    id: "tabulark:delimited",
    adapterApiVersion: 1,
    kind: "official",
    [marker]: Object.freeze({ id: "tabulark:delimited", moduleUrl: injectedUrl }),
  });

  let engine;
  try {
    engine = await createEngine({ adapters: [forgedDelimited, arrowIpcAdapter] });
    const hello = AdapterCaptureWorker.latest.requests.find((request) => request.op === "hello");
    assert.ok(hello);
    assert.deepEqual(hello.payload.adapters.map((adapter) => adapter.id), [
      "tabulark:delimited",
      "tabulark:arrow-ipc",
    ]);
    assert.match(hello.payload.adapters[0].moduleUrl, /\/wasm\/delimited\/tabulark_delimited\.js$/);
    assert.match(hello.payload.adapters[1].moduleUrl, /\/wasm\/arrow\/tabulark_arrow\.js$/);
    assert.notEqual(hello.payload.adapters[0].moduleUrl, injectedUrl);
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

test("delimited adapter options reject structural CSV bytes as delimiters", async () => {
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
          protocolVersion: 2,
          adapterApiVersion: 1,
          batchLayoutVersion: 1,
          adapters: request.payload.adapters.map((adapter) => adapter.id),
          transferableBatches: true,
        }
      : undefined;
    queueMicrotask(() => {
      const response = {
        protocolVersion: 2,
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
