import { expect, test } from "@playwright/test";

test("opens CSV in a Worker and reads non-adjacent ranges", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const engine = await createEngine({ memoryBudgetBytes: 256 * 1024 * 1024 });
    const source = new Blob([
      "name,score,team\nAda,10,red\nGrace,20,blue\nLinus,30,green\n",
    ]);

    const dataset = await engine.open(source, {
      format: "csv",
      header: "first-row",
      mode: "lenient",
    });
    const table = await dataset.openTable(dataset.tables[0].id);

    try {
      const first = await table.readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 3,
      });
      const last = await table.readRange({
        rowStart: 2,
        rowCount: 1,
        columnStart: 0,
        columnCount: 3,
      });

      return {
        first: first.toRows(),
        last: last.toRows(),
        tableCount: dataset.tables.length,
      };
    } finally {
      await table.close();
      await dataset.close();
      await engine.close();
    }
  });

  expect(result).toEqual({
    first: [["Ada", "10", "red"]],
    last: [["Linus", "30", "green"]],
    tableCount: 1,
  });
});

test("cancels a range read with AbortSignal", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const errorCode = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const engine = await createEngine();
    const dataset = await engine.open(new Blob(["value\n1\n2\n"]), {
      format: "csv",
      header: "first-row",
      mode: "lenient",
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    const controller = new AbortController();
    controller.abort();

    try {
      await table.readRange(
        {
          rowStart: 0,
          rowCount: 1,
          columnStart: 0,
          columnCount: 1,
        },
        { signal: controller.signal },
      );
      return "resolved";
    } catch (error) {
      return error?.code ?? error?.name ?? "unknown";
    } finally {
      await table.close();
      await dataset.close();
      await engine.close();
    }
  });

  expect(errorCode).toBe("CANCELLED");
});

test("cancels a large source open without consuming a Worker source slot", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const engine = await createEngine();
    const abort = new AbortController();
    const largeSource = new Blob(["value\n", "0123456789abcdef\n".repeat(1_000_000)]);
    const opening = engine.open(largeSource, {
      format: "csv",
      header: "first-row",
      signal: abort.signal,
    });
    abort.abort();

    let errorCode;
    try {
      await opening;
      errorCode = "resolved";
    } catch (error) {
      errorCode = error?.code ?? error?.name ?? "unknown";
    }

    const datasets = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        datasets.push(await engine.open(new Blob([`value\n${index}\n`]), {
          format: "csv",
          header: "first-row",
        }));
      }
      return { errorCode, reopened: datasets.length };
    } finally {
      for (const dataset of datasets.reverse()) {
        await dataset.close();
      }
      await engine.close();
    }
  });

  expect(result).toEqual({ errorCode: "CANCELLED", reopened: 2 });
});

test("propagates an unexpected Worker error to live table handles", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const NativeWorker = globalThis.Worker;
    let worker;
    class CapturingWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        worker = this;
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: CapturingWorker,
    });

    let engine;
    let controller;
    try {
      const { createEngine, createTableController } = await import("/dist/index.js");
      engine = await createEngine();
      const dataset = await engine.open(new Blob(["value\na\n"]), { format: "csv" });
      const table = await dataset.openTable(dataset.tables[0].id);
      const events = [];
      table.subscribe((event) => events.push(event.type));
      controller = createTableController(table);

      worker.dispatchEvent(new ErrorEvent("error", { message: "synthetic Worker failure" }));

      let nextReadCode;
      try {
        await table.readRange({
          rowStart: 0,
          rowCount: 1,
          columnStart: 0,
          columnCount: 1,
        });
        nextReadCode = "resolved";
      } catch (error) {
        nextReadCode = error?.code ?? error?.name ?? "unknown";
      }
      return {
        events,
        controllerStatus: controller.getSnapshot().status,
        nextReadCode,
      };
    } finally {
      controller?.dispose();
      await engine?.close();
      if (originalWorker) {
        Object.defineProperty(globalThis, "Worker", originalWorker);
      } else {
        delete globalThis.Worker;
      }
    }
  });

  expect(result).toEqual({
    events: ["runtimeError", "closed"],
    controllerStatus: "error",
    nextReadCode: "HANDLE_CLOSED",
  });
});

test("closing a table keeps its dataset reusable", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const engine = await createEngine();
    const dataset = await engine.open(new Blob(["value\nfirst\nsecond\n"]), {
      format: "csv",
      header: "first-row",
      mode: "lenient",
    });

    try {
      const first = await dataset.openTable(dataset.tables[0].id);
      await first.close();

      const reopened = await dataset.openTable(dataset.tables[0].id);
      try {
        const batch = await reopened.readRange({
          rowStart: 1,
          rowCount: 1,
          columnStart: 0,
          columnCount: 1,
        });
        return { rows: batch.toRows(), reopened: true };
      } finally {
        await reopened.close();
      }
    } finally {
      await dataset.close();
      await engine.close();
    }
  });

  expect(result).toEqual({ rows: [["second"]], reopened: true });
});

test("reads a range discovered after the first 1 MiB scan chunk", async ({ page }) => {
  await page.goto("/test/browser/harness.html");

  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const row = "0123456789abcdefghij\n";
    const engine = await createEngine();
    const dataset = await engine.open(new Blob(["value\n", row.repeat(100_000)]), {
      format: "csv",
      header: "first-row",
      mode: "lenient",
    });
    const table = await dataset.openTable(dataset.tables[0].id);

    try {
      const batch = await table.readRange({
        rowStart: 90_000,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
      return {
        rows: batch.toRows(),
        rowExtent: table.metadata.extent.rows,
      };
    } finally {
      await table.close();
      await dataset.close();
      await engine.close();
    }
  });

  expect(result.rows).toEqual([["0123456789abcdefghij"]]);
  expect(result.rowExtent.value).toBeGreaterThanOrEqual(90_001);
});
