# Architecture

> **M4 candidate, pre-alpha.** This document describes the current
> CSV/TSV-plus-Arrow IPC architecture. It does not assert that M4 is complete:
> CI, Pages deployment, and deployed-site smoke evidence must exist for the
> candidate revision before that label is earned.

## Design constraints

Tabulark previews local tabular sources without sending their contents to a
service. It keeps format parsing and large allocations off the main thread,
keeps rendered DOM proportional to the viewport, and makes source ownership and
lifecycle explicit.

The M4 extension boundary is intentionally closed. The runtime accepts only two
frozen official descriptors:

| ID | Public entry point | Artifact |
| --- | --- | --- |
| `tabulark:delimited` | `tabulark` | `dist/wasm/delimited/` |
| `tabulark:arrow-ipc` | `tabulark/arrow` | `dist/wasm/arrow/` |

There is no public arbitrary-adapter factory, module URL, global registry,
remote byte provider, or Arrow JavaScript/C Data Interface path in M4.

## Runtime shape

```text
File | Blob | ArrayBuffer
          |
          v
  main-thread Engine / Dataset / Table handles
          |  protocol v2 RPC
          v
      module Worker
          |
          +-- source byte broker (bounded Blob/ArrayBuffer slices)
          +-- adapter manager (loads selected artifact on first open)
          |       +-- Delimited Rust/WASM adapter
          |       +-- Arrow IPC Rust/WASM adapter
          |
          +-- generic layout-v1 batch validation and transfer
          v
Canvas viewport + bounded ARIA grid + TSV copy
```

`createEngine({ adapters })` validates and freezes its official allow-list but
does not load WASM. The first open for a registered adapter loads that adapter’s
glue/WASM artifact. Concurrent first opens coalesce. The Worker never delegates
format interpretation to JavaScript: it only supplies bounded `read-bytes`
responses to the Rust operation ABI and validates/transfers generic batch
buffers.

## Rust packages and build outputs

The root `tabulark` crate owns shared models, protocol values, resource limits,
and the native adapter implementations. Two `publish = false` `cdylib` wrappers
produce independently loadable browser artifacts:

```text
tabulark-delimited-wasm  -> dist/wasm/delimited/tabulark_delimited*.{js,wasm}
tabulark-arrow-wasm      -> dist/wasm/arrow/tabulark_arrow*.{js,wasm}
```

The Arrow wrapper uses individual `arrow-array`, `arrow-buffer`, `arrow-cast`,
`arrow-data`, `arrow-ipc`, `arrow-schema`, and `arrow-select` dependencies
pinned to 59.1.0 with default features disabled. IPC LZ4 and Zstd support is
enabled in the Arrow artifact only; the historical Delimited core remains
separately size-gated.

## Adapter and operation ABI

The internal Rust ABI is experimental but common to both built-in adapters:

```text
beginOpen -> continueOperation* -> openTable -> metadata -> beginRead
     |                                      |                |
     +-------- cancelOperation -------------+----------------+

closeTable -> closeSource -> shutdown
```

An operation can request one bounded `read-bytes { offset, length }` action at
a time. The Worker reads the requested Blob/ArrayBuffer range and returns bytes
without examining format framing. Adapter failure, cancellation, source close,
or engine shutdown releases the operation/source/table handles owned by that
adapter; a failed Arrow source must not poison the Delimited path on the same
engine.

## Input ownership and lifecycle

`Engine.open()` accepts only `File`, `Blob`, or `ArrayBuffer` and always needs
an explicitly registered descriptor. `transferInput` defaults to `false`.
Only an `ArrayBuffer` may be transferred; a requested `Blob`/`File` transfer is
an `INVALID_ARGUMENT` error.

The public lifetimes are nested but explicit:

```text
Engine
  └─ DatasetSession
       └─ TableHandle
            └─ TableBatch
```

A UI changes sources in this order: destroy view, close table, close dataset,
then open the next source. An engine closes on `pagehide` and terminal Worker
failure. Closing a table does not require closing an otherwise usable dataset.

## Protocol and typed batches

M4 freezes the following wire identifiers:

| Contract | Version |
| --- | --- |
| Worker protocol | 2 |
| Built-in adapter API | 1 |
| Generic batch layout | 1 |

Protocol v1 receives an explicit incompatibility error. A table batch carries a
deduplicated pool of typed buffers plus, for each column, a Rust-produced native
descriptor and a UTF-8 display descriptor. The main thread performs generic
range/buffer boundary checks, caches batches under the engine budget, and
constructs `TableBatch`; it does not parse CSV or Arrow itself.

`toRows()` decodes logical native values. Dictionary and run-end descriptors
remain visible for inspection while the method returns their logical values.
`toDisplayRows()` returns stable `(string | null)[][]`; Canvas paint, the ARIA
grid, column sizing, and copy use this display-only method. This split keeps
browser rendering deterministic without losing Arrow semantics for programmatic
callers.

`ColumnSchema.dataType` recursively represents the Arrow 59.1.0 built-in type
family, including nested, union, dictionary, decimal, temporal, interval,
run-end encoded, and extension storage types. Unknown extension types retain
extension name/metadata and decode through their storage type.

## Arrow IPC adapter

The Arrow adapter supports one logical table per IPC source.

- File containers read the magic/footer, schema, dictionaries, and RecordBatch
  block index before satisfying projected range reads.
- Stream containers build schema, dictionaries, and a row-prefix index in
  order. Before EOF metadata can report `indexed-prefix`; after completion it
  becomes exact/full.
- A requested range can span RecordBatches; the adapter slices, projects, and
  merges the selected cells.
- IPC File and Stream inputs support no compression, LZ4, and Zstd.
- Tensor, sparse tensor, and non-native-endian inputs return a structured
  `UNSUPPORTED_FEATURE` error rather than being misinterpreted.

The Rust resource broker accounts for ingress bytes, WASM copies, schema/index
state, dictionaries, compressed/decompressed blocks, decoded arrays, display
output, and caches. M4 fixes nesting at 64, fields at 16,384, and range cells at
250,000; related caps derive from the engine’s memory budget.

## View layer

`createCanvasTableView()` uses native scrolling and draws the visible table
region on Canvas. A viewport-sized ARIA grid mirrors only active/visible cells;
it supports keyboard navigation, selection, copy, and column resizing. The
semantics and pixels are deliberately driven by display text, never raw
recursive native values.

The static Playground owns source selection and lifecycle rather than format
inference. It exposes CSV, TSV, and Arrow IPC explicitly, hides delimited-only
controls for Arrow, clears the previous session before switching, and provides
loading, cancellation, retry, focus, forced-colors, reduced-motion, and
responsive behavior.

## Delivery boundary

The npm archive contains the root and `/arrow` entry points, declarations,
source maps, generic Worker, both WASM artifacts, licenses, and notices. The
Pages assembler copies the same runtime, the pinned Arrow fixture, provenance,
licenses, and notice into a relative-URL static artifact. Package and Pages
tests verify those contents; post-deployment browser smoke remains the final
environmental proof.

For detailed commands and evidence rules, see [Testing and performance
validation](testing.md).
