import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const tsc = spawnSync(process.execPath, [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "--project", resolve(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
if (tsc.error) throw tsc.error;
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
};
await Promise.all([
  build({ ...common, entryPoints: [resolve(root, "src/index.ts")], outfile: resolve(dist, "index.js"), external: ["./pdf-worker.js"] }),
  build({ ...common, entryPoints: [resolve(root, "src/pdf-worker.ts")], outfile: resolve(dist, "pdf-worker.js") }),
  copyFile(resolve(repositoryRoot, "node_modules/@hyzyla/pdfium/dist/pdfium.wasm"), resolve(dist, "pdfium.wasm")),
]);
