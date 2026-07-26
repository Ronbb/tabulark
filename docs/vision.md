# Vision

> Tabulark's four-format 0.1.0 implementation is a release candidate. It has
> not been tagged or published to npm or crates.io.

Tabulark is a browser-native table preview engine: a small, composable layer
between local tabular bytes and an application's table UI. It should make the
first useful viewport fast, keep memory bounded, preserve data meaning, and
remain accessible without requiring every application to rebuild format
parsing, Worker orchestration, range caching, presentation, and Canvas
virtualization.

## Product principles

### Local-first by default

A local `File`, `Blob`, or `ArrayBuffer` remains local. Tabulark does not need a
server to preview it. Future network-backed sources must be explicit
capabilities with explicit application authority; they are not part of 0.1.0.

### One table contract, four source families

Renderers should not know whether a table came from delimited text, Arrow IPC,
Parquet, or Excel. Official adapters normalize datasets, tables, schemas,
capabilities, ranges, logical batches, errors, presentation, and lifecycle
while keeping format-specific options and parsing behind their boundary.

The 0.1.0 candidate validates that shape with four independently loadable
Rust/WASM adapters:

- CSV/TSV through `tabulark:delimited`.
- Apache Arrow IPC File/Stream through `tabulark:arrow-ipc`.
- Apache Parquet through `tabulark:parquet`.
- Excel 97-2003 BIFF8 XLS and OOXML XLSX through `tabulark:excel`.

These descriptors are official and closed. A third-party adapter ecosystem,
remote registry, or public adapter factory needs a separately versioned
security and compatibility design; the private Worker protocol and adapter ABI
are not shortcuts around that work.

### Keep the stable surface logical

Public consumers work with Engine, Dataset, Table, logical schema/value/batch,
structured errors, and the high-level Canvas view. Transport buffers,
descriptors, Worker protocol v3, official adapter API v2, and the batch wire
layout remain private so their representation can evolve without breaking
applications.

The four stable JavaScript entries permit compatible additions throughout
0.1.x. Low-level painter, controller, layout, and selection primitives live in
`tabulark/experimental` and deliberately do not carry that promise.

### Preserve semantics and render predictably

A table API should not flatten typed data merely because a UI ultimately draws
text. Arrow IPC and Parquet therefore expose logical native values and a
separate deterministic display representation. Dictionary/run-end encoding,
nested values, decimals, temporal values, binary data, and extension-backed
storage retain their meaning at the stable logical boundary.

Excel 0.1 intentionally chooses a narrower display-string value contract while
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
and decoded batches can all become denial-of-service surfaces. One global
ledger accounts for every significant simultaneous allocation. Operations are
cancellable; engine/dataset/table close cascades and is idempotent; every
reservation is released on success, failure, cancellation, or close. A budget
error identifies the constrained resource and required/available capacity.

Format readers should also avoid unnecessary work: Parquet fetches only the
footer, metadata, selected row groups, and projected column chunks, while Excel
declares and validates the cost of its bounded whole-workbook staging before it
allocates.

### Accessibility is rendering architecture

Canvas speed cannot come at the cost of keyboard or screen-reader access. A
bounded semantic grid, visible focus, text-backed status, keyboard selection,
copy, merged hit regions, and resizing belong to the view contract. Forced
colors, reduced motion, touch targets, and small-screen layouts are release
gates rather than optional polish.

Chromium is the sole formal browser gate for 0.1.0. Firefox and WebKit support
will be claimed only after their own reproducible validation exists.

### Evidence precedes release labels

Implementation is not publication. A release candidate must have versioned and
independently produced fixtures, protocol and lifecycle conformance, fuzz seed
replay, browser behavior, accessibility and visual checks, size/performance
measurements, clean packed consumers, an assembled package and Pages site, and
a real deployed-URL smoke attributable to the same revision.

The M4 record is frozen at `1d79837`; it does not stand in for the expanded
four-adapter matrix. The 0.1.0 label becomes a release only after the protected
pre-tag and registry delivery process succeeds.

## Direction after 0.1.0

Once the stable boundary has real-world feedback, compatible 0.1.x additions
can improve supported logical types, presentation fidelity, diagnostics, and
performance without exposing the private transport. Larger capabilities remain
separate design decisions:

- Firefox and WebKit validation.
- Explicit remote range and streaming sources.
- Persistent, opt-in caching keyed by source fingerprint and adapter version.
- SQLite and other independently budgeted local formats.
- Framework bindings around the same engine/table/view lifecycles.
- A separately versioned and reviewed third-party adapter model.

## Non-goals

Tabulark is not intended to become a full spreadsheet editor, formula engine,
database server, cloud upload service, or universal in-memory dataframe. It
provides dependable preview infrastructure on which applications can build
those higher-level experiences.
