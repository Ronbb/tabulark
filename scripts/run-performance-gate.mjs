#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const candidateRoot = resolve(options.candidateRoot);
const baselineRoot = resolve(options.baselineRoot);
const outputRoot = resolve(candidateRoot, options.outputDirectory);
const metrics = [
  "workerWasmStartupMs",
  "firstUsablePaintMs",
  "rangeReadMedianMs",
  "cacheHitMs",
  "lifecycleCloseMs",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const attempts = [];
let finalAttempt = await runPass({ pairs: 5, warmups: 1, label: "initial" });
attempts.push(finalAttempt);
if (finalAttempt.failures.length > 0) {
  finalAttempt = await runPass({ pairs: 9, warmups: 2, label: "confirmation" });
  attempts.push(finalAttempt);
}
const evidence = { ...finalAttempt, attempts };
const output = resolve(outputRoot, "comparison.json");
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, ...evidence.comparisons }, null, 2)}\n`);
if (evidence.failures.length > 0) {
  throw new Error(`performance regression exceeds 10%: ${evidence.failures.join(", ")}`);
}

async function runPass({ pairs, warmups, label }) {
  const directory = resolve(outputRoot, label);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  runOne(baselineRoot, resolve(directory, "baseline-warmup.json"), warmups, true);
  runOne(candidateRoot, resolve(directory, "candidate-warmup.json"), warmups, false);

  const baselineReports = [];
  const candidateReports = [];
  for (let index = 0; index < pairs; index += 1) {
    const order = index % 2 === 0
      ? [["baseline", baselineRoot], ["candidate", candidateRoot]]
      : [["candidate", candidateRoot], ["baseline", baselineRoot]];
    for (const [name, root] of order) {
      const path = resolve(directory, `${String(index + 1).padStart(2, "0")}-${name}.json`);
      runOne(root, path, 0, name === "baseline");
      const report = JSON.parse(await readFile(path, "utf8"));
      (name === "baseline" ? baselineReports : candidateReports).push(report);
    }
  }

  const comparisons = {};
  const failures = [];
  for (const metric of metrics) {
    const baseline = median(baselineReports.map((report) => report.summary[metric].median));
    const candidate = median(candidateReports.map((report) => report.summary[metric].median));
    const maximum = baseline * 1.1;
    const passed = candidate <= maximum;
    comparisons[metric] = {
      baselineMedian: baseline,
      candidateMedian: candidate,
      maximumMedian: maximum,
      regressionRatio: baseline === 0 ? (candidate === 0 ? 1 : null) : candidate / baseline,
      passed,
    };
    if (!passed) failures.push(metric);
  }
  return {
    schemaVersion: 1,
    pass: label,
    pairs,
    warmups,
    threshold: 1.1,
    comparisons,
    failures,
  };
}

function runOne(root, output, warmups, allowCacheRpc) {
  const result = spawnSync(
    process.execPath,
    [
      "test/performance/run-browser.mjs",
      "--scenario", "canonical",
      "--iterations", "1",
      "--warmups", String(warmups),
      "--output", output,
      ...(allowCacheRpc ? ["--allow-cache-rpc"] : []),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`performance sample failed in ${root}`);
  }
}

function median(values) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("performance evidence contains an invalid metric");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseArguments(args) {
  const parsed = {
    baselineRoot: undefined,
    candidateRoot: ".",
    outputDirectory: "target/bench/performance-gate",
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[++index];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--baseline-root") parsed.baselineRoot = value;
    else if (option === "--candidate-root") parsed.candidateRoot = value;
    else if (option === "--output-directory") parsed.outputDirectory = value;
    else throw new Error(`unknown option: ${option}`);
  }
  if (parsed.baselineRoot === undefined) throw new Error("--baseline-root is required");
  return parsed;
}
