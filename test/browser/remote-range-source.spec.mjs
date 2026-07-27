import { expect, test } from "@playwright/test";

import { startTestServer, stopTestServer } from "./server.mjs";

let fixtureServer;
let fixtureBaseURL;

test.setTimeout(180_000);

test.beforeAll(async () => {
  fixtureServer = await startTestServer({ host: "127.0.0.1", port: 0 });
  const address = fixtureServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("remote RangeSource fixture server did not expose a TCP port");
  }
  fixtureBaseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (fixtureServer !== undefined) await stopTestServer(fixtureServer);
});

test("fixture server implements single byte ranges and unsatisfied responses", async ({
  request,
}) => {
  const fixture = `${fixtureBaseURL}/test/fixtures/csv/v1/rfc-quotes.csv`;
  const partial = await request.get(fixture, { headers: { Range: "bytes=1-3" } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["accept-ranges"]).toBe("bytes");
  expect(partial.headers()["content-range"]).toBe("bytes 1-3/69");
  expect(partial.headers().etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/u);
  expect(await partial.body()).toEqual(Buffer.from("ame"));

  const suffix = await request.get(fixture, { headers: { Range: "bytes=-5" } });
  expect(suffix.status()).toBe(206);
  expect(suffix.headers()["content-range"]).toBe("bytes 64-68/69");
  expect((await suffix.body()).byteLength).toBe(5);

  const unsatisfied = await request.get(fixture, { headers: { Range: "bytes=69-70" } });
  expect(unsatisfied.status()).toBe(416);
  expect(unsatisfied.headers()["content-range"]).toBe("bytes */69");
  expect((await unsatisfied.body()).byteLength).toBe(0);
});

test("httpRangeSource reads every stable format through the real Worker and WASM", async ({
  page,
}) => {
  const cleared = await page.request.delete(
    `${fixtureBaseURL}/__tabulark-test/requests`,
  );
  expect(cleared.ok()).toBe(true);
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate(async ({ fixtureOrigin }) => {
    const { createEngine, delimitedAdapter } = await import("/dist/index.js");
    const { arrowIpcAdapter } = await import("/dist/arrow.js");
    const { parquetAdapter } = await import("/dist/parquet.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const { httpRangeSource } = await import("/dist/http.js");

    const cases = [
      {
        id: "csv",
        path: "/test/fixtures/csv/v1/rfc-quotes.csv",
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
      },
      {
        id: "tsv",
        path: "/test/fixtures/csv/v1/cjk-mixed.tsv",
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "tsv", header: "first-row", mode: "strict" },
      },
      {
        id: "same-origin-csv",
        path: "/test/fixtures/csv/v1/rfc-quotes.csv",
        sameOrigin: true,
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
      },
      {
        id: "redirect-csv",
        path: "/__tabulark-test/redirect?path=%2Ftest%2Ffixtures%2Fcsv%2Fv1%2Frfc-quotes.csv",
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
      },
      {
        id: "arrow-file",
        path: "/test/fixtures/arrow/v1/m4-sample.arrow",
        adapter: arrowIpcAdapter,
        adapterOptions: { container: "file" },
      },
      {
        id: "arrow-stream",
        path: "/test/performance/fixtures/arrow/m4-stream-none.arrows",
        adapter: arrowIpcAdapter,
        adapterOptions: { container: "stream" },
      },
      {
        id: "parquet",
        path: "/test/fixtures/parquet/v1/tabulark-rust.parquet",
        adapter: parquetAdapter,
        adapterOptions: {},
      },
      {
        id: "xlsx",
        path: "/test/fixtures/excel/v1/tabulark-ooxml.xlsx",
        adapter: excelAdapter,
        adapterOptions: { format: "xlsx" },
      },
      {
        id: "xls",
        path: "/test/fixtures/excel/v1/tabulark-biff8.xls",
        adapter: excelAdapter,
        adapterOptions: { format: "xls" },
      },
    ];
    const engine = await createEngine({
      adapters: [delimitedAdapter, arrowIpcAdapter, parquetAdapter, excelAdapter],
      memoryBudgetBytes: 64 * 1024 * 1024,
    });
    const samples = [];
    const unsubscribe = engine.subscribePerformance((sample) => samples.push(sample));
    const formats = {};

    try {
      for (const fixture of cases) {
        let dataset;
        let table;
        try {
          const source = httpRangeSource(
            fixture.sameOrigin ? fixture.path : `${fixtureOrigin}${fixture.path}`,
            {
              maxAttempts: 1,
              validation: "etag",
            },
          );
          dataset = await engine.open(source, {
            adapter: fixture.adapter,
            adapterOptions: fixture.adapterOptions,
          });
          table = await dataset.openTable(dataset.tables[0].id);
          const columnCount = table.metadata.schema.columns.length;
          const batch = await table.readRange({
            rowStart: 0,
            rowCount: 4,
            columnStart: 0,
            columnCount,
          });
          formats[fixture.id] = {
            rows: batch.toDisplayRows().flat(),
            tableCount: dataset.tables.length,
          };
        } finally {
          await table?.close();
          await dataset?.close();
        }
      }
    } finally {
      unsubscribe();
      await engine.close();
    }
    return {
      formats,
      sourceReads: samples.reduce((total, sample) => total + sample.sourceReads, 0),
    };
  }, { fixtureOrigin: fixtureBaseURL });

  expect(result.formats.csv.rows).toContain("Alice");
  expect(result.formats.tsv.rows).toContain("上海（浦东）");
  expect(result.formats["same-origin-csv"].rows).toContain("Alice");
  expect(result.formats["redirect-csv"].rows).toContain("Alice");
  expect(result.formats["arrow-file"].rows).toContain("你好，Arrow");
  expect(result.formats["arrow-stream"].rows).toContain("你好，Arrow");
  expect(result.formats.parquet.rows).toContain("上海");
  expect(result.formats.xlsx.rows).toContain("城市数据");
  expect(result.formats.xls.rows).toContain("BIFF8 smoke");
  expect(Object.values(result.formats).every(({ tableCount }) => tableCount > 0)).toBe(true);
  expect(result.sourceReads).toBeGreaterThan(0);

  const ledger = await (await page.request.get(
    `${fixtureBaseURL}/__tabulark-test/requests`,
  )).json();
  const sourceRequests = ledger.filter(({ path }) => path.startsWith("/test/"));
  expect(new Set(sourceRequests.map(({ path }) => path))).toEqual(new Set([
    "/test/fixtures/csv/v1/rfc-quotes.csv",
    "/test/fixtures/csv/v1/cjk-mixed.tsv",
    "/test/fixtures/arrow/v1/m4-sample.arrow",
    "/test/performance/fixtures/arrow/m4-stream-none.arrows",
    "/test/fixtures/parquet/v1/tabulark-rust.parquet",
    "/test/fixtures/excel/v1/tabulark-ooxml.xlsx",
    "/test/fixtures/excel/v1/tabulark-biff8.xls",
  ]));
  expect(sourceRequests.length).toBeGreaterThan(7);
  expect(sourceRequests.every(({ method, range }) => (
    method === "GET" && /^bytes=[0-9]+-[0-9]+$/u.test(range ?? "")
  ))).toBe(true);
});
