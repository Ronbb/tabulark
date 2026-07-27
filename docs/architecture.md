# Architecture

> **This document describes the finalized 0.2.0 architecture.** The historical
> `v0.1.0` tag and its artifact evidence remain immutable in
> [release-0.1.0-evidence.md](release-0.1.0-evidence.md).

## Boundary and invariants

Tabulark previews bounded local bytes and can also consume an explicit remote
`RangeSource`. Local bytes remain in the browser. For a remote source, URL,
network policy, credentials, headers, and the provider implementation stay on
the main thread; the module Worker receives only an opaque source handle, an
exact length, and bounded byte responses. Format parsing, source staging, and
large decoded allocations remain in the Worker; the main thread receives
bounded logical batches and paints only a viewport-sized Canvas and semantic
grid.

The only built-in adapters are derived from one checked-in official manifest:

| ID | Public entry point | WASM artifact | Source policy |
| --- | --- | --- | --- |
| `tabulark:delimited` | `tabulark` | `dist/wasm/delimited/` | streaming |
| `tabulark:arrow-ipc` | `tabulark/arrow` | `dist/wasm/arrow/` | range |
| `tabulark:parquet` | `tabulark/parquet` | `dist/wasm/parquet/` | range |
| `tabulark:excel` | `tabulark/excel` | `dist/wasm/excel/` | range |

The manifest drives descriptor validation, Worker loading, build output,
package and Pages assembly, and size checks. There is no global registry,
arbitrary JavaScript adapter, module URL injection, `ReadableStream`, Arrow
JavaScript table, or C Data Interface route. `RangeSource` is the one explicit
source capability: it is repeatably opened, validates an exact size and
snapshot, and is brokered through a private main-thread handle.

`sourceMode: "large"` accepts only a local `File`/`Blob` through exactly
`2,147,483,648` bytes (`2^31`); `ArrayBuffer` and `auto` retain their
conservative limits. A `RangeSource` is capped separately at exactly
`4,294,967,295` bytes (`2^32 - 1`) and may be used with CSV/TSV, Arrow IPC,
Parquet, XLSX, and XLS. The exact-boundary Chromium gate covers the five local
containers; remote tests use a virtual/sparse source and non-adjacent offsets
above `2^31`. Checked synthetic tests cover larger offsets and arithmetic
overflow without allocating an over-limit source.

## Runtime shape

```text
File | Blob | ArrayBuffer       RangeSource / tabulark/http
          |                                  |
          +---------------+------------------+
                          v
       stable main-thread Engine / Dataset / Table handles
                          +-- immutable BatchBacking cache + singleflight
                          +-- source-reader registry + staging quota
                          |  (URL/auth/network never cross this boundary)
                          |  private Worker protocol v4
                          v
                      module Worker
                          |
                          +-- opaque source broker / cross-adapter quota coordinator
          +-- official-adapter host
          |       +-- Delimited Rust/WASM + resource ledger
          |       +-- Arrow IPC Rust/WASM + resource ledger
          |       +-- Parquet Rust/WASM + resource ledger
          |       +-- Excel Rust/WASM + resource ledger
          |
          +-- one-transfer typed batch bridge
          v
Canvas viewport + bounded ARIA grid + copy/keyboard interaction
```

`createEngine({ adapters })` validates and freezes the selected official
allow-list but does not fetch WASM. The first open for a descriptor imports its
glue and artifact; concurrent first opens coalesce. Parsing, indexes,
decompression, operation state, native caches, resource admission, and batch
construction live in Rust/WASM. JavaScript retains the public facade, local
Blob accessor, remote source-reader registry, transfer bridge, top-level quota
coordination, the sole decoded-batch cache, Canvas, and ARIA. In every path the
Worker requests bounded source bytes through an opaque handle, validates the
handle/range/length/action mapping again on receipt, and owns cleanup.

### RangeSource broker

`RangeSource.open()` runs on the main thread with the engine's source and
staging limits. It returns an independent reader with an exact byte length and
`strong` or `weak` snapshot. The host assigns an opaque handle; URLs, headers,
credentials, validators, provider callbacks, source implementations, and
`RangeSource.name` all remain host-side and are never serialized to the Worker.
Applications may still provide an explicit logical `sourceName` through the
selected adapter's normal options.
A Worker step can request at most 32 ranges. The host validates the
handle, action index, safe offset/length, and exact returned byte count before
transferring a buffer back. Overlapping or directly adjacent ranges in one
step are merged, split only to fit the staging budget, and read with at most
four provider calls in flight. A dataset-level singleflight and byte-counted
LRU avoid duplicate provider reads and are discarded on dataset close or
termination.

The optional `tabulark/http` entry point is a source helper, not an implicit
fetch policy. Its probe uses `GET` with `Range: bytes=0-0`; a successful `206` must
carry an exact `Content-Range` total and a validator. Each later `206` is
checked against that total and validator. A server that returns `200` or `416`
after a successful probe is a source failure, not a reason to silently switch
to full download. `fallback: { mode: "bounded-download", maxBytes }` is the
only full-response path, and it requires a trusted length below both the
caller bound and main-thread staging budget. Retry status codes and
`Retry-After` are bounded; diagnostics are sanitized to exclude request
identity and validator material.

## Private protocol and adapter ABI

Worker protocol v4 and official adapter ABI v3 are deliberately private and
experimental. Every open, table-open, read, and presentation operation uses a
resumable `pending`/`progress`/`complete` state machine. One step requests at
most 32 ranges within its operation budget and may yield without I/O so long
parses remain cancellable. Operation handles carry monotonic revisions;
missing, duplicate, stale, and out-of-bounds results are rejected. JavaScript
accepts only non-negative safe integers, while Rust uses checked `u64`
arithmetic. The typed-buffer contract remains private batch layout v1.

The protocol associates metadata, progress, and revisions with a table and
supports datasets containing several tables. It also carries optional
presentation and range-presentation queries. A completed output owns an
independent transferable backing, so a cache miss needs at most one
WASM-to-JavaScript output copy and a cache hit transfers or copies no backing.
Protocol compatibility is checked at the Worker/adapter seam; consumers neither
import nor depend on these versions.

## Global memory accounting and lifetime

The Worker retains the necessary top-level broker for quotas shared across
WASM adapters. The engine-wide `memoryBudgetBytes` is split across threads:
75% is the Worker/runtime pool, 12.5% is main-thread source reads/staging, and
the remaining 12.5% is retained batches and an explicitly bounded HTTP
fallback. Remote range-cache bytes are charged to the Worker share. Each Rust
runtime performs its own checked admission and reports a private ledger split
into persistent, active-operation, ingress/output, native-cache, and
caller-owned telemetry. Runtime-owned budget pressure clears soft native cache
and retries admission exactly once before failing. The ledger also records
current and high-water WebAssembly memory pages.

The main thread is the only owner of decoded batch caching. An immutable
`BatchBacking` is keyed by dataset, logical table ID, revision, schema version,
and normalized range. Entries are charged at least 4 KiB and capped by both
budget and count. Temporary table-handle close preserves reusable backing;
dataset close or revision/schema changes evict it. Identical concurrent misses
coalesce. A single caller may cancel independently, and only cancellation of
all waiters propagates one cancel to the Worker.

```text
Engine.close()
  └─ source readers and opening controllers
  └─ DatasetSession.close()
       └─ range cache and pending source reads
            └─ TableHandle.close() / outstanding operations
```

All close operations are idempotent. Dataset/engine close cascades downward;
cancellation versus close settles once. Resource exhaustion reports
`RESOURCE_LIMIT` with the resource category plus requested and available
capacity. A source reader is closed exactly once on a failed or cancelled open,
dataset close, engine close, or Worker failure; its range cache and pending
singleflight requests are released with it. Lifecycle evidence repeats 100
open/read/cancel/close cycles per official runtime and source kind, requires
runtime-owned accounting to return to zero, and requires the WASM page
high-water mark to stop growing after cycle 10.

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

The Rust runtime performs range-backed container discovery for both formats.
For XLSX it reads ZIP/ZIP64 tail and central-directory metadata, workbook
relationships, shared resources, and the selected worksheet ranges. For XLS it
walks CFB/DIFAT/FAT/miniFAT/directory structures with checked offsets and reads
the referenced Workbook/Book stream ranges. It then compacts only the required
entries or stream into a bounded workbook passed to the existing Calamine
compatibility parser. No separate JavaScript Excel parser remains, and this
does not claim a complete custom XML/BIFF checkpoint or worksheet tile-store
implementation.

The range paths never stage the original large source or reserve its size as
their working set. The Excel target validates ZIP/CFB entry counts and sizes,
ZIP expansion, worksheet dimensions and cells, styles, layout entries, and
merge count; unsafe relationship paths, external XML entities/DOCTYPE, and
compression-bomb conditions fail before unbounded allocation. Each worksheet
becomes `sheet-{ordinal}` in workbook order; hidden and very-hidden sheets
remain tables, while chart/dialog/macro sheets are skipped with warnings.

BIFF8 presentation records receive a conservative count-based reservation
before style parsing. XLSX parsing is bounded by the declared ZIP expansion and
presentation count limits; before a source is registered, the ledger then adds
a capacity-derived conservative retained estimate for style values/strings,
per-cell style maps, sparse axis maps, merge vectors, and worksheet-name
buckets. Opened worksheet
reservations likewise include Calamine value and formula string heaps rather
than only their inline dense-range slots.

The Excel value contract is display-string only (`typedValues=false`): A,
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

The npm archive contains the five stable entries (root, `/arrow`, `/parquet`,
`/excel`, and `/http`), the explicit experimental entry, declarations/source
maps, generic Worker, all four WASM artifacts, licenses, notices, and changelog.
`/http` has its own measured raw/Brotli budget; adding it does not relax the
core, adapter, npm, or Pages caps. Pages assembly uses the same manifest and
copies all format fixtures plus locked provenance. Package, Pages, artifact-
size, HTTP contract, and three-browser tests validate this boundary. Chromium,
Firefox, and WebKit are release-blocking functional gates; Chromium alone owns
pixel snapshots, performance comparison, and exact-2-GiB evidence.

The stable compatibility promise is documented in
[api-stability.md](api-stability.md). Rust APIs, Worker protocol v4, adapter ABI
v3, and batch layout v1 remain experimental/private. For commands and release
evidence, see [testing.md](testing.md) and [releasing.md](releasing.md).
