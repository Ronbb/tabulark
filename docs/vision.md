# Vision

> Tabulark 0.2.0 finalizes the four-format, three-browser, exact-2-GiB local
> foundation and a stable bounded remote-range capability. The historical
> `v0.1.0` tag, registry provenance, and artifact checksums remain immutable in
> [release-0.1.0-evidence.md](release-0.1.0-evidence.md).

Tabulark is a browser-native table preview engine: a small, composable layer
between local tabular bytes and an application's table UI. It should make the
first useful viewport fast, keep memory bounded, preserve data meaning, and
remain accessible without requiring every application to rebuild format
parsing, Worker orchestration, range caching, presentation, and Canvas
virtualization.

## Product principles

### Local-first by default

A local `File`, `Blob`, or `ArrayBuffer` remains local. Tabulark does not need a
server to preview it. Network-backed input is also available when an
application explicitly supplies a `RangeSource`; URL, credentials, headers,
and fetch policy remain on the main thread, and the Worker receives only an
opaque handle and bounded bytes. There is no implicit remote fetch.

### One table contract, four format families

Renderers should not know whether a table came from delimited text, Arrow IPC,
Parquet, or Excel. Official adapters normalize datasets, tables, schemas,
capabilities, ranges, logical batches, errors, presentation, and lifecycle
while keeping format-specific options and parsing behind their boundary.

The 0.2.0 release validates that shape with four independently loadable
Rust/WASM adapters:

- CSV/TSV through `tabulark:delimited`.
- Apache Arrow IPC File/Stream through `tabulark:arrow-ipc`.
- Apache Parquet through `tabulark:parquet`.
- Excel 97-2003 BIFF8 XLS and OOXML XLSX through `tabulark:excel`.

These descriptors are official and closed. A third-party adapter ecosystem,
remote registry, or public adapter factory needs a separately versioned
security and compatibility design; the private Worker protocol and adapter ABI
are not shortcuts around that work.

The same adapters accept the stable `RangeSource` capability for bounded
remote or application-owned bytes. A reader must report an exact size and
snapshot, return exact-length ranges, and stay at or below
`4,294,967,295` bytes (`2^32 - 1`). The host merges overlapping/adjacent
requests, limits provider concurrency to four, and releases the reader,
singleflight state, and byte-counted range cache on close or termination.
`tabulark/http` supplies an opt-in HTTP implementation with a `Range` probe,
validator checks, bounded retries, and an explicit bounded-download fallback.

### Keep the stable surface logical

Public consumers work with Engine, Dataset, Table, logical schema/value/batch,
structured errors, and the high-level Canvas view. Transport buffers,
descriptors, Worker protocol v4, official adapter API v3, and batch layout v1
remain private so their representation can evolve without breaking
applications.

The five stable JavaScript entries (root, `/arrow`, `/parquet`, `/excel`, and
`/http`) permit compatible additions throughout 0.2.x. Low-level painter,
controller, layout, and selection primitives live in
`tabulark/experimental` and deliberately do not carry that promise.

### Preserve semantics and render predictably

A table API should not flatten typed data merely because a UI ultimately draws
text. Arrow IPC and Parquet therefore expose logical native values and a
separate deterministic display representation. Dictionary/run-end encoding,
nested values, decimals, temporal values, binary data, and extension-backed
storage retain their meaning at the stable logical boundary.

Excel 0.2 intentionally chooses a narrower display-string value contract while
preserving workbook structure needed for preview. Formulas use cached values;
Tabulark does not evaluate them.

### Treat presentation as optional table data

Spreadsheet layout should not leak Excel parsing into a renderer. The common
`spreadsheet-v1` presentation contract carries worksheet visibility, frozen
bands, sparse row/column dimensions and hidden state, merged regions, and
deduplicated static styles. Formats without presentation return `null`.

The Canvas view consumes this contract by default but remains usable if a
caller ignores it or presentation fails. Forced-colors mode gives system
colors authority while retaining useful geometry, merged hit regions,
alignment, and font emphasis. This is static preview fidelity, not a promise of
formula calculation, editing, or document-perfect workbook reconstruction.

### Pay only for the selected adapter

Engine creation loads no WASM. The first source open selects and coalesces one
official adapter load. CSV/TSV, Arrow, Parquet, and Excel have separate
artifacts and size budgets; XLS and XLSX deliberately share the Excel artifact.
A large optional format cannot hide a regression in the core path.

### Keep work bounded, cancellable, and recoverable

Parsing, framing, ZIP/CFB traversal, decompression, metadata, worksheet state,
and decoded batches can all become denial-of-service surfaces. The Worker
coordinates cross-adapter quota while each Rust runtime accounts for
persistent, active-operation, ingress/output, and reclaimable native-cache
state. Operations are cancellable; engine/dataset/table close cascades and is
idempotent; every reservation is released on success, failure, cancellation,
or close. A budget error identifies the constrained resource and
required/available capacity. The main thread owns the sole immutable decoded
backing cache, with singleflight and independent caller cancellation.

Format readers should also avoid unnecessary work: Parquet fetches only the
footer, metadata, selected row groups, and projected column chunks. Excel uses
Rust range-backed ZIP64/CFB indexing and compacts only needed workbook content
for the bounded Calamine compatibility parser. This is not yet a complete
custom XML/BIFF checkpoint engine or worksheet tile store.

### Accessibility is rendering architecture

Canvas speed cannot come at the cost of keyboard or screen-reader access. A
bounded semantic grid, visible focus, text-backed status, keyboard selection,
copy, merged hit regions, and resizing belong to the view contract. Forced
colors, reduced motion, touch targets, and small-screen layouts are release
gates rather than optional polish.

Chromium, Firefox, and WebKit are formal functional gates for 0.2.0. Chromium
additionally owns exact pixels, performance, real Clipboard API, and the five
exact-2-GiB container gates; the other engines exercise copy through a
deterministic clipboard seam.

### Evidence precedes release labels

Implementation is not publication. A release must have versioned and
independently produced fixtures, protocol and lifecycle conformance, fuzz seed
replay, browser behavior, accessibility and visual checks, size/performance
measurements, clean packed consumers, an assembled package and Pages site, and
a real deployed-URL smoke attributable to the same revision.

The M4 record is frozen at `1d79837`; the completed 0.1.0 artifact record is
separate and immutable. The 0.2.0 preflight requires CI, Pages, M6 Large Files,
and Remote RangeSource evidence for the same SHA. A patch release must use a new
tag and the protected OIDC delivery process.

## Direction after 0.2.0

Once the stable boundary has real-world feedback, compatible 0.2.x additions
can improve supported logical types, presentation fidelity, diagnostics, and
performance without exposing the private transport. Larger capabilities remain
separate design decisions:

- Persistent, opt-in OPFS caching keyed by source snapshot and adapter version,
  with explicit quota, cleanup, and offline policy.
- Streaming sources with a defined OPFS spill or bounded sliding-window
  contract; `ReadableStream` is not accepted by the 0.2 API.
- SQLite and other independently budgeted local formats.
- Framework bindings around the same engine/table/view lifecycles.
- A separately versioned and reviewed third-party adapter model.

## Non-goals

Tabulark is not intended to become a full spreadsheet editor, formula engine,
database server, cloud upload service, or universal in-memory dataframe. It
provides dependable preview infrastructure on which applications can build
those higher-level experiences.
