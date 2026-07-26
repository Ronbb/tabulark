# Tabulark

> **Status: 0.1.0 released; 0.1.1 stabilization and M6 are in progress.**
> The immutable `v0.1.0` tag and its registry/Pages evidence are recorded in
> [the release evidence](docs/release-0.1.0-evidence.md). The 0.1.1 line adds
> compatible diagnostics, capability queries, performance observation, and
> synchronized Canvas themes. M6 is separately gated 2 GiB local-Blob work.

Tabulark is a WebAssembly-first browser primitive for previewing local tabular
data without uploading it. A module Worker owns parsing, bounded byte access,
adapter state, cancellation, and cleanup. A Canvas viewport renders visible
cells while a bounded semantic grid supplies keyboard and screen-reader access.

[Try the playground](https://ronbb.github.io/tabulark/) · [Architecture](docs/architecture.md) · [API stability](docs/api-stability.md) · [Testing](docs/testing.md)

## Supported local formats

The 0.1.0 source tree contains four immutable official adapters. Each adapter
is a separate, lazily loaded WebAssembly artifact; creating an engine loads no
WASM and opening one format does not fetch unused artifacts.

| Format | Official ID | Stable entry point | 0.1 contract |
| --- | --- | --- | --- |
| CSV/TSV | `tabulark:delimited` | `tabulark` | Explicit delimiter, header, and strict/lenient modes |
| Arrow IPC | `tabulark:arrow-ipc` | `tabulark/arrow` | File/Stream; none, LZ4, and Zstd IPC compression |
| Parquet | `tabulark:parquet` | `tabulark/parquet` | Range-driven row-group/column projection and the documented codec set |
| Excel | `tabulark:excel` | `tabulark/excel` | Excel 97–2003 BIFF8 XLS and OOXML XLSX, including static presentation |

Remote sources, arbitrary adapter/module URLs, public third-party adapters,
persistent caches, formula calculation, editing, and document-level Excel
round-tripping are outside 0.1.

## Install and build

The npm package has no production JavaScript dependencies. It targets modern
Chromium and requires Node 20 or newer to build from source. Rust 1.85 is the
minimum supported Rust version.

```sh
npm ci
npm run build
npm run check
npm run test:browser
```

`npm run build` creates five public JavaScript entry points, a generic Worker,
and independent Delimited, Arrow, Parquet, and Excel WASM artifacts under
`dist/wasm/`.

## Stable JavaScript API

Register only the adapters an engine may use. The allow-list is immutable for
that engine's lifetime, and the only accepted source inputs are `File`, `Blob`,
and `ArrayBuffer`.

```ts
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";
import { parquetAdapter } from "tabulark/parquet";
import { excelAdapter } from "tabulark/excel";

const engine = await createEngine({
  adapters: [delimitedAdapter, arrowIpcAdapter, parquetAdapter, excelAdapter],
});

const csv = await engine.open(csvFile, {
  adapter: delimitedAdapter,
  sourceMode: "auto", // use "large" for a local File/Blob up to 2 GiB
  adapterOptions: {
    dialect: "csv",
    header: "first-row",
    mode: "lenient",
  },
});

const parquet = await engine.open(parquetFile, {
  adapter: parquetAdapter,
  adapterOptions: { sourceName: parquetFile.name },
});

const workbook = await engine.open(excelFile, {
  adapter: excelAdapter,
  adapterOptions: { format: "auto", sourceName: excelFile.name },
});
```

In the stable API, adapter selection is explicit. Excel's `format: "auto"` and Arrow's
`container: "auto"` inspect source bytes; filename extensions never select or
authenticate a format.

The bundled playground is a convenience layer: it uses the local file name,
MIME type, and (when needed) a bounded signature read to choose the explicit
adapter call for you. Applications using the stable API should continue to
select and register an adapter themselves.

`ArrayBuffer` ownership is retained by default. Set `transferInput: true` only
when intentionally detaching an `ArrayBuffer`; using it with a `Blob` or
`File` returns `INVALID_ARGUMENT`.

`sourceMode: "auto"` keeps the conservative source policy. The opt-in
`sourceMode: "large"` path accepts a local `File`/`Blob` no larger than
`2,147,483,648` bytes (2 GiB); it does not raise the existing `ArrayBuffer`
staging limit or allocate a work set proportional to the file. A larger source
fails before an open request is sent to the Worker, with `RESOURCE_LIMIT` details containing
`resource`, `requiredBytes`, and `availableBytes`.

The range-backed large-mode Excel path currently covers OOXML `format: "xlsx"`.
BIFF8 `format: "xls"` remains on the bounded compatibility staging path until
the separate CFB large-offset gate passes; use the capability snapshot rather
than assuming every Excel container is eligible for 2 GiB range access.

### Tables, logical batches, and presentation

```ts
const table = await workbook.openTable(workbook.tables[0].id);
const batch = await table.readRange({
  rowStart: 0,
  rowCount: 100,
  columnStart: 0,
  columnCount: table.metadata.schema.columns.length,
});

const nativeRows = batch.toRows();
const displayRows = batch.toDisplayRows();
const presentation = await table.getPresentation();
const visiblePresentation = await table.readPresentationRange(batch.range);
```

The stable `TableBatch` exposes logical data, its returned range, columns, and
logical accessors. WASM buffer regions, wire descriptors, protocol versions,
adapter ABI versions, and physical batch layout are private implementation
details.

`toRows()` preserves native values such as `bigint`, `Uint8Array`, decimals,
temporal values, lists, structs, maps, and unions. `toDisplayRows()` returns
only `(string | null)[][]` for rendering, accessibility, sizing, and copy.

Excel tables can return a `spreadsheet-v1` presentation. It includes sheet
visibility, frozen rows/columns, sparse row and column sizes/hidden state, a
deduplicated static style table, range-aligned style IDs, and intersecting
merged cells. Styles cover number formats, fonts, colors, fills, borders, and
alignment. The high-level Canvas view uses presentation automatically:

```ts
const view = createCanvasTableView({
  container,
  table,
  presentation: "auto", // default; use "ignore" for logical data only
});
```

Forced-colors mode overrides workbook colors while retaining dimensions,
merges, alignment, and font emphasis.

Low-level painter, controller, layout, hit-testing, and selection primitives
live under `tabulark/experimental` and carry no compatibility promise.

## Format behavior

### Parquet

Each file exposes one table. The adapter reads the footer and metadata first,
then only row groups and top-level projected columns intersecting a request; it
does not stage the full file. Supported compression is uncompressed, Snappy,
Gzip, Brotli, LZ4, LZ4_RAW, and Zstd. INT96 becomes a timezone-free nanosecond
timestamp. LZO, encrypted Parquet, and experimental Variant/Geo types return
`UNSUPPORTED_FEATURE`.

All promised Parquet codecs in the official WebAssembly adapter use Rust
implementations. Arrow/Parquet 59.1.0 calls the narrow `zstd` 0.13 bulk API
directly, so the workspace supplies a Rust 1.85-compatible implementation of
that API backed by pinned `ruzstd` 0.8.1. The release gate proves the official
Arrow and Parquet WASM graphs contain neither `zstd-sys` nor `zstd-safe`.

Cargo removes workspace patches when it publishes a crate. Therefore the
experimental crates.io Rust features deliberately do not enable upstream's
Zstd feature; Zstd is part of the stable JavaScript/WASM format contract, not
the experimental Rust API contract. This prevents a crates.io consumer from
silently receiving a C-backed implementation.

### Excel

Each worksheet becomes a table in workbook order with an ID such as
`sheet-0`. Hidden and very-hidden worksheets remain addressable and preserve
visibility. Chart, dialog, and macro sheets are skipped with a warning.

Columns are named A, B, …; the first row is always data; empty cells are null.
Excel values are display strings (`typedValues=false`). Formula cells use only
their cached result—Tabulark never executes formulas—and missing cached values
become null with a warning. Merged cells use the top-left value as their anchor.

XLS support is deliberately limited to BIFF8. Earlier BIFF, XLSM, XLSB, ODS,
and encrypted workbooks return `UNSUPPORTED_FEATURE`. XLS and XLSX share the
same bounded static-presentation subset.

## Memory and lifecycle

One engine-wide reservation ledger accounts for adapter runtimes, source
staging, compressed/decompressed pages, opened worksheets, batches, and caches.
`RESOURCE_LIMIT` errors identify the resource category and the required and
available amounts. Excel stages one bounded workbook; Parquet performs bounded
range reads. ZIP/CFB entry counts, decompressed bytes, worksheet dimensions,
cells, styles, layout entries, and merged regions are capped before allocation.

Handles are nested and cleanup cascades downward:

```text
Engine
  └─ DatasetSession
       └─ TableHandle
            └─ TableBatch
```

Close operations are idempotent. Closing a dataset closes its tables; closing
an engine closes every dataset. Cancellation and close races settle once, and
reservations are released on success, failure, cancellation, and close.

```ts
view.destroy();
await table.close();
await workbook.close();
await engine.close();
```

## Verification

```sh
# Rust 1.85/stable, Clippy, all features, lifecycle, fixtures, fuzz seeds
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --locked

# Stable exports/declarations, clean package consumers, and Pages assembly
npm run check

# Real module Worker/WASM, Canvas, ARIA, keyboard, copy, forced-colors, visuals
npm run test:browser

# Independent core, Arrow, Parquet, Excel, npm, and Pages delivery budgets
npm run benchmark:size

# Parquet/XLS/XLSX cold-open, range-read, and Chromium memory evidence
npm run benchmark:formats
```

Chromium remains the formal browser gate. CI records its exact version for each
release line; the 0.1.0 value is preserved in the release evidence record.
The Pages post-deploy smoke opens CSV, Arrow IPC, Parquet, XLS, and XLSX and
asserts that only used adapter artifacts were requested.

## Stability and release

The root, `/arrow`, `/parquet`, and `/excel` entry points are stable for 0.1.x:
compatible additions are allowed, but removals and breaking changes wait for
0.2.0. Rust APIs, the Worker protocol, adapter ABI, wire DTOs, and
`/experimental` remain experimental/private.

The `v0.1.0` tag is immutable and must never be moved or reused. npm and
crates.io publishing is serialized behind protected GitHub Environments with
required reviewer approval; recovery finalizes artifacts without republishing.
See
[docs/releasing.md](docs/releasing.md) for the immutable-release and patch
recovery policy.

## Repository map

```text
src/                         shared Rust model, protocol, and native adapters
crates/tabulark-*-wasm/      four independently built WASM entry crates
js/                          stable API, private Worker host, batches, and view
examples/csv-preview/        static six-format Playground
test/fixtures/               pinned format fixtures and provenance
test/browser/                Chromium, accessibility, visual, and Pages smoke
test/performance/            performance and per-artifact delivery budgets
docs/                        architecture, testing, stability, and release policy
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
Shipped third-party material is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
