#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.env.TABULARK_REGISTRY_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version ?? "")) {
  throw new Error("TABULARK_REGISTRY_VERSION must be an exact semantic version");
}

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const targetRoot = resolve(repositoryRoot, "target");
const officialManifest = JSON.parse(await readFile(
  resolve(repositoryRoot, "js", "official-adapters.json"),
  "utf8",
));
const runtimeAdapterImports = officialManifest.adapters.map((adapter, index) => (
  `import { ${adapter.exportName} as adapter${index} } from ${JSON.stringify(packageSpecifier(adapter.entrypoint))};\n`
)).join("");
const runtimeAdapterNames = officialManifest.adapters.map((_, index) => `adapter${index}`);
const expectedAdapterIds = officialManifest.adapters.map(({ id }) => id).sort().join(",");
await mkdir(targetRoot, { recursive: true });
const smokeRoot = await mkdtemp(resolve(targetRoot, "registry-smoke-"));
assertInsideTarget(smokeRoot);

try {
  await writeFile(
    resolve(smokeRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  runNpm([
    "install",
    `tabulark@${version}`,
    "typescript@7.0.2",
    "esbuild@0.28.1",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
  ], smokeRoot);

  await writeFile(
    resolve(smokeRoot, "consumer.mjs"),
    `import { createCanvasTableView, createEngine } from "tabulark";\n`
      + runtimeAdapterImports
      + `import * as experimental from "tabulark/experimental";\n`
      + `const adapters = [${runtimeAdapterNames.join(", ")}];\n`
      + `const ids = adapters.map((adapter) => adapter.id).sort().join(",");\n`
      + `if (ids !== ${JSON.stringify(expectedAdapterIds)}) throw new Error("stable adapter exports mismatch");\n`
      + `if (typeof createEngine !== "function" || typeof createCanvasTableView !== "function" || typeof experimental.CanvasTablePainter !== "function") throw new Error("stable entry point mismatch");\n`,
    "utf8",
  );
  run(process.execPath, [resolve(smokeRoot, "consumer.mjs")], smokeRoot);

  await writeFile(
    resolve(smokeRoot, "consumer.ts"),
    `import { createCanvasTableView, createEngine, delimitedAdapter, type TableBatch, type TablePresentation } from "tabulark";\n`
      + `import { arrowIpcAdapter } from "tabulark/arrow";\n`
      + `import { parquetAdapter, type ParquetAdapterOptions } from "tabulark/parquet";\n`
      + `import { excelAdapter, type ExcelAdapterOptions } from "tabulark/excel";\n`
      + `import { CanvasTablePainter } from "tabulark/experimental";\n`
      + `const parquetOptions: ParquetAdapterOptions = { sourceName: "fixture.parquet" };\n`
      + `const excelOptions: ExcelAdapterOptions = { format: "auto", sourceName: "fixture.xlsx" };\n`
      + `const engine = createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter, parquetAdapter, excelAdapter] });\n`
      + `declare const batch: TableBatch; declare const presentation: TablePresentation | null;\n`
      + `void batch.toDisplayRows; void presentation; void parquetOptions; void excelOptions; void engine; void createCanvasTableView; void CanvasTablePainter;\n`,
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
    resolve(smokeRoot, "node_modules", "typescript", "bin", "tsc"),
    "--project",
    resolve(smokeRoot, "tsconfig.json"),
  ], smokeRoot);
  run(resolve(smokeRoot, "node_modules", "esbuild", "bin", "esbuild"), [
    "consumer.mjs",
    "--bundle",
    "--format=esm",
    "--outfile=bundle.mjs",
  ], smokeRoot);

  console.log(`Registry consumer smoke passed for tabulark@${version}.`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

function packageSpecifier(entrypoint) {
  return entrypoint === "." ? "tabulark" : `tabulark${entrypoint.slice(1)}`;
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
    ?? (process.platform === "win32"
      ? resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")
      : undefined);
  if (npmCli !== undefined) {
    run(process.execPath, [npmCli, ...args], cwd);
  } else {
    run("npm", args, cwd);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function assertInsideTarget(path) {
  if (path === targetRoot || !path.startsWith(`${targetRoot}${sep}`)) {
    throw new Error(`Refusing registry smoke operation outside target/: ${path}`);
  }
}
