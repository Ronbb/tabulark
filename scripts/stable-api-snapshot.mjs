import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const declarationRoot = new URL("../dist/", import.meta.url);
const snapshotUrl = new URL(
  "../test/fixtures/api/stable-declarations-v0.2.json",
  import.meta.url,
);
const historicalV01SnapshotUrl = new URL(
  "../test/fixtures/api/stable-declarations-v0.1.json",
  import.meta.url,
);

const stableEntrypoints = Object.freeze({
  ".": "index.d.ts",
  "./arrow": "arrow.d.ts",
  "./parquet": "parquet.d.ts",
  "./excel": "excel.d.ts",
  "./http": "http.d.ts",
});

export async function collectStableDeclarationSnapshot() {
  const pending = Object.values(stableEntrypoints).map((path) => new URL(path, declarationRoot));
  const declarations = new Map();

  while (pending.length > 0) {
    const declarationUrl = pending.pop();
    if (declarationUrl === undefined) break;
    const key = declarationKey(declarationUrl);
    if (declarations.has(key)) continue;

    const source = normalizeDeclaration(await readFile(declarationUrl, "utf8"));
    declarations.set(key, Object.freeze({
      bytes: Buffer.byteLength(source),
      sha256: createHash("sha256").update(source).digest("hex"),
    }));

    for (const specifier of relativeDeclarationSpecifiers(source)) {
      const imported = new URL(specifier.replace(/\.js$/u, ".d.ts"), declarationUrl);
      declarationKey(imported);
      pending.push(imported);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    compatibilityLine: "0.2.x",
    entrypoints: stableEntrypoints,
    files: Object.fromEntries([...declarations].sort(([left], [right]) => left.localeCompare(right))),
  });
}

export async function readCommittedStableDeclarationSnapshot() {
  return JSON.parse(await readFile(snapshotUrl, "utf8"));
}

export async function readHistoricalV01DeclarationSnapshot() {
  return JSON.parse(await readFile(historicalV01SnapshotUrl, "utf8"));
}

function normalizeDeclaration(source) {
  return `${source.replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}

function relativeDeclarationSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:from\s+|import\s*\()\s*["'](\.[^"']+\.js)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function declarationKey(url) {
  if (!url.href.startsWith(declarationRoot.href)) {
    throw new Error(`stable declaration import escapes dist: ${url.href}`);
  }
  return `dist/${decodeURIComponent(url.href.slice(declarationRoot.href.length))}`;
}

async function main() {
  const actual = await collectStableDeclarationSnapshot();
  if (process.argv.includes("--print")) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = await readCommittedStableDeclarationSnapshot();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.stderr.write(
      "Stable 0.2 declaration surface changed. Review compatibility and update the checked-in snapshot deliberately.\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
