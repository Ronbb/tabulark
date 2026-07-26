import assert from "node:assert/strict";
import test from "node:test";

test("Worker derives Wasm limits and bounds/cancels queued range reads", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?budget-queue=${Date.now()}`);
    const wasmModuleUrl = mockWasmModuleUrl();
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 4, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", wasmModuleUrl)],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");
    assert.equal(globalThis.__tabularkWasmConfigs.length, 0, "hello must not load WASM");

    const source = new SlowBlob(["a"]);
    const opened = send("openSource", {
      source,
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "lenient" },
    });
    const datasetHandle = (await responseFor(opened)).result.data.datasetHandle;
    assert.deepEqual(globalThis.__tabularkWasmConfigs[0], {
      memoryBudgetBytes: 4 * 1024 * 1024,
      indexBudgetBytes: 1024 * 1024,
      tileCacheBudgetBytes: 1024 * 1024,
      chunkBytes: 1024 * 1024,
      checkpointRows: 1024,
      maxFieldBytes: 256 * 1024,
      maxColumns: 16_384,
      maxRangeCells: 250_000,
      maxBatchBytes: 256 * 1024,
      maxSources: 2,
      maxActiveRanges: 2,
    });

    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;

    source.pauseSlices();
    const range = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };
    const reads = Array.from({ length: 11 }, () => send("readRange", { tableHandle, range }));
    await eventually(() => globalThis.__tabularkBeginCount === 2);
    assert.equal(globalThis.__tabularkBeginCount, 2, "only two ranges may begin at once");

    const overLimit = await responseFor(reads[10]);
    assert.equal(overLimit.status, "failure");
    assert.equal(overLimit.error.code, "RESOURCE_LIMIT");
    assertResourceLimitDetails(overLimit.error.details);

    const cancelled = send("cancel", { targetRequestId: reads[2] });
    assert.equal((await responseFor(cancelled)).status, "success");
    const cancelledRead = await responseFor(reads[2]);
    assert.equal(cancelledRead.status, "failure");
    assert.equal(cancelledRead.error.code, "CANCELLED");

    const lateCancel = send("cancel", { targetRequestId: opened });
    assert.equal((await responseFor(lateCancel)).status, "success");
    assert.equal(globalThis.__tabularkClosedSources, 1);
    const closedDataset = send("listTables", { datasetHandle });
    const closedDatasetResponse = await responseFor(closedDataset);
    assert.equal(closedDatasetResponse.status, "failure");
    assert.equal(closedDatasetResponse.error.code, "HANDLE_CLOSED");

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Worker cancels an in-flight open and releases its source immediately", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
    "__tabularkCancelCalls",
    "__tabularkOpenBeginCount",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
    __tabularkCancelCalls: { configurable: true, writable: true, value: 0 },
    __tabularkOpenBeginCount: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?open-cancel=${Date.now()}`);
    const wasmModuleUrl = mockWasmModuleUrl();
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 4, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", wasmModuleUrl)],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new SlowBlob(["a"]);
    source.pauseSlices();
    const opening = send("openSource", {
      source,
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "lenient" },
    });
    await eventually(() => globalThis.__tabularkOpenBeginCount === 1);

    const cancel = send("cancel", { targetRequestId: opening });
    assert.equal((await responseFor(cancel)).status, "success");
    const openingResponse = await responseFor(opening);
    assert.equal(openingResponse.status, "failure");
    assert.equal(openingResponse.error.code, "CANCELLED");
    assert.equal(globalThis.__tabularkCancelCalls, 1);
    assert.equal(globalThis.__tabularkClosedSources, 1);

    const leakedDataset = send("listTables", { datasetHandle: "d1" });
    const leakedDatasetResponse = await responseFor(leakedDataset);
    assert.equal(leakedDatasetResponse.status, "failure");
    assert.equal(leakedDatasetResponse.error.code, "HANDLE_CLOSED");
    source.resumeSlices();
  } finally {
    restoreGlobals(globals);
  }
});

test("cancelled Blob reads retain reservations until normal and progressive reads settle", async () => {
  for (const progressive of [false, true]) {
    await assertCancelledBlobReservationsHeld(progressive);
  }
});

test("Worker counts datasets and cross-adapter in-flight opens against one source limit", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkArrowConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkArrowConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?global-source-slots=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };
    const delimitedOptions = { delimiter: ",", header: "first-row", mode: "lenient" };

    const hello = send("hello", {
      adapters: [
        testAdapter("tabulark:delimited", mockWasmModuleUrl()),
        testAdapter("tabulark:arrow-ipc", mockArrowWasmModuleUrl()),
      ],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const first = send("openSource", {
      source: new Blob(["a"]),
      adapterId: "tabulark:delimited",
      options: delimitedOptions,
    });
    const firstDataset = (await responseFor(first)).result.data.datasetHandle;

    const blockedArrowSource = new SlowBlob(["arrow"]);
    blockedArrowSource.pauseSlices();
    const pendingArrow = send("openSource", {
      source: blockedArrowSource,
      adapterId: "tabulark:arrow-ipc",
      options: { container: "auto" },
    });
    await eventually(() => globalThis.__tabularkArrowConfigs.length === 1);

    const overLimit = send("openSource", {
      source: new Blob(["b"]),
      adapterId: "tabulark:delimited",
      options: delimitedOptions,
    });
    const overLimitResponse = await responseFor(overLimit);
    assert.equal(overLimitResponse.status, "failure");
    assert.equal(overLimitResponse.error.code, "RESOURCE_LIMIT");
    assert.equal(overLimitResponse.error.details.maxSources, 2);
    assertResourceLimitDetails(overLimitResponse.error.details);
    assert.equal(globalThis.__tabularkWasmConfigs[0].memoryBudgetBytes, 2 * 1024 * 1024);
    assert.equal(globalThis.__tabularkArrowConfigs[0].memoryBudgetBytes, 2 * 1024 * 1024);

    const cancelArrow = send("cancel", { targetRequestId: pendingArrow });
    assert.equal((await responseFor(cancelArrow)).status, "success");
    assert.equal((await responseFor(pendingArrow)).error.code, "CANCELLED");

    const recovered = send("openSource", {
      source: new Blob(["b"]),
      adapterId: "tabulark:delimited",
      options: delimitedOptions,
    });
    const recoveredResponse = await responseFor(recovered);
    assert.equal(recoveredResponse.status, "success");

    const closeFirst = send("closeSource", { datasetHandle: firstDataset });
    const closeRecovered = send("closeSource", {
      datasetHandle: recoveredResponse.result.data.datasetHandle,
    });
    assert.equal((await responseFor(closeFirst)).status, "success");
    assert.equal((await responseFor(closeRecovered)).status, "success");
    blockedArrowSource.resumeSlices();

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Delimited open returns an indexed preview while its ABI-v3 operation scans in background", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkReadStarts",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkReadStarts: { configurable: true, writable: true, value: [] },
  });

  try {
    await import(`../dist/worker.js?progressive-delimited=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", progressiveDelimitedWasmModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new BackgroundFailureBlob([new Uint8Array(2 * 1024 * 1024)]);
    const opened = send("openSource", {
      source,
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const openResponse = await responseFor(opened);
    assert.equal(openResponse.status, "success", "the first indexed chunk is enough to open");
    await eventually(() => source.waitingForSecondSlice);
    const datasetHandle = openResponse.result.data.datasetHandle;
    const listed = send("listTables", { datasetHandle });
    assert.equal((await responseFor(listed)).status, "success");
    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;

    const previewRead = send("readRange", {
      tableHandle,
      range: { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    assert.equal((await responseFor(previewRead)).status, "success");
    assert.deepEqual(globalThis.__tabularkReadStarts, [0]);

    const futureRead = send("readRange", {
      tableHandle,
      range: { rowStart: 400, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.some((message) => message.requestId === futureRead), false);
    assert.deepEqual(globalThis.__tabularkReadStarts, [0]);

    const additionalFutureReads = Array.from({ length: 10 }, () => send("readRange", {
      tableHandle,
      range: { rowStart: 400, rowCount: 1, columnStart: 0, columnCount: 1 },
    }));
    const overLimit = await responseFor(additionalFutureReads.at(-1));
    assert.equal(overLimit.status, "failure");
    assert.equal(overLimit.error.code, "RESOURCE_LIMIT");
    assertResourceLimitDetails(overLimit.error.details);
    const cancelWaiting = send("cancel", { targetRequestId: additionalFutureReads[0] });
    assert.equal((await responseFor(cancelWaiting)).status, "success");
    assert.equal((await responseFor(additionalFutureReads[0])).error.code, "CANCELLED");
    const replacementFutureRead = send("readRange", {
      tableHandle,
      range: { rowStart: 400, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.some((message) => message.requestId === replacementFutureRead), false);

    source.releaseSecondSlice();
    assert.equal((await responseFor(futureRead)).status, "success");
    const remainingFutureReads = additionalFutureReads.slice(1, -1);
    const completedFutureReads = await Promise.all([
      ...remainingFutureReads,
      replacementFutureRead,
    ].map(responseFor));
    assert.equal(completedFutureReads.every((response) => response.status === "success"), true);
    assert.deepEqual(globalThis.__tabularkReadStarts, [0, ...Array(10).fill(400)]);
    await eventually(() => messages.some((message) => (
      message.event === "progress" && message.payload?.done === true
    )));
    const completed = messages.find((message) => (
      message.event === "progress" && message.payload?.done === true
    ));
    assert.deepEqual(completed.payload, {
      sourceHandle: datasetHandle,
      tableId: "table-0",
      revision: 0,
      bytesScanned: 2 * 1024 * 1024,
      rowsDiscovered: 600,
      done: true,
    });

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Delimited EOF progress is retained until open finishes the listTables handshake", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkContinueCalls",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkContinueCalls: { configurable: true, writable: true, value: [] },
  });

  try {
    await import(`../dist/worker.js?buffered-delimited-eof=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", progressiveDelimitedWasmModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const sourceSize = 2 * 1024 * 1024;
    const opened = send("openSource", {
      source: new Blob([new Uint8Array(sourceSize)]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const openResponse = await responseFor(opened);
    assert.equal(openResponse.status, "success", "the indexed prefix opens before EOF is observed");
    const datasetHandle = openResponse.result.data.datasetHandle;

    // Let the background action reach EOF while events are still gated behind
    // the listTables response. This is the exact race that previously let the
    // final progress event disappear and made the performance harness wait forever.
    await eventually(() => globalThis.__tabularkContinueCalls.length === 2);
    assert.deepEqual(globalThis.__tabularkContinueCalls, [
      { offset: 0, length: 1024 * 1024, eof: false },
      { offset: 1024 * 1024, length: 1024 * 1024, eof: true },
    ]);
    assert.equal(messages.some((message) => message.event === "progress"), false);

    const listed = send("listTables", { datasetHandle });
    assert.equal((await responseFor(listed)).status, "success");
    await eventually(() => messages.some((message) => (
      message.event === "progress" && message.payload?.done === true
    )));

    const completed = messages.filter((message) => message.event === "progress");
    assert.deepEqual(completed, [{
      protocolVersion: 4,
      event: "progress",
      datasetHandle,
      tableId: "table-0",
      revision: 0,
      payload: {
        sourceHandle: datasetHandle,
        tableId: "table-0",
        revision: 0,
        bytesScanned: sourceSize,
        rowsDiscovered: 600,
        done: true,
      },
    }]);
    assert.ok(
      messages.findIndex((message) => message.requestId === listed)
        < messages.findIndex((message) => message.event === "progress"),
      "the tables response must arrive before its buffered progress event",
    );

    // Empty input reaches EOF inside scanInitialPrefix through a required
    // zero-byte action. Its completed snapshot uses the separate open-time
    // buffering branch and must obey the same response-before-event contract.
    const emptyOpened = send("openSource", {
      source: new Blob([]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const emptyOpenResponse = await responseFor(emptyOpened);
    assert.equal(emptyOpenResponse.status, "success");
    const emptyDatasetHandle = emptyOpenResponse.result.data.datasetHandle;
    await eventually(() => globalThis.__tabularkContinueCalls.length === 3);
    assert.deepEqual(globalThis.__tabularkContinueCalls[2], {
      offset: 0,
      length: 0,
      eof: true,
    });
    assert.equal(messages.filter((message) => message.event === "progress").length, 1);

    const emptyListed = send("listTables", { datasetHandle: emptyDatasetHandle });
    assert.equal((await responseFor(emptyListed)).status, "success");
    await eventually(() => messages.filter((message) => message.event === "progress").length === 2);
    const emptyCompleted = messages.filter((message) => message.event === "progress").at(-1);
    assert.deepEqual(emptyCompleted?.payload, {
      sourceHandle: emptyDatasetHandle,
      tableId: "table-0",
      revision: 0,
      bytesScanned: 0,
      rowsDiscovered: 0,
      done: true,
    });
    assert.ok(
      messages.findIndex((message) => message.requestId === emptyListed)
        < messages.findIndex((message) => message === emptyCompleted),
      "the empty-source tables response must arrive before its EOF progress event",
    );

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Arrow Stream open publishes an indexed prefix and completes under the same handles", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkReadStarts",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkReadStarts: { configurable: true, writable: true, value: [] },
  });

  try {
    await import(`../dist/worker.js?progressive-arrow=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:arrow-ipc", progressiveArrowWasmModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new BackgroundFailureBlob([new Uint8Array(2 * 1024 * 1024)]);
    const opened = send("openSource", {
      source,
      adapterId: "tabulark:arrow-ipc",
      options: { container: "stream" },
    });
    const openResponse = await responseFor(opened);
    assert.equal(
      openResponse.status,
      "success",
      `the first decoded record prefix is enough to open: ${JSON.stringify(openResponse)}`,
    );
    await eventually(() => source.waitingForSecondSlice);
    const datasetHandle = openResponse.result.data.datasetHandle;
    const listed = send("listTables", { datasetHandle });
    assert.equal((await responseFor(listed)).status, "success");
    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;
    const prefixMetadata = send("getMetadata", { tableHandle });
    const prefixMetadataResponse = await responseFor(prefixMetadata);
    assert.equal(prefixMetadataResponse.result.data.extent.rows.kind, "at-least");
    assert.equal(prefixMetadataResponse.result.data.extent.rows.value, 300);
    assert.equal(prefixMetadataResponse.result.data.capabilities.randomAccess, "indexed-prefix");

    const previewRead = send("readRange", {
      tableHandle,
      range: { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    assert.equal((await responseFor(previewRead)).status, "success");
    assert.deepEqual(globalThis.__tabularkReadStarts, [0]);

    const prefixBoundaryRead = send("readRange", {
      tableHandle,
      range: { rowStart: 250, rowCount: 100, columnStart: 0, columnCount: 1 },
    });
    const prefixBoundaryResponse = await responseFor(prefixBoundaryRead);
    assert.equal(prefixBoundaryResponse.result.data.range.rowCount, 50);
    assert.equal(prefixBoundaryResponse.result.data.complete, false);
    assert.deepEqual(globalThis.__tabularkReadStarts, [0, 250]);

    const futureRead = send("readRange", {
      tableHandle,
      range: { rowStart: 400, rowCount: 1, columnStart: 0, columnCount: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.some((message) => message.requestId === futureRead), false);
    source.releaseSecondSlice();
    assert.equal((await responseFor(futureRead)).status, "success");
    assert.deepEqual(globalThis.__tabularkReadStarts, [0, 250, 400]);

    await eventually(() => messages.some((message) => (
      message.event === "progress" && message.payload?.done === true
    )));
    const completedMetadata = send("getMetadata", { tableHandle });
    const completedMetadataResponse = await responseFor(completedMetadata);
    assert.equal(completedMetadataResponse.result.data.extent.rows.kind, "exact");
    assert.equal(completedMetadataResponse.result.data.extent.rows.value, 600);
    assert.equal(completedMetadataResponse.result.data.capabilities.randomAccess, "full");

    const completedBoundaryRead = send("readRange", {
      tableHandle,
      range: { rowStart: 250, rowCount: 100, columnStart: 0, columnCount: 1 },
    });
    const completedBoundaryResponse = await responseFor(completedBoundaryRead);
    assert.equal(completedBoundaryResponse.result.data.range.rowCount, 100);
    assert.equal(completedBoundaryResponse.result.data.complete, true);
    assert.deepEqual(globalThis.__tabularkReadStarts, [0, 250, 400, 250]);

    const completed = messages.find((message) => (
      message.event === "progress" && message.payload?.done === true
    ));
    assert.deepEqual(completed.payload, {
      sourceHandle: datasetHandle,
      tableId: "table-0",
      revision: 0,
      bytesScanned: 2 * 1024 * 1024,
      rowsDiscovered: 600,
      done: true,
    });

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("an adapter open failure cancels its operation and does not poison later opens", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?background-fatal=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      const request = { protocolVersion: 4, requestId, op, payload };
      for (const listener of listeners) listener({ data: request });
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", backgroundFailureWasmModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const source = new BackgroundFailureBlob([new Uint8Array(1024 * 1024)]);
    const failedOpen = send("openSource", {
      source,
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    await eventually(() => source.waitingForSecondSlice);
    source.releaseSecondSlice();
    const failedResponse = await responseFor(failedOpen);
    assert.equal(failedResponse.status, "failure");
    assert.equal(failedResponse.error.code, "RUNTIME_FAILURE");
    assert.equal(globalThis.__tabularkClosedSources, 1);

    const recoveredOpen = send("openSource", {
      source: new Blob(["ok"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const recoveredResponse = await responseFor(recoveredOpen);
    assert.equal(recoveredResponse.status, "success");
    assert.equal(typeof recoveredResponse.result.data.datasetHandle, "string");

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    assert.equal(globalThis.__tabularkClosedSources, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("a failed Arrow artifact initialization is retryable and does not poison delimited", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
    "__tabularkArrowInitAttempts",
    "__tabularkArrowOpenOptions",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
    __tabularkArrowInitAttempts: { configurable: true, writable: true, value: 0 },
    __tabularkArrowOpenOptions: { configurable: true, writable: true, value: undefined },
  });

  try {
    await import(`../dist/worker.js?adapter-load-recovery=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [
        testAdapter("tabulark:delimited", mockWasmModuleUrl()),
        testAdapter("tabulark:arrow-ipc", flakyArrowWasmModuleUrl()),
      ],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const firstArrow = send("openSource", {
      source: new Blob(["arrow"]),
      adapterId: "tabulark:arrow-ipc",
      options: { container: "auto" },
    });
    const firstArrowResponse = await responseFor(firstArrow);
    assert.equal(firstArrowResponse.status, "failure");
    assert.equal(firstArrowResponse.error.code, "RUNTIME_FAILURE");
    assert.equal(globalThis.__tabularkArrowInitAttempts, 1);

    const csv = send("openSource", {
      source: new Blob(["a"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const csvResponse = await responseFor(csv);
    assert.equal(csvResponse.status, "success");

    const recoveredArrow = send("openSource", {
      source: new Blob(["arrow"]),
      adapterId: "tabulark:arrow-ipc",
      options: { container: "auto" },
    });
    const recoveredArrowResponse = await responseFor(recoveredArrow);
    assert.equal(recoveredArrowResponse.status, "success");
    assert.equal(globalThis.__tabularkArrowInitAttempts, 2);
    assert.deepEqual(globalThis.__tabularkArrowOpenOptions.limits, {
      maxSourceBytes: 0xffff_ffff,
      maxDecodedBytes: 1024 * 1024,
      maxOutputBytes: 256 * 1024,
      maxMetadataBytes: 256 * 1024,
      maxBlockBytes: 256 * 1024,
      streamChunkBytes: 32 * 1024,
      maxFields: 16_384,
      maxNestingDepth: 64,
      maxRangeCells: 250_000,
      maxDisplayCellBytes: 64 * 1024,
    });

    const csvTables = send("listTables", { datasetHandle: csvResponse.result.data.datasetHandle });
    const arrowTables = send("listTables", {
      datasetHandle: recoveredArrowResponse.result.data.datasetHandle,
    });
    assert.equal((await responseFor(csvTables)).status, "success");
    assert.equal((await responseFor(arrowTables)).status, "success");

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

test("Worker canonicalizes snake_case fields from Rust enum variant descriptors", async () => {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkAdapterOutputBuffers",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkAdapterOutputBuffers: { configurable: true, writable: true, value: [] },
  });

  try {
    await import(`../dist/worker.js?rust-descriptor-fields=${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `r${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
      return requestId;
    };
    const responseFor = async (requestId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.requestId === requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`No response for ${requestId}`);
    };

    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", snakeCaseDescriptorWasmModuleUrl())],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const opened = send("openSource", {
      source: new Blob(["x"]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const datasetHandle = (await responseFor(opened)).result.data.datasetHandle;
    const openedTable = send("openTable", { datasetHandle, tableId: "table-0" });
    const tableHandle = (await responseFor(openedTable)).result.data.tableHandle;
    const read = send("readRange", {
      tableHandle,
      range: { rowStart: 0, rowCount: 2, columnStart: 0, columnCount: 2 },
    });
    const batchResponse = await responseFor(read);
    assert.equal(batchResponse.status, "success");
    const [union, runEndEncoded] = batchResponse.result.data.columns;
    assert.equal(union.native.typeIds.buffer, 0);
    assert.equal("type_ids" in union.native, false);
    assert.equal(runEndEncoded.native.runEnds.dataType.type, "int16");
    assert.equal("run_ends" in runEndEncoded.native, false);
    assert.equal(batchResponse.result.data.buffers.length, 7);
    for (const [index, backing] of batchResponse.result.data.buffers.entries()) {
      assert.equal(
        backing,
        globalThis.__tabularkAdapterOutputBuffers[index],
        `buffer ${index} should be adopted without an extra Worker copy`,
      );
    }

    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
});

class SlowBlob extends Blob {
  #paused = false;
  #resolvers = [];

  pauseSlices() {
    this.#paused = true;
  }

  get pendingSlices() {
    return this.#resolvers.length;
  }

  resumeSlices() {
    this.#paused = false;
    for (const resolve of this.#resolvers.splice(0)) {
      resolve(new ArrayBuffer(0));
    }
  }

  slice(...args) {
    if (!this.#paused) return super.slice(...args);
    return {
      arrayBuffer: () => new Promise((resolve) => this.#resolvers.push(resolve)),
    };
  }
}

async function assertCancelledBlobReservationsHeld(progressive) {
  const globals = saveGlobals([
    "addEventListener",
    "postMessage",
    "close",
    "__tabularkWasmConfigs",
    "__tabularkBeginCount",
    "__tabularkClosedSources",
  ]);
  const listeners = new Set();
  const messages = [];
  Object.defineProperties(globalThis, {
    addEventListener: { configurable: true, value: (type, listener) => {
      if (type === "message") listeners.add(listener);
    } },
    postMessage: { configurable: true, value: (message) => messages.push(message) },
    close: { configurable: true, value: () => {} },
    __tabularkWasmConfigs: { configurable: true, writable: true, value: [] },
    __tabularkBeginCount: { configurable: true, writable: true, value: 0 },
    __tabularkClosedSources: { configurable: true, writable: true, value: 0 },
  });

  try {
    await import(`../dist/worker.js?reservation-after-cancel=${progressive}-${Date.now()}`);
    let nextRequest = 1;
    const send = (op, payload) => {
      const requestId = `lease-${progressive}-${nextRequest++}`;
      for (const listener of listeners) {
        listener({ data: { protocolVersion: 4, requestId, op, payload } });
      }
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
    const moduleUrl = progressive
      ? progressiveDelimitedWasmModuleUrl()
      : mockWasmModuleUrl();
    const hello = send("hello", {
      adapters: [testAdapter("tabulark:delimited", moduleUrl)],
      memoryBudgetBytes: 2 * 1024 * 1024,
    });
    assert.equal((await responseFor(hello)).status, "success");

    const sourceBytes = 256 * 1024;
    const blockedSources = [];
    for (let index = 0; index < 4; index += 1) {
      const source = new SlowBlob([new Uint8Array(sourceBytes)]);
      source.pauseSlices();
      blockedSources.push(source);
      const opening = send("openSource", {
        source,
        adapterId: "tabulark:delimited",
        options: { delimiter: ",", header: "first-row", mode: "strict" },
      });
      await eventually(() => source.pendingSlices === 1);
      const cancel = send("cancel", { targetRequestId: opening });
      assert.equal((await responseFor(cancel)).status, "success");
      assert.equal((await responseFor(opening)).error.code, "CANCELLED");
    }

    const whileReadsPending = send("openSource", {
      source: new Blob([new Uint8Array(sourceBytes)]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    const blocked = await responseFor(whileReadsPending);
    assert.equal(blocked.status, "failure");
    assert.equal(blocked.error.code, "RESOURCE_LIMIT");
    assert.deepEqual(blocked.error.details, {
      resource: "source-staging",
      requiredBytes: sourceBytes,
      availableBytes: 0,
    });

    blockedSources[0].resumeSlices();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterSettlement = send("openSource", {
      source: new Blob([new Uint8Array(sourceBytes)]),
      adapterId: "tabulark:delimited",
      options: { delimiter: ",", header: "first-row", mode: "strict" },
    });
    assert.equal((await responseFor(afterSettlement)).status, "success");

    for (const source of blockedSources.slice(1)) source.resumeSlices();
    const shutdown = send("shutdown", {});
    assert.equal((await responseFor(shutdown)).status, "success");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals(globals);
  }
}

class BackgroundFailureBlob extends Blob {
  #sliceCount = 0;
  #release;
  waitingForSecondSlice = false;

  slice(...args) {
    this.#sliceCount += 1;
    if (this.#sliceCount !== 2) return super.slice(...args);
    const expectedLength = super.slice(...args).size;
    this.waitingForSecondSlice = true;
    return {
      arrayBuffer: () => new Promise((resolve) => {
        this.#release = () => resolve(new ArrayBuffer(expectedLength));
      }),
    };
  }

  releaseSecondSlice() {
    this.#release?.();
  }
}

function mockWasmModuleUrl() {
  const source = `
    const metadata = () => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: { rows: { kind: "exact", value: 1 }, columns: { kind: "exact", value: 1 } },
      schema: { version: 0, columns: [{ id: "c0", name: "a", index: 0, dataType: { type: "utf8" }, nullable: true }] },
      capabilities: { randomAccess: "full", typedValues: false, search: false, sort: false, filter: false, multiTable: false },
    });
    const operations = new Map();
    let nextOperation = 1;
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { globalThis.__tabularkWasmConfigs.push(config); }
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen(_options, sourceLength) {
        const handle = nextOperation++;
        if (typeof globalThis.__tabularkOpenBeginCount === "number") {
          globalThis.__tabularkOpenBeginCount += 1;
        }
        operations.set(handle, { kind: "open" });
        return { kind: "pending", operationHandle: handle, operationRevision: 1, cooperativeYield: false, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: sourceLength }] };
      }
      continueOperation(handle, revision, results) {
        const operation = operations.get(handle);
        operations.delete(handle);
        if (operation.kind === "open") {
          return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 1, tables: [{ id: "table-0", name: "Table 1" }], metadata: metadata() };
        }
        const range = operation.range;
        const values = new Uint8Array();
        const offsets = new Uint32Array(range.rowCount + 1);
        const validity = new Uint8Array([1]);
        return { kind: "complete", operationKind: "read", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, batch: {
          layoutVersion: 1,
          tableId: "table-0", revision: 0, schemaVersion: 0, range, complete: true,
          buffers: [values, offsets, validity],
          columns: [{
            columnId: "c0",
            native: { dataType: { type: "utf8" }, length: range.rowCount, encoding: "variable-width", values: { buffer: 0, byteOffset: 0, byteLength: 0 }, offsets: { buffer: 1, byteOffset: 0, byteLength: offsets.byteLength }, validity: { buffer: { buffer: 2, byteOffset: 0, byteLength: 1 }, bitOffset: 0 } },
            display: { encoding: "variable-width", values: { buffer: 0, byteOffset: 0, byteLength: 0 }, offsets: { buffer: 1, byteOffset: 0, byteLength: offsets.byteLength }, validity: { buffer: { buffer: 2, byteOffset: 0, byteLength: 1 }, bitOffset: 0 } },
          }],
        } };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead(_table, request) {
        const handle = nextOperation++;
        globalThis.__tabularkBeginCount += 1;
        operations.set(handle, { kind: "read", range: request });
        return { kind: "pending", operationHandle: handle, operationRevision: 1, cooperativeYield: false, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: 1 }] };
      }
      cancelOperation(handle) {
        if (typeof globalThis.__tabularkCancelCalls === "number") {
          globalThis.__tabularkCancelCalls += 1;
        }
        const operation = operations.get(handle);
        operations.delete(handle);
        if (operation?.kind === "open") globalThis.__tabularkClosedSources += 1;
      }
      closeTable() {}
      closeSource() { globalThis.__tabularkClosedSources += 1; }
      shutdown() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function mockArrowWasmModuleUrl() {
  const source = `
    const metadata = () => ({
      tableId: "table-0", name: "Arrow IPC", revision: 0,
      extent: { rows: { kind: "exact", value: 0 }, columns: { kind: "exact", value: 0 } },
      schema: { version: 0, columns: [] },
      capabilities: { randomAccess: "full", typedValues: true, search: false, sort: false, filter: false, multiTable: false },
    });
    const operations = new Set();
    let nextOperation = 1;
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { globalThis.__tabularkArrowConfigs.push(config); }
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:arrow-ipc"; }
      beginOpen(_options, sourceLength) {
        const handle = nextOperation++;
        operations.add(handle);
        return { kind: "pending", operationHandle: handle, operationRevision: 1, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: sourceLength }], cooperativeYield: false };
      }
      continueOperation(handle, revision) {
        operations.delete(handle);
        return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 1, tables: [{ id: "table-0", name: "Arrow IPC" }], metadata: metadata() };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead() { throw new Error("not used"); }
      cancelOperation(handle) { operations.delete(handle); }
      closeTable() {}
      closeSource() {}
      shutdown() { operations.clear(); }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function backgroundFailureWasmModuleUrl() {
  const source = `
    let nextOperation = 1;
    let failNextOpen = true;
    let chunkBytes = 1;
    const operations = new Map();
    const metadata = () => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: { rows: { kind: "exact", value: 1 }, columns: { kind: "exact", value: 1 } },
      schema: { version: 0, columns: [{ id: "c0", name: "a", index: 0, dataType: { type: "utf8" }, nullable: true }] },
      capabilities: { randomAccess: "full", typedValues: false, search: false, sort: false, filter: false, multiTable: false },
    });
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { chunkBytes = config.chunkBytes; }
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen(_options, sourceLength) {
        const handle = nextOperation++;
        const fail = failNextOpen;
        failNextOpen = false;
        operations.set(handle, { fail, sourceLength, step: 0 });
        return { kind: "pending", operationHandle: handle, operationRevision: 1, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: Math.min(chunkBytes, sourceLength) }], cooperativeYield: false };
      }
      continueOperation(handle, revision) {
        const operation = operations.get(handle);
        if (operation.fail && operation.step === 0) {
          operation.step = 1;
          return {
            kind: "pending", operationHandle: handle, operationRevision: revision + 1,
            cooperativeYield: false,
            actions: [{
              kind: "read-bytes", actionIndex: 0,
              offset: chunkBytes,
              length: Math.min(chunkBytes, operation.sourceLength - chunkBytes),
            }],
          };
        }
        if (operation.fail) throw new Error("synthetic adapter open failure");
        operations.delete(handle);
        return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 1, tables: [{ id: "table-0", name: "Table 1" }], metadata: metadata() };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead() { throw new Error("not used"); }
      cancelOperation(handle) {
        if (operations.delete(handle)) globalThis.__tabularkClosedSources += 1;
      }
      closeTable() {}
      closeSource() { globalThis.__tabularkClosedSources += 1; }
      shutdown() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function progressiveDelimitedWasmModuleUrl() {
  const source = `
    let chunkBytes = 1;
    let scannedRows = 0;
    let scanDone = false;
    const operations = new Map();
    const metadata = () => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: {
        rows: { kind: scanDone ? "exact" : "at-least", value: scannedRows },
        columns: { kind: "exact", value: 1 },
      },
      schema: { version: 0, columns: [{ id: "c0", name: "value", index: 0, dataType: { type: "utf8" }, nullable: true }] },
      capabilities: { randomAccess: scanDone ? "full" : "indexed-prefix", typedValues: false, search: false, sort: false, filter: false, multiTable: false },
    });
    const tables = [{ id: "table-0", name: "Table 1" }];
    let nextImmediate = 1000;
    const pending = (operationHandle, operationRevision, offset, length) => ({
      kind: "progress", operationKind: "open", operationHandle, operationRevision,
      actions: [{ kind: "read-bytes", actionIndex: 0, offset, length }], cooperativeYield: false,
      sourceHandle: 1,
      metadata: metadata(),
      tables,
      progress: { sourceHandle: 1, bytesScanned: offset, rowsDiscovered: scannedRows, done: false },
    });
    const batch = (request) => {
      const values = new TextEncoder().encode("preview");
      const offsets = new Uint32Array([0, values.byteLength]);
      const descriptor = {
        dataType: { type: "utf8" }, length: 1, encoding: "variable-width",
        offsets: { buffer: 1, byteOffset: 0, byteLength: offsets.byteLength },
        values: { buffer: 0, byteOffset: 0, byteLength: values.byteLength },
      };
      return {
        layoutVersion: 1, tableId: "table-0", revision: 0, schemaVersion: 0,
        range: { ...request, rowCount: 1, columnCount: 1 }, complete: true,
        buffers: [values, offsets],
        columns: [{ columnId: "c0", native: descriptor, display: descriptor }],
      };
    };
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { chunkBytes = config.chunkBytes; }
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen(_options, sourceLength) {
        scannedRows = 0;
        scanDone = false;
        operations.clear();
        operations.set(1, { sourceLength, offset: 0 });
        return pending(1, 1, 0, Math.min(chunkBytes, sourceLength));
      }
      continueOperation(handle, revision, results) {
        const { offset, bytes, eof } = results[0];
        const operation = operations.get(handle);
        globalThis.__tabularkContinueCalls?.push({ offset, length: bytes.byteLength, eof });
        operation.offset = Math.min(operation.offset + chunkBytes, operation.sourceLength);
        scannedRows = operation.sourceLength === 0
          ? 0
          : operation.offset < operation.sourceLength ? 300 : 600;
        if (operation.offset < operation.sourceLength) {
          return pending(
            handle,
            revision + 1,
            operation.offset,
            Math.min(chunkBytes, operation.sourceLength - operation.offset),
          );
        }
        operations.delete(handle);
        scanDone = true;
        return {
          kind: "complete", operationKind: "open", operationHandle: handle,
          operationRevision: revision + 1, actions: [], cooperativeYield: false,
          sourceHandle: 1, metadata: metadata(), tables,
          progress: { sourceHandle: 1, bytesScanned: operation.sourceLength, rowsDiscovered: scannedRows, done: true },
        };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead(_table, request) {
        globalThis.__tabularkReadStarts.push(request.rowStart);
        return { kind: "complete", operationKind: "read", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, batch: batch(request) };
      }
      cancelOperation(handle) { operations.delete(handle); }
      closeTable() {}
      closeSource() { operations.clear(); }
      shutdown() { operations.clear(); }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function progressiveArrowWasmModuleUrl() {
  const source = `
    let chunkBytes = 1;
    const sourceHandle = 7;
    let scannedRows = 0;
    let scanDone = false;
    const operations = new Map();
    const metadata = () => ({
      tableId: "table-0", name: "Arrow IPC", revision: 0,
      extent: {
        rows: { kind: scanDone ? "exact" : "at-least", value: scannedRows },
        columns: { kind: "exact", value: 1 },
      },
      schema: { version: 1, columns: [{ id: "c0", name: "value", index: 0, dataType: { type: "int64" }, nullable: true }] },
      capabilities: { randomAccess: scanDone ? "full" : "indexed-prefix", typedValues: true, search: false, sort: false, filter: false, multiTable: false },
    });
    const tables = [{ id: "table-0", name: "Arrow IPC" }];
    let nextImmediate = 1000;
    const pending = (operationHandle, operationRevision, offset, length) => ({
      kind: "progress", operationKind: "open", operationHandle, operationRevision,
      actions: [{ kind: "read-bytes", actionIndex: 0, offset, length }], cooperativeYield: false,
      sourceHandle,
      metadata: metadata(),
      tables,
      progress: { sourceHandle, bytesScanned: offset, rowsDiscovered: scannedRows, done: false },
    });
    const batch = (request) => {
      const availableRows = scanDone ? 600 : 300;
      const returnedRows = Math.max(0, Math.min(request.rowCount, availableRows - request.rowStart));
      const nativeValues = new BigInt64Array(returnedRows).fill(42n);
      const displayValues = new TextEncoder().encode("42".repeat(returnedRows));
      const displayOffsets = Uint32Array.from(
        { length: returnedRows + 1 },
        (_, index) => index * 2,
      );
      return {
        layoutVersion: 1, tableId: "table-0", revision: 0, schemaVersion: 1,
        range: { ...request, rowCount: returnedRows, columnCount: 1 },
        complete: returnedRows === request.rowCount,
        buffers: [nativeValues, displayValues, displayOffsets],
        columns: [{
          columnId: "c0",
          native: {
            dataType: { type: "int64" }, length: returnedRows, encoding: "fixed-width",
            values: { buffer: 0, byteOffset: 0, byteLength: nativeValues.byteLength },
          },
          display: {
            dataType: { type: "utf8" }, length: returnedRows, encoding: "variable-width",
            offsets: { buffer: 2, byteOffset: 0, byteLength: displayOffsets.byteLength },
            values: { buffer: 1, byteOffset: 0, byteLength: displayValues.byteLength },
          },
        }],
      };
    };
    export default async function init() {}
    export class WasmRuntime {
      constructor(config) { chunkBytes = config.chunkBytes; }
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:arrow-ipc"; }
      beginOpen(_options, sourceLength) {
        operations.set(1, { sourceLength, offset: 0 });
        return {
          kind: "pending", operationHandle: 1, operationRevision: 1,
          actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: Math.min(chunkBytes, sourceLength) }], cooperativeYield: false,
        };
      }
      continueOperation(handle, revision) {
        const operation = operations.get(handle);
        operation.offset = Math.min(operation.offset + chunkBytes, operation.sourceLength);
        scannedRows = operation.offset < operation.sourceLength ? 300 : 600;
        if (operation.offset < operation.sourceLength) {
          return pending(
            handle,
            revision + 1,
            operation.offset,
            Math.min(chunkBytes, operation.sourceLength - operation.offset),
          );
        }
        operations.delete(handle);
        scanDone = true;
        return {
          kind: "complete", operationKind: "open", operationHandle: handle,
          operationRevision: revision + 1, actions: [], cooperativeYield: false,
          sourceHandle, metadata: metadata(), tables,
          progress: { sourceHandle, bytesScanned: operation.sourceLength, rowsDiscovered: scannedRows, done: true },
        };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 9, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead(_table, request) {
        globalThis.__tabularkReadStarts.push(request.rowStart);
        return { kind: "complete", operationKind: "read", operationHandle: nextImmediate++, operationRevision: 1, actions: [], cooperativeYield: false, batch: batch(request) };
      }
      cancelOperation(handle) { operations.delete(handle); }
      closeTable() {}
      closeSource() { operations.clear(); }
      shutdown() { operations.clear(); }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function flakyArrowWasmModuleUrl() {
  const source = `
    let nextOperation = 1;
    const operations = new Set();
    const metadata = () => ({
      tableId: "table-0", name: "Arrow IPC", revision: 0,
      extent: { rows: { kind: "exact", value: 0 }, columns: { kind: "exact", value: 0 } },
      schema: { version: 0, columns: [] },
      capabilities: { randomAccess: "full", typedValues: true, search: false, sort: false, filter: false, multiTable: false },
    });
    export default async function init() {
      globalThis.__tabularkArrowInitAttempts += 1;
      if (globalThis.__tabularkArrowInitAttempts === 1) throw new Error("synthetic Arrow initializer failure");
    }
    export class WasmRuntime {
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:arrow-ipc"; }
      beginOpen(options, sourceLength) {
        globalThis.__tabularkArrowOpenOptions = options;
        const handle = nextOperation++;
        operations.add(handle);
        return { kind: "pending", operationHandle: handle, operationRevision: 1, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: sourceLength }], cooperativeYield: false };
      }
      continueOperation(handle, revision) {
        operations.delete(handle);
        return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 2, tables: [{ id: "table-0", name: "Arrow IPC" }], metadata: metadata() };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 2, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead() { throw new Error("not used"); }
      cancelOperation(handle) { operations.delete(handle); }
      closeTable() {}
      closeSource() {}
      shutdown() { operations.clear(); }
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function snakeCaseDescriptorWasmModuleUrl() {
  const source = `
    let nextOperation = 1;
    const unionType = {
      type: "union", mode: "sparse",
      fields: [
        { typeId: 5, field: { name: "left", dataType: { type: "int32" }, nullable: true } },
        { typeId: 7, field: { name: "right", dataType: { type: "int32" }, nullable: true } },
      ],
    };
    const runEndType = {
      type: "run-end-encoded",
      run_ends: { name: "run_ends", dataType: { type: "int16" }, nullable: false },
      values: { name: "values", dataType: { type: "int32" }, nullable: true },
    };
    const metadata = () => ({
      tableId: "table-0", name: "Table 1", revision: 0,
      extent: { rows: { kind: "exact", value: 2 }, columns: { kind: "exact", value: 2 } },
      schema: { version: 0, columns: [
        { id: "c0", name: "union", index: 0, dataType: unionType, nullable: true },
        { id: "c1", name: "ree", index: 1, dataType: runEndType, nullable: true },
      ] },
      capabilities: { randomAccess: "full", typedValues: true, search: false, sort: false, filter: false, multiTable: false },
    });
    const display = () => ({
      dataType: { type: "utf8" }, length: 2, encoding: "variable-width",
      offsets: { buffer: 5, byteOffset: 0, byteLength: 12 },
      values: { buffer: 6, byteOffset: 0, byteLength: 0 },
    });
    export default async function init() {}
    export class WasmRuntime {
      protocolVersion() { return 4; }
      adapterApiVersion() { return 3; }
      batchLayoutVersion() { return 1; }
      adapterId() { return "tabulark:delimited"; }
      beginOpen(_options, sourceLength) {
        return { kind: "pending", operationHandle: nextOperation++, operationRevision: 1, actions: [{ kind: "read-bytes", actionIndex: 0, offset: 0, length: sourceLength }], cooperativeYield: false };
      }
      continueOperation(handle, revision) {
        return { kind: "complete", operationKind: "open", operationHandle: handle, operationRevision: revision + 1, actions: [], cooperativeYield: false, sourceHandle: 1, tables: [{ id: "table-0", name: "Table 1" }], metadata: metadata() };
      }
      beginOpenTable() { return { kind: "complete", operationKind: "open-table", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, table: { tableHandle: 1, metadata: metadata() } }; }
      beginMetadata() { return { kind: "complete", operationKind: "metadata", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, metadata: metadata() }; }
      beginPresentation() { return { kind: "complete", operationKind: "presentation", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginPresentationRange() { return { kind: "complete", operationKind: "presentation-range", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, presentation: null }; }
      beginRead() {
        const typeIds = new Int8Array([5, 7]);
        const left = new Int32Array([11, 0]);
        const right = new Int32Array([0, 22]);
        const runEnds = new Int16Array([2]);
        const runValues = new Int32Array([7]);
        const displayOffsets = new Uint32Array([0, 0, 0]);
        const displayValues = new Uint8Array();
        const buffers = [typeIds, left, right, runEnds, runValues, displayOffsets, displayValues];
        globalThis.__tabularkAdapterOutputBuffers = buffers.map((value) => value.buffer);
        return { kind: "complete", operationKind: "read", operationHandle: nextOperation++, operationRevision: 1, actions: [], cooperativeYield: false, batch: {
          layoutVersion: 1, tableId: "table-0", revision: 0, schemaVersion: 0,
          range: { rowStart: 0, rowCount: 2, columnStart: 0, columnCount: 2 }, complete: true,
          buffers,
          columns: [
            {
              columnId: "c0",
              native: {
                dataType: unionType, length: 2, encoding: "union",
                type_ids: { buffer: 0, byteOffset: 0, byteLength: 2 },
                fields: [
                  { typeId: 5, values: { dataType: { type: "int32" }, length: 2, encoding: "fixed-width", values: { buffer: 1, byteOffset: 0, byteLength: 8 } } },
                  { typeId: 7, values: { dataType: { type: "int32" }, length: 2, encoding: "fixed-width", values: { buffer: 2, byteOffset: 0, byteLength: 8 } } },
                ],
              },
              display: display(),
            },
            {
              columnId: "c1",
              native: {
                dataType: runEndType, length: 2, encoding: "run-end-encoded",
                run_ends: { dataType: { type: "int16" }, length: 1, encoding: "fixed-width", values: { buffer: 3, byteOffset: 0, byteLength: 2 } },
                values: { dataType: { type: "int32" }, length: 1, encoding: "fixed-width", values: { buffer: 4, byteOffset: 0, byteLength: 4 } },
              },
              display: display(),
            },
          ],
        } };
      }
      cancelOperation() {}
      closeTable() {}
      closeSource() {}
      shutdown() {}
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
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

function assertResourceLimitDetails(details) {
  assert.equal(typeof details?.resource, "string");
  assert.ok(details.resource.length > 0);
  const hasBytes = Number.isFinite(details.requiredBytes)
    && Number.isFinite(details.availableBytes);
  const hasCount = Number.isFinite(details.required)
    && Number.isFinite(details.available);
  assert.equal(hasBytes || hasCount, true, "resource errors report required and available capacity");
}

function saveGlobals(names) {
  const savedNames = [...new Set(["__tabularkTestOnlyAdapterModuleUrls", ...names])];
  return savedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
}

function restoreGlobals(descriptors) {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
