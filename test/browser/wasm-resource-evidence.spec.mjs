import { expect, test } from "@playwright/test";

const runtimes = [
  {
    id: "tabulark:delimited",
    module: "/target/pages/dist/wasm/delimited/tabulark_delimited.js",
    inlineSource: "name,score\nAda,10\nGrace,20\n",
  },
  {
    id: "tabulark:arrow-ipc",
    module: "/target/pages/dist/wasm/arrow/tabulark_arrow.js",
    fixture: "/test/fixtures/arrow/v1/m4-sample.arrow",
  },
  {
    id: "tabulark:parquet",
    module: "/target/pages/dist/wasm/parquet/tabulark_parquet.js",
    fixture: "/test/fixtures/parquet/v1/tabulark-rust.parquet",
  },
  {
    id: "tabulark:excel",
    module: "/target/pages/dist/wasm/excel/tabulark_excel.js",
    fixture: "/test/fixtures/excel/v1/tabulark-ooxml.xlsx",
  },
];

test.setTimeout(180_000);

test("official WASM runtimes release 100 identical lifecycles without memory growth", async ({
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
        const actionResults = step.actions.map((action) => {
          const end = action.offset + action.length;
          if (
            action.kind !== "read-bytes"
            || !Number.isSafeInteger(action.actionIndex)
            || !Number.isSafeInteger(action.offset)
            || !Number.isSafeInteger(action.length)
            || action.offset < 0
            || action.length < 0
            || !Number.isSafeInteger(end)
            || end > source.length
          ) {
            throw new Error(`invalid adapter byte request ${String(action.offset)}+${String(action.length)}`);
          }
          return {
            actionIndex: action.actionIndex,
            offset: action.offset,
            bytes: source.slice(action.offset, end),
            eof: end === source.length,
          };
        });
        step = runtime.continueOperation(
          step.operationHandle,
          step.operationRevision,
          actionResults,
        );
      }
      throw new Error(`${operationKind} exceeded the conformance step limit`);
    };

    const output = [];
    for (const descriptor of descriptors) {
      const module = await import(descriptor.module);
      await module.default();
      const source = await loadSource(descriptor);
      const runtime = new module.WasmRuntime(config);
      let cycleTenHighWaterPages;
      let finalSnapshot;
      try {
        for (let cycle = 1; cycle <= 100; cycle += 1) {
          const opened = drive(runtime, runtime.beginOpen({}, source.length), source, "open");
          const openedTable = drive(
            runtime,
            runtime.beginOpenTable(opened.sourceHandle, opened.tables[0].id),
            source,
            "open-table",
          ).table;
          drive(
            runtime,
            runtime.beginRead(openedTable.tableHandle, {
              rowStart: 0,
              rowCount: 1,
              columnStart: 0,
              columnCount: 1,
            }),
            source,
            "read",
          );

          // Every beginOpen is progressive for the official runtimes, which
          // gives all four formats the same deterministic cancellation seam.
          const cancellable = runtime.beginOpen({}, source.length);
          if (runtime.cancelOperation(cancellable.operationHandle) !== true) {
            throw new Error(`${descriptor.id} cycle ${cycle} did not cancel its operation`);
          }
          if (runtime.cancelOperation(cancellable.operationHandle) !== false) {
            throw new Error(`${descriptor.id} cycle ${cycle} cancelled the same operation twice`);
          }
          if (!runtime.closeTable(openedTable.tableHandle)) {
            throw new Error(`${descriptor.id} cycle ${cycle} did not close its table`);
          }
          if (!runtime.closeSource(opened.sourceHandle)) {
            throw new Error(`${descriptor.id} cycle ${cycle} did not close its source`);
          }

          const snapshot = runtime.resourceSnapshot();
          if (snapshot.runtimeOwnedBytes !== 0) {
            throw new Error(
              `${descriptor.id} cycle ${cycle} retained ${snapshot.runtimeOwnedBytes} runtime-owned bytes`,
            );
          }
          if (cycle === 10) {
            cycleTenHighWaterPages = snapshot.wasmMemoryHighWaterPages;
          } else if (
            cycle > 10
            && snapshot.wasmMemoryHighWaterPages !== cycleTenHighWaterPages
          ) {
            throw new Error(
              `${descriptor.id} WASM memory grew after cycle 10: `
              + `${cycleTenHighWaterPages} -> ${snapshot.wasmMemoryHighWaterPages} pages at cycle ${cycle}`,
            );
          }
          finalSnapshot = snapshot;
        }

        output.push({
          id: runtime.adapterId(),
          cycles: 100,
          cycleTenHighWaterPages,
          finalRuntimeOwnedBytes: finalSnapshot.runtimeOwnedBytes,
          finalHighWaterPages: finalSnapshot.wasmMemoryHighWaterPages,
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
      cycles: 100,
      finalRuntimeOwnedBytes: 0,
    });
    expect(result.cycleTenHighWaterPages).toBeGreaterThan(0);
    expect(result.finalHighWaterPages).toBe(result.cycleTenHighWaterPages);
  }
});
