# Architecture

> **M4 is complete; this document describes the 0.1.0 release-candidate
> architecture.** The prior M4 CI, Pages, and deployed smoke evidence is frozen
> in [m4-completion.md](m4-completion.md). It is not evidence that 0.1.0 has
> been published.

## Boundary and invariants

Tabulark previews local bytes without sending them to a service. It keeps
format parsing, source staging, and large decoded allocations in a module
Worker; the main thread receives bounded logical batches and paints only a
viewport-sized Canvas and semantic grid.

The only built-in adapters are derived from one checked-in official manifest:

| ID | Public entry point | WASM artifact | Source policy |
| --- | --- | --- | --- |
| `tabulark:delimited` | `tabulark` | `dist/wasm/delimited/` | streaming |
| `tabulark:arrow-ipc` | `tabulark/arrow` | `dist/wasm/arrow/` | range |
| `tabulark:parquet` | `tabulark/parquet` | `dist/wasm/parquet/` | range |
| `tabulark:excel` | `tabulark/excel` | `dist/wasm/excel/` | bounded whole-workbook staging |

The manifest drives descriptor validation, Worker loading, build output,
package and Pages assembly, and size checks. There is no global registry,
arbitrary JavaScript adapter, module URL injection, remote range provider,
`ReadableStream`, Arrow JavaScript table, or C Data Interface route.

## Runtime shape

```text
File | Blob | ArrayBuffer
          |
          v
  stable main-thread Engine / Dataset / Table handles
          |  private Worker protocol v3
          v
      module Worker
          |
          +-- bounded source byte broker
          +-- official-adapter host / global reservation ledger
          |       +-- Delimited Rust/WASM
          |       +-- Arrow IPC Rust/WASM
          |       +-- Parquet Rust/WASM
          |       +-- Excel Rust/WASM
          |
          +-- private typed batch transfer and range cache
          v
Canvas viewport + bounded ARIA grid + copy/keyboard interaction
```

`createEngine({ adapters })` validates and freezes the selected official
allow-list but does not fetch WASM. The first open for a descriptor imports its
glue and artifact; concurrent first opens coalesce. The Worker never parses a
format in JavaScript. It only brokers bounded source bytes, drives the adapter
operation state machine, validates opaque transport values, and owns cleanup.

## Private protocol and adapter ABI

Worker protocol v3 and official adapter ABI v2 are deliberately private and
experimental. They use discriminated open/read step DTOs: an adapter either
requests a bounded byte range, reports progress, or returns a completed open or
read result. The typed-buffer layout is likewise private (currently layout v1).
Public `TableBatch` values are logical facades over that transport.

The protocol associates metadata, progress, and revisions with a table and
supports datasets containing several tables. It also carries optional
presentation and range-presentation queries. Protocol compatibility is checked
at the Worker/adapter seam; consumers neither import nor depend on these
versions.

## Global memory accounting and lifetime

Each engine has one reservation ledger. It accounts for adapter runtime capacity,
source staging, compressed pages, decompression output, opened worksheets,
batches, and caches. The official manifest supplies relative runtime weights,
not a hard-coded split based on the number of formats. A reservation is
idempotent, so success, failure, cancellation, and close can all run normal
cleanup without double release.

```text
Engine.close()
  └─ DatasetSession.close()
       └─ TableHandle.close()
            └─ outstanding operation/cache reservations
```

All close operations are idempotent. Dataset/engine close cascades downward;
cancellation versus close settles once. Resource exhaustion reports
`RESOURCE_LIMIT` with the resource category plus requested and available
capacity.

## Rust packages and artifacts

The root `tabulark` crate owns shared models, errors, protocol types, Delimited,
Arrow, and Parquet logic. Four `publish = false` `cdylib` wrappers provide a
uniform `WasmRuntime` export:

```text
tabulark-delimited-wasm  -> dist/wasm/delimited/tabulark_delimited*.{js,wasm}
tabulark-arrow-wasm      -> dist/wasm/arrow/tabulark_arrow*.{js,wasm}
tabulark-parquet-wasm    -> dist/wasm/parquet/tabulark_parquet*.{js,wasm}
tabulark-excel-wasm      -> dist/wasm/excel/tabulark_excel*.{js,wasm}
```

All four implement the same public-to-host operation surface: open, continue a
byte request, cancel, open table, metadata, read, presentation queries, close
table/source, and shutdown. This makes conformance and lifecycle testing
uniform while keeping the ABI private.

## Format adapters

### Delimited and Arrow IPC

Delimited retains explicit CSV/TSV delimiter, header, and strict/lenient
semantics. Arrow IPC exposes one logical table per source; File sources read
footer/index metadata and Stream sources build a prefix index. Arrow File and
Stream accept uncompressed, LZ4, and Zstd payloads. Tensor, sparse tensor,
non-native-endian messages, and unsupported input fail structurally.

### Parquet

Parquet uses `parquet` 59.1.0 with default features disabled and only the
promised Arrow and codec features enabled. It reads footer, metadata, matching
row groups, then only matching top-level column chunks. Offsets remain `u64`
internally; every metadata, compressed-page, decompressed-page, and decoded
batch allocation reserves capacity first. One Parquet file maps to one table
and reuses the Arrow typed-batch representation. INT96 maps to a timezone-free
nanosecond timestamp. LZO, encrypted files, and experimental Variant/Geo
values return `UNSUPPORTED_FEATURE`.

The codec dependency boundary is intentionally explicit. Snappy, Gzip
(`flate2-rust_backend`), Brotli, and LZ4/LZ4_RAW use Rust implementations.
Arrow/Parquet 59.1.0 has no Zstd backend hook, so the official WASM wrappers
activate its existing `zstd` 0.13 call surface through the narrow
`crates/zstd-pure-compat` workspace patch. That compatibility crate is backed
by pinned `ruzstd` 0.8.1, enforces frame/output/window limits, and supports
Rust 1.85 and `wasm32-unknown-unknown`. Production WASM graphs must not contain
`zstd-sys` or `zstd-safe`.

Cargo strips root patch tables from a published dependency. The experimental
crates.io Rust feature graph consequently leaves upstream Zstd disabled; only
the official, separately built WASM wrappers opt in. This keeps the stable JS
format promise pure Rust without allowing registry consumers to fall back to a
different C-backed implementation.

### Excel

The Excel wrapper pins `calamine` 0.35.0 and preserves Rust 1.85 support. File
signature—not extension—selects XLS versus XLSX. XLS is limited to Excel
97–2003 BIFF8; XLSM, XLSB, ODS, earlier BIFF, and encrypted workbooks return
`UNSUPPORTED_FEATURE`.

Excel stages a bounded full workbook before opening worksheets. It validates
ZIP/CFB entry counts and sizes, total ZIP expansion, worksheet dimensions and
cells, styles, layout entries, and merge count; unsafe relationship paths,
external XML entities/DOCTYPE, and compression-bomb conditions fail before
unbounded allocation. Each worksheet becomes `sheet-{ordinal}` in workbook
order; hidden and very-hidden sheets remain tables, while chart/dialog/macro
sheets are skipped with warnings.

BIFF8 presentation records receive a conservative count-based reservation
before style parsing. XLSX parsing is bounded by the declared ZIP expansion and
presentation count limits; before a source is registered, the ledger then adds
a capacity-derived conservative retained estimate for style values/strings,
per-cell style maps, sparse axis maps, merge vectors, and worksheet-name
buckets. Opened worksheet
reservations likewise include Calamine value and formula string heaps rather
than only their inline dense-range slots.

The 0.1 Excel value contract is display-string only (`typedValues=false`): A,
B, … column names, first row as data, null empty cells, cached formula values
only, and warnings for absent formula caches. The top-left cell is the value
anchor for a merge.

## Presentation contract and Canvas

`TableHandle.getPresentation()` returns `TablePresentation | null`.
`readPresentationRange()` aligns style IDs to exactly the requested logical
range and returns intersecting merge regions plus sparse axis layout entries.
The first kind, `spreadsheet-v1`, supplies sheet visibility, frozen rows and
columns, sparse row/column size and hidden state, and a deduplicated static
style table. The supported style vocabulary is number format, font, color,
fill, borders, and horizontal/vertical alignment.

The high-level Canvas view requests presentation automatically unless
`presentation: "ignore"` is selected. It maintains a logical data/ARIA surface
even when presentation loading fails. Forced-colors mode uses system colors but
continues to honor dimensions, merged hit regions, alignment, and font emphasis.
Formula execution, editing, and document reconstruction are intentionally not
part of this layer.

## Delivery boundary

The npm archive contains the four stable entries, the explicit experimental
entry, declarations/source maps, generic Worker, all four WASM artifacts,
licenses, notices, and changelog. Pages assembly uses the same manifest and
copies all format fixtures plus locked provenance. Package, Pages, artifact-size,
and Chromium tests validate this boundary.

The stable compatibility promise is documented in
[api-stability.md](api-stability.md). Rust APIs, Worker protocol, adapter ABI,
and wire layout remain experimental/private. For commands and release evidence,
see [testing.md](testing.md) and [releasing.md](releasing.md).
