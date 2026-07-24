#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { startTestServer, stopTestServer } from "../browser/server.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "test/performance/scenarios.json"), "utf8"));
const scenario = manifest.scenarios[options.scenario];
if (scenario === undefined) {
  throw new Error(`unknown performance scenario: ${options.scenario}`);
}
const measuredIterations = options.iterations ?? scenario.measuredIterations;
const warmupIterations = options.warmups ?? scenario.warmupIterations;
const datasetPath = resolve(repositoryRoot, "target", "bench", `tabulark-${options.scenario}.csv`);
await ensureDataset(datasetPath, scenario);

const server = await startTestServer({ crossOriginIsolated: true, port: 0 });
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("performance server did not expose a TCP port");
}
const baseURL = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  channel: "chromium",
  headless: !options.headed,
  args: [
    "--enable-precise-memory-info",
    "--enable-blink-features=ForceEagerMeasureMemory",
    "--js-flags=--expose-gc",
  ],
});

try {
  const results = [];
  const totalIterations = warmupIterations + measuredIterations;
  for (let index = 0; index < totalIterations; index += 1) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      locale: "en-US",
      reducedMotion: "reduce",
      viewport: { width: 1024, height: 640 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseURL}/test/performance/harness.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.__tabularkPerformanceReady === true);
    await page.locator("#source").setInputFiles(datasetPath);
    const result = await page.evaluate(async ({ expectedRows, scrollFrames }) => (
      globalThis.__tabularkRunPerformanceScenario({
        expectedRows,
        requireMemory: true,
        scrollFrames,
      })
    ), { expectedRows: scenario.rows, scrollFrames: scenario.scrollFrames });
    await context.close();
    if (pageErrors.length > 0) {
      throw new Error(`performance page emitted errors: ${pageErrors.join("; ")}`);
    }
    validateResult(result, scenario);
    if (index >= warmupIterations) {
      results.push(result);
    }
    process.stderr.write(
      `${index < warmupIterations ? "warmup" : "sample"} ${index + 1}/${totalIterations}: `
      + `startup=${result.workerWasmStartupMs.toFixed(1)}ms, `
      + `paint=${result.firstUsablePaintMs.toFixed(1)}ms, `
      + `scan=${result.completedScan.mibPerSecond.toFixed(1)}MiB/s\n`,
    );
  }

  const revision = await repositoryRevision();
  const report = {
    benchmarkSchemaVersion: 1,
    scenario: options.scenario,
    recordedAt: new Date().toISOString(),
    source: revision,
    environment: {
      os: { platform: platform(), release: release(), arch: arch() },
      cpu: { model: cpus()[0]?.model ?? "unknown", logicalCores: cpus().length },
      totalMemoryBytes: totalmem(),
      node: process.version,
      chromium: browser.version(),
      headless: !options.headed,
      viewport: { width: 1024, height: 640, deviceScaleFactor: 1 },
      crossOriginIsolated: true,
      forcedGcBeforeMemorySample: results.every(
        (result) => result.memory.forcedGcBeforeSample === true,
      ),
    },
    dataset: {
      generator: manifest.generator,
      requestedBytes: scenario.requestedBytes,
      generatedBytes: scenario.generatedBytes,
      rows: scenario.rows,
      sha256: scenario.sha256,
    },
    iterations: {
      warmup: warmupIterations,
      measured: measuredIterations,
    },
    summary: summarizeResults(results),
    samples: results,
  };
  const output = resolve(repositoryRoot, options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, summary: report.summary }, null, 2)}\n`);
} finally {
  await browser.close();
  await stopTestServer(server);
}

async function ensureDataset(path, expected) {
  let metadata = await stat(path).catch(() => undefined);
  let digest = metadata?.isFile() ? await sha256(path) : undefined;
  if (metadata?.size !== expected.generatedBytes || digest !== expected.sha256) {
    await mkdir(dirname(path), { recursive: true });
    await run(process.execPath, [
      resolve(repositoryRoot, "test/performance/generate-csv.mjs"),
      "--size",
      String(expected.requestedBytes),
      "--output",
      path,
    ]);
    metadata = await stat(path);
    digest = await sha256(path);
  }
  if (metadata.size !== expected.generatedBytes || digest !== expected.sha256) {
    throw new Error(
      `generated dataset does not match manifest: ${metadata.size} bytes, sha256 ${digest}`,
    );
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function validateResult(result, expected) {
  const finite = [
    result.workerWasmStartupMs,
    result.firstUsablePaintMs,
    result.completedScan.durationMs,
    result.completedScan.mibPerSecond,
    result.rangeRead.medianMs,
    result.rangeRead.p95Ms,
    result.scroll.medianMs,
    result.scroll.p95Ms,
    result.scroll.maxMs,
    result.transfer.batchPayloadBytes,
    result.transfer.sourceRatio,
    result.memory.peakDeltaBytes,
  ];
  if (finite.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("performance result contains a non-finite or negative metric");
  }
  if (result.completedScan.bytesScanned !== expected.generatedBytes) {
    throw new Error("completed scan did not cover the entire deterministic source");
  }
  if (result.completedScan.rowsDiscovered !== expected.rows) {
    throw new Error("completed scan row count does not match the deterministic source");
  }
  if (result.scroll.frames !== expected.scrollFrames) {
    throw new Error("scroll frame sample count is incomplete");
  }
  if (result.transfer.batchResponses < 1 || result.transfer.sourceRatio >= 1) {
    throw new Error("range transfer invariant failed: expected bounded demand-driven batches");
  }
  if (result.memory.api !== "measureUserAgentSpecificMemory") {
    throw new Error("canonical memory API was not used");
  }
  if (result.memory.forcedGcBeforeSample !== true) {
    throw new Error("canonical memory samples were not preceded by forced garbage collection");
  }
}

function summarizeResults(results) {
  if (results.length === 0) throw new Error("at least one measured iteration is required");
  return {
    workerWasmStartupMs: distribution(results.map((result) => result.workerWasmStartupMs)),
    firstUsablePaintMs: distribution(results.map((result) => result.firstUsablePaintMs)),
    completedScanMiBPerSecond: distribution(
      results.map((result) => result.completedScan.mibPerSecond),
    ),
    rangeReadMedianMs: distribution(results.map((result) => result.rangeRead.medianMs)),
    scrollP95Ms: distribution(results.map((result) => result.scroll.p95Ms)),
    scrollLongFramesOver33ms: distribution(
      results.map((result) => result.scroll.longFramesOver33ms),
    ),
    transferBatchPayloadBytes: distribution(
      results.map((result) => result.transfer.batchPayloadBytes),
    ),
    memoryPeakDeltaBytes: distribution(
      results.map((result) => result.memory.peakDeltaBytes),
    ),
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function repositoryRevision() {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repositoryRoot }),
  ]);
  return { gitCommit: sha.trim(), workingTreeDirty: status.trim().length > 0 };
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`))
    ));
  });
}

function parseArguments(args) {
  const parsed = {
    scenario: "smoke",
    output: "target/bench/performance-smoke.json",
    iterations: undefined,
    warmups: undefined,
    headed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scenario") parsed.scenario = requiredValue(args, ++index, argument);
    else if (argument === "--output") parsed.output = requiredValue(args, ++index, argument);
    else if (argument === "--iterations") parsed.iterations = positiveInteger(requiredValue(args, ++index, argument));
    else if (argument === "--warmups") parsed.warmups = nonNegativeInteger(requiredValue(args, ++index, argument));
    else if (argument === "--headed") parsed.headed = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node test/performance/run-browser.mjs [--scenario smoke|canonical] [--iterations N] [--warmups N] [--output PATH] [--headed]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return parsed;
}

function requiredValue(args, index, option) {
  if (args[index] === undefined) throw new Error(`${option} requires a value`);
  return args[index];
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("iterations must be positive");
  return parsed;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("warmups must be non-negative");
  return parsed;
}
