import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const wasmOutputRoot = fileURLToPath(new URL("dist/wasm/", rootUrl));

const artifacts = [
  {
    packageName: "tabulark-delimited-wasm",
    wasmName: "tabulark_delimited",
    outputName: "tabulark_delimited",
    outputDirectory: "dist/wasm/delimited/",
  },
  {
    packageName: "tabulark-arrow-wasm",
    wasmName: "tabulark_arrow",
    outputName: "tabulark_arrow",
    outputDirectory: "dist/wasm/arrow/",
  },
];

for (const artifact of artifacts) {
  run("cargo", [
    "build",
    "--package",
    artifact.packageName,
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ]);
}

// Recreate the complete WASM delivery directory only after every crate builds.
// This prevents an incremental M3 -> M4 build from silently packaging the
// retired dist/wasm/tabulark* artifact beside the adapter-specific outputs.
await rm(wasmOutputRoot, { force: true, recursive: true });
await mkdir(wasmOutputRoot, { recursive: true });

for (const artifact of artifacts) {
  const wasmInput = fileURLToPath(new URL(
    `target/wasm32-unknown-unknown/release/${artifact.wasmName}.wasm`,
    rootUrl,
  ));
  const outDir = fileURLToPath(new URL(artifact.outputDirectory, rootUrl));
  await mkdir(outDir, { recursive: true });
  run("wasm-bindgen", [
    wasmInput,
    "--target",
    "web",
    "--out-dir",
    outDir,
    "--out-name",
    artifact.outputName,
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
