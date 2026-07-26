#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startTestServer, stopTestServer } from "../browser/server.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const output = resolve(repositoryRoot, "target", "bench", "performance-format-adapters.json");
const formatBudgets = await loadFormatBudgets();

const scenarios = await loadScenarios();
const server = await startTestServer({ crossOriginIsolated: true, port: 0 });
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("format performance server did not expose a TCP port");
}
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: [
    "--enable-precise-memory-info",
    "--enable-blink-features=ForceEagerMeasureMemory",
    "--js-flags=--expose-gc",
  ],
});

try {
  const samples = [];
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      locale: "en-US",
      reducedMotion: "reduce",
      viewport: { width: 1024, height: 640 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/test/performance/harness.html`, {
      waitUntil: "load",
    });
    await page.locator("#source").setInputFiles(scenario.path);
    const sample = await page.evaluate(async (input) => {
      const root = await import("/dist/index.js");
      const adapterModule = input.adapter === "parquet"
        ? await import("/dist/parquet.js")
        : await import("/dist/excel.js");
      const adapter = input.adapter === "parquet"
        ? adapterModule.parquetAdapter
        : adapterModule.excelAdapter;
      const source = document.querySelector("#source")?.files?.[0];
      if (!(source instanceof File)) throw new Error("format performance source is missing");
      if (!crossOriginIsolated) throw new Error("format performance requires COOP/COEP isolation");
      if (typeof performance.measureUserAgentSpecificMemory !== "function") {
        throw new Error("measureUserAgentSpecificMemory is unavailable in Chromium");
      }
      if (typeof globalThis.gc !== "function") {
        throw new Error("forced garbage collection is unavailable in Chromium");
      }

      const memory = [];
      const measure = async (phase) => {
        globalThis.gc();
        const result = await performance.measureUserAgentSpecificMemory();
        if (!Number.isFinite(result.bytes) || result.bytes <= 0) {
          throw new Error(`invalid memory sample for ${phase}`);
        }
        memory.push({ phase, bytes: result.bytes });
      };

      let engine;
      let dataset;
      let table;
      try {
        await measure("idle");
        const engineStart = performance.now();
        engine = await root.createEngine({
          adapters: [adapter],
          memoryBudgetBytes: input.memoryBudgetBytes,
        });
        const engineStartupMs = performance.now() - engineStart;

        const openStart = performance.now();
        dataset = await engine.open(source, {
          adapter,
          adapterOptions: input.adapter === "excel"
            ? { format: input.excelFormat, sourceName: source.name }
            : { sourceName: source.name },
        });
        const adapterColdOpenMs = performance.now() - openStart;
        if (dataset.tables.length !== input.expectedTables) {
          throw new Error(`table count mismatch: expected ${input.expectedTables}, got ${dataset.tables.length}`);
        }
        table = await dataset.openTable(dataset.tables[0].id);

        const rowCount = table.metadata.extent.rows.kind === "exact"
          ? table.metadata.extent.rows.value
          : 0;
        const columnCount = table.metadata.schema.columns.length;
        if (rowCount < 1 || columnCount < 1) {
          throw new Error("format performance fixture did not expose a non-empty table");
        }
        const rangeStart = performance.now();
        const batch = await table.readRange({
          rowStart: Math.max(0, rowCount - Math.min(2, rowCount)),
          rowCount: Math.min(2, rowCount),
          columnStart: 0,
          columnCount,
        });
        const rangeReadMs = performance.now() - rangeStart;
        const display = batch.toDisplayRows({ maxCells: Math.max(1, batch.range.rowCount * batch.range.columnCount) });
        if (display.length !== batch.range.rowCount) {
          throw new Error("format range result is not aligned with its returned range");
        }
        const presentation = await table.getPresentation();
        if (input.adapter === "excel") {
          if (presentation?.kind !== "spreadsheet-v1") {
            throw new Error("Excel fixture did not expose spreadsheet presentation");
          }
          const range = await table.readPresentationRange({
            rowStart: 0,
            rowCount: Math.min(2, rowCount),
            columnStart: 0,
            columnCount: Math.min(2, columnCount),
          });
          if (range?.kind !== "spreadsheet-v1") {
            throw new Error("Excel fixture did not expose an aligned presentation range");
          }
        } else if (presentation !== null) {
          throw new Error("Parquet must not claim spreadsheet presentation");
        }
        await measure("range-read");

        await table.close();
        table = undefined;
        await dataset.close();
        dataset = undefined;
        await engine.close();
        engine = undefined;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await measure("closed");

        const idle = memory[0]?.bytes;
        const peak = Math.max(...memory.map(({ bytes }) => bytes));
        return {
          adapterId: adapter.id,
          sourceBytes: source.size,
          tableCount: input.expectedTables,
          rowCount,
          columnCount,
          coldLoad: { engineStartupMs, adapterColdOpenMs },
          rangeRead: { durationMs: rangeReadMs, returnedRows: batch.range.rowCount },
          memory: {
            api: "measureUserAgentSpecificMemory",
            forcedGcBeforeSample: true,
            peakDeltaBytes: Math.max(0, peak - idle),
            samples: memory,
          },
        };
      } finally {
        await table?.close().catch(() => {});
        await dataset?.close().catch(() => {});
        await engine?.close().catch(() => {});
      }
    }, {
      adapter: scenario.adapter,
      excelFormat: scenario.excelFormat,
      expectedTables: scenario.expectedTables,
      memoryBudgetBytes: formatBudgets.adapters[scenario.adapter].maxMemoryPeakDeltaBytes,
    });
    await context.close();
    if (errors.length > 0) throw new Error(`${scenario.name} emitted page errors: ${errors.join("; ")}`);
    const budget = formatBudgets.adapters[scenario.adapter];
    validateSample(sample, scenario, budget);
    const { path: _localPath, ...evidence } = scenario;
    samples.push({ ...evidence, budget, sample });
    process.stderr.write(
      `${scenario.name}: engine=${sample.coldLoad.engineStartupMs.toFixed(1)}ms, `
        + `open=${sample.coldLoad.adapterColdOpenMs.toFixed(1)}ms, `
        + `range=${sample.rangeRead.durationMs.toFixed(1)}ms, `
        + `memory=${sample.memory.peakDeltaBytes}B\n`,
    );
  }

  const report = {
    benchmarkSchemaVersion: 1,
    formatBudgetSchemaVersion: formatBudgets.schemaVersion,
    adapterBudgets: formatBudgets.adapters,
    recordedAt: new Date().toISOString(),
    environment: {
      os: { platform: platform(), release: release(), arch: arch() },
      cpu: { model: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length },
      totalMemoryBytes: totalmem(),
      node: process.version,
      chromium: browser.version(),
      crossOriginIsolated: true,
    },
    samples,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, samples: samples.map(({ name }) => name) }, null, 2)}\n`);
} finally {
  await browser.close();
  await stopTestServer(server);
}

async function loadScenarios() {
  const parquet = await fixture("parquet", "tabulark-rust.parquet");
  const xls = await fixture("excel", "tabulark-biff8.xls");
  const xlsx = await fixture("excel", "tabulark-ooxml.xlsx");
  return [
    { name: "parquet", adapter: "parquet", expectedTables: 1, ...parquet },
    { name: "excel-xls", adapter: "excel", excelFormat: "xls", expectedTables: 1, ...xls },
    { name: "excel-xlsx", adapter: "excel", excelFormat: "xlsx", expectedTables: 3, ...xlsx },
  ];
}

async function loadFormatBudgets() {
  const value = JSON.parse(await readFile(
    resolve(repositoryRoot, "test", "performance", "format-budget.json"),
    "utf8",
  ));
  if (value.schemaVersion !== 1 || !isRecord(value.adapters)) {
    throw new Error("format performance budget has an unsupported schema");
  }
  const adapters = {};
  for (const name of ["parquet", "excel"]) {
    const budget = value.adapters[name];
    if (!isRecord(budget)) throw new Error(`format performance budget is missing ${name}`);
    for (const field of [
      "maxEngineStartupMs",
      "maxAdapterColdOpenMs",
      "maxRangeReadMs",
      "maxMemoryPeakDeltaBytes",
    ]) {
      if (!Number.isFinite(budget[field]) || budget[field] <= 0) {
        throw new Error(`${name} format performance budget has an invalid ${field}`);
      }
    }
    adapters[name] = Object.freeze({ ...budget });
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, adapters: Object.freeze(adapters) });
}

async function fixture(format, filename) {
  const directory = resolve(repositoryRoot, "test", "fixtures", format, "v1");
  const provenance = JSON.parse(await readFile(resolve(directory, "provenance.json"), "utf8"));
  const entry = provenance.files?.find(({ path }) => path === filename);
  if (!entry) throw new Error(`fixture provenance is missing ${format}/${filename}`);
  const path = resolve(directory, filename);
  const metadata = await stat(path);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (metadata.size !== entry.bytes || digest !== entry.sha256) {
    throw new Error(`${format}/${filename} does not match pinned provenance`);
  }
  return Object.freeze({
    fixture: `test/fixtures/${format}/v1/${filename}`,
    bytes: metadata.size,
    sha256: digest,
    path,
  });
}

function validateSample(sample, scenario, budget) {
  if (sample.adapterId !== (scenario.adapter === "parquet" ? "tabulark:parquet" : "tabulark:excel")) {
    throw new Error(`${scenario.name} returned the wrong adapter ID`);
  }
  if (sample.sourceBytes !== scenario.bytes || sample.tableCount !== scenario.expectedTables) {
    throw new Error(`${scenario.name} source or table count does not match its fixture contract`);
  }
  const numeric = [
    sample.rowCount,
    sample.columnCount,
    sample.coldLoad.engineStartupMs,
    sample.coldLoad.adapterColdOpenMs,
    sample.rangeRead.durationMs,
    sample.rangeRead.returnedRows,
    sample.memory.peakDeltaBytes,
  ];
  if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${scenario.name} recorded an invalid performance value`);
  }
  if (sample.rowCount < 1 || sample.columnCount < 1 || sample.rangeRead.returnedRows < 1) {
    throw new Error(`${scenario.name} did not return a usable range`);
  }
  if (sample.memory.api !== "measureUserAgentSpecificMemory" || sample.memory.forcedGcBeforeSample !== true) {
    throw new Error(`${scenario.name} did not record the required Chromium memory evidence`);
  }
  if (sample.coldLoad.engineStartupMs > budget.maxEngineStartupMs) {
    throw new Error(
      `${scenario.name} exceeded its ${budget.maxEngineStartupMs}ms engine startup budget`,
    );
  }
  if (sample.coldLoad.adapterColdOpenMs > budget.maxAdapterColdOpenMs) {
    throw new Error(
      `${scenario.name} exceeded its ${budget.maxAdapterColdOpenMs}ms adapter cold-open budget`,
    );
  }
  if (sample.rangeRead.durationMs > budget.maxRangeReadMs) {
    throw new Error(`${scenario.name} exceeded its ${budget.maxRangeReadMs}ms range-read budget`);
  }
  if (sample.memory.peakDeltaBytes > budget.maxMemoryPeakDeltaBytes) {
    throw new Error(
      `${scenario.name} exceeded its ${budget.maxMemoryPeakDeltaBytes}-byte memory budget`,
    );
  }
  const phases = sample.memory.samples.map(({ phase }) => phase);
  if (phases.join(",") !== "idle,range-read,closed") {
    throw new Error(`${scenario.name} recorded incomplete memory phases`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
