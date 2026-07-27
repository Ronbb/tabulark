import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, delimitedAdapter } from "../dist/index.js";
import { arrowIpcAdapter } from "../dist/arrow.js";
import { excelAdapter } from "../dist/excel.js";

const TWO_GIB = 2 * 1024 * 1024 * 1024;

test("large Blob mode rejects a source above the 2 GiB binary limit before Worker open", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: SourceModeWorker,
  });
  let engine;
  try {
    engine = await createEngine({ adapters: [delimitedAdapter] });
    const source = new SizedBlob(TWO_GIB + 1);
    await assert.rejects(
      engine.open(source, { adapter: delimitedAdapter, sourceMode: "large" }),
      (error) => {
        assert.equal(error.code, "RESOURCE_LIMIT");
        assert.deepEqual(error.details, {
          resource: "source-staging",
          requiredBytes: TWO_GIB + 1,
          availableBytes: TWO_GIB,
        });
        return true;
      },
    );
    assert.equal(
      SourceModeWorker.latest.requests.some((request) => request.op === "openSource"),
      false,
    );
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("large Blob mode permits the exact 2 GiB boundary and keeps ArrayBuffer limits unchanged", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: SourceModeWorker,
  });
  let engine;
  let dataset;
  try {
    engine = await createEngine({ adapters: [delimitedAdapter] });
    dataset = await engine.open(new SizedBlob(TWO_GIB), {
      adapter: delimitedAdapter,
      sourceMode: "large",
    });
    const openRequest = SourceModeWorker.latest.requests.find((request) => request.op === "openSource");
    assert.equal(openRequest.payload.sourceMode, "large");
    await dataset.close();
  } finally {
    await dataset?.close();
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("large mode is reserved for local Blob or File sources", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: SourceModeWorker,
  });
  let engine;
  try {
    engine = await createEngine({ adapters: [delimitedAdapter] });
    await assert.rejects(
      engine.open(new ArrayBuffer(8), {
        adapter: delimitedAdapter,
        sourceMode: "large",
      }),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
    assert.equal(
      SourceModeWorker.latest.requests.some((request) => request.op === "openSource"),
      false,
    );
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

test("local Arrow and Excel Blobs retain the exact 2 GiB limit in auto mode", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: SourceModeWorker,
  });
  let engine;
  try {
    engine = await createEngine({
      adapters: [delimitedAdapter, arrowIpcAdapter, excelAdapter],
    });
    for (const adapter of [arrowIpcAdapter, excelAdapter]) {
      await assert.rejects(
        engine.open(new SizedBlob(TWO_GIB + 1), { adapter }),
        (error) => {
          assert.equal(error.code, "RESOURCE_LIMIT");
          assert.equal(error.details.requiredBytes, TWO_GIB + 1);
          assert.equal(error.details.availableBytes, TWO_GIB);
          return true;
        },
      );
    }
    assert.equal(
      SourceModeWorker.latest.requests.some((request) => request.op === "openSource"),
      false,
    );

    const exact = await engine.open(new SizedBlob(TWO_GIB), {
      adapter: arrowIpcAdapter,
    });
    await exact.close();
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
});

class SizedBlob extends Blob {
  #reportedSize;

  constructor(reportedSize) {
    super([]);
    this.#reportedSize = reportedSize;
  }

  get size() {
    return this.#reportedSize;
  }
}

class SourceModeWorker {
  static latest;

  #listeners = new Map();
  requests = [];

  constructor() {
    SourceModeWorker.latest = this;
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
    let result;
    if (request.op === "hello") {
      result = {
        kind: "hello",
        data: {
          protocolVersion: 4,
          adapterApiVersion: 3,
          batchLayoutVersion: 1,
          adapters: request.payload.adapters.map(({ id }) => id),
        },
      };
    } else if (request.op === "openSource") {
      result = { kind: "dataset", data: { datasetHandle: "d1" } };
    } else if (request.op === "listTables") {
      result = { kind: "tables", data: [{ id: "t1", name: "Table 1" }] };
    } else {
      result = { kind: "acknowledged" };
    }
    queueMicrotask(() => {
      const response = {
        protocolVersion: 4,
        requestId: request.requestId,
        status: "success",
        result,
      };
      for (const listener of this.#listeners.get("message") ?? []) {
        listener({ data: response });
      }
    });
  }

  terminate() {}
}

function restoreWorker(originalWorker) {
  if (originalWorker) {
    Object.defineProperty(globalThis, "Worker", originalWorker);
  } else {
    delete globalThis.Worker;
  }
}
