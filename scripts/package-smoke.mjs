#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetRoot = resolve(repositoryRoot, "target");
const smokeRoot = resolve(targetRoot, "package-smoke");
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
  "dist/index.js",
  "dist/index.js.map",
  "dist/index.d.ts",
  "dist/arrow.js",
  "dist/arrow.js.map",
  "dist/arrow.d.ts",
  "dist/worker.js",
  "dist/worker.js.map",
  "dist/worker.d.ts",
  "dist/wasm/delimited/tabulark_delimited.js",
  "dist/wasm/delimited/tabulark_delimited.d.ts",
  "dist/wasm/delimited/tabulark_delimited_bg.wasm",
  "dist/wasm/delimited/tabulark_delimited_bg.wasm.d.ts",
  "dist/wasm/arrow/tabulark_arrow.js",
  "dist/wasm/arrow/tabulark_arrow.d.ts",
  "dist/wasm/arrow/tabulark_arrow_bg.wasm",
  "dist/wasm/arrow/tabulark_arrow_bg.wasm.d.ts",
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "THIRD_PARTY_NOTICES.md",
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
assertExport(installedManifest, ".", "./dist/index.js", "./dist/index.d.ts");
assertExport(installedManifest, "./arrow", "./dist/arrow.js", "./dist/arrow.d.ts");

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
  `import { ADAPTER_API_VERSION, PROTOCOL_VERSION, delimitedAdapter } from "tabulark";\n`
    + `import { arrowIpcAdapter } from "tabulark/arrow";\n`
    + `if (PROTOCOL_VERSION !== 2 || ADAPTER_API_VERSION !== 1) throw new Error("version export mismatch");\n`
    + `if (delimitedAdapter.id !== "tabulark:delimited") throw new Error("delimited export mismatch");\n`
    + `if (arrowIpcAdapter.id !== "tabulark:arrow-ipc") throw new Error("arrow export mismatch");\n`,
  "utf8",
);
run(process.execPath, [resolve(smokeRoot, "consumer.mjs")], smokeRoot);

await writeFile(
  resolve(smokeRoot, "consumer.ts"),
  `import { createEngine, delimitedAdapter, type TableBatch } from "tabulark";\n`
    + `import { arrowIpcAdapter, type ArrowIpcAdapterOptions } from "tabulark/arrow";\n`
    + `const arrowOptions: ArrowIpcAdapterOptions = { container: "auto" };\n`
    + `const engine = createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter] });\n`
    + `declare const batch: TableBatch;\n`
    + `const display: readonly (readonly (string | null)[])[] = batch.toDisplayRows();\n`
    + `void arrowOptions; void engine; void display;\n`,
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
  `Validated ${packResult.filename}: root and /arrow exports, declarations, maps, and both WASM artifacts.`,
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
