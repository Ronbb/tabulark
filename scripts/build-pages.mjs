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
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetRoot = resolve(repositoryRoot, "target");
const pagesRoot = resolve(targetRoot, "pages");
const officialManifest = JSON.parse(await readFile(
  resolve(repositoryRoot, "js", "official-adapters.json"),
  "utf8",
));

assertInsideTarget(pagesRoot);
await rm(pagesRoot, { force: true, recursive: true });
await mkdir(pagesRoot, { recursive: true });

await Promise.all([
  copyFile(resolve(repositoryRoot, "index.html"), resolve(pagesRoot, "index.html")),
  copyFile(resolve(repositoryRoot, "LICENSE-APACHE"), resolve(pagesRoot, "LICENSE-APACHE")),
  copyFile(resolve(repositoryRoot, "LICENSE-MIT"), resolve(pagesRoot, "LICENSE-MIT")),
  copyFile(
    resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    resolve(pagesRoot, "THIRD_PARTY_NOTICES.md"),
  ),
  cp(resolve(repositoryRoot, "dist"), resolve(pagesRoot, "dist"), { recursive: true }),
  cp(
    resolve(repositoryRoot, "examples", "csv-preview"),
    resolve(pagesRoot, "examples", "csv-preview"),
    { recursive: true },
  ),
  cp(
    resolve(repositoryRoot, "test", "fixtures", "arrow"),
    resolve(pagesRoot, "test", "fixtures", "arrow"),
    { recursive: true },
  ),
  cp(
    resolve(repositoryRoot, "test", "fixtures", "parquet"),
    resolve(pagesRoot, "test", "fixtures", "parquet"),
    { recursive: true },
  ),
  cp(
    resolve(repositoryRoot, "test", "fixtures", "excel"),
    resolve(pagesRoot, "test", "fixtures", "excel"),
    { recursive: true },
  ),
]);
await writeFile(resolve(pagesRoot, ".nojekyll"), "", "utf8");

const stableBundles = officialManifest.adapters.map(({ entrypoint }) => (
  entrypoint === "." ? "index" : entrypoint.replace(/^\.\//u, "")
));
const publicBundles = [...stableBundles, "experimental", "worker", "worker-range-source"];
const requiredFiles = [
  ".nojekyll",
  "index.html",
  "LICENSE-APACHE",
  "LICENSE-MIT",
  "THIRD_PARTY_NOTICES.md",
  "examples/csv-preview/index.html",
  "examples/csv-preview/main.js",
  ...publicBundles.flatMap((name) => [
    `dist/${name}.js`,
    `dist/${name}.js.map`,
    `dist/${name}.d.ts`,
  ]),
  ...officialManifest.adapters.flatMap(({ wasm }) => [
    `${wasm.outputDirectory}/${wasm.outputName}.js`,
    `${wasm.outputDirectory}/${wasm.outputName}.d.ts`,
    `${wasm.outputDirectory}/${wasm.outputName}_bg.wasm`,
    `${wasm.outputDirectory}/${wasm.outputName}_bg.wasm.d.ts`,
  ]),
  "test/fixtures/arrow/v1/APACHE-ARROW-TESTING-LICENSE.txt",
  "test/fixtures/arrow/v1/apache-arrow-1.0.0-generated-nested.arrow",
  "test/fixtures/arrow/v1/m4-sample.arrow",
  "test/fixtures/arrow/v1/provenance.json",
  "test/fixtures/parquet/v1/provenance.json",
  "test/fixtures/parquet/v1/APACHE-PARQUET-TESTING-LICENSE.txt",
  "test/fixtures/parquet/v1/apache-parquet-testing-alltypes-plain.parquet",
  "test/fixtures/parquet/v1/tabulark-rust.parquet",
  "test/fixtures/excel/v1/provenance.json",
  "test/fixtures/excel/v1/tabulark-biff8.xls",
  "test/fixtures/excel/v1/tabulark-ooxml.xlsx",
  "test/fixtures/excel/v1/XLSXWRITER-LICENSE.txt",
  "test/fixtures/excel/v1/xlsxwriter-merge-range01.xlsx",
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
for (const bundle of stableBundles) {
  if (!playground.includes(`from "../../dist/${bundle}.js"`)) {
    throw new Error(`Playground no longer resolves the manifest bundle ${bundle} relatively`);
  }
}
if (/\b(?:import|from)\s*(?:\(|)["']https?:\/\//u.test(playground)) {
  throw new Error("Playground cannot import runtime code from a CDN or remote origin");
}

const arrowProvenance = JSON.parse(await readFile(
  resolve(pagesRoot, "test", "fixtures", "arrow", "v1", "provenance.json"),
  "utf8",
));
const arrowSample = await readFile(
  resolve(pagesRoot, "test", "fixtures", "arrow", "v1", "m4-sample.arrow"),
);
const arrowSampleDigest = createHash("sha256").update(arrowSample).digest("hex");
if (
  arrowProvenance.playground?.bytes !== arrowSample.byteLength
  || arrowProvenance.playground?.sha256 !== arrowSampleDigest
) {
  throw new Error("Pages Arrow sample does not match its pinned provenance");
}
for (const fixture of arrowProvenance.external?.files ?? []) {
  const bytes = await readFile(
    resolve(pagesRoot, "test", "fixtures", "arrow", "v1", fixture.path),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (fixture.bytes !== bytes.byteLength || fixture.sha256 !== digest) {
    throw new Error(`Pages external Arrow fixture ${fixture.path} does not match provenance`);
  }
}

for (const format of ["parquet", "excel"]) {
  const formatRoot = resolve(pagesRoot, "test", "fixtures", format, "v1");
  const provenance = JSON.parse(await readFile(resolve(formatRoot, "provenance.json"), "utf8"));
  for (const fixture of provenance.files ?? []) {
    const bytes = await readFile(resolve(formatRoot, fixture.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (fixture.bytes !== bytes.byteLength || fixture.sha256 !== digest) {
      throw new Error(`Pages ${format} fixture ${fixture.path} does not match provenance`);
    }
  }
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
