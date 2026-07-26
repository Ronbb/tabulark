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

test("four real WASM runtimes conform to ABI v2 cancellation and idempotent cleanup", async ({
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
        runtime.continueOperation(0, 0, new Uint8Array(), false);
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
        secondKind: second.kind,
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
      protocolVersion: 3,
      adapterApiVersion: 2,
      batchLayoutVersion: 1,
      firstCancelled: true,
      firstCancelledAgain: false,
      secondCancelled: true,
      illegalHandleCode: "HANDLE_CLOSED",
      zeroBudgetCode: "INVALID_ARGUMENT",
      closedUnknownTable: false,
      closedUnknownSource: false,
    });
    expect(["read-bytes", "open-progress"]).toContain(result.firstKind);
    expect(["read-bytes", "open-progress"]).toContain(result.secondKind);
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

    const drive = (runtime, initial, source) => {
      let step = initial;
      for (let index = 0; index < 1_024; index += 1) {
        if (step.kind === "open-complete" || step.kind === "read-complete") return step;
        if (
          (step.kind !== "read-bytes" && step.kind !== "open-progress")
          || step.action?.kind !== "read-bytes"
        ) {
          throw new Error(`unexpected ${String(step.kind)} operation step`);
        }
        const { offset, length } = step.action;
        const end = offset + length;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || end > source.length) {
          throw new Error(`invalid adapter byte request ${String(offset)}+${String(length)}`);
        }
        step = runtime.continueOperation(
          step.operationHandle,
          offset,
          source.slice(offset, end),
          end === source.length,
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

        // Feed an incorrect offset to a valid operation handle. The failed
        // operation must be consumed so its source/parser reservation cannot
        // survive into the recovery open.
        const invalid = runtime.beginOpen({}, source.length);
        const invalidAction = invalid.action;
        let invalidStepCode = "resolved";
        try {
          runtime.continueOperation(
            invalid.operationHandle,
            invalidAction.offset + 1,
            source.slice(invalidAction.offset, invalidAction.offset + invalidAction.length),
            false,
          );
        } catch (error) {
          invalidStepCode = error?.code ?? error?.name ?? "unknown";
        }
        const invalidOperationStillOpen = runtime.cancelOperation(invalid.operationHandle);

        const opened = drive(runtime, runtime.beginOpen({}, source.length), source);
        const tableDescriptor = opened.tables[0];
        const openedTable = runtime.openTable(opened.sourceHandle, tableDescriptor.id);
        const request = { rowStart: 0, rowCount: 1, columnStart: 0, columnCount: 1 };

        const cancellableRead = runtime.beginRead(openedTable.tableHandle, request);
        const readStepKind = cancellableRead.kind;
        let readCancelled = null;
        let readCancelledAgain = null;
        if (cancellableRead.kind === "read-bytes") {
          readCancelled = runtime.cancelOperation(cancellableRead.operationHandle);
          readCancelledAgain = runtime.cancelOperation(cancellableRead.operationHandle);
        }

        const recoveredRead = drive(
          runtime,
          runtime.beginRead(openedTable.tableHandle, request),
          source,
        );
        const closedTable = runtime.closeTable(openedTable.tableHandle);
        const closedTableAgain = runtime.closeTable(openedTable.tableHandle);
        const closedSource = runtime.closeSource(opened.sourceHandle);
        const closedSourceAgain = runtime.closeSource(opened.sourceHandle);

        output.push({
          id: runtime.adapterId(),
          cancelledOpenCycles,
          invalidStepCode,
          invalidOperationStillOpen,
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
      invalidOperationStillOpen: false,
      recoveredReadKind: "read-complete",
      closedTable: true,
      closedTableAgain: false,
      closedSource: true,
      closedSourceAgain: false,
    });
    if (result.readStepKind === "read-bytes") {
      expect(result.readCancelled).toBe(true);
      expect(result.readCancelledAgain).toBe(false);
    } else {
      // Staged adapters may satisfy a small range synchronously and therefore
      // have no in-flight read handle to cancel.
      expect(result.readStepKind).toBe("read-complete");
      expect(result.readCancelled).toBeNull();
      expect(result.readCancelledAgain).toBeNull();
    }
  }
});
