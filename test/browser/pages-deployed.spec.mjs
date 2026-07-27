import { expect, test } from "@playwright/test";

import { installClipboardContract, readClipboardText } from "./clipboard.mjs";

test.skip(
  !process.env.TABULARK_DEPLOYED_BASE_URL,
  "This smoke runs only after the GitHub Pages deployment step.",
);

// The deployed Pages smoke cold-loads every official WebAssembly adapter. Keep
// this bounded, while allowing an uncached global CDN edge enough time for the
// Parquet and Excel binaries in slower WebKit environments.
test.setTimeout(240_000);

test("deployed Pages opens all supported local formats and stays console-clean", async ({
  browserName,
  context,
  page,
}) => {
  await installClipboardContract({ browserName, context, page });
  const browserErrors = [];
  const failedRequests = [];
  const wasmRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("request", (request) => {
    if (isOfficialAdapterArtifact(request.url())) wasmRequests.push(request.url());
  });

  await page.goto("./");
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  expect(wasmRequests).toEqual([]);

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("status")).toContainText("2,000 rows are ready");
  expectAdapterRequests(wasmRequests, "delimited", 1);
  expectAdapterRequests(wasmRequests, "arrow", 0);
  expectAdapterRequests(wasmRequests, "parquet", 0);
  expectAdapterRequests(wasmRequests, "excel", 0);

  await page.getByTestId("format").selectOption("tsv");
  await page.getByTestId("source-input").setInputFiles({
    name: "deployed-smoke.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("name\tnote\nAda\t部署 smoke\n", "utf8"),
  });
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("status")).toContainText("1 rows are ready");
  let grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toContainText("部署 smoke");
  await grid.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+C");
  await expect.poll(async () => navigatorText(page)).toBe("Ada\t部署 smoke");
  expectAdapterRequests(wasmRequests, "delimited", 1);
  expectAdapterRequests(wasmRequests, "arrow", 0);

  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("status")).toContainText("4 rows are ready");

  grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect(grid).toContainText("你好，Arrow");
  await expect(page.locator("[data-tabulark-view]")).toHaveCount(1);
  expectAdapterRequests(wasmRequests, "delimited", 1);
  expectAdapterRequests(wasmRequests, "arrow", 1);
  await grid.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+C");
  await expect.poll(async () => navigatorText(page)).toContain("\t");

  // Reopen the Arrow source in a fresh dataset session. The adapter runtime
  // and WASM module must be reused instead of fetched or instantiated again.
  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("status")).toContainText("4 rows are ready");
  grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect(grid).toContainText("你好，Arrow");
  expectAdapterRequests(wasmRequests, "arrow", 1);

  await openDeployedFixture(
    page,
    "parquet",
    "test/fixtures/parquet/v1/tabulark-rust.parquet",
    "application/vnd.apache.parquet",
  );
  await expectReady(page, "4 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("São Paulo");
  expectAdapterRequests(wasmRequests, "parquet", 1);
  expectAdapterRequests(wasmRequests, "excel", 0);

  await openDeployedFixture(
    page,
    "xls",
    "test/fixtures/excel/v1/tabulark-biff8.xls",
    "application/vnd.ms-excel",
  );
  await expectReady(page, "1 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("BIFF8 smoke");
  expectAdapterRequests(wasmRequests, "excel", 1);

  await openDeployedFixture(
    page,
    "xlsx",
    "test/fixtures/excel/v1/tabulark-ooxml.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  await expectReady(page, "4 rows are ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toContainText("城市数据");
  expectAdapterRequests(wasmRequests, "excel", 1);

  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

async function navigatorText(page) {
  return readClipboardText(page);
}

function expectAdapterRequests(requests, adapter, count) {
  expect(requests.filter((url) => (
    url.includes(`/wasm/${adapter}/tabulark_${adapter}_bg.wasm`)
  ))).toHaveLength(count);
}

function isOfficialAdapterArtifact(url) {
  return /\/wasm\/(?:delimited|arrow|parquet|excel)\/tabulark_(?:delimited|arrow|parquet|excel)_bg\.wasm(?:[?#]|$)/u.test(url);
}

async function openDeployedFixture(page, format, path, mimeType) {
  const bytes = await page.evaluate(async (relativePath) => {
    const response = await fetch(relativePath);
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    return [...new Uint8Array(await response.arrayBuffer())];
  }, path);
  await page.getByTestId("format").selectOption(format);
  await page.getByTestId("source-input").setInputFiles({
    name: path.split("/").at(-1),
    mimeType,
    buffer: Buffer.from(bytes),
  });
  await page.getByTestId("open-button").click();
}

async function expectReady(page, message) {
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("status")).toContainText(message);
  await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute("aria-busy", "false");
}
