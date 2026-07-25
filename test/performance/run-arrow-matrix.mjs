#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "test/performance/scenarios.json"), "utf8"),
);
const forwarded = parseArguments(process.argv.slice(2));
const scenarios = Object.entries(manifest.scenarios)
  .filter(([, scenario]) => scenario.kind === "arrow")
  .sort(([left], [right]) => left.localeCompare(right));

if (scenarios.length === 0) {
  throw new Error("Arrow performance matrix has no Arrow scenarios");
}

const reports = [];
for (const [name] of scenarios) {
  const output = resolve(repositoryRoot, "target/bench", `performance-${name}.json`);
  run(process.execPath, [
    resolve(repositoryRoot, "test/performance/run-browser.mjs"),
    "--scenario",
    name,
    "--output",
    output,
    ...forwarded,
  ]);
  const report = JSON.parse(await readFile(output, "utf8"));
  reports.push({ output: relativeToRoot(output), scenario: name, summary: report.summary });
}

const matrixOutput = resolve(repositoryRoot, "target/bench/performance-arrow-matrix.json");
await mkdir(dirname(matrixOutput), { recursive: true });
await writeFile(
  matrixOutput,
  `${JSON.stringify({
    benchmarkSchemaVersion: 1,
    scenarios: reports,
  }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify({ output: relativeToRoot(matrixOutput), scenarios: reports }, null, 2)}\n`);

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: node test/performance/run-arrow-matrix.mjs [--iterations N] [--warmups N] [--headed]\n",
    );
    process.exit(0);
  }
  for (const argument of args) {
    if (argument === "--scenario" || argument === "--output") {
      throw new Error(`${argument} is selected by the Arrow matrix`);
    }
  }
  return args;
}

function relativeToRoot(path) {
  return path.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}
