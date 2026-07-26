# MVP and milestone status

> **Current status: M4 complete; M5 is an unreleased 0.1.0 release
> candidate.** M4's CI, GitHub Pages deployment, and deployed-URL smoke
> succeeded for `1d79837`. The repository's 0.1.0 version fields do not mean a
> `v0.1.0` tag exists or that npm/crates.io publication has occurred.

## Product boundary

Tabulark is a local browser preview primitive, not a spreadsheet editor or
database product. It accepts `File`, `Blob`, or `ArrayBuffer`, opens the source
through an explicitly selected official adapter in a Worker, exposes bounded
dataset/table/range APIs, and renders a keyboard-accessible Canvas viewport
with a bounded semantic grid.

The 0.1.0 candidate contains exactly four official adapter IDs:

- `tabulark:delimited` for CSV/TSV.
- `tabulark:arrow-ipc` for Arrow IPC File/Stream.
- `tabulark:parquet` for Parquet.
- `tabulark:excel` for BIFF8 XLS and OOXML XLSX.

Network range providers, `ReadableStream`, persistent caches, arbitrary
JavaScript adapters, application-defined module URLs, and remote registries
remain outside this release.

## Milestone history

### M0-M2: table model and first vertical slice

The early work established the table model, Worker RPC, Rust/WASM integration,
incremental CSV/TSV parsing, range reads, Canvas rendering, and a bounded ARIA
grid.

### M3: CSV/TSV hardening and measurement

M3 produced the original delimited vertical-slice evidence:

- Versioned corpus and fuzz seeds for tricky CSV/TSV inputs.
- Real Worker/WASM lifecycle, cancellation, resource-limit, and recovery tests.
- Canvas snapshots, keyboard selection/copy/resize, CJK propagation, axe,
  forced-colors, and responsive checks.
- A reproducible canonical CSV browser benchmark and independent package/Pages
  size controls.

The M3 canonical CSV baseline remains a protected historical reference. Later
formats do not relax its core raw or Brotli budgets.

### M4: Arrow IPC extension boundary

M4 replaced the provisional CSV-only facade with explicit built-in adapter
registration:

```ts
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";

const engine = await createEngine({
  adapters: [delimitedAdapter, arrowIpcAdapter],
});
```

It moved both formats through one Worker/Rust operation ABI and private
layout-v1 batch transport, while keeping the adapter allow-list immutable and
disallowing arbitrary adapter code or module URLs. Arrow added File/Stream,
none/LZ4/Zstd, projection and ranges across RecordBatches, nested and encoded
logical values, deterministic display values, structured errors, provenance,
and an independently lazy WASM artifact.

M4's required Rust, protocol-v2, fixture, browser, performance, packed-package,
Pages, deployment, and real deployed-URL evidence is complete and frozen in
[`m4-completion.md`](m4-completion.md). That evidence is historical: it does
not claim that the later 0.1.0 format matrix has shipped.

## M5: 0.1.0 release candidate

### Official adapter host and lifecycle

One checked-in manifest now drives the four IDs, entry points, option
validation, WASM build/package/Pages paths, source strategy, and size groups.
Every wrapper exports `WasmRuntime`. Worker protocol v3 and official adapter API
v2 use discriminated open/read steps and support table-scoped
metadata/progress/revisions, presentation queries, and multi-table datasets.
Those interfaces and the typed-buffer wire layout remain private.

A global engine reservation ledger accounts for adapter capacity, staging,
compressed and decompressed data, opened worksheets, batches, and caches.
Close is idempotent, dataset/engine close cascades, cancellation races settle
once, and reservations are released after success, failure, cancellation, or
close. Budget failures use `RESOURCE_LIMIT` with resource and capacity detail.

### Stable JavaScript boundary

The compatibility-covered entries are:

| Entry | Stable purpose |
| --- | --- |
| `tabulark` | `createEngine`, `delimitedAdapter`, Engine/Dataset/Table, logical schema/value/batch, errors, and high-level Canvas view |
| `tabulark/arrow` | `arrowIpcAdapter` |
| `tabulark/parquet` | `parquetAdapter` and `ParquetAdapterOptions { sourceName? }` |
| `tabulark/excel` | `excelAdapter` and `ExcelAdapterOptions { format?: "auto" \| "xls" \| "xlsx"; sourceName? }` |

`tabulark/experimental` contains the low-level painter/controller/layout/
selection primitives and has no compatibility promise. Public `TableBatch`
exposes logical range/data access and `toRows()`/`toDisplayRows()`; physical
buffer regions, transport descriptors, and ABI/protocol/layout constants are
not stable exports. In the 0.1.x line the four stable entries allow compatible
additions only; removals or incompatible changes wait for 0.2.0.

### Parquet

The independently lazy Parquet adapter reads footer, metadata, matching row
groups, and only projected top-level column chunks through bounded range
requests. It supports uncompressed, Snappy, Gzip, Brotli, LZ4, LZ4_RAW, and
Zstd; preserves `u64` offsets internally; reuses typed Arrow batches; and maps
INT96 to a timezone-free nanosecond timestamp. LZO, encrypted Parquet, and the
unsupported Variant/Geo surface fail structurally.

### Excel and presentation

One lazy Excel adapter selects BIFF8 XLS versus OOXML XLSX by signature, not by
extension. It stages a bounded workbook, exposes worksheets in workbook order
as `sheet-{ordinal}`, retains hidden and very-hidden worksheets, and skips
non-worksheet sheet kinds with warnings. Columns are A/B/...; the first row is
data; empty cells are null. Values are display strings in 0.1, formulas use
cached results only, and missing caches warn rather than executing a formula.

`TableHandle.getPresentation()` and `readPresentationRange()` provide the
optional `spreadsheet-v1` contract: visibility, frozen rows/columns, sparse
sizes and hidden state, intersecting merges, range-aligned style IDs, and a
deduplicated static style table. The high-level Canvas view uses presentation
automatically unless `presentation: "ignore"` is selected. Forced colors replace
workbook colors while preserving geometry, merges, alignment, and font
emphasis. Formula calculation, editing, and document-perfect reconstruction
remain out of scope.

### Delivery evidence

The candidate adds independently produced and SHA-locked Parquet and Excel
fixtures, four lifecycle fuzz targets, real-WASM conformance, stable export and
declaration snapshots, Node 20/22/24 clean consumers, Rust 1.85/stable checks,
and separate Parquet/Excel size groups. Chromium is the sole 0.1.0 browser
gate. The assembled and deployed Pages tests open CSV, TSV, Arrow, Parquet,
XLS, and XLSX while proving that only the selected adapter artifact loads.

## Release boundary

M5 is not complete merely because implementation or local tests are green.
The same commit must pass CI, Pages assembly/deployment, the actual deployed-URL
smoke, format/lifecycle/budget/fuzz/size gates, clean consumers, registry
availability and ownership checks, and trusted-publisher confirmation. Only
then may `v0.1.0` trigger protected crates.io -> npm -> GitHub Release ->
registry-smoke delivery. See [`testing.md`](testing.md) and
[`releasing.md`](releasing.md).

No release tag has been created and 0.1.0 has not been published.

## Out of scope for 0.1.0

- Third-party adapter distribution or a stable public adapter ABI.
- Firefox/WebKit compatibility gates.
- Remote sources, persistent caching, and application-controlled streaming.
- SQLite, framework bindings, and Arrow JavaScript/FFI/C Data interfaces.
- XLSM, XLSB, ODS, pre-BIFF8 XLS, encrypted workbooks, and formula execution.
- Editing, workbook round-tripping, or document-level Excel rendering.
