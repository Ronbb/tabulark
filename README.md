# Tabulark

> **Status: pre-alpha M4 candidate.** Tabulark has an explicit built-in
> adapter boundary for local CSV/TSV and Apache Arrow IPC. The source and local
> test suite implement the M4 contract, but M4 must not be called complete
> until CI, GitHub Pages deployment, and the deployed-URL smoke test have run
> successfully for the candidate revision.

Tabulark is a WebAssembly-first browser primitive for previewing local tabular
data without uploading it. A module Worker owns parsing, byte access, adapter
state, cancellation, and cleanup; a Canvas viewport renders visible cells; a
bounded semantic grid supplies keyboard and screen-reader access.

[Try the playground](https://ronbb.github.io/tabulark/) · [Architecture](docs/architecture.md) · [M4 migration](docs/m4-migration.md) · [Testing](docs/testing.md)

## What the M4 candidate contains

- Explicit, immutable registration of the built-in CSV/TSV and Arrow IPC
  adapters.
- Separate lazily loaded WebAssembly artifacts. Creating an engine loads no
  WASM; opening CSV/TSV does not fetch Arrow; concurrent first opens share one
  artifact load.
- Apache Arrow IPC File and Stream decoding through Rust/WASM, including
  uncompressed, LZ4, and Zstd IPC payloads.
- A recursive Arrow schema and a generic typed-buffer batch layout shared by
  both adapters.
- Native values for programmatic consumers and stable display strings for the
  Canvas viewport, ARIA grid, sizing, and TSV copy.
- Static GitHub Pages packaging, a pinned Arrow fixture, source maps,
  declarations, third-party notices, browser integration coverage, and size
  gates.

This is not a spreadsheet, a remote data connector, a generic third-party
adapter marketplace, or a released compatibility promise.

## Install and build

The package has no production npm dependencies. It targets modern Chromium
browsers and requires Node 20+ to build from source.

```sh
npm ci
npm run build
npm test
npm run test:browser
```

`npm run build` produces the root runtime, the `tabulark/arrow` entry point, a
generic Worker, and independent Delimited and Arrow WASM artifacts under
`dist/wasm/`.

## Open a source explicitly

Choose adapters when constructing the engine; the engine’s allow-list is fixed
for its lifetime. The only accepted source inputs are `File`, `Blob`, and
`ArrayBuffer`.

```ts
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";

const engine = await createEngine({
  adapters: [delimitedAdapter, arrowIpcAdapter],
});

const csv = await engine.open(csvFile, {
  adapter: delimitedAdapter,
  adapterOptions: {
    dialect: "csv",
    header: "first-row",
    mode: "lenient",
  },
});

const arrow = await engine.open(arrowFile, {
  adapter: arrowIpcAdapter,
  adapterOptions: { container: "auto" }, // "auto" | "file" | "stream"
});
```

Adapter selection never comes from a filename or extension. `container: "auto"`
is resolved by the Rust Arrow adapter from the IPC bytes.

`ArrayBuffer` ownership is retained by default. Use `transferInput: true` only
when intentionally detaching an `ArrayBuffer`; using it with a `Blob` or
`File` fails with `INVALID_ARGUMENT`.

```ts
const moved = await engine.open(buffer, {
  adapter: arrowIpcAdapter,
  transferInput: true,
});
```

The former `format`, `wasmModuleUrl`, and `workerUrl` options are removed. See
[the migration guide](docs/m4-migration.md) for before/after code.

## Read tables and batches

```ts
const table = await arrow.openTable(arrow.tables[0].id);
const batch = await table.readRange({
  rowStart: 0,
  rowCount: 100,
  columnStart: 0,
  columnCount: table.metadata.schema.columns.length,
});

const nativeRows = batch.toRows();
const displayRows = batch.toDisplayRows();
```

`ColumnSchema.dataType` is recursive and replaces the old coarse
`logicalType`. `toRows()` returns native recursive values, including
`bigint`, `Uint8Array`, decimal, temporal, interval, list, struct, map, and
union representations. `toDisplayRows()` returns only `(string | null)[][]`.
The visual renderer, accessible grid, width measurement, and copy path consume
display rows only.

The Rust display contract preserves nulls, renders binary as lowercase `0x…`,
uses `NaN`, `Infinity`, `-Infinity`, and `-0` for special floats, preserves
decimal scale, uses stable ISO temporal text, and escapes tabs/newlines in
nested values.

## Runtime and lifecycle

The public protocol is version 2, the built-in adapter ABI is version 1, and
the batch layout is version 1. Protocol v1 is explicitly rejected. A source
exposes one logical dataset and one or more explicit table handles; callers
close view, table, dataset, and engine resources deliberately.

```ts
view.destroy();
await table.close();
await dataset.close();
await engine.close();
```

The Playground follows the same order before switching sources, closes its
engine on `pagehide`, and creates a new engine after terminal Worker failure.

## Playground and fixtures

`npm run example` builds the static site and serves it locally. The Playground
offers explicit CSV, TSV, and Arrow IPC modes; delimited-only controls disappear
for Arrow, and the file picker accepts `.csv`, `.tsv`, `.arrow`, `.arrows`, and
`.feather`.

The Arrow sample is a committed IPC File fetched as a static asset, not created
in browser JavaScript. Its SHA-256, generator provenance, and Apache
cross-language companion fixture are recorded in
[`test/fixtures/arrow/v1/provenance.json`](test/fixtures/arrow/v1/provenance.json).

## Verification

```sh
# Type, unit, fixture/protocol, and package-consumer checks
npm run check

# Browser Worker, Canvas, ARIA, forced-colors, mobile, and Arrow checks
npm run test:browser

# Build the static artifact and inspect its delivery contents
npm run build:pages

# Enforce independent core/Arrow/npm/Pages size budgets
npm run benchmark:size

# Exercise Arrow File/Stream × none/LZ4/Zstd cold-open, range, real-scroll,
# transfer, and memory baselines against committed multi-batch fixtures
npm run benchmark:arrow

# M3 CSV canonical performance evidence
npm run benchmark:canonical
```

The Pages workflow tests the assembled artifact before upload and then runs a
CSV/TSV/Arrow/copy/console smoke test against the URL returned by GitHub Pages.
Until that post-deploy job has succeeded for a revision, deployed-site evidence
is pending rather than implied by local tests.

## Boundaries and limits

- No public arbitrary JavaScript adapters, module URLs, global adapter registry,
  remote range provider, `ReadableStream`, Arrow JS table, or C Data Interface.
- Arrow tensor, sparse tensor, and non-native-endian messages fail with a
  structured `UNSUPPORTED_FEATURE` error.
- The runtime enforces a nesting depth of 64, up to 16,384 fields, and at most
  250,000 cells per range. Other index, decoding, caching, and display limits
  are derived from the engine memory budget.
- The M4 candidate remains Chromium-first. Firefox/WebKit support, persistent
  caches, additional formats, and framework bindings are future work.

## Repository map

```text
src/                         shared Rust model, protocol, and adapters
crates/tabulark-*-wasm/      thin independently-built WASM entry crates
js/                          public runtime, Worker, typed batch, and view
examples/csv-preview/        static Playground controller
test/fixtures/arrow/         pinned Arrow IPC fixtures and provenance
test/browser/                browser, accessibility, visual, Pages smoke tests
test/performance/            CSV and Arrow performance/size harnesses
docs/                        architecture, testing, milestone, and migration docs
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
Shipped third-party material is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
