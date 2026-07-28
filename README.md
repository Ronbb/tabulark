# Tabulark

> **Status: 0.2.1.** The immutable `v0.1.0` tag and its registry/Pages
> evidence remain recorded in
> [the release evidence](docs/release-0.1.0-evidence.md); that tag is never
> moved or reused. Version 0.2 adds bounded local and remote range sources,
> structured diagnostics and capabilities, performance observation, and
> synchronized Canvas themes without changing the documented 0.1.0 calling
> patterns. Local `sourceMode: "large"` remains capped at 2 GiB; a validated
> `RangeSource` may address at most `4,294,967,295` bytes (`2^32 - 1`).

Tabulark is a WebAssembly-first browser primitive for previewing tabular data
without uploading it. Local bytes stay local; an explicit `RangeSource` can
read a remote object through a main-thread broker without giving its URL,
credentials, or headers to the Worker. A module Worker owns parsing, bounded
byte access, adapter state, cancellation, and cleanup. A Canvas viewport
renders visible cells while a bounded semantic grid supplies keyboard and
screen-reader access.

[Try the playground](https://ronbb.github.io/tabulark/) · [Architecture](docs/architecture.md) · [API stability](docs/api-stability.md) · [Testing](docs/testing.md)

## Supported local formats

The 0.2.1 source tree contains four official adapters. Each adapter
is a separate, lazily loaded WebAssembly artifact; creating an engine loads no
WASM and opening one format does not fetch unused artifacts.

| Format | Official ID | Stable entry point | 0.2 contract |
| --- | --- | --- | --- |
| CSV/TSV | `tabulark:delimited` | `tabulark` | Explicit delimiter, header, and strict/lenient modes |
| Arrow IPC | `tabulark:arrow-ipc` | `tabulark/arrow` | File/Stream; none, LZ4, and Zstd IPC compression |
| Parquet | `tabulark:parquet` | `tabulark/parquet` | Range-driven row-group/column projection and the documented codec set |
| Excel | `tabulark:excel` | `tabulark/excel` | Excel 97–2003 BIFF8 XLS and OOXML XLSX, including static presentation |

Arbitrary adapter/module URLs, public third-party adapters, persistent caches,
ReadableStream sources, formula calculation, editing, and document-level Excel
round-tripping are outside 0.2. Remote input is available only through the
explicit `RangeSource` contract (or the opt-in `tabulark/http` helper).

## Install and build

The npm package has no production JavaScript dependencies. Its desktop release
gate covers Chromium, Firefox, and WebKit, and it requires Node 20 or newer to
build from source. Rust 1.85 is the minimum supported Rust version.

```sh
npm ci
npm run build
npm run check
npm run test:browser
```

`npm run build` creates six public JavaScript entry points, a generic Worker,
and independent Delimited, Arrow, Parquet, and Excel WASM artifacts under
`dist/wasm/`.

## Stable JavaScript API

Register only the adapters an engine may use. The allow-list is immutable for
that engine's lifetime. Local inputs are `File`, `Blob`, and `ArrayBuffer`; an
explicit `RangeSource` is the bounded remote (or application-owned) source
capability.

```ts
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";
import { parquetAdapter } from "tabulark/parquet";
import { excelAdapter } from "tabulark/excel";
import { httpRangeSource } from "tabulark/http";

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

const remote = httpRangeSource("https://data.example.test/table.parquet", {
  credentials: "include",
  validation: "strong", // ETag, or Last-Modified + length when permitted
  maxConcurrency: 2,
});
const remoteTable = await engine.open(remote, {
  adapter: parquetAdapter,
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
`sourceMode: "large"` path accepts only a local `File`/`Blob` no larger than
exactly `2,147,483,648` bytes (`2^31`, 2 GiB); it does not raise the existing
`ArrayBuffer` staging limit or allocate a work set proportional to the file. A
larger source fails before an open request is sent to the Worker, with
`RESOURCE_LIMIT` details containing `resource`, `requiredBytes`, and
`availableBytes`.

`RangeSource` readers report an exact size and snapshot validator and return
exactly the requested bytes. `TabularkEngine.open()` creates an independent
reader for each open and closes it exactly once on failure, cancellation, or
dataset/engine close. `sourceMode` and `transferInput` are rejected for a
`RangeSource`. The source ceiling is exactly `4,294,967,295` bytes; a 4 GiB
source is rejected before adapter startup. The Worker receives only an opaque
source handle, size, and bounded transferable byte buffers. Provider requests
are merged for overlap/adjacency, limited to four concurrent reads, and
covered by a dataset range-cache/singleflight layer.

The `tabulark/http` helper probes with `GET Range: bytes=0-0`, requires a
precise `Content-Range` and a trusted ETag (or an explicitly allowed weak
Last-Modified-plus-length validator), and revalidates every `206` response.
Retries are bounded and limited to transient network/status failures. A full
download is never implicit: `fallback: { mode: "bounded-download", maxBytes }`
must be supplied and must fit both that bound and the engine staging budget.
Error messages and performance samples omit URLs, query strings, headers,
validators, and snapshot identifiers.

The exact-boundary local-file release gate covers five real containers: CSV,
Arrow File, Parquet, XLSX, and XLS. Each fixture is exactly `2^31` bytes and
the test reads the final bounded window ending at byte `2^31 - 1`. Remote
RangeSource gates separately use a virtual/sparse source at
`4,294,967,295` bytes and exercise non-adjacent offsets above `2^31` without
allocating oversized browser fixtures. Overflow and 4 GiB rejection are
checked before adapter startup.

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

For large XLSX, Rust indexes ZIP/ZIP64 metadata and fetches the workbook,
relationships, shared resources, and selected worksheet ranges. For large XLS,
Rust indexes CFB/DIFAT/FAT/miniFAT/directory data and fetches the referenced
Workbook/Book stream ranges. In both cases it compacts only the needed content
into a bounded workbook for the existing Calamine compatibility parser. This
does not imply a custom XML/BIFF checkpoint engine or worksheet tile store.

## Memory, cache, and lifecycle

The main thread owns the only decoded-batch cache. It stores immutable backing
objects keyed by dataset, logical table, revision, schema version, and
normalized range; each API call receives a fresh logical facade. Concurrent
identical misses are singleflight operations. Cancelling one caller does not
cancel work shared by others, while cancelling every waiter sends one Worker
cancel. A table handle may close without discarding its logical-table backing;
dataset close or a revision/schema change evicts it.

The Worker coordinates the engine-wide quota across adapters. Inside each
Rust/WASM runtime, a checked ledger distinguishes persistent state, active
operations, ingress/output, reclaimable native cache, and caller-owned
telemetry. Admission clears soft native cache and retries once before returning
`RESOURCE_LIMIT`, whose details identify required and available capacity.
ZIP/CFB entries, decompression, worksheet dimensions, cells, styles, layout,
merged regions, Parquet pages, and decoded batches remain bounded.

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

# Real module Worker/WASM, Canvas, ARIA, keyboard, copy, and forced-colors
npm run test:browser

# Independent core, Arrow, Parquet, Excel, npm, and Pages delivery budgets
npm run benchmark:size

# Parquet/XLS/XLSX cold-open, range-read, and Chromium memory evidence
npm run benchmark:formats
```

Chromium, Firefox, and WebKit are all release-blocking desktop functional gates.
Chromium additionally owns exact pixel snapshots, performance comparison, real
Clipboard API coverage, and the exact-2-GiB workflow. Firefox and WebKit cover
the four adapters, lifecycle, Blob ranges, themes, ARIA, input behavior, copy
through a deterministic clipboard seam, and Pages smoke. The Pages post-deploy
smoke opens CSV, Arrow IPC, Parquet, XLS, and XLSX and asserts that only used
adapter artifacts were requested.

## Stability and release

The root, `/arrow`, `/parquet`, `/excel`, and `/http` entry points are stable
for 0.2.x. (`/experimental` remains explicitly unstable.)
Version 0.2 preserves the documented 0.1.0 calls and adds diagnostics,
capability queries, performance observation, `SourceMode`, and Canvas themes.
Rust APIs, Worker protocol v4, adapter ABI v3, wire DTOs, batch layout v1, and
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
js/                          stable API, HTTP/range broker, private Worker host,
                             batches, and view
examples/csv-preview/        static six-format Playground
test/fixtures/               pinned format fixtures and provenance
test/browser/                three-browser behavior, Chromium visual/performance, and Pages smoke
test/performance/            performance and per-artifact delivery budgets
docs/                        architecture, testing, stability, and release policy
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
Shipped third-party material is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
