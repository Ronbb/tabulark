import assert from "node:assert/strict";
import test from "node:test";

const MAX_REMOTE_BYTES = 0xffff_ffff;

test("Worker RangeSource merges, singleflights, caches, evicts, and bounds provider concurrency", async () => {
  await withRangeWorker(async ({ provider, responseFor, send }) => {
    const hello = send("hello", {
      adapters: [{ id: "tabulark:delimited" }],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const opening = send("openSource", {
      source: {
        kind: "range",
        handle: "sparse-max",
        size: MAX_REMOTE_BYTES,
        maxConcurrency: 4,
      },
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    }, true);
    const opened = await responseFor(opening);
    assert.equal(opened.status, "success", JSON.stringify(opened));
    const datasetHandle = opened.result.data.datasetHandle;

    // The first two high-offset actions are adjacent and must be one provider
    // request; the final action addresses the last valid byte window.
    assert.deepEqual(
      provider.reads.slice(0, 2).map(({ offset, length }) => ({ offset, length })),
      [
        { offset: 0x8000_0000, length: 8 },
        { offset: MAX_REMOTE_BYTES - 8, length: 8 },
      ],
    );
    assert.equal(opened.result.telemetry.sourceReads, 2);

    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;

    provider.hold([100]);
    const first = send("readRange", {
      tableHandle,
      range: logicalRange(0),
    }, true);
    const second = send("readRange", {
      tableHandle,
      range: logicalRange(1),
    }, true);
    await eventually(() => globalThis.__tabularkRangeBeginReads === 2);
    await eventually(() => provider.reads.filter(({ offset }) => offset === 100).length === 1);
    assert.equal(
      provider.reads.filter(({ offset }) => offset === 100).length,
      1,
      "identical concurrent actions must share one provider read",
    );
    provider.releaseHeld();
    const [firstResult, secondResult] = await Promise.all([
      responseFor(first),
      responseFor(second),
    ]);
    assert.equal(firstResult.status, "success");
    assert.equal(secondResult.status, "success");
    assert.equal(
      firstResult.result.telemetry.sourceReads + secondResult.result.telemetry.sourceReads,
      1,
    );
    assert.equal(
      firstResult.result.telemetry.sourceCacheHitBytes
        + secondResult.result.telemetry.sourceCacheHitBytes,
      0,
      "singleflight coverage is not reported as an LRU hit",
    );

    const covered = send("readRange", {
      tableHandle,
      range: logicalRange(2),
    }, true);
    const coveredResult = await responseFor(covered);
    assert.equal(coveredResult.status, "success");
    assert.equal(coveredResult.result.telemetry.sourceReads, 0);
    assert.equal(coveredResult.result.telemetry.sourceCacheHitBytes, 4);

    // Each 300,000-byte entry fits the per-dataset cache, but two do not fit
    // its 393,216-byte slice. Revisiting the first interval must read again.
    for (const rowStart of [3, 4, 5]) {
      const request = send("readRange", {
        tableHandle,
        range: logicalRange(rowStart),
      }, true);
      assert.equal((await responseFor(request)).status, "success");
    }
    assert.equal(provider.reads.filter(({ offset }) => offset === 1_000).length, 2);
    assert.equal(provider.reads.filter(({ offset }) => offset === 400_000).length, 1);

    const concurrencyOffsets = [800_000, 800_008, 800_016, 800_024, 800_032];
    provider.hold(concurrencyOffsets);
    const concurrent = send("readRange", {
      tableHandle,
      range: logicalRange(6),
    }, true);
    await eventually(() => provider.heldCount === 4);
    assert.equal(provider.maxActive, 4);
    provider.releaseHeld();
    await eventually(() => provider.heldCount === 1);
    provider.releaseHeld();
    assert.equal((await responseFor(concurrent)).status, "success");
    assert.equal(provider.maxActive, 4, "provider reads must never exceed four");

    const closed = send("closeSource", { datasetHandle });
    assert.equal((await responseFor(closed)).status, "success");
    await eventually(() => provider.closedHandles.includes("sparse-max"));
    assert.equal(provider.closedHandles.filter((value) => value === "sparse-max").length, 1);

    provider.corruptNextResponse();
    const mismatched = send("openSource", {
      source: {
        kind: "range",
        handle: "mismatched-response",
        size: MAX_REMOTE_BYTES,
        maxConcurrency: 4,
      },
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const mismatchFailure = await responseFor(mismatched);
    assert.equal(mismatchFailure.status, "failure");
    assert.equal(mismatchFailure.error.code, "PROTOCOL_INCOMPATIBLE");
    await eventually(() => provider.closedHandles.includes("mismatched-response"));
    assert.ok(provider.cancelledReads > 0);

    const tooLarge = send("openSource", {
      source: { kind: "range", handle: "four-gib", size: 0x1_0000_0000 },
      adapterId: "tabulark:delimited",
      options: {},
    });
    const rejected = await responseFor(tooLarge);
    assert.equal(rejected.status, "failure");
    assert.equal(rejected.error.code, "RESOURCE_LIMIT");
    assert.equal(rejected.error.details.availableBytes, MAX_REMOTE_BYTES);

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

function logicalRange(rowStart) {
  return { rowStart, rowCount: 1, columnStart: 0, columnCount: 1 };
}

async function withRangeWorker(run) {
  const names = [
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkTestOnlyAdapterModuleUrls",
    "__tabularkRangeBeginReads",
  ];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const listeners = new Set();
  const messages = [];
  const provider = new RangeProvider((message) => {
    for (const listener of listeners) listener({ data: message });
  });
  Object.defineProperties(globalThis, {
    addEventListener: {
      configurable: true,
      value: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
    },
    postMessage: {
      configurable: true,
      value: (message) => {
        messages.push(message);
        provider.accept(message);
      },
    },
    close: { configurable: true, value: () => {} },
    __tabularkRangeBeginReads: { configurable: true, writable: true, value: 0 },
    __tabularkTestOnlyAdapterModuleUrls: {
      configurable: true,
      writable: true,
      value: { "tabulark:delimited": rangeAdapterModuleUrl() },
    },
  });

  let nextRequest = 1;
  const send = (op, payload, measure = false) => {
    const requestId = `r${nextRequest++}`;
    const request = { protocolVersion: 4, requestId, op, payload, ...(measure ? { measure: true } : {}) };
    for (const listener of listeners) listener({ data: request });
    return requestId;
  };
  const responseFor = async (requestId) => {
    await eventually(() => messages.some((message) => (
      message.protocolVersion === 4 && message.requestId === requestId
    )));
    return messages.find((message) => (
      message.protocolVersion === 4 && message.requestId === requestId
    ));
  };

  try {
    await import(`../dist/worker.js?range-source=${Date.now()}-${Math.random()}`);
    await run({ provider, responseFor, send });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

class RangeProvider {
  #deliver;
  #held = [];
  #holdOffsets = new Set();
  #active = 0;
  #corruptNext = false;
  reads = [];
  maxActive = 0;
  closedHandles = [];
  cancelledReads = 0;

  constructor(deliver) {
    this.#deliver = deliver;
  }

  get heldCount() {
    return this.#held.length;
  }

  hold(offsets) {
    this.#holdOffsets = new Set(offsets);
  }

  corruptNextResponse() {
    this.#corruptNext = true;
  }

  accept(message) {
    if (message?.type === "source-close") {
      this.closedHandles.push(message.sourceHandle);
      return;
    }
    if (message?.type === "source-read-cancel") {
      this.cancelledReads += 1;
      return;
    }
    if (message?.type !== "source-read") return;
    this.reads.push(message);
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    if (this.#holdOffsets.has(message.offset)) {
      this.#held.push(message);
    } else {
      queueMicrotask(() => this.#respond(message));
    }
  }

  releaseHeld() {
    const pending = this.#held.splice(0);
    for (const message of pending) this.#respond(message);
  }

  #respond(message) {
    this.#active -= 1;
    const corrupt = this.#corruptNext;
    this.#corruptNext = false;
    this.#deliver({
      type: "source-read-result",
      requestId: message.requestId,
      sourceHandle: message.sourceHandle,
      offset: message.offset + (corrupt ? 1 : 0),
      length: message.length,
      buffer: new ArrayBuffer(message.length),
    });
  }
}

function rangeAdapterModuleUrl() {
  const source = `
    let nextOperation = 1;
    const operations = new Map();
    const metadata = () => ({
      tableId: "table-0", name: "Sparse", revision: 0,
      extent: { rows: { kind: "exact", value: 16 }, columns: { kind: "exact", value: 1 } },
      schema: { version: 0, columns: [{ id: "c0", name: "value", index: 0, dataType: { type: "int32" }, nullable: false }] },
      capabilities: { randomAccess: "full", typedValues: true, search: false, sort: false, filter: false, multiTable: false },
    });
    const action = (actionIndex, offset, length) => ({ kind: "read-bytes", actionIndex, offset, length });
    const readActions = (rowStart) => {
      switch (rowStart) {
        case 0: case 1: return [action(0, 100, 16)];
        case 2: return [action(0, 104, 4)];
        case 3: case 5: return [action(0, 1_000, 300_000)];
        case 4: return [action(0, 400_000, 300_000)];
        case 6: return [800_000, 800_008, 800_016, 800_024, 800_032].map((offset, index) => action(index, offset, 4));
        default: return [action(0, 200, 4)];
      }
    };
    const batch = (request) => {
      const nativeValues = new Int32Array([42]);
      const displayValues = new TextEncoder().encode("42");
      const displayOffsets = new Uint32Array([0, 2]);
      return {
        layoutVersion: 1, tableId: "table-0", revision: 0, schemaVersion: 0,
        range: { ...request, rowCount: 1, columnCount: 1 }, complete: true,
        buffers: [nativeValues, displayValues, displayOffsets],
        columns: [{
          columnId: "c0",
          native: { dataType: { type: "int32" }, length: 1, encoding: "fixed-width", values: { buffer: 0, byteOffset: 0, byteLength: 4 } },
          display: { dataType: { type: "utf8" }, length: 1, encoding: "variable-width", values: { buffer: 1, byteOffset: 0, byteLength: 2 }, offsets: { buffer: 2, byteOffset: 0, byteLength: 8 } },
        }],
      };
    };
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen() {
        const handle = nextOperation++;
        operations.set(handle, { kind: "open" });
        return {
          kind: "pending", operationHandle: handle, operationRevision: 1, cooperativeYield: false,
          actions: [
            action(0, 0x8000_0000, 4),
            action(1, 0x8000_0004, 4),
            action(2, 0xffff_fff7, 8),
          ],
        };
      }
      beginRead(_table, request) {
        globalThis.__tabularkRangeBeginReads += 1;
        const handle = nextOperation++;
        operations.set(handle, { kind: "read", request });
        return { kind: "pending", operationHandle: handle, operationRevision: 1, cooperativeYield: false, actions: readActions(request.rowStart) };
      }
      continueOperation(handle, revision) {
        const operation = operations.get(handle);
        operations.delete(handle);
        if (operation.kind === "open") {
          return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 1, tables: [{ id: "table-0", name: "Sparse" }], metadata: metadata() };
        }
        return { kind: "complete", operationKind: "read", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, batch: batch(operation.request) };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      cancelOperation(handle) { operations.delete(handle); }
      closeTable() {}
      closeSource() {}
      shutdown() { operations.clear(); }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function eventually(predicate, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Worker RangeSource state");
}
