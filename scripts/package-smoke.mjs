#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetRoot = resolve(repositoryRoot, "target");
const smokeRoot = resolve(targetRoot, "package-smoke");
const officialManifest = JSON.parse(await readFile(
  resolve(repositoryRoot, "js", "official-adapters.json"),
  "utf8",
));
const stableBundles = officialManifest.adapters.map(({ entrypoint }) => (
  entrypoint === "." ? "index" : entrypoint.replace(/^\.\//u, "")
));
const runtimeAdapterImports = officialManifest.adapters.map((adapter, index) => (
  `import { ${adapter.exportName} as adapter${index} } from ${JSON.stringify(packageSpecifier(adapter.entrypoint))};\n`
)).join("");
const runtimeAdapterChecks = officialManifest.adapters.map((adapter, index) => (
  `if (adapter${index}.id !== ${JSON.stringify(adapter.id)}) throw new Error(${JSON.stringify(`${adapter.exportName} mismatch`)});\n`
)).join("");
assertInsideTarget(smokeRoot);
await rm(smokeRoot, { force: true, recursive: true });
await mkdir(smokeRoot, { recursive: true });

const packed = runNpm([
  "pack",
  "--json",
  "--ignore-scripts",
  "--pack-destination",
  smokeRoot,
  "--cache",
  resolve(targetRoot, "npm-cache"),
], repositoryRoot);
const packResult = JSON.parse(packed)[0];
if (typeof packResult?.filename !== "string") {
  throw new Error("npm pack did not report an archive filename");
}

const archive = resolve(smokeRoot, packResult.filename);
assertInsideTarget(archive);
await writeFile(
  resolve(smokeRoot, "package.json"),
  `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  "utf8",
);
runNpm([
  "install",
  archive,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--no-package-lock",
  "--cache",
  resolve(targetRoot, "npm-cache"),
], smokeRoot);

const packageRoot = resolve(smokeRoot, "node_modules", "tabulark");
const requiredFiles = [
  ...stableBundles.flatMap((bundle) => [
    `dist/${bundle}.js`,
    `dist/${bundle}.js.map`,
    `dist/${bundle}.d.ts`,
  ]),
  "dist/experimental.js",
  "dist/experimental.js.map",
  "dist/experimental.d.ts",
  "dist/worker.js",
  "dist/worker.js.map",
  "dist/worker.d.ts",
  "dist/worker/large-excel-adapter.js",
  "dist/worker/large-excel-adapter.js.map",
  "dist/worker/large-excel-adapter.d.ts",
  ...officialManifest.adapters.flatMap(({ wasm }) => [
    `${wasm.outputDirectory}/${wasm.outputName}.js`.replace(/^dist\//u, "dist/"),
    `${wasm.outputDirectory}/${wasm.outputName}.d.ts`.replace(/^dist\//u, "dist/"),
    `${wasm.outputDirectory}/${wasm.outputName}_bg.wasm`.replace(/^dist\//u, "dist/"),
    `${wasm.outputDirectory}/${wasm.outputName}_bg.wasm.d.ts`.replace(/^dist\//u, "dist/"),
  ]),
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
];
for (const relativePath of requiredFiles) {
  const metadata = await lstat(resolve(packageRoot, relativePath)).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) {
    throw new Error(`Packed consumer is missing ${relativePath}`);
  }
}

const installedManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (
  installedManifest.dependencies !== undefined
  || installedManifest.optionalDependencies !== undefined
  || installedManifest.bundleDependencies !== undefined
  || installedManifest.bundledDependencies !== undefined
) {
  throw new Error("The packed runtime must not declare or bundle production dependencies");
}
for (const adapter of officialManifest.adapters) {
  const bundle = adapter.entrypoint === "."
    ? "index"
    : adapter.entrypoint.replace(/^\.\//u, "");
  assertExport(
    installedManifest,
    adapter.entrypoint,
    `./dist/${bundle}.js`,
    `./dist/${bundle}.d.ts`,
  );
}
assertExport(installedManifest, "./experimental", "./dist/experimental.js", "./dist/experimental.d.ts");

for (const retiredPath of [
  "dist/wasm/tabulark.js",
  "dist/wasm/tabulark.d.ts",
  "dist/wasm/tabulark_bg.wasm",
  "dist/wasm/tabulark_bg.wasm.d.ts",
]) {
  const metadata = await lstat(resolve(packageRoot, retiredPath)).catch(() => undefined);
  if (metadata !== undefined) {
    throw new Error(`Packed consumer still contains retired M3 artifact ${retiredPath}`);
  }
}
await writeFile(
  resolve(smokeRoot, "consumer.mjs"),
  `import * as stable from "tabulark";\n`
    + runtimeAdapterImports
    + `import { CanvasTablePainter, createTableController } from "tabulark/experimental";\n`
    + `for (const privateName of ["PROTOCOL_VERSION", "ADAPTER_API_VERSION", "BATCH_LAYOUT_VERSION", "ColumnarTableBatch"]) {\n`
    + `  if (privateName in stable) throw new Error(\`private export leaked: \${privateName}\`);\n`
    + `}\n`
    + runtimeAdapterChecks
    + `if (typeof createTableController !== "function") throw new Error("experimental export mismatch");\n`
    + `if (typeof CanvasTablePainter !== "function") throw new Error("experimental painter mismatch");\n`
    + `await import("tabulark/protocol").then(\n`
    + `  () => { throw new Error("private protocol subpath is exported"); },\n`
    + `  (error) => { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; },\n`
    + `);\n`,
  "utf8",
);
run(process.execPath, [resolve(smokeRoot, "consumer.mjs")], smokeRoot);

await writeFile(
  resolve(smokeRoot, "consumer.ts"),
  `import { createCanvasTableView, createEngine, delimitedAdapter, type TableBatch, type TablePresentation } from "tabulark";\n`
    + `import { arrowIpcAdapter, type ArrowIpcAdapterOptions } from "tabulark/arrow";\n`
    + `import { parquetAdapter, type ParquetAdapterOptions } from "tabulark/parquet";\n`
    + `import { excelAdapter, type ExcelAdapterOptions } from "tabulark/excel";\n`
    + `import { CanvasTablePainter, createTableController } from "tabulark/experimental";\n`
    + `const arrowOptions: ArrowIpcAdapterOptions = { container: "auto" };\n`
    + `const parquetOptions: ParquetAdapterOptions = { sourceName: "sample.parquet" };\n`
    + `const excelOptions: ExcelAdapterOptions = { format: "auto", sourceName: "sample.xlsx" };\n`
    + `const engine = createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter, parquetAdapter, excelAdapter] });\n`
    + `declare const batch: TableBatch;\n`
    + `const display: readonly (readonly (string | null)[])[] = batch.toDisplayRows();\n`
    + `const first = batch.columns[0]?.getValue(0);\n`
    + `declare const presentation: TablePresentation | null;\n`
    + `// @ts-expect-error wire buffers are private implementation details\n`
    + `batch.buffers;\n`
    + `// @ts-expect-error native descriptors are private implementation details\n`
    + `batch.columns[0]?.native;\n`
    + `void arrowOptions; void parquetOptions; void excelOptions; void engine; void display; void first; void presentation;\n`
    + `void createCanvasTableView; void CanvasTablePainter; void createTableController;\n`,
  "utf8",
);
await writeFile(
  resolve(smokeRoot, "tsconfig.json"),
  `${JSON.stringify({
    compilerOptions: {
      lib: ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
    },
    files: ["consumer.ts"],
  }, null, 2)}\n`,
  "utf8",
);
run(process.execPath, [
  resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
  "--project",
  resolve(smokeRoot, "tsconfig.json"),
], smokeRoot);

console.log(
  `Validated ${packResult.filename}: five entrypoints, stable API boundary, declarations, maps, and four WASM artifacts.`,
);

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
    ?? (process.platform === "win32"
      ? resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")
      : undefined);
  if (npmCli !== undefined) {
    return run(process.execPath, [npmCli, ...args], cwd);
  }
  return run("npm", args, cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
  return result.stdout ?? "";
}

function assertInsideTarget(path) {
  if (path === targetRoot || !path.startsWith(`${targetRoot}${sep}`)) {
    throw new Error(`Refusing package-smoke operation outside target/: ${path}`);
  }
}

function packageSpecifier(entrypoint) {
  return entrypoint === "." ? "tabulark" : `tabulark${entrypoint.slice(1)}`;
}

function assertExport(manifest, key, expectedImport, expectedTypes) {
  const descriptor = manifest.exports?.[key];
  if (
    descriptor?.import !== expectedImport
    || descriptor?.default !== expectedImport
    || descriptor?.types !== expectedTypes
  ) {
    throw new Error(`Packed consumer has an invalid ${key} export map`);
  }
}
