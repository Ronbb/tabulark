import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const wasmOutputRoot = fileURLToPath(new URL("dist/wasm/", rootUrl));

const officialManifest = JSON.parse(await readFile(
  fileURLToPath(new URL("js/official-adapters.json", rootUrl)),
  "utf8",
));
const artifacts = officialManifest.adapters.map(({ wasm }) => ({
  packageName: wasm.packageName,
  wasmName: wasm.crateArtifact,
  outputName: wasm.outputName,
  outputDirectory: `${wasm.outputDirectory}/`,
  runtimeExport: wasm.runtimeExport,
}));

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

// Recreate the complete WASM delivery directory only after every manifest
// crate builds. This prevents an incremental build from silently packaging a
// retired artifact beside the current adapter-specific outputs.
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
  const generatedModule = await readFile(fileURLToPath(new URL(
    `${artifact.outputDirectory}${artifact.outputName}.js`,
    rootUrl,
  )), "utf8");
  if (!generatedModule.includes(`export class ${artifact.runtimeExport}`)) {
    throw new Error(
      `${artifact.packageName} does not export manifest runtime ${artifact.runtimeExport}`,
    );
  }
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
