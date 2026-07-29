import { expect, test } from "@playwright/test";

const fixturePath = process.env.TABULARK_LOCAL_PARQUET_FIXTURE;

test.skip(
  fixturePath === undefined,
  "TABULARK_LOCAL_PARQUET_FIXTURE supplies the optional large Parquet regression fixture.",
);
test.setTimeout(10 * 60 * 1_000);

test("large Parquet remains renderable across repeated Playground scrolling", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "The local regression fixture is exercised once.");
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/target/pages/index.html#playground");
  await page.getByTestId("source-input").setInputFiles(fixturePath);
  await expect(page.getByTestId("format")).toHaveValue("parquet");
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 3 * 60 * 1_000,
  });

  const view = page.locator("[data-tabulark-view]");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  const loadingCells = grid.getByRole("gridcell", { name: "Loading", exact: true });
  const scroller = view.locator("[data-tabulark-scroll]");
  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 2 * 60 * 1_000 });
  await expect(loadingCells).toHaveCount(0, { timeout: 2 * 60 * 1_000 });

  for (const fraction of [0.08, 0.22, 0.4, 0.58, 0.76, 0.92, 0.5, 0.12, 0]) {
    await scroller.evaluate((element, nextFraction) => {
      element.scrollTop = Math.floor(
        (element.scrollHeight - element.clientHeight) * nextFraction,
      );
      element.dispatchEvent(new Event("scroll"));
    }, fraction);
    // Let the view consume the scroll event before observing its loading state.
    await page.waitForTimeout(50);
    await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 2 * 60 * 1_000 });
    await expect(loadingCells).toHaveCount(0, { timeout: 2 * 60 * 1_000 });
    await expect(view.locator("[data-tabulark-message]")).not.toContainText(
      "Unable to render table",
    );
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready");
  }

  expect(browserErrors).toEqual([]);
});

test("Canvas display-only reads avoid typed Parquet failures under a 512 MiB shared budget", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "The local regression fixture is exercised once.");
  await page.goto("/test/browser/harness.html");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "local-parquet-fixture";
    input.type = "file";
    document.body.append(input);
  });
  await page.locator("#local-parquet-fixture").setInputFiles(fixturePath);

  const metadata = await page.evaluate(async () => {
    const {
      createCanvasTableView,
      createEngine,
      delimitedAdapter,
    } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const { parquetAdapter } = await import("/dist/parquet.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const input = document.querySelector("#local-parquet-fixture");
    const source = input.files?.[0];
    if (!source) throw new Error("local Parquet fixture was not attached");

    const engine = await createEngine({
      adapters: [delimitedAdapter, arrowIpcAdapter, parquetAdapter, excelAdapter],
      memoryBudgetBytes: 512 * 1024 * 1024,
    });
    const dataset = await engine.open(source, {
      adapter: parquetAdapter,
      sourceMode: "large",
      adapterOptions: { sourceName: source.name },
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    let adaptiveLimitCount = 0;
    let displayOnlyReadCount = 0;
    const readRange = table.readRange.bind(table);
    const observedTable = new Proxy(table, {
      get(target, property) {
        if (property === "readRange") {
          return async (...args) => {
            if (
              args[1]?.[Symbol.for("tabulark.internal.display-only-read.v1")] === true
            ) {
              displayOnlyReadCount += 1;
            }
            try {
              return await readRange(...args);
            } catch (error) {
              if (
                error?.code === "RESOURCE_LIMIT"
                && [
                  "typed-batch-output",
                  "typed-batch-decoded",
                  "compressed-pages",
                  "decompressed-pages",
                  "parquet-operation",
                ].includes(error?.details?.resource)
              ) {
                adaptiveLimitCount += 1;
              }
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    document.body.replaceChildren();
    document.body.style.margin = "0";
    const container = document.createElement("div");
    container.style.width = "900px";
    container.style.height = "560px";
    document.body.append(container);
    const viewErrors = [];
    const view = createCanvasTableView({
      container,
      table: observedTable,
      onError(error) {
        viewErrors.push({
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    window.__localParquetRegression = {
      dataset,
      engine,
      table,
      view,
      stats: () => ({
        adaptiveLimitCount,
        displayOnlyReadCount,
        viewErrors,
      }),
    };
    return table.metadata;
  });
  expect(metadata.extent.rows).toEqual({ kind: "exact", value: 1_854 });

  const view = page.locator("[data-tabulark-view]");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  const loadingCells = grid.getByRole("gridcell", { name: "Loading", exact: true });
  const scroller = view.locator("[data-tabulark-scroll]");
  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 2 * 60 * 1_000 });
  await expect(loadingCells).toHaveCount(0, { timeout: 2 * 60 * 1_000 });
  for (const fraction of [0.025, 0.1, 0.24, 0.42, 0.61, 0.8, 0.96, 0.33, 0]) {
    await scroller.evaluate((element, nextFraction) => {
      element.scrollTop = Math.floor(
        (element.scrollHeight - element.clientHeight) * nextFraction,
      );
      element.dispatchEvent(new Event("scroll"));
    }, fraction);
    await page.waitForTimeout(50);
    await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 2 * 60 * 1_000 });
    await expect(loadingCells).toHaveCount(0, { timeout: 2 * 60 * 1_000 });
    await expect(view.locator("[data-tabulark-message]")).not.toContainText(
      "Unable to render table",
    );
  }

  const stats = await page.evaluate(async () => {
    const regression = window.__localParquetRegression;
    const result = regression.stats();
    regression.view.dispose();
    await regression.table.close();
    await regression.dataset.close();
    await regression.engine.close();
    delete window.__localParquetRegression;
    return result;
  });
  expect(stats.displayOnlyReadCount).toBeGreaterThan(0);
  expect(stats.adaptiveLimitCount).toBe(0);
  expect(stats.viewErrors).toEqual([]);
});
