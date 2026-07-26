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
