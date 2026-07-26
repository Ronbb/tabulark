import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, delimitedAdapter } from "../dist/index.js";

const metadata = {
  tableId: "table-0",
  name: "Table 1",
  revision: 3,
  extent: { rows: { kind: "exact", value: 1 }, columns: { kind: "exact", value: 1 } },
  schema: {
    version: 1,
    columns: [{ id: "c0", name: "value", index: 0, dataType: { type: "utf8" }, nullable: true }],
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

test("stable sessions expose bounded diagnostics and logical capabilities", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: StabilityWorker });
  let engine;
  try {
    engine = await createEngine({ adapters: [delimitedAdapter], memoryBudgetBytes: 8 * 1024 * 1024 });
    const samples = [];
    engine.subscribePerformance((sample) => samples.push(sample));
    const session = await engine.open(new Blob(["value\na\n"]), {
      adapter: delimitedAdapter,
      adapterOptions: { dialect: "csv" },
    });
    assert.deepEqual(session.getCapabilities(), {
      adapterId: "tabulark:delimited",
      sourceAccess: "streaming",
      progressive: true,
      maxSourceBytes: Number.MAX_SAFE_INTEGER,
      multiTable: false,
      presentation: false,
      typedValues: false,
    });
    const diagnostics = [];
    session.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
    StabilityWorker.latest.emitWarning();
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(session.getDiagnostics(), diagnostics);
    assert.equal(Object.isFrozen(session.getDiagnostics()), true);
    assert.equal(diagnostics[0].code, "ragged-row");
    assert.equal(diagnostics[0].severity, "warning");

    const table = await session.openTable("table-0");
    assert.deepEqual(table.getCapabilities(), metadata.capabilities);
    const tableDiagnostics = [];
    const tableWarnings = [];
    table.subscribeDiagnostics((diagnostic) => tableDiagnostics.push(diagnostic));
    table.subscribe((event) => {
      if (event.type === "warning") tableWarnings.push(event.warning);
    });
    StabilityWorker.latest.emitWarning(false, "other-table");
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(tableDiagnostics.length, 0);
    assert.equal(tableWarnings.length, 1, "legacy dataset warnings still reach open tables");
    StabilityWorker.latest.emitWarning(false, "table-0");
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(tableDiagnostics.length, 1);
    assert.equal(tableWarnings.length, 2);
    assert.equal(table.getDiagnostics()[0].tableId, "table-0");
    assert.ok(samples.some((sample) => sample.stage === "open"));
    await table.close();
    await session.close();
    assert.ok(samples.some((sample) => sample.stage === "close-table"));
    assert.ok(samples.some((sample) => sample.stage === "close-session"));
    await engine.close();
    assert.ok(samples.some((sample) => sample.stage === "close"));
  } finally {
    await engine?.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
  }
});

class StabilityWorker {
  static latest;
  #listeners = new Map();
  terminated = false;

  constructor() {
    StabilityWorker.latest = this;
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  terminate() {
    this.terminated = true;
  }

  postMessage(request) {
    const respond = (result, payload) => queueMicrotask(() => this.#emit({
      protocolVersion: 4,
      requestId: request.requestId,
      status: "success",
      result: { kind: result, ...(payload === undefined ? {} : { data: payload }) },
    }));
    switch (request.op) {
      case "hello":
        respond("hello", { protocolVersion: 4, adapterApiVersion: 3, batchLayoutVersion: 1, adapters: ["tabulark:delimited"] });
        break;
      case "openSource":
        respond("dataset", { datasetHandle: "d1" });
        break;
      case "listTables":
        respond("tables", [{ id: "table-0", name: "Table 1" }]);
        break;
      case "openTable":
        respond("table", { tableHandle: "t1" });
        break;
      case "getMetadata":
        respond("metadata", metadata);
        break;
      case "closeTable":
      case "closeSource":
      case "shutdown":
        respond("acknowledged");
        break;
      default:
        respond("acknowledged");
    }
  }

  emitWarning(table = false, tableId) {
    this.#emit({
      protocolVersion: 4,
      event: "warning",
      datasetHandle: "d1",
      ...(table ? { tableHandle: "t1", tableId: "table-0", revision: 3 } : {}),
      ...(!table && tableId !== undefined ? { tableId, revision: 3 } : {}),
      payload: {
        handle: table ? "t1" : "d1",
        kind: "ragged-row",
        message: "row has a different field count",
        byteOffset: 12,
        row: 2,
      },
    });
  }

  #emit(event) {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: event });
  }
}
