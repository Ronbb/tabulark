# MVP and milestone status

> **Current status: M4 candidate, pre-alpha.** The implementation and local
> gates in this repository are not a declaration that M4 is complete. The
> candidate still needs green CI, a successful GitHub Pages deployment, and a
> smoke test against that deployment’s actual URL.

## Product boundary

The first product is a local browser preview primitive, not a spreadsheet or
database product. It accepts a local source, opens it through a selected
official adapter in a Worker, exposes a bounded table/range API, and renders a
keyboard-accessible Canvas viewport.

The public source inputs are `File`, `Blob`, and `ArrayBuffer`. Network range
providers, `ReadableStream`, remote registries, arbitrary JavaScript adapters,
and application-defined module URLs are outside M4.

## Milestone history

### M0–M2: table model and first vertical slice

The early work established the table model, Worker RPC, Rust/WASM integration,
incremental CSV/TSV parsing, range reads, Canvas rendering, and a bounded ARIA
grid.

### M3: CSV/TSV hardening and measurement

M3 produced the original delimited vertical-slice evidence:

- Versioned corpus and fuzz seeds for tricky CSV/TSV inputs.
- Real Worker/WASM lifecycle, cancellation, resource-limit, and recovery tests.
- Canvas layout snapshots, keyboard selection/copy/resize, CJK propagation, axe,
  forced-colors, and responsive checks.
- A reproducible canonical CSV browser benchmark and independent package/Pages
  size controls.

The M3 canonical CSV baseline remains a protected regression reference. M4 does
not relax its core raw or Brotli budgets.

### M4: Rust/WASM-first Arrow IPC extension validation

M4 changes the provisional CSV-only facade to an explicit built-in adapter API:

```ts
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";

const engine = await createEngine({
  adapters: [delimitedAdapter, arrowIpcAdapter],
});
```

The only registered IDs are `tabulark:delimited` and `tabulark:arrow-ipc`.
The descriptors are frozen, the allow-list is immutable, duplicate IDs fail,
and neither arbitrary adapter code nor arbitrary module URLs are public.

M4 moves every built-in format through the same Worker/Rust operation ABI,
generic layout-v1 batch transfer, resource accounting, and lifecycle paths. It
also makes the breaking public changes below:

| M3 | M4 |
| --- | --- |
| `createEngine()` | `createEngine({ adapters: [...] })` |
| `open(source, { format, ... })` | `open(source, { adapter, adapterOptions, transferInput? })` |
| `ColumnSchema.logicalType` | recursive `ColumnSchema.dataType` |
| string-only display batch | native `toRows()` plus `toDisplayRows()` |
| one shared WASM artifact | lazy Delimited and Arrow artifacts |

The Arrow adapter covers IPC File and Stream containers, uncompressed/LZ4/Zstd
messages, projection and ranges across RecordBatches, dictionary/run-end
encoding, nested values, extension storage fallback, and structured unsupported
feature errors. It is built from individually pinned Arrow Rust crates rather
than the aggregate crate or Arrow JavaScript.

### M4 evidence required before completion

- Rust SPI/lifecycle conformance for both adapters and Arrow type/container/
  compression/error matrices.
- Protocol-v2 fixtures with explicit v1 rejection; native/display batch, buffer
  deduplication, input-transfer, and multi-adapter lifecycle tests.
- A real committed Arrow fixture with provenance, digest, CJK, `bigint`,
  decimal, timestamp, nullable, dictionary, and nested values.
- Browser tests for explicit selection, lazy WASM network behavior, range/view
  behavior, Canvas/ARIA/copy, keyboard/focus, forced colors, reduced motion,
  and mobile layout.
- Arrow cold-load/range/scroll/memory/transfer measurements plus independent
  Arrow, core, npm, and Pages size budgets.
- A packed-consumer smoke test, assembled Pages artifact test, deployment, and
  post-deployment CSV/TSV/Arrow/switch/copy/console/network smoke.

The first five categories can be checked in CI or locally. Deployment and
actual-URL evidence are environmental and remain explicitly pending until the
Pages workflow records them for the same commit.

## Out of scope for M4

- crates.io or npm publication, tag creation, and registry ownership changes.
- Third-party adapter distribution or a stable public adapter ABI.
- Web `ReadableStream`, remote range sources, Arrow JS `Table`/`RecordBatch`,
  Arrow FFI, or the C Data Interface.
- Tensor, sparse tensor, or non-native-endian Arrow payload support.
- Persistent cache storage, framework bindings, and Firefox/WebKit support.

## Next milestone decision

Only after M4 deployment evidence is complete should the project decide whether
to stabilize the adapter/package boundary or broaden format coverage. Future
formats must each bring independently lazy artifacts, explicit source options,
fixtures from more than one producer where practical, resource limits, browser
tests, and measured delivery impact.
