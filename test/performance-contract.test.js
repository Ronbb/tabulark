import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startTestServer, stopTestServer } from "./browser/server.mjs";

test("performance scenarios and size budgets remain reproducible and bounded", async () => {
  const [manifest, budget, formatBudget, packageJson] = await Promise.all([
    readJson("./performance/scenarios.json"),
    readJson("./performance/size-budget.json"),
    readJson("./performance/format-budget.json"),
    readJson("../package.json"),
  ]);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(budget.schemaVersion, 2);
  assert.equal(formatBudget.schemaVersion, 1);
  assert.equal(
    packageJson.scripts["benchmark:formats"],
    "node test/performance/run-format-smoke.mjs",
  );
  assert.deepEqual(Object.keys(formatBudget.adapters).sort(), ["excel", "parquet"]);
  for (const [adapter, limits] of Object.entries(formatBudget.adapters)) {
    for (const field of [
      "maxEngineStartupMs",
      "maxAdapterColdOpenMs",
      "maxRangeReadMs",
      "maxMemoryPeakDeltaBytes",
    ]) {
      assert.ok(Number.isSafeInteger(limits[field]) && limits[field] > 0, `${adapter}.${field}`);
    }
    assert.ok(
      limits.maxMemoryPeakDeltaBytes <= 64 * 1024 * 1024,
      `${adapter} memory cap must not exceed the 64 MiB platform budget`,
    );
  }
  for (const [name, scenario] of Object.entries(manifest.scenarios)) {
    if (scenario.kind === "arrow") {
      assert.match(
        scenario.fixture,
        /^test\/(?:fixtures\/arrow|performance\/fixtures\/arrow)\/.+\.arrows?$/u,
        name,
      );
      assert.ok(Number.isSafeInteger(scenario.bytes) && scenario.bytes > 0, name);
      assert.ok(Number.isSafeInteger(scenario.columns) && scenario.columns > 0, name);
      assert.ok(["auto", "file", "stream"].includes(scenario.container), name);
      assert.ok(["none", "lz4", "zstd"].includes(scenario.compression), name);
      assert.ok(Array.isArray(scenario.randomRangeRows) && scenario.randomRangeRows.length > 0, name);
      const bytes = await readFile(new URL(`../${scenario.fixture}`, import.meta.url));
      assert.equal(bytes.byteLength, scenario.bytes, `${name} bytes`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), scenario.sha256, `${name} digest`);
    } else {
      assert.ok(Number.isSafeInteger(scenario.requestedBytes) && scenario.requestedBytes > 0, name);
      assert.ok(scenario.generatedBytes >= scenario.requestedBytes, name);
    }
    assert.ok(Number.isSafeInteger(scenario.rows) && scenario.rows > 0, name);
    assert.match(scenario.sha256, /^[0-9a-f]{64}$/u, name);
    assert.ok(Number.isSafeInteger(scenario.scrollFrames) && scenario.scrollFrames >= 60, name);
  }
  assert.ok(manifest.scenarios.canonical.requestedBytes > 8 * 1024 * 1024);
  assert.ok(manifest.scenarios.canonical.measuredIterations >= 5);
  assert.ok(manifest.scenarios.canonical.warmupIterations >= 1);
  const arrowScenarios = Object.values(manifest.scenarios).filter(({ kind }) => kind === "arrow");
  assert.deepEqual(
    arrowScenarios.map(({ compression, container }) => `${container}-${compression}`).sort(),
    [
      "file-lz4",
      "file-none",
      "file-zstd",
      "stream-lz4",
      "stream-none",
      "stream-zstd",
    ],
  );
  const provenance = await readJson("./performance/fixtures/arrow/provenance.json");
  assert.equal(provenance.generator, "examples/generate_arrow_fixture.rs");
  assert.equal(provenance.arrowVersion, "59.1.0");
  assert.ok(Number.isSafeInteger(provenance.rows) && provenance.rows >= 128);
  assert.ok(Number.isSafeInteger(provenance.batchRows) && provenance.batchRows > 0);
  assert.ok(provenance.batchRows < provenance.rows, "performance fixtures must span batches");
  const provenanceByPath = new Map(
    provenance.files.map((fixture) => [`test/performance/fixtures/arrow/${fixture.path}`, fixture]),
  );
  for (const scenario of arrowScenarios) {
    assert.equal(scenario.rows, provenance.rows, `${scenario.fixture} rows`);
    assert.ok(
      scenario.randomRangeRows.some((row) => row >= provenance.batchRows),
      `${scenario.fixture} must measure a range beyond the first RecordBatch`,
    );
    assert.deepEqual(
      {
        bytes: scenario.bytes,
        compression: scenario.compression,
        container: scenario.container,
        sha256: scenario.sha256,
      },
      {
        bytes: provenanceByPath.get(scenario.fixture)?.bytes,
        compression: provenanceByPath.get(scenario.fixture)?.compression,
        container: provenanceByPath.get(scenario.fixture)?.container,
        sha256: provenanceByPath.get(scenario.fixture)?.sha256,
      },
      scenario.fixture,
    );
  }

  assert.deepEqual(Object.keys(budget.maximumBytes).sort(), [
    "arrowBrotli",
    "arrowRaw",
    "coreBrotli",
    "coreRaw",
    "excelBrotli",
    "excelRaw",
    "httpBrotli",
    "httpRaw",
    "npmPacked",
    "npmUnpacked",
    "pagesBrotli",
    "pagesRaw",
    "parquetBrotli",
    "parquetRaw",
  ]);
  for (const maximum of Object.values(budget.maximumBytes)) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0);
  }
  const packageBaseline = await readJson("./performance/baselines/package-sizes.json");
  assert.equal(budget.maximumBytes.coreRaw, 524288, "M3 core raw cap must not widen");
  assert.equal(budget.maximumBytes.coreBrotli, 147456, "M3 core Brotli cap must not widen");
  assert.equal(budget.maximumBytes.arrowRaw, 2555904, "M4 Arrow raw cap must not widen");
  assert.equal(budget.maximumBytes.arrowBrotli, 393216, "M4 Arrow Brotli cap must not widen");
  for (const [budgetKey, group, field] of [
    ["parquetRaw", "parquet", "rawBytes"],
    ["parquetBrotli", "parquet", "brotliBytes"],
    ["excelRaw", "excel", "rawBytes"],
    ["excelBrotli", "excel", "brotliBytes"],
    ["npmPacked", "npm", "packedBytes"],
    ["npmUnpacked", "npm", "unpackedBytes"],
    ["pagesRaw", "pages", "rawBytes"],
    ["pagesBrotli", "pages", "brotliBytes"],
  ]) {
    assert.equal(
      budget.maximumBytes[budgetKey],
      withDeliveryHeadroom(packageBaseline[group][field]),
      `${budgetKey} delivery headroom`,
    );
  }
  for (const [budgetKey, field] of [
    ["httpRaw", "rawBytes"],
    ["httpBrotli", "brotliBytes"],
  ]) {
    assert.equal(
      budget.maximumBytes[budgetKey],
      Math.ceil(packageBaseline.http[field] * 1.15),
      `${budgetKey} exact 15% delivery headroom`,
    );
  }
});

test("performance server opts into cross-origin isolation explicitly", async () => {
  const server = await startTestServer({ crossOriginIsolated: true, port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/test/performance/harness.html`,
      { headers: { connection: "close" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  } finally {
    await stopTestServer(server);
  }
});

test("committed M3 performance baseline records required memory evidence", async () => {
  const [manifest, baseline] = await Promise.all([
    readJson("./performance/scenarios.json"),
    readJson("./performance/baselines/windows-chromium-16mib.json"),
  ]);
  const canonical = manifest.scenarios.canonical;

  assert.equal(baseline.benchmarkSchemaVersion, 1);
  assert.equal(baseline.scenario, "canonical");
  assert.equal(baseline.source.workingTreeDirty, false);
  assert.equal(baseline.environment.crossOriginIsolated, true);
  assert.equal(baseline.environment.forcedGcBeforeMemorySample, true);
  assert.equal(baseline.dataset.requestedBytes, canonical.requestedBytes);
  assert.equal(baseline.dataset.generatedBytes, canonical.generatedBytes);
  assert.equal(baseline.dataset.rows, canonical.rows);
  assert.equal(baseline.dataset.sha256, canonical.sha256);
  assert.equal(baseline.iterations.warmup, canonical.warmupIterations);
  assert.equal(baseline.iterations.measured, canonical.measuredIterations);
  assert.equal(baseline.samples.length, canonical.measuredIterations);
  for (const sample of baseline.samples) {
    assert.equal(sample.memory.api, "measureUserAgentSpecificMemory");
    assert.equal(sample.memory.forcedGcBeforeSample, true);
    assert.deepEqual(sample.memory.samples.map(({ phase }) => phase), [
      "idle",
      "engine-ready",
      "scan-complete",
      "scroll-complete",
      "closed",
    ]);
  }
});

test("0.2 P0 gates keep paired medians, JavaScript shrinkage, and the frozen SHA", async () => {
  const [baseline, gate, sizes, workflow] = await Promise.all([
    readJson("./performance/baselines/v0.2-p0.json"),
    readFile(new URL("../scripts/run-performance-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("./performance/measure-sizes.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);

  assert.equal(baseline.schemaVersion, 1);
  assert.match(baseline.baselineSha, /^[0-9a-f]{40}$/u);
  assert.equal(baseline.fixtureSeed, "tabulark-0.2-p0-2026-07-26");
  assert.equal(
    baseline.shippedJavaScript.candidateMaximumBytes,
    Math.floor(baseline.shippedJavaScript.brotliBytes * 0.9),
  );
  assert.equal(
    baseline.shippedJavaScript.workerMaximumBytes,
    baseline.shippedJavaScript.workerBrotliBytes,
  );
  assert.equal(
    baseline.shippedJavaScript.removedArtifact,
    "dist/worker/large-excel-adapter.js",
  );
  for (const metric of [
    "workerWasmStartupMs",
    "firstUsablePaintMs",
    "rangeReadMedianMs",
    "cacheHitMs",
    "lifecycleCloseMs",
  ]) {
    assert.ok(gate.includes(`"${metric}"`), `${metric} must stay in the paired gate`);
  }
  assert.match(gate, /pairs: 5, warmups: 1/u);
  assert.match(gate, /pairs: 9, warmups: 2/u);
  assert.match(gate, /baseline \* 1\.1/u);
  assert.match(sizes, /candidateMaximumBytes/u);
  assert.match(sizes, /workerMaximumBytes/u);
  assert.match(sizes, /removedArtifact/u);
  assert.match(sizes, /!== "dist\/http\.js"/u);
  assert.match(workflow, /git worktree add --detach "\$baseline" "\$baseline_sha"/u);
  assert.match(workflow, /node scripts\/run-performance-gate\.mjs --baseline-root/u);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

function withDeliveryHeadroom(bytes) {
  return Math.ceil((bytes * 1.15) / (64 * 1024)) * 64 * 1024;
}
