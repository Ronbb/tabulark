import { expect, test } from "@playwright/test";

const runtimes = [
  {
    id: "tabulark:delimited",
    module: "/target/pages/dist/wasm/delimited/tabulark_delimited.js",
    sourceLength: 32,
    inlineSource: "name,score\nAda,10\nGrace,20\n",
  },
  {
    id: "tabulark:arrow-ipc",
    module: "/target/pages/dist/wasm/arrow/tabulark_arrow.js",
    sourceLength: 8_192,
    fixture: "/test/fixtures/arrow/v1/m4-sample.arrow",
  },
  {
    id: "tabulark:parquet",
    module: "/target/pages/dist/wasm/parquet/tabulark_parquet.js",
    sourceLength: 32,
    fixture: "/test/fixtures/parquet/v1/tabulark-rust.parquet",
  },
  {
    id: "tabulark:excel",
    module: "/target/pages/dist/wasm/excel/tabulark_excel.js",
    sourceLength: 32,
    fixture: "/test/fixtures/excel/v1/tabulark-ooxml.xlsx",
  },
];

test.setTimeout(120_000);

test("four real WASM adapters share successful, failed, recovered, and cascading lifecycles", async ({
  page,
}) => {
  await page.goto("/test/browser/harness.html");
  const results = await page.evaluate(async () => {
    const root = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const { parquetAdapter } = await import("/dist/parquet.js");
    const { excelAdapter } = await import("/dist/excel.js");

    const fetchBlob = async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      return new Blob([await response.arrayBuffer()]);
    };
    const cases = [
      {
        id: root.delimitedAdapter.id,
        adapter: root.delimitedAdapter,
        good: new Blob(["name,score\nAda,10\nGrace,20\n"]),
        bad: new Blob(["name\n\"unterminated"]),
        options: { dialect: "csv", header: "first-row", mode: "strict" },
      },
      {
        id: arrowIpcAdapter.id,
        adapter: arrowIpcAdapter,
        good: await fetchBlob("/test/fixtures/arrow/v1/m4-sample.arrow"),
        bad: new Blob([new Uint8Array([1, 2, 3, 4])]),
        options: { container: "auto" },
      },
      {
        id: parquetAdapter.id,
        adapter: parquetAdapter,
        good: await fetchBlob("/test/fixtures/parquet/v1/tabulark-rust.parquet"),
        bad: new Blob([new TextEncoder().encode("PAR1bad-PAR1")]),
        options: {},
      },
      {
        id: excelAdapter.id,
        adapter: excelAdapter,
        good: await fetchBlob("/test/fixtures/excel/v1/tabulark-ooxml.xlsx"),
        bad: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]),
        options: { format: "auto" },
      },
    ];

    const output = [];
    for (const fixture of cases) {
      const engine = await root.createEngine({
        adapters: [fixture.adapter],
        memoryBudgetBytes: 64 * 1024 * 1024,
      });
      let firstDataset;
      let recoveredDataset;
      const tables = [];
      try {
        let failedOpenCode = "resolved";
        try {
          await engine.open(fixture.bad, {
            adapter: fixture.adapter,
            adapterOptions: fixture.options,
          });
        } catch (error) {
          failedOpenCode = error?.code ?? error?.name ?? "unknown";
        }

        firstDataset = await engine.open(fixture.good, {
          adapter: fixture.adapter,
          adapterOptions: fixture.options,
        });
        for (const descriptor of firstDataset.tables) {
          tables.push(await firstDataset.openTable(descriptor.id));
        }
        const first = tables[0];
        const columnCount = Math.min(2, first.metadata.schema.columns.length);
        const batch = await first.readRange({
          rowStart: 0,
          rowCount: 1,
          columnStart: 0,
          columnCount,
        });
        const firstRows = batch.toDisplayRows({ maxCells: Math.max(1, columnCount) });

        let isolatedRows = null;
        await first.close();
        await first.close();
        if (tables.length > 1) {
          const sibling = tables[1];
          const siblingColumns = Math.min(1, sibling.metadata.schema.columns.length);
          isolatedRows = (await sibling.readRange({
            rowStart: 0,
            rowCount: 1,
            columnStart: 0,
            columnCount: siblingColumns,
          })).toDisplayRows({ maxCells: Math.max(1, siblingColumns) });
        }

        await firstDataset.close();
        await firstDataset.close();
        let cascadedCode = "resolved";
        try {
          const target = tables.at(-1);
          await target.readRange({ rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 });
        } catch (error) {
          cascadedCode = error?.code ?? error?.name ?? "unknown";
        }

        // A second successful dataset on the same engine proves that failure,
        // table close, and dataset close returned their global reservations.
        recoveredDataset = await engine.open(fixture.good, {
          adapter: fixture.adapter,
          adapterOptions: fixture.options,
        });
        const recoveredTable = await recoveredDataset.openTable(recoveredDataset.tables[0].id);
        const recovered = await recoveredTable.readRange({
          rowStart: 0,
          rowCount: 1,
          columnStart: 0,
          columnCount: 1,
        });
        const recoveredRows = recovered.toDisplayRows({ maxCells: 1 });
        await recoveredTable.close();
        await recoveredDataset.close();
        recoveredDataset = undefined;

        output.push({
          id: fixture.id,
          failedOpenCode,
          firstRows,
          isolatedRows,
          recoveredRows,
          cascadedCode,
          tableCount: tables.length,
        });
      } finally {
        await recoveredDataset?.close().catch(() => {});
        await firstDataset?.close().catch(() => {});
        await Promise.all(tables.map((table) => table.close().catch(() => {})));
        await engine.close();
        await engine.close();
      }
    }
    return output;
  });

  expect(results.map(({ id }) => id)).toEqual(runtimes.map(({ id }) => id));
  for (const result of results) {
    expect(result.failedOpenCode).not.toBe("resolved");
    expect(result.firstRows).toHaveLength(1);
    expect(result.recoveredRows).toHaveLength(1);
    expect(result.cascadedCode).toBe("HANDLE_CLOSED");
  }
  expect(results.find(({ id }) => id === "tabulark:excel")).toMatchObject({
    tableCount: 3,
    isolatedRows: [["Hidden"]],
  });
});

test("four real WASM runtimes conform to ABI v3 cancellation and idempotent cleanup", async ({
  page,
}) => {
  await page.goto("/target/pages/index.html");
  const results = await page.evaluate(async (descriptors) => {
    const output = [];
    const config = {
      memoryBudgetBytes: 8 * 1024 * 1024,
      indexBudgetBytes: 1024 * 1024,
      tileCacheBudgetBytes: 1024 * 1024,
      chunkBytes: 32 * 1024,
      checkpointRows: 1_024,
      maxFieldBytes: 256 * 1024,
      maxColumns: 16_384,
      maxRangeCells: 250_000,
      maxBatchBytes: 1024 * 1024,
      maxSources: 2,
      maxActiveRanges: 2,
    };

    for (const descriptor of descriptors) {
      const module = await import(descriptor.module);
      await module.default();

      let zeroBudgetCode;
      try {
        new module.WasmRuntime({ ...config, memoryBudgetBytes: 0 });
      } catch (error) {
        zeroBudgetCode = error?.code;
      }

      const runtime = new module.WasmRuntime(config);
      const first = runtime.beginOpen({}, descriptor.sourceLength);
      const firstCancelled = runtime.cancelOperation(first.operationHandle);
      const firstCancelledAgain = runtime.cancelOperation(first.operationHandle);
      const second = runtime.beginOpen({}, descriptor.sourceLength);
      const secondCancelled = runtime.cancelOperation(second.operationHandle);

      let illegalHandleCode;
      try {
        runtime.continueOperation(0, 1, []);
      } catch (error) {
        illegalHandleCode = error?.code;
      }

      const closedUnknownTable = runtime.closeTable(0);
      const closedUnknownSource = runtime.closeSource(0);
      runtime.shutdown();
      runtime.shutdown();
      output.push({
        id: runtime.adapterId(),
        protocolVersion: runtime.protocolVersion(),
        adapterApiVersion: runtime.adapterApiVersion(),
        batchLayoutVersion: runtime.batchLayoutVersion(),
        firstKind: first.kind,
        firstRevision: first.operationRevision,
        firstActionCount: first.actions.length,
        secondKind: second.kind,
        secondRevision: second.operationRevision,
        secondActionCount: second.actions.length,
        firstCancelled,
        firstCancelledAgain,
        secondCancelled,
        illegalHandleCode,
        zeroBudgetCode,
        closedUnknownTable,
        closedUnknownSource,
      });
    }
    return output;
  }, runtimes);

  expect(results.map(({ id }) => id)).toEqual(runtimes.map(({ id }) => id));
  for (const result of results) {
    expect(result).toMatchObject({
      protocolVersion: 4,
      adapterApiVersion: 3,
      batchLayoutVersion: 1,
      firstRevision: 1,
      firstActionCount: 1,
      secondRevision: 1,
      secondActionCount: 1,
      firstCancelled: true,
      firstCancelledAgain: false,
      secondCancelled: true,
      illegalHandleCode: "HANDLE_CLOSED",
      zeroBudgetCode: "INVALID_ARGUMENT",
      closedUnknownTable: false,
      closedUnknownSource: false,
    });
    expect(["pending", "progress"]).toContain(result.firstKind);
    expect(["pending", "progress"]).toContain(result.secondKind);
  }
});

test("real WASM operations reject invalid steps, cancel pending reads, and release capacity", async ({
  page,
}) => {
  await page.goto("/target/pages/index.html");
  const results = await page.evaluate(async (descriptors) => {
    const config = {
      memoryBudgetBytes: 8 * 1024 * 1024,
      indexBudgetBytes: 1024 * 1024,
      tileCacheBudgetBytes: 1024 * 1024,
      chunkBytes: 32 * 1024,
      checkpointRows: 1_024,
      maxFieldBytes: 256 * 1024,
      maxColumns: 16_384,
      maxRangeCells: 250_000,
      maxBatchBytes: 1024 * 1024,
      maxSources: 2,
      maxActiveRanges: 2,
    };

    const loadSource = async (descriptor) => {
      if (descriptor.inlineSource) {
        return new TextEncoder().encode(descriptor.inlineSource);
      }
      const response = await fetch(descriptor.fixture);
      if (!response.ok) throw new Error(`${descriptor.fixture} returned HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };

    const drive = (runtime, initial, source, operationKind) => {
      let step = initial;
      for (let index = 0; index < 1_024; index += 1) {
        if (step.kind === "complete") {
          if (step.operationKind !== operationKind) {
            throw new Error(`expected ${operationKind}, received ${String(step.operationKind)}`);
          }
          return step;
        }
        if (step.kind !== "pending" && step.kind !== "progress") {
          throw new Error(`unexpected ${String(step.kind)} operation step`);
        }
        if (!Array.isArray(step.actions)) {
          throw new Error("adapter operation actions must be an array");
        }
        if (step.actions.length === 0 && step.cooperativeYield !== true) {
          throw new Error("empty adapter operation step did not request a cooperative yield");
        }
        const results = step.actions.map((action) => {
          if (action.kind !== "read-bytes") {
            throw new Error(`unexpected ${String(action.kind)} adapter action`);
          }
          const { actionIndex, offset, length } = action;
          const end = offset + length;
          if (
            !Number.isSafeInteger(actionIndex)
            || !Number.isSafeInteger(offset)
            || !Number.isSafeInteger(length)
            || end > source.length
          ) {
            throw new Error(`invalid adapter byte request ${String(offset)}+${String(length)}`);
          }
          return {
            actionIndex,
            offset,
            bytes: source.slice(offset, end),
            eof: end === source.length,
          };
        });
        step = runtime.continueOperation(
          step.operationHandle,
          step.operationRevision,
          results,
        );
      }
      throw new Error("adapter operation exceeded the conformance step limit");
    };

    const output = [];
    for (const descriptor of descriptors) {
      const module = await import(descriptor.module);
      await module.default();
      const source = await loadSource(descriptor);
      const runtime = new module.WasmRuntime(config);
      try {
        // Repeated start/cancel cycles exercise real source reservations. With
        // maxSources=2, even a small per-cycle handle leak would fail quickly.
        let cancelledOpenCycles = 0;
        for (let index = 0; index < 12; index += 1) {
          const pending = runtime.beginOpen({}, source.length);
          if (runtime.cancelOperation(pending.operationHandle) !== true) {
            throw new Error("first cancellation did not own the open operation");
          }
          if (runtime.cancelOperation(pending.operationHandle) !== false) {
            throw new Error("cancelled open operation settled more than once");
          }
          cancelledOpenCycles += 1;
        }

        // Feed an incorrect offset to a valid operation handle. ABI-v3 rejects
        // the result set without consuming the valid revision, so explicitly
        // cancel the still-owned operation before the recovery open.
        const invalid = runtime.beginOpen({}, source.length);
        let invalidStepCode = "resolved";
        try {
          runtime.continueOperation(
            invalid.operationHandle,
            invalid.operationRevision,
            invalid.actions.map((action, index) => ({
              actionIndex: action.actionIndex,
              offset: action.offset + (index === 0 ? 1 : 0),
              bytes: source.slice(action.offset, action.offset + action.length),
              eof: action.offset + action.length === source.length,
            })),
          );
        } catch (error) {
          invalidStepCode = error?.code ?? error?.name ?? "unknown";
        }
        const invalidOperationCancelled = runtime.cancelOperation(invalid.operationHandle);
        const invalidOperationCancelledAgain = runtime.cancelOperation(invalid.operationHandle);

        const opened = drive(runtime, runtime.beginOpen({}, source.length), source, "open");
        const tableDescriptor = opened.tables[0];
        const openedTableStep = drive(
          runtime,
          runtime.beginOpenTable(opened.sourceHandle, tableDescriptor.id),
          source,
          "open-table",
        );
        const openedTable = openedTableStep.table;
        const request = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

        const cancellableRead = runtime.beginRead(openedTable.tableHandle, request);
        const readStepKind = cancellableRead.kind;
        let readCancelled = null;
        let readCancelledAgain = null;
        if (cancellableRead.kind !== "complete") {
          readCancelled = runtime.cancelOperation(cancellableRead.operationHandle);
          readCancelledAgain = runtime.cancelOperation(cancellableRead.operationHandle);
        }

        const recoveredRead = drive(
          runtime,
          runtime.beginRead(openedTable.tableHandle, request),
          source,
          "read",
        );
        const closedTable = runtime.closeTable(openedTable.tableHandle);
        const closedTableAgain = runtime.closeTable(openedTable.tableHandle);
        const closedSource = runtime.closeSource(opened.sourceHandle);
        const closedSourceAgain = runtime.closeSource(opened.sourceHandle);

        output.push({
          id: runtime.adapterId(),
          cancelledOpenCycles,
          invalidStepCode,
          invalidOperationCancelled,
          invalidOperationCancelledAgain,
          readStepKind,
          readCancelled,
          readCancelledAgain,
          recoveredReadKind: recoveredRead.kind,
          closedTable,
          closedTableAgain,
          closedSource,
          closedSourceAgain,
        });
      } finally {
        runtime.shutdown();
        runtime.shutdown();
      }
    }
    return output;
  }, runtimes);

  expect(results.map(({ id }) => id)).toEqual(runtimes.map(({ id }) => id));
  for (const result of results) {
    expect(result).toMatchObject({
      cancelledOpenCycles: 12,
      invalidStepCode: "INVALID_ARGUMENT",
      invalidOperationCancelled: true,
      invalidOperationCancelledAgain: false,
      recoveredReadKind: "complete",
      closedTable: true,
      closedTableAgain: false,
      closedSource: true,
      closedSourceAgain: false,
    });
    if (result.readStepKind !== "complete") {
      expect(["pending", "progress"]).toContain(result.readStepKind);
      expect(result.readCancelled).toBe(true);
      expect(result.readCancelledAgain).toBe(false);
    } else {
      // An adapter may satisfy a small indexed range synchronously and
      // therefore have no in-flight read handle to cancel.
      expect(result.readStepKind).toBe("complete");
      expect(result.readCancelled).toBeNull();
      expect(result.readCancelledAgain).toBeNull();
    }
  }
});

test("Excel presentation over-budget degrades to null while table data remains readable", async ({
  page,
}) => {
  await page.goto("/target/pages/index.html");
  const result = await page.evaluate(async () => {
    const module = await import("/target/pages/dist/wasm/excel/tabulark_excel.js");
    await module.default();
    const response = await fetch("/test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture returned HTTP ${response.status}`);
    const source = new Uint8Array(await response.arrayBuffer());
    const runtime = new module.WasmRuntime({
      memoryBudgetBytes: 8 * 1024 * 1024,
      maxBatchBytes: 512,
      maxRangeCells: 250_000,
      maxSources: 2,
    });
    const drive = (initial, operationKind) => {
      let step = initial;
      for (let count = 0; count < 256; count += 1) {
        if (step.kind === "complete") {
          if (step.operationKind !== operationKind) throw new Error("operation kind mismatch");
          return step;
        }
        const results = step.actions.map((action) => {
          const end = action.offset + action.length;
          return {
            actionIndex: action.actionIndex,
            offset: action.offset,
            bytes: source.slice(action.offset, end),
            eof: end === source.length,
          };
        });
        step = runtime.continueOperation(step.operationHandle, step.operationRevision, results);
      }
      throw new Error("Excel operation did not converge");
    };
    try {
      const opened = drive(runtime.beginOpen({ format: "xlsx" }, source.length), "open");
      const table = drive(
        runtime.beginOpenTable(opened.sourceHandle, opened.tables[0].id),
        "open-table",
      ).table;
      const presentation = runtime.beginPresentation(table.tableHandle);
      const batch = runtime.beginRead(table.tableHandle, {
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      return {
        presentation: presentation.presentation,
        warning: presentation.warnings?.[0],
        readKind: batch.kind,
        buffers: batch.batch?.buffers?.length,
      };
    } finally {
      runtime.shutdown();
    }
  });

  expect(result).toMatchObject({
    presentation: null,
    warning: {
      kind: "presentation-resource-limit",
      resource: "presentation-output",
    },
    readKind: "complete",
  });
  expect(result.warning.requiredBytes).toBeGreaterThan(result.warning.availableBytes);
  expect(result.buffers).toBeGreaterThan(0);
});
