import { expect, test } from "@playwright/test";

test.skip(
  !process.env.TABULARK_DEPLOYED_BASE_URL,
  "This smoke runs only after the GitHub Pages deployment step.",
);

test("deployed Pages opens CSV, TSV, and Arrow, switches, copies, and stays console-clean", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
    if (request.url().includes("_bg.wasm")) wasmRequests.push(request.url());
  });

  await page.goto("./");
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  expect(wasmRequests).toEqual([]);

  await page.getByTestId("sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("status")).toContainText("2,000 rows are ready");
  expect(wasmRequests.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(wasmRequests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(0);

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
  expect(wasmRequests.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(wasmRequests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(0);

  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("status")).toContainText("4 rows are ready");

  grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect(grid).toContainText("你好，Arrow");
  await expect(page.locator("[data-tabulark-view]")).toHaveCount(1);
  expect(wasmRequests.filter((url) => url.includes("tabulark_delimited_bg.wasm"))).toHaveLength(1);
  expect(wasmRequests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(1);
  await grid.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+C");
  await expect.poll(async () => navigatorText(page)).toContain("\t");

  // Reopen the Arrow source in a fresh dataset session. The adapter runtime
  // and WASM module must be reused instead of fetched or instantiated again.
  await page.getByTestId("arrow-sample-button").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("status")).toContainText("4 rows are ready");
  grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toHaveAttribute("aria-busy", "false");
  await expect(grid).toContainText("你好，Arrow");
  expect(wasmRequests.filter((url) => url.includes("tabulark_arrow_bg.wasm"))).toHaveLength(1);

  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

async function navigatorText(page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
}
