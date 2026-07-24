#!/usr/bin/env node

import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetRoot = resolve(repositoryRoot, "target");
const pagesRoot = resolve(targetRoot, "pages");

assertInsideTarget(pagesRoot);
await rm(pagesRoot, { force: true, recursive: true });
await mkdir(pagesRoot, { recursive: true });

await Promise.all([
  copyFile(resolve(repositoryRoot, "index.html"), resolve(pagesRoot, "index.html")),
  copyFile(resolve(repositoryRoot, "LICENSE-APACHE"), resolve(pagesRoot, "LICENSE-APACHE")),
  copyFile(resolve(repositoryRoot, "LICENSE-MIT"), resolve(pagesRoot, "LICENSE-MIT")),
  cp(resolve(repositoryRoot, "dist"), resolve(pagesRoot, "dist"), { recursive: true }),
  cp(
    resolve(repositoryRoot, "examples", "csv-preview"),
    resolve(pagesRoot, "examples", "csv-preview"),
    { recursive: true },
  ),
]);
await writeFile(resolve(pagesRoot, ".nojekyll"), "", "utf8");

const requiredFiles = [
  ".nojekyll",
  "index.html",
  "examples/csv-preview/index.html",
  "examples/csv-preview/main.js",
  "dist/index.js",
  "dist/worker.js",
  "dist/wasm/tabulark.js",
  "dist/wasm/tabulark_bg.wasm",
];
for (const path of requiredFiles) {
  const metadata = await lstat(resolve(pagesRoot, path)).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) {
    throw new Error(`Pages artifact is missing ${path}`);
  }
}

const index = await readFile(resolve(pagesRoot, "index.html"), "utf8");
if (!index.includes('src="./examples/csv-preview/main.js"')) {
  throw new Error("Pages index does not load the playground module from a relative URL");
}
if (/\b(?:href|src)=["']\/(?!\/)/u.test(index)) {
  throw new Error("Pages index contains a root-absolute asset URL that will break on project Pages");
}

const playground = await readFile(
  resolve(pagesRoot, "examples", "csv-preview", "main.js"),
  "utf8",
);
if (!playground.includes('from "../../dist/index.js"')) {
  throw new Error("Playground module no longer resolves the packaged runtime relatively");
}

const artifact = await inspectTree(pagesRoot);
console.log(
  `Prepared target/pages (${artifact.files} files, ${formatBytes(artifact.bytes)}; no links).`,
);

async function inspectTree(root) {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Pages artifact cannot contain links: ${relative(root, path)}`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile()) {
        files += 1;
        bytes += metadata.size;
      }
    }
  }
  return { bytes, files };
}

function assertInsideTarget(path) {
  if (path === targetRoot || !path.startsWith(`${targetRoot}${sep}`)) {
    throw new Error(`Refusing to replace Pages output outside target/: ${path}`);
  }
}

function formatBytes(value) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
