import { mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const dist = fileURLToPath(new URL("dist/", rootUrl));

await cleanJavaScriptArtifacts(dist);

run(process.execPath, [
  fileURLToPath(new URL("node_modules/typescript/bin/tsc", rootUrl)),
  "--project",
  fileURLToPath(new URL("tsconfig.build.json", rootUrl)),
]);

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL("js/index.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/index.js", rootUrl)),
  }),
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL("js/arrow.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/arrow.js", rootUrl)),
  }),
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL("js/worker.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/worker.js", rootUrl)),
  }),
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

async function cleanJavaScriptArtifacts(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    // The WebAssembly build owns this directory. Keeping it makes `build:js`
    // safe to run independently after a complete browser build.
    if (entry.isDirectory() && entry.name === "wasm") {
      return;
    }
    await rm(path, { recursive: entry.isDirectory(), force: true });
  }));
}
