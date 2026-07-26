import { expect, test } from "@playwright/test";

const localPages = "/target/pages/index.html";

test.setTimeout(120_000);

test("playground auto-selects XLSX adapter when an uploaded file has no manual format choice", async (
  { page },
  testInfo,
) => {
  const requestScope = await beginRequestLedger(page, testInfo, "xlsx-auto");
  await page.goto(localPages);
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");

  // The playground starts on CSV. Uploading an OOXML workbook must update the
  // format control from the file metadata before Open preview is pressed;
  // this is the path users take when they simply choose a local .xlsx file.
  await expect(page.getByTestId("format")).toHaveValue("csv");
  const bytes = await page.evaluate(async () => {
    const response = await fetch("test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    return [...new Uint8Array(await response.arrayBuffer())];
  });
  await page.getByTestId("source-input").setInputFiles({
    name: "模版 权限视图参考V1.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(bytes),
  });

  await expect(page.getByTestId("format")).toHaveValue("xlsx");
  await expect(page.getByTestId("file-summary")).toContainText("XLSX");
  await expect(page.getByTestId("file-summary")).toContainText("2 GiB local-file mode");
  await page.getByTestId("open-button").click();
  await expectReady(page, "4 rows are ready");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toContainText("城市数据");
  await expect(grid).toContainText("上海");
  // Explicit large-mode OOXML is served by the bounded Rust range runtime.
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 0, arrow: 0, parquet: 0, excel: 1,
  });
});

test("all five supported local formats use only their requested lazy adapter artifacts", async (
  { page },
  testInfo,
) => {
  const requestScope = await beginRequestLedger(page, testInfo, "all-formats");
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(localPages);
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 0, arrow: 0, parquet: 0, excel: 0,
  });

  await page.getByTestId("sample-button").click();
  await expectReady(page, "2,000 rows are ready");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 0, parquet: 0, excel: 0,
  });

  await page.getByTestId("arrow-sample-button").click();
  await expectReady(page, "4 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("你好，Arrow");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 1, parquet: 0, excel: 0,
  });

  await openFixture(page, "parquet", "tabulark-rust.parquet", "application/vnd.apache.parquet");
  await expectReady(page, "4 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("上海");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("São Paulo");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 1, parquet: 1, excel: 0,
  });

  await openFixture(page, "xls", "tabulark-biff8.xls", "application/vnd.ms-excel");
  await expectReady(page, "1 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("BIFF8 smoke");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 1, parquet: 1, excel: 1,
  });

  await openFixture(
    page,
    "xlsx",
    "tabulark-ooxml.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  await expectReady(page, "4 rows are ready");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toContainText("城市数据");
  await expect(grid).toContainText("上海");
  await expect(grid).toContainText("3");
  const mergedAnchor = grid.locator('[role="gridcell"][aria-colspan="2"]');
  await expect(mergedAnchor).toHaveCount(1);
  await expect(mergedAnchor).toContainText("城市数据");
  const view = page.locator("[data-tabulark-view]");
  await expect(view).toHaveAttribute("data-tabulark-presentation", "spreadsheet-v1");
  await expect(view).toHaveAttribute("data-tabulark-worksheet-visibility", "visible");
  await expect(view).toHaveAttribute("data-tabulark-frozen-rows", "1");
  await expect(view).toHaveAttribute("data-tabulark-frozen-columns", "1");
  // XLS and XLSX share one official lazy runtime and therefore do not fetch it twice.
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 1, parquet: 1, excel: 1,
  });

  await openFixture(
    page,
    "xlsx",
    "xlsxwriter-merge-range01.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  await expectReady(page, "2 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("Foo");
  expectRequests(await scopedRequests(page, requestScope), {
    delimited: 1, arrow: 1, parquet: 1, excel: 1,
  });
  expect(errors).toEqual([]);
});

test("real XLSX tables preserve workbook order, visibility, isolation, and cascading close", async ({
  page,
}) => {
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const response = await fetch("/test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    const engine = await createEngine({
      adapters: [excelAdapter],
      memoryBudgetBytes: 64 * 1024 * 1024,
    });
    const dataset = await engine.open(new Blob([await response.arrayBuffer()]), {
      adapter: excelAdapter,
      // Detection must come from the bytes, never this intentionally wrong suffix.
      adapterOptions: { format: "auto", sourceName: "misleading.csv" },
    });
    const tables = [...dataset.tables];
    const opened = await Promise.all(tables.map(({ id }) => dataset.openTable(id)));
    const presentations = await Promise.all(opened.map((table) => table.getPresentation()));
    const hiddenBatch = await opened[1].readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    });

    await opened[0].close();
    await opened[0].close();
    const stillOpen = (await opened[2].readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    })).toDisplayRows();

    await dataset.close();
    await dataset.close();
    let cascadedCode;
    try {
      await opened[1].readRange({
        rowStart: 0,
        rowCount: 1,
        columnStart: 0,
        columnCount: 1,
      });
    } catch (error) {
      cascadedCode = error?.code;
    }
    await engine.close();
    await engine.close();
    return {
      cascadedCode,
      capabilities: opened.map(({ metadata }) => metadata.capabilities),
      hiddenRows: hiddenBatch.toDisplayRows(),
      presentations,
      stillOpen,
      tables,
    };
  });

  expect(result.tables).toEqual([
    { id: "sheet-0", name: "Visible" },
    { id: "sheet-1", name: "Hidden" },
    { id: "sheet-2", name: "VeryHidden" },
  ]);
  expect(result.presentations.map(({ visibility }) => visibility)).toEqual([
    "visible",
    "hidden",
    "very-hidden",
  ]);
  expect(result.hiddenRows).toEqual([["Hidden"]]);
  expect(result.stillOpen).toEqual([["Very hidden"]]);
  expect(result.capabilities.every(({ typedValues, multiTable }) => (
    typedValues === false && multiTable === true
  ))).toBe(true);
  expect(result.cascadedCode).toBe("HANDLE_CLOSED");
});

async function openFixture(page, format, name, mimeType) {
  const path = format === "parquet"
    ? `test/fixtures/parquet/v1/${name}`
    : `test/fixtures/excel/v1/${name}`;
  const bytes = await page.evaluate(async (relativePath) => {
    const response = await fetch(relativePath);
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    return [...new Uint8Array(await response.arrayBuffer())];
  }, path);
  await page.getByTestId("format").selectOption(format);
  await page.getByTestId("source-input").setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(bytes),
  });
  await page.getByTestId("open-button").click();
}

async function expectReady(page, message) {
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("status")).toContainText(message);
  await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute("aria-busy", "false");
}

function expectRequests(requests, expected) {
  // Firefox may satisfy the generated JS binding from its module map without
  // issuing another scoped HTTP request. The .wasm fetch is the stable,
  // cross-engine proof that a runtime family was actually instantiated.
  for (const [adapter, count] of Object.entries(expected)) {
    expect(requests.filter((url) => (
      url.includes(`/wasm/${adapter}/tabulark_${adapter}_bg.wasm`)
    ))).toHaveLength(count);
  }
}

function isOfficialAdapterArtifact(url) {
  return /\/wasm\/(?:delimited|arrow|parquet|excel)\/tabulark_(?:delimited|arrow|parquet|excel)(?:\.js|_bg\.wasm)(?:[?#]|$)/u.test(url);
}

async function beginRequestLedger(page, testInfo, label) {
  const scope = [
    label,
    testInfo.project.name,
    testInfo.workerIndex,
    testInfo.retry,
    Date.now(),
  ].join("-");
  await page.context().setExtraHTTPHeaders({ "x-tabulark-test-scope": scope });
  const response = await page.request.delete(
    `/__tabulark-test/requests?scope=${encodeURIComponent(scope)}`,
  );
  expect(response.ok()).toBe(true);
  return scope;
}

async function scopedRequests(page, scope) {
  const response = await page.request.get(
    `/__tabulark-test/requests?scope=${encodeURIComponent(scope)}`,
  );
  expect(response.ok()).toBe(true);
  const entries = await response.json();
  return entries
    .map(({ path }) => new URL(path, "http://tabulark.test").href)
    .filter(isOfficialAdapterArtifact);
}
