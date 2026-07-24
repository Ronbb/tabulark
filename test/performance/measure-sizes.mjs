#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as zlibConstants, brotliCompress } from "node:zlib";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const runtimePaths = [
  "dist/index.js",
  "dist/worker.js",
  "dist/wasm/tabulark.js",
  "dist/wasm/tabulark_bg.wasm",
];

const runtimeFiles = [];
for (const path of runtimePaths) {
  runtimeFiles.push(await measureFile(resolve(repositoryRoot, path), repositoryRoot));
}
const pagesFiles = await walkFiles(resolve(repositoryRoot, "target/pages"));
const pagesMeasured = [];
for (const path of pagesFiles) {
  pagesMeasured.push(await measureFile(path, resolve(repositoryRoot, "target/pages")));
}
const npm = await measureNpmPackage();
const report = {
  sizeSchemaVersion: 1,
  compression: { algorithm: "brotli", quality: 11 },
  runtime: {
    rawBytes: sum(runtimeFiles, "rawBytes"),
    brotliBytes: sum(runtimeFiles, "brotliBytes"),
    files: runtimeFiles,
  },
  npm,
  pages: {
    rawBytes: sum(pagesMeasured, "rawBytes"),
    brotliBytes: sum(pagesMeasured, "brotliBytes"),
    files: pagesMeasured.length,
  },
};

const budget = JSON.parse(await readFile(resolve(repositoryRoot, options.budget), "utf8"));
const actual = {
  runtimeRaw: report.runtime.rawBytes,
  runtimeBrotli: report.runtime.brotliBytes,
  npmPacked: report.npm.packedBytes,
  npmUnpacked: report.npm.unpackedBytes,
  pagesRaw: report.pages.rawBytes,
  pagesBrotli: report.pages.brotliBytes,
};
const comparisons = Object.fromEntries(Object.entries(budget.maximumBytes).map(([name, maximum]) => {
  const bytes = actual[name];
  if (!Number.isSafeInteger(bytes)) throw new Error(`unknown size budget metric: ${name}`);
  return [name, { bytes, maximumBytes: maximum, remainingBytes: maximum - bytes }];
}));
report.budget = { schemaVersion: budget.schemaVersion, comparisons };
const failures = Object.entries(comparisons).filter(([, value]) => value.remainingBytes < 0);

const output = resolve(repositoryRoot, options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, ...actual, budgetFailures: failures }, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`size budget exceeded: ${failures.map(([name]) => name).join(", ")}`);
}

async function measureFile(path, root) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`size input must be a regular file: ${path}`);
  }
  const bytes = await readFile(path);
  const compressed = await brotliCompressAsync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  return {
    path: relative(root, path).replaceAll("\\", "/"),
    rawBytes: bytes.byteLength,
    brotliBytes: compressed.byteLength,
  };
}

async function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`size input cannot contain links: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(path);
    }
  }
  return files.sort();
}

async function measureNpmPackage() {
  const npmCli = process.env.npm_execpath
    ?? (process.platform === "win32"
      ? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
      : undefined);
  const command = npmCli === undefined ? "npm" : process.execPath;
  const prefix = npmCli === undefined ? [] : [npmCli];
  const { stdout } = await execFileAsync(command, [...prefix,
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--cache",
    resolve(repositoryRoot, "target/npm-cache"),
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const entry = parsed[0];
  if (!Number.isSafeInteger(entry?.size) || !Number.isSafeInteger(entry?.unpackedSize)) {
    throw new Error("npm pack did not report deterministic package sizes");
  }
  return {
    packedBytes: entry.size,
    unpackedBytes: entry.unpackedSize,
    files: entry.entryCount ?? entry.files?.length,
  };
}

function sum(values, field) {
  return values.reduce((total, value) => total + value[field], 0);
}

function parseArguments(args) {
  const parsed = {
    budget: "test/performance/size-budget.json",
    output: "target/bench/package-sizes.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--budget") parsed.budget = requiredValue(args, ++index, "--budget");
    else if (args[index] === "--output") parsed.output = requiredValue(args, ++index, "--output");
    else if (args[index] === "--help" || args[index] === "-h") {
      process.stdout.write("Usage: node test/performance/measure-sizes.mjs [--budget PATH] [--output PATH]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${args[index]}`);
  }
  return parsed;
}

function requiredValue(args, index, option) {
  if (args[index] === undefined) throw new Error(`${option} requires a value`);
  return args[index];
}
