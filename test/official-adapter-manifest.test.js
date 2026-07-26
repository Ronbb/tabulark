import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("official adapter manifest owns stable IDs, entrypoints, exports, and artifacts", async () => {
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, "js", "official-adapters.json"),
    "utf8",
  ));
  const packageManifest = JSON.parse(await readFile(
    join(repositoryRoot, "package.json"),
    "utf8",
  ));

  assert.equal(manifest.manifestVersion, 1);
  assert.deepEqual(manifest.adapters.map(({ id }) => id), [
    "tabulark:delimited",
    "tabulark:arrow-ipc",
    "tabulark:parquet",
    "tabulark:excel",
  ]);
  assert.deepEqual(manifest.adapters.map(({ entrypoint }) => entrypoint), [
    ".",
    "./arrow",
    "./parquet",
    "./excel",
  ]);
  assert.equal(new Set(manifest.adapters.map(({ id }) => id)).size, manifest.adapters.length);
  assert.equal(
    new Set(manifest.adapters.map(({ wasm }) => wasm.outputDirectory)).size,
    manifest.adapters.length,
  );

  for (const adapter of manifest.adapters) {
    assert.equal(adapter.wasm.runtimeExport, "WasmRuntime", adapter.id);
    assert.match(adapter.wasm.modulePath, /^\.\/wasm\//u, adapter.id);
    assert.match(adapter.wasm.outputDirectory, /^dist\/wasm\//u, adapter.id);
    assert.equal(
      new Set(adapter.options.allowedKeys).size,
      adapter.options.allowedKeys.length,
      `${adapter.id} option keys`,
    );
    assert.ok(adapter.resources.runtimeWeight > 0, `${adapter.id} runtime weight`);

    const bundle = adapter.entrypoint === "."
      ? "index"
      : adapter.entrypoint.replace(/^\.\//u, "");
    const exported = await import(pathToFileURL(join(repositoryRoot, "dist", `${bundle}.js`)));
    assert.ok(adapter.exportName in exported, `${adapter.entrypoint} exports ${adapter.exportName}`);
    assert.equal(exported[adapter.exportName].id, adapter.id, adapter.exportName);

    const packageExport = packageManifest.exports[adapter.entrypoint];
    assert.deepEqual(packageExport, {
      types: `./dist/${bundle}.d.ts`,
      import: `./dist/${bundle}.js`,
      default: `./dist/${bundle}.js`,
    });
  }
});

test("build, Pages, and package checks derive official adapter sets from the manifest", async () => {
  const files = [
    "scripts/build.mjs",
    "scripts/build-wasm.mjs",
    "scripts/build-pages.mjs",
    "scripts/package-smoke.mjs",
    "scripts/registry-smoke.mjs",
    "test/performance/measure-sizes.mjs",
  ];
  for (const file of files) {
    const source = await readFile(join(repositoryRoot, file), "utf8");
    assert.match(source, /official-adapters\.json/u, `${file} reads the manifest`);
    assert.match(source, /officialManifest\.adapters/u, `${file} derives adapters`);
  }

  const source = await readFile(
    join(repositoryRoot, "js", "official-adapter-manifest.ts"),
    "utf8",
  );
  assert.match(source, /manifestEntries\.map\(\(entry\) => entry\.id\)/u);
  assert.doesNotMatch(
    source,
    /export const OFFICIAL_ADAPTER_IDS\s*=\s*\[\s*"tabulark:/u,
    "runtime ID arrays must not duplicate manifest values",
  );
});
