import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const wasmInput = fileURLToPath(
  new URL("target/wasm32-unknown-unknown/release/tabulark.wasm", rootUrl),
);
const outDir = fileURLToPath(new URL("dist/wasm/", rootUrl));

run("cargo", [
  "build",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--no-default-features",
  "--features",
  "wasm",
]);
await mkdir(outDir, { recursive: true });
run("wasm-bindgen", [
  wasmInput,
  "--target",
  "web",
  "--out-dir",
  outDir,
  "--out-name",
  "tabulark",
]);

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
