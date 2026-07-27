import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, delimitedAdapter } from "../dist/index.js";
import { httpRangeSource } from "../dist/http.js";

const MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;

test("RangeSource readers are opened independently and closed exactly once", async () => {
  await withRangeSourceEngine(async ({ engine }) => {
    const state = createReaderState();
    const source = trackedRangeSource(state);

    const first = await engine.open(source, { adapter: delimitedAdapter });
    const second = await engine.open(source, { adapter: delimitedAdapter });
    assert.equal(state.openCount, 2);
    assert.equal(state.readers.length, 2);

    await first.close();
    await first.close();
    assert.deepEqual(state.readers.map(({ closeCount }) => closeCount), [1, 0]);

    await engine.close();
    await engine.close();
    await second.close();
    assert.deepEqual(state.readers.map(({ closeCount }) => closeCount), [1, 1]);
  });
});

test("the host broker enforces reader maxConcurrency across queued source reads", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    const state = createReaderState();
    const source = trackedRangeSource(state, {
      maxConcurrency: 2,
      read: gatedRead,
    });
    worker.queueOpenReads([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 4 },
      { offset: 12, length: 4 },
    ]);

    const opening = engine.open(source, { adapter: delimitedAdapter });
    await waitFor(() => state.readCalls.length === 2);
    assert.equal(state.activeReads, 2);
    assert.equal(state.maxActiveReads, 2);

    state.readCalls[0].release();
    state.readCalls[1].release();
    await waitFor(() => state.readCalls.length === 4);
    assert.equal(state.maxActiveReads, 2);
    assert.equal(state.activeReads, 2);
    state.readCalls[2].release();
    state.readCalls[3].release();

    const dataset = await opening;
    assert.deepEqual(
      state.readCalls.map(({ range }) => range),
      [
        { offset: 0, length: 4 },
        { offset: 4, length: 4 },
        { offset: 8, length: 4 },
        { offset: 12, length: 4 },
      ],
    );
    assert.ok(state.readCalls.every(({ signal }) => signal instanceof AbortSignal));
    assert.equal(worker.brokerResponses.length, 4);
    assert.ok(worker.brokerResponses.every(({ type }) => type === "source-read-result"));
    assert.ok(worker.brokerResponses.every(({ buffer, length }) => (
      buffer instanceof ArrayBuffer && buffer.byteLength === length
    )));

    await dataset.close();
    assert.equal(state.readers[0].closeCount, 1);
  });
});

for (const [name, delta] of [["short", -1], ["long", 1]]) {
  test(`${name} RangeSource reads fail structurally and close the reader once`, async () => {
    await withRangeSourceEngine(async ({ engine, worker }) => {
      const state = createReaderState();
      const source = trackedRangeSource(state, {
        read: ({ length }) => new Uint8Array(length + delta),
      });
      worker.queueOpenReads([{ offset: 3, length: 4 }]);

      await assert.rejects(
        engine.open(source, { adapter: delimitedAdapter }),
        (error) => {
          assert.equal(error?.name, "TabularkError");
          assert.equal(error?.code, "RUNTIME_FAILURE");
          assert.equal(error?.retryable, false);
          return true;
        },
      );
      assert.equal(worker.brokerResponses.length, 1);
      assert.equal(worker.brokerResponses[0].type, "source-read-failure");
      assert.deepEqual(worker.brokerResponses[0].error, {
        code: "RUNTIME_FAILURE",
        message: "The source provider returned invalid bytes",
        retryable: false,
      });
      assert.equal(state.readers[0].closeCount, 1);

      await engine.close();
      assert.equal(state.readers[0].closeCount, 1);
    });
  });
}

test("structured SOURCE_CHANGED provider failures survive the broker without leaking diagnostics", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    const state = createReaderState();
    const secret = "https://private.invalid/data?token=classified";
    const source = trackedRangeSource(state, {
      read() {
        throw {
          name: "TabularkError",
          code: "SOURCE_CHANGED",
          retryable: false,
          message: `validator changed at ${secret}`,
          cause: new Error(secret),
          details: { validator: secret },
        };
      },
    });
    worker.queueOpenReads([{ offset: 0, length: 4 }]);

    await assert.rejects(
      engine.open(source, { adapter: delimitedAdapter }),
      (error) => {
        assert.equal(error?.code, "SOURCE_CHANGED");
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(error?.message.includes(secret), false);
        return true;
      },
    );
    assert.deepEqual(worker.brokerResponses[0].error, {
      code: "SOURCE_CHANGED",
      message: "The source changed while it was open",
      retryable: false,
    });
    await waitFor(() => state.readers[0].closeCount === 1);
    await engine.close();
    assert.equal(state.readers[0].closeCount, 1);
  });
});

test("cancelling open aborts an in-flight provider read and closes once", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    const state = createReaderState();
    const source = trackedRangeSource(state, { read: pendingRead });
    const controller = new AbortController();
    worker.queueOpenReads([{ offset: 0, length: 8 }]);

    const opening = engine.open(source, {
      adapter: delimitedAdapter,
      signal: controller.signal,
    });
    await waitFor(() => state.readCalls.length === 1);
    controller.abort();

    await assert.rejects(opening, (error) => {
      assert.equal(error?.code, "CANCELLED");
      return true;
    });
    await waitFor(() => state.readers[0].closeCount === 1);
    assert.equal(state.readCalls[0].signal.aborted, true);
    assert.equal(
      worker.requests.some(({ op }) => op === "cancel"),
      true,
    );

    await engine.close();
    assert.equal(state.readers[0].closeCount, 1);
  });
});

test("a Worker crash aborts pending provider reads and completes reader cleanup", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    const state = createReaderState();
    const source = trackedRangeSource(state, { read: pendingRead });
    worker.queueOpenReads([{ offset: 4, length: 8 }]);

    const opening = engine.open(source, { adapter: delimitedAdapter });
    await waitFor(() => state.readCalls.length === 1);
    worker.fail("error");

    await assert.rejects(opening, (error) => {
      assert.equal(error?.code, "RUNTIME_FAILURE");
      return true;
    });
    await engine.close();
    assert.equal(state.readCalls[0].signal.aborted, true);
    assert.equal(state.readers[0].closeCount, 1);
    assert.equal(worker.terminated, 1);
  });
});

test("HTTP validator changes keep SOURCE_CHANGED across independently bundled entrypoints", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    let fetchCalls = 0;
    const source = httpRangeSource("https://example.invalid/private.csv?token=hidden", {
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response(new Uint8Array([0]), {
            status: 206,
            headers: {
              "Content-Length": "1",
              "Content-Range": "bytes 0-0/64",
              ETag: '"revision-1"',
            },
          });
        }
        return new Response(new Uint8Array(4), {
          status: 206,
          headers: {
            "Content-Length": "4",
            "Content-Range": "bytes 0-3/64",
            ETag: '"revision-2"',
          },
        });
      },
    });
    worker.queueOpenReads([{ offset: 0, length: 4 }]);

    await assert.rejects(
      engine.open(source, { adapter: delimitedAdapter }),
      (error) => {
        assert.equal(error?.name, "TabularkError");
        assert.equal(error?.code, "SOURCE_CHANGED");
        assert.equal(error?.retryable, false);
        assert.equal(JSON.stringify(error).includes("token=hidden"), false);
        return true;
      },
    );
    assert.equal(worker.brokerResponses[0]?.error?.code, "SOURCE_CHANGED");
    assert.equal(fetchCalls, 2);
  });
});

test("bounded HTTP downloads share the engine retained-byte budget and release it on close", async () => {
  await withRangeSourceEngine(async ({ engine, worker }) => {
    const bodyBytes = 600 * 1024;
    let fetchCalls = 0;
    const source = httpRangeSource("https://example.invalid/private.csv?token=hidden", {
      fallback: { mode: "bounded-download", maxBytes: bodyBytes },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array(bodyBytes), {
          status: 200,
          headers: {
            "Content-Length": String(bodyBytes),
            ETag: '"bounded-revision"',
          },
        });
      },
    });

    const first = await engine.open(source, { adapter: delimitedAdapter });
    await assert.rejects(
      engine.open(source, { adapter: delimitedAdapter }),
      (error) => {
        assert.equal(error?.code, "RESOURCE_LIMIT");
        assert.deepEqual(error?.details, {
          resource: "source-retained",
          requiredBytes: bodyBytes,
          availableBytes: 1024 * 1024 - bodyBytes,
        });
        return true;
      },
    );
    assert.equal(
      worker.requests.filter(({ op }) => op === "openSource").length,
      1,
      "the rejected reader must fail before it is published to the Worker",
    );

    await first.close();
    const reopened = await engine.open(source, { adapter: delimitedAdapter });
    await reopened.close();
    assert.equal(fetchCalls, 3);
  }, { memoryBudgetBytes: MEMORY_BUDGET_BYTES });
});

async function withRangeSourceEngine(run, options = {}) {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: RangeSourceWorker,
  });
  let engine;
  try {
    engine = await createEngine({
      adapters: [delimitedAdapter],
      ...options,
    });
    await run({ engine, worker: RangeSourceWorker.latest });
  } finally {
    await engine?.close();
    restoreWorker(originalWorker);
  }
}

function createReaderState() {
  return {
    openCount: 0,
    readers: [],
    readCalls: [],
    activeReads: 0,
    maxActiveReads: 0,
  };
}

function trackedRangeSource(state, { maxConcurrency, read } = {}) {
  return {
    kind: "range",
    async open(options) {
      state.openCount += 1;
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(options.maxSourceBytes, 0xffff_ffff);
      assert.ok(options.maxStagingBytes > 0);
      const readerState = { closeCount: 0 };
      state.readers.push(readerState);
      return {
        size: 64,
        snapshot: { id: `snapshot-${state.openCount}`, strength: "strong" },
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
        read: (range, readOptions) => (read ?? defaultRead)(range, readOptions, state),
        close() {
          readerState.closeCount += 1;
        },
      };
    },
  };
}

function defaultRead({ length }) {
  return new Uint8Array(length);
}

function gatedRead(range, { signal }, state) {
  state.activeReads += 1;
  state.maxActiveReads = Math.max(state.maxActiveReads, state.activeReads);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      state.activeReads -= 1;
      action();
    };
    const onAbort = () => settle(() => reject(new DOMException("aborted", "AbortError")));
    const call = {
      range: { ...range },
      signal,
      release: () => settle(() => resolve(new Uint8Array(range.length).fill(range.offset))),
    };
    state.readCalls.push(call);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pendingRead(range, { signal }, state) {
  state.activeReads += 1;
  state.maxActiveReads = Math.max(state.maxActiveReads, state.activeReads);
  return new Promise((_resolve, reject) => {
    const onAbort = () => {
      state.activeReads -= 1;
      reject(new DOMException("aborted", "AbortError"));
    };
    state.readCalls.push({ range: { ...range }, signal });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class RangeSourceWorker {
  static latest;

  #listeners = new Map();
  #openPlans = [];
  #pendingOpen;
  #nextBrokerId = 1;
  #nextDatasetId = 1;
  requests = [];
  brokerResponses = [];
  terminated = 0;

  constructor() {
    RangeSourceWorker.latest = this;
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  queueOpenReads(ranges) {
    this.#openPlans.push(ranges.map((range) => ({ ...range })));
  }

  postMessage(message) {
    if (typeof message?.type === "string") {
      this.#handleBrokerResponse(message);
      return;
    }
    this.requests.push(message);
    switch (message.op) {
      case "hello":
        this.#respond(message, "hello", {
          protocolVersion: 4,
          adapterApiVersion: 3,
          batchLayoutVersion: 1,
          adapters: message.payload.adapters.map(({ id }) => id),
          transferableBatches: true,
        });
        break;
      case "openSource":
        this.#openSource(message);
        break;
      case "listTables":
        this.#respond(message, "tables", [{ id: "table-0", name: "Table 1" }]);
        break;
      case "cancel":
      case "closeSource":
      case "shutdown":
        this.#respond(message, "acknowledged");
        break;
      default:
        throw new Error(`Unexpected operation: ${message.op}`);
    }
  }

  terminate() {
    this.terminated += 1;
  }

  fail(type) {
    this.#emit(type, { type });
  }

  #openSource(request) {
    const ranges = this.#openPlans.shift() ?? [];
    assert.equal(request.payload.source.kind, "range");
    if (ranges.length === 0) {
      this.#respondDataset(request);
      return;
    }
    assert.equal(this.#pendingOpen, undefined, "only one brokered open may be pending in this fake");
    const pending = {
      request,
      remaining: new Set(),
      failure: undefined,
    };
    this.#pendingOpen = pending;
    queueMicrotask(() => {
      for (const range of ranges) {
        const requestId = `source-${this.#nextBrokerId++}`;
        pending.remaining.add(requestId);
        this.#emit("message", {
          data: {
            type: "source-read",
            requestId,
            sourceHandle: request.payload.source.handle,
            ...range,
          },
        });
      }
    });
  }

  #handleBrokerResponse(message) {
    if (message.type !== "source-read-result" && message.type !== "source-read-failure") {
      return;
    }
    this.brokerResponses.push(message);
    const pending = this.#pendingOpen;
    if (!pending || !pending.remaining.delete(message.requestId)) return;
    if (message.type === "source-read-failure" && pending.failure === undefined) {
      pending.failure = message.error;
    }
    if (pending.remaining.size > 0) return;
    this.#pendingOpen = undefined;
    if (pending.failure !== undefined) {
      this.#emit("message", {
        data: {
          protocolVersion: 4,
          requestId: pending.request.requestId,
          status: "failure",
          error: pending.failure,
        },
      });
      return;
    }
    this.#respondDataset(pending.request);
  }

  #respondDataset(request) {
    this.#respond(request, "dataset", { datasetHandle: `dataset-${this.#nextDatasetId++}` });
  }

  #respond(request, kind, data) {
    queueMicrotask(() => this.#emit("message", {
      data: {
        protocolVersion: 4,
        requestId: request.requestId,
        status: "success",
        result: data === undefined ? { kind } : { kind, data },
      },
    }));
  }

  #emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for RangeSource test state");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function restoreWorker(originalWorker) {
  if (originalWorker) {
    Object.defineProperty(globalThis, "Worker", originalWorker);
  } else {
    delete globalThis.Worker;
  }
}
