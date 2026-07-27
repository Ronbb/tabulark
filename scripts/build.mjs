import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const dist = fileURLToPath(new URL("dist/", rootUrl));
const officialManifest = JSON.parse(await readFile(
  fileURLToPath(new URL("js/official-adapters.json", rootUrl)),
  "utf8",
));

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
  // Keep identifiers and syntax stable for readable stacks while removing
  // formatting-only bytes from every shipped runtime bundle.
  minifyWhitespace: true,
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
};

const adapterEntrypoints = new Map();
for (const adapter of officialManifest.adapters) {
  const outputName = adapter.entrypoint === "." ? "index" : adapter.entrypoint.replace(/^\.\//u, "");
  adapterEntrypoints.set(outputName, outputName);
}

await Promise.all([
  ...[...adapterEntrypoints].map(([sourceName, outputName]) => build({
    ...shared,
    // Keep the stable root under its frozen delivery ceiling. Source maps
    // preserve debuggability while production identifier/syntax compaction
    // avoids charging readable internal names to every local consumer.
    ...(sourceName === "index" ? { minify: true } : {}),
    entryPoints: [fileURLToPath(new URL(`js/${sourceName}.ts`, rootUrl))],
    outfile: fileURLToPath(new URL(`dist/${outputName}.js`, rootUrl)),
  })),
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL("js/experimental.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/experimental.js", rootUrl)),
  }),
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL("js/http.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/http.js", rootUrl)),
  }),
  build({
    ...shared,
    // The Worker is a private protocol endpoint: compact its internal names
    // while keeping source maps for diagnostics. This pays for ABI-v3
    // validation without relaxing the frozen P0 Worker-size ceiling.
    minify: true,
    // This private module is a separately measured, lazy Worker capability.
    // Preserving the relative import ensures Blob/ArrayBuffer opens never
    // download its HTTP/provider broker and interval cache.
    external: ["./worker-range-source.js"],
    entryPoints: [fileURLToPath(new URL("js/worker.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/worker.js", rootUrl)),
  }),
  build({
    ...shared,
    minify: true,
    entryPoints: [fileURLToPath(new URL("js/worker-range-source.ts", rootUrl))],
    outfile: fileURLToPath(new URL("dist/worker-range-source.js", rootUrl)),
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
