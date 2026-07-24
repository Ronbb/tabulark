#!/usr/bin/env node

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_SIZE = 1024 ** 3;
const DEFAULT_OUTPUT = resolve("target", "bench", "tabulark-1g.csv");
const CHUNK_TARGET_BYTES = 1024 * 1024;

const options = parseArguments(process.argv.slice(2));
await mkdir(dirname(options.output), { recursive: true });

const output = createWriteStream(options.output, { encoding: "utf8" });
output.on("error", (error) => {
  throw error;
});

let bytesWritten = write(output, "id,name,category,active,amount,notes\n");
let row = 0;

while (bytesWritten < options.size) {
  let chunk = "";
  let chunkBytes = 0;

  while (
    chunkBytes < CHUNK_TARGET_BYTES &&
    bytesWritten + chunkBytes < options.size
  ) {
    row += 1;
    const nextRow = makeRow(row);
    chunk += nextRow;
    chunkBytes += Buffer.byteLength(nextRow);
  }

  if (chunk.length === 0) {
    break;
  }

  bytesWritten += chunkBytes;
  if (!output.write(chunk)) {
    await once(output, "drain");
  }
}

output.end();
await once(output, "finish");

const generated = await stat(options.output);
console.log(
  JSON.stringify(
    {
      output: options.output,
      bytes: generated.size,
      rows: row,
      requestedBytes: options.size,
    },
    null,
    2,
  ),
);

function makeRow(id) {
  const category = `group-${id % 97}`;
  const active = id % 3 === 0 ? "true" : "false";
  const amount = `${Math.trunc(id / 100)}.${String(id % 100).padStart(2, "0")}`;
  const note = id % 101 === 0 ? '"contains, comma and ""quotes"""' : `row-${id}`;

  return `${id},name-${id},${category},${active},${amount},${note}\n`;
}

function parseArguments(args) {
  let output = DEFAULT_OUTPUT;
  let size = DEFAULT_SIZE;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--output") {
      output = resolve(readValue(args, ++index, "--output"));
      continue;
    }

    if (argument === "--size") {
      size = parseSize(readValue(args, ++index, "--size"));
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node test/performance/generate-csv.mjs [options]

Options:
  --output PATH  Destination (default: target/bench/tabulark-1g.csv)
  --size SIZE    Minimum file size in bytes, KiB, MiB, or GiB (default: 1GiB)
  --help         Show this message`);
      process.exit(0);
    }

    throw new Error(`unknown argument: ${argument}`);
  }

  return { output, size };
}

function readValue(args, index, option) {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`${option} requires a value`);
  }

  return value;
}

function parseSize(value) {
  const match = /^(\d+)(B|KiB|MiB|GiB)?$/i.exec(value);
  if (match === null) {
    throw new Error(`invalid size: ${value}`);
  }

  const units = {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  };
  const unit = (match[2] ?? "B").toLowerCase();
  const size = Number(match[1]) * units[unit];

  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`size must be a positive safe integer: ${value}`);
  }

  return size;
}

function write(stream, value) {
  stream.write(value);
  return Buffer.byteLength(value);
}
