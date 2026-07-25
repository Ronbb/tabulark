import { expect, test } from "@playwright/test";

const fixtureUrl = "/test/fixtures/arrow/v1/m4-sample.arrow";
const progressiveStreamFixtureUrl = "/test/performance/fixtures/arrow/m4-stream-none.arrows";
const progressiveWorkerUrl = "/test/browser/progressive-arrow-worker.mjs";

test("opens the committed Arrow IPC fixture with recursive native values and display rows", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async ({ fixture }) => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const source = await (await fetch(fixture)).arrayBuffer();
    const bytesBeforeOpen = source.byteLength;
    // Exercise the real Arrow WASM path at the public minimum budget. This
    // catches adapter-option defaults that accidentally exceed the engine
    // ceiling before any IPC bytes are read.
    const engine = await createEngine({
      adapters: [delimitedAdapter, arrowIpcAdapter],
      memoryBudgetBytes: 8 * 1024 * 1024,
    });
    let dataset;
    let table;
    try {
      dataset = await engine.open(source, {
        adapter: arrowIpcAdapter,
        adapterOptions: { container: "auto" },
      });
      const bytesAfterRetainedOpen = source.byteLength;
      table = await dataset.openTable(dataset.tables[0].id);
      const batch = await table.readRange({
        rowStart: 0,
        rowCount: 4,
        columnStart: 0,
        columnCount: 7,
      });
      return {
        bytesBeforeOpen,
        bytesAfterRetainedOpen,
        schema: table.metadata.schema.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType.type,
        })),
        rows: batch.toRows(),
        display: batch.toDisplayRows(),
        descriptor: {
          dictionary: batch.columns[4].native.dictionary !== undefined,
          listChildren: batch.columns[5].native.children?.length ?? 0,
          structChildren: batch.columns[6].native.children?.length ?? 0,
        },
        bufferCount: batch.buffers.length,
        byteLength: batch.byteLength,
      };
    } finally {
      await table?.close();
      await dataset?.close();
      await engine.close();
    }
  }, { fixture: fixtureUrl });

  expect(result.bytesBeforeOpen).toBeGreaterThan(0);
  expect(result.bytesAfterRetainedOpen).toBe(result.bytesBeforeOpen);
  expect(result.schema).toEqual([
    { name: "bigint", dataType: "int64" },
    { name: "amount", dataType: "decimal128" },
    { name: "observed_at", dataType: "timestamp" },
    { name: "label", dataType: "utf8" },
    { name: "status", dataType: "dictionary" },
    { name: "tags", dataType: "list" },
    { name: "details", dataType: "struct" },
  ]);
  expect(result.rows[0][0]).toBe(9_007_199_254_740_993n);
  expect(result.rows[0][1]).toEqual({
    kind: "decimal",
    unscaled: 1_234_567n,
    precision: 20,
    scale: 4,
  });
  expect(result.rows[0][3]).toBe("你好，Arrow");
  expect(result.rows[0][4]).toBe("待处理");
  expect(result.rows[0][5]).toEqual(["数据", "preview"]);
  expect(result.rows[0][6]).toEqual({ city: "上海", score: 98 });
  expect(result.rows[1][3]).toBeNull();
  expect(result.rows[2][0]).toBeNull();
  expect(result.display[0][1]).toBe("123.4567");
  expect(result.display[0][3]).toBe("你好，Arrow");
  expect(result.display[0][5]).not.toMatch(/[\t\r\n]/u);
  expect(result.descriptor).toEqual({ dictionary: true, listChildren: 1, structChildren: 2 });
  expect(result.bufferCount).toBeGreaterThan(0);
  expect(result.byteLength).toBeGreaterThan(0);
});

test("publishes and reads an Arrow Stream prefix before upgrading stable handles at EOF", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async ({ fixture, workerHarness }) => {
    const CONTROL_CHANNEL = "__tabularkProgressiveArrowTest";
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const NativeWorker = globalThis.Worker;
    let worker;
    let releaseSent = false;
    let resolveBlockedRead;
    let resolveLaterReadPosted;
    const blockedReadDetailPromise = new Promise((resolve) => {
      resolveBlockedRead = resolve;
    });
    const laterReadPosted = new Promise((resolve) => {
      resolveLaterReadPosted = resolve;
    });

    class ProgressiveArrowWorker extends NativeWorker {
      constructor(url, options) {
        const actualUrl = new URL(String(url), location.href);
        if (!actualUrl.pathname.endsWith("/dist/worker.js")) {
          throw new Error(`unexpected Tabulark Worker URL: ${actualUrl.pathname}`);
        }
        super(new URL(workerHarness, location.href), options);
        worker = this;
        this.addEventListener("message", (event) => {
          const control = event.data?.[CONTROL_CHANNEL];
          if (control?.kind !== "source-read-blocked") {
            return;
          }
          event.stopImmediatePropagation();
          resolveBlockedRead(control);
        });
      }

      postMessage(message, transfer) {
        if (message?.op === "readRange" && message.payload?.range?.rowStart === 511) {
          resolveLaterReadPosted({
            requestId: message.requestId,
            rowStart: message.payload.range.rowStart,
          });
        }
        super.postMessage(message, transfer);
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: ProgressiveArrowWorker,
    });

    let engine;
    let dataset;
    let table;
    let unsubscribeDataset;
    let unsubscribeTable;
    const releaseSourceRead = () => {
      if (!releaseSent && worker) {
        releaseSent = true;
        worker.postMessage({ [CONTROL_CHANNEL]: { kind: "release-source-read" } });
      }
    };

    try {
      const { createEngine, delimitedAdapter } = await import("/dist/index.js");
      const { arrowIpcAdapter } = await import("/dist/arrow.js");
      const source = await (await fetch(fixture)).blob();
      const memoryBudgetBytes = 8 * 1024 * 1024;
      engine = await createEngine({
        adapters: [delimitedAdapter, arrowIpcAdapter],
        memoryBudgetBytes,
      });

      const [openedDataset, blockedReadDetail] = await Promise.all([
        engine.open(source, {
          adapter: arrowIpcAdapter,
          adapterOptions: { container: "stream" },
        }),
        blockedReadDetailPromise,
      ]);
      dataset = openedDataset;
      const datasetIdentity = dataset;
      const datasetHandle = dataset.handle;
      const progressEvents = [];
      let resolveDone;
      const doneProgress = new Promise((resolve) => {
        resolveDone = resolve;
      });
      unsubscribeDataset = dataset.subscribe((event) => {
        if (event.type === "progress") {
          progressEvents.push(event.progress);
          if (event.progress.done) {
            resolveDone(event.progress);
          }
        }
      });

      table = await dataset.openTable(dataset.tables[0].id);
      const tableIdentity = table;
      const tableHandle = table.handle;
      const prefixMetadata = structuredClone(table.metadata);
      if (
        prefixMetadata.extent.rows.kind !== "at-least"
        || prefixMetadata.capabilities.randomAccess !== "indexed-prefix"
      ) {
        throw new Error("the gated Stream did not publish indexed-prefix metadata");
      }

      let resolveExactMetadata;
      const exactMetadata = new Promise((resolve) => {
        resolveExactMetadata = resolve;
      });
      unsubscribeTable = table.subscribe((event) => {
        if (
          event.type === "metadata"
          && event.metadata.extent.rows.kind === "exact"
          && event.metadata.capabilities.randomAccess === "full"
        ) {
          resolveExactMetadata(event.metadata);
        }
      });

      const prefixBatch = await table.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      const laterBatchPending = table.readRange({
        rowStart: 511,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      const laterRequest = await laterReadPosted;

      releaseSourceRead();
      const [laterBatch, done, exact] = await Promise.all([
        laterBatchPending,
        doneProgress,
        exactMetadata,
      ]);
      const finalMetadata = structuredClone(table.metadata);

      return {
        blockedRead: blockedReadDetail,
        datasetHandle,
        datasetHandleAfter: dataset.handle,
        datasetIdentityStable: dataset === datasetIdentity,
        done,
        exact: {
          randomAccess: exact.capabilities.randomAccess,
          rows: exact.extent.rows,
        },
        final: {
          randomAccess: finalMetadata.capabilities.randomAccess,
          rows: finalMetadata.extent.rows,
        },
        laterRequest,
        laterRows: laterBatch.toRows(),
        memoryBudgetBytes,
        prefix: {
          randomAccess: prefixMetadata.capabilities.randomAccess,
          rows: prefixMetadata.extent.rows,
        },
        prefixRows: prefixBatch.toRows(),
        progressEvents,
        sourceBytes: source.size,
        tableHandle,
        tableHandleAfter: table.handle,
        tableIdentityStable: table === tableIdentity,
      };
    } finally {
      releaseSourceRead();
      unsubscribeTable?.();
      unsubscribeDataset?.();
      await table?.close();
      await dataset?.close();
      await engine?.close();
      if (originalWorker) {
        Object.defineProperty(globalThis, "Worker", originalWorker);
      } else {
        delete globalThis.Worker;
      }
    }
  }, { fixture: progressiveStreamFixtureUrl, workerHarness: progressiveWorkerUrl });

  expect(result.memoryBudgetBytes).toBe(8 * 1024 * 1024);
  expect(result.blockedRead).toEqual({
    kind: "source-read-blocked",
    completedSourceBytes: 32 * 1024,
    pendingSourceBytes: result.sourceBytes - 32 * 1024,
    sourceReadCount: 2,
  });
  expect(result.prefix).toEqual({
    randomAccess: "indexed-prefix",
    rows: { kind: "at-least", value: 256 },
  });
  expect(result.prefixRows).toEqual([[9_007_199_254_740_993n]]);
  expect(result.laterRequest.rowStart).toBeGreaterThanOrEqual(result.prefix.rows.value);
  expect(result.done).toEqual({
    sourceHandle: result.datasetHandle,
    bytesScanned: result.sourceBytes,
    rowsDiscovered: 512,
    done: true,
  });
  expect(result.progressEvents.at(-1)).toEqual(result.done);
  expect(result.exact).toEqual({
    randomAccess: "full",
    rows: { kind: "exact", value: 512 },
  });
  expect(result.final).toEqual(result.exact);
  expect(result.laterRows).toEqual([[42n]]);
  expect(result.datasetIdentityStable).toBe(true);
  expect(result.tableIdentityStable).toBe(true);
  expect(result.datasetHandleAfter).toBe(result.datasetHandle);
  expect(result.tableHandleAfter).toBe(result.tableHandle);
});

test("keeps ArrayBuffer transfer opt-in and rejects Blob transfer", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async ({ fixture }) => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const bytes = await (await fetch(fixture)).arrayBuffer();
    const transferred = bytes.slice(0);
    const engine = await createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter] });
    let retained;
    let moved;
    try {
      retained = await engine.open(bytes, { adapter: arrowIpcAdapter });
      const retainedLength = bytes.byteLength;
      await retained.close();
      retained = undefined;

      moved = await engine.open(transferred, {
        adapter: arrowIpcAdapter,
        transferInput: true,
      });
      const movedLength = transferred.byteLength;
      await moved.close();
      moved = undefined;

      let blobFailure;
      try {
        await engine.open(new Blob(["x"]), {
          adapter: arrowIpcAdapter,
          transferInput: true,
        });
      } catch (error) {
        blobFailure = error?.code;
      }
      return { retainedLength, movedLength, blobFailure };
    } finally {
      await retained?.close();
      await moved?.close();
      await engine.close();
    }
  }, { fixture: fixtureUrl });

  expect(result.retainedLength).toBeGreaterThan(0);
  expect(result.movedLength).toBe(0);
  expect(result.blobFailure).toBe("INVALID_ARGUMENT");
});

test("keeps concurrent CSV and Arrow sources isolated across close and Arrow failure", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async ({ fixture }) => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const arrowBytes = await (await fetch(fixture)).arrayBuffer();
    const engine = await createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter] });
    let csv;
    let arrow;
    let csvTable;
    let arrowTable;
    let reopened;
    let reopenedTable;
    try {
      [csv, arrow] = await Promise.all([
        engine.open(new Blob(["name\nCSV survives\n"]), {
          adapter: delimitedAdapter,
          adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
        }),
        engine.open(arrowBytes, { adapter: arrowIpcAdapter }),
      ]);
      [csvTable, arrowTable] = await Promise.all([
        csv.openTable("table-0"),
        arrow.openTable("table-0"),
      ]);
      const [csvRows, arrowRows] = await Promise.all([
        csvTable.readRange({ rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }),
        arrowTable.readRange({ rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 }),
      ]);
      await arrowTable.close();
      arrowTable = undefined;
      await arrow.close();
      arrow = undefined;

      let arrowFailure;
      try {
        await engine.open(new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer, {
          adapter: arrowIpcAdapter,
          adapterOptions: { container: "auto" },
        });
      } catch (error) {
        arrowFailure = error?.code;
      }

      const csvAfterArrowFailure = await csvTable.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      reopened = await engine.open(arrowBytes, { adapter: arrowIpcAdapter });
      reopenedTable = await reopened.openTable("table-0");
      const reopenedRows = await reopenedTable.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      return {
        csvRows: csvRows.toDisplayRows(),
        arrowRows: arrowRows.toRows(),
        arrowFailure,
        csvAfterArrowFailure: csvAfterArrowFailure.toDisplayRows(),
        reopenedRows: reopenedRows.toRows(),
      };
    } finally {
      await reopenedTable?.close();
      await reopened?.close();
      await arrowTable?.close();
      await arrow?.close();
      await csvTable?.close();
      await csv?.close();
      await engine.close();
    }
  }, { fixture: fixtureUrl });

  expect(result.csvRows).toEqual([["CSV survives"]]);
  expect(result.arrowRows[0][0]).toBe(9_007_199_254_740_993n);
  expect(result.arrowFailure).toBeTruthy();
  expect(result.csvAfterArrowFailure).toEqual([["CSV survives"]]);
  expect(result.reopenedRows[0][0]).toBe(9_007_199_254_740_993n);
});

test("loads only the selected adapter WASM and reuses the Arrow artifact", async ({ page }) => {
  const requested = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto("/test/browser/harness.html");

  await page.evaluate(async () => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    window.__m4Engine = await createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter] });
  });
  expect(requested.filter((url) => url.includes("/dist/wasm/"))).toHaveLength(0);
  expect(requested.filter((url) => url.includes("_bg.wasm"))).toHaveLength(0);

  await page.evaluate(async () => {
    const { delimitedAdapter } = await import("/dist/index.js");
    const dataset = await window.__m4Engine.open(new Blob(["value\na\n"]), {
      adapter: delimitedAdapter,
      adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
    });
    await dataset.close();
  });
  expect(requested.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(requested.filter((url) => url.includes("wasm/delimited/tabulark_delimited.js"))).toHaveLength(1);
  expect(requested.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(0);
  expect(requested.filter((url) => url.includes("wasm/arrow/tabulark_arrow.js"))).toHaveLength(0);

  await page.evaluate(async ({ fixture }) => {
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const source = await (await fetch(fixture)).arrayBuffer();
    const datasets = await Promise.all([
      window.__m4Engine.open(source.slice(0), { adapter: arrowIpcAdapter }),
      window.__m4Engine.open(source.slice(0), { adapter: arrowIpcAdapter }),
    ]);
    await Promise.all(datasets.map((dataset) => dataset.close()));
  }, { fixture: fixtureUrl });
  const arrowWasmRequests = requested.filter((url) => url.includes("tabulark_arrow_bg.wasm"));
  expect(arrowWasmRequests).toHaveLength(1);
  expect(requested.filter((url) => url.includes("wasm/arrow/tabulark_arrow.js"))).toHaveLength(1);

  await page.evaluate(async ({ fixture }) => {
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const source = await (await fetch(fixture)).arrayBuffer();
    const dataset = await window.__m4Engine.open(source, { adapter: arrowIpcAdapter });
    await dataset.close();
    await window.__m4Engine.close();
    delete window.__m4Engine;
  }, { fixture: fixtureUrl });
  expect(requested.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(1);
});
