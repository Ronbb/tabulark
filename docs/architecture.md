# Architecture

> Status: M0 through M2 are implemented as an experimental local CSV/TSV
> vertical slice. M3 hardening and measurement and M4 second-adapter validation
> remain unfinished, and no interface is stable yet.

This document records the implemented prototype boundaries and the intended
architecture they are validating. M0-M2 descriptions apply to the current
CSV/TSV path unless a section is marked as a future extension. A general
adapter registry, remote byte sources, additional formats, and package splitting
remain design targets rather than shipped features.

## 1. Product boundary

Tabulark is browser infrastructure for opening and previewing tabular data. It
owns the path from source bytes to a visible, navigable table surface, while the
host application owns product-specific workflows and presentation.

### Core responsibilities

- Open a source through a format-specific runtime boundary: built-in CSV/TSV
  today and independently installed adapters in a future extension.
- Enumerate one or more logical tables exposed by that source.
- Expose consistent metadata, schema, extent, and range access for each table.
- Parse and retain source data outside the browser main thread.
- Transfer bounded, render-oriented batches instead of complete tables or
  per-cell JavaScript objects.
- Coordinate viewport requests, cancellation, prefetching, and memory-bounded
  caching.
- Provide a framework-neutral layout engine and a Canvas renderer.
- Expose headless controllers for keyboard navigation, selection, and copying.

### Composable extensions

- Additional source adapters.
- Search, sorting, filtering, and derived table views.
- Framework bindings such as React or Vue.
- Persistent caches backed by IndexedDB or OPFS.
- Alternative renderers and application-specific toolbars.
- Optional editing layers that do not change the core preview contract.

### Out of scope

- Spreadsheet formula evaluation and workbook recalculation.
- Macros, VBA, or arbitrary workbook code.
- Pixel-perfect Office rendering.
- Database query planning or execution.
- Pivot tables, chart authoring, BI modeling, or document editing.

## 2. System overview

```text
Host application
    |
    v
Public facade and headless controller                 main thread
    |                                                        |
    +--> viewport state --> range cache --> layout --> Canvas |
    |                                                        |
    +---------------- versioned Worker protocol -------------+
                                                             |
Worker runtime                                               |
    |                                                        |
    +--> adapter registry (M4 target; CSV/TSV only today)    |
    +--> source sessions and table handles                   |
    +--> parser/index state                                  |
    +--> memory-bounded batch cache                          |
    |                                                        |
    +--> built-in WebAssembly CSV/TSV path -------------------+
             |
             v
        source bytes / externally supplied row batches
```

The overview shows the intended component boundary. The M0-M2 prototype uses
one built-in CSV/TSV scanner selected by an explicit format option; it does not
yet expose an independently installable adapter registry.

The dependency direction is one-way:

```text
model <- protocol <- runtime <- client/controller <- renderer/bindings
             ^
             |
          adapters
```

The renderer must not know which adapter produced a table. Adapters must not
know which renderer consumes their batches. Framework bindings must not own
parsing, viewport calculation, or cell rendering.

## 3. Runtime boundaries

### Main thread

The main thread owns browser interaction and presentation:

- Public JavaScript facade and lifecycle.
- Source selection and adapter configuration.
- Viewport, focus, selection, and column layout state.
- Visible-range calculation and bounded look-ahead prefetching.
- A small cache of batches needed for the current view.
- Frame scheduling, Canvas painting, hit testing, and the semantic DOM layer.

React or another UI framework may display metadata, progress, errors, toolbars,
and inspectors. It must not render one component per cell or receive the entire
dataset as component state.

### Worker runtime

The Worker owns data-heavy and latency-sensitive work:

- Explicit source-format selection and initialization; future adapter loading
  and probing belong behind the same boundary.
- Parsing, indexing, schema discovery, and table enumeration.
- Source and table handle registries.
- Request scheduling, cancellation, progress, and resource cleanup.
- Parsed blocks and a byte-budgeted LRU cache.
- Construction of transferable response buffers.

WebAssembly is the preferred implementation for performance-sensitive parsers
and data operations, but it is not a requirement for every adapter. The Worker
boundary is the architectural requirement.

### Adapter boundary

An adapter converts one source family into the common dataset and table model.
It is responsible for format semantics, not UI behavior. The current CSV/TSV
runtime validates much of this boundary internally, but making the boundary
independently installable and proving it with a second source are M4 work.

An adapter may:

- Probe a bounded prefix and declared source metadata.
- Validate adapter-specific open options.
- Open a dataset session and enumerate its logical tables.
- Report metadata and capabilities.
- Serve bounded table ranges.
- Maintain format-specific indexes and parser state.

An adapter must not:

- Manipulate the DOM or Canvas.
- Fetch arbitrary network resources by default.
- Return an entire large table as nested JavaScript arrays.
- Expose implementation pointers or Rust traits through the Worker protocol.
- Treat Worker isolation as a security sandbox.

## 4. Domain model

### Source, dataset, and table

A physical source and a logical table are different concepts:

```text
SourceInput
    -> DatasetSession
        -> TableDescriptor[]
            -> TableHandle
```

- A CSV source exposes one logical table.
- An XLSX source may expose one table per worksheet.
- A database adapter may expose externally supplied result sets.

The common name `Table` applies to each logical table, not necessarily to the
whole file. Format-specific names such as workbook or sheet remain adapter
metadata and do not leak into the renderer contract.

The initial source inputs are `File`/`Blob` and `ArrayBuffer`. Streams, remote
range sources, and application-defined byte sources are later extensions. The
host application remains responsible for authentication, CORS policy, and
network fetching unless a separately installed source provider says otherwise.

### Identity and lifecycle

- Dataset sessions and table handles use opaque protocol IDs, never memory
  addresses.
- A table handle belongs to exactly one dataset session.
- `close()` is idempotent and releases all resources owned by that handle.
- Closing a dataset invalidates its table handles and cancels outstanding work.
- The first model is an immutable snapshot. A future live-source model must add
  explicit revisions rather than silently changing data beneath cached ranges.

### Extent

`TableShape { rows, columns }` is insufficient while a source is still being
parsed. Each axis needs an explicit state:

```ts
type AxisExtent =
  | { kind: "exact"; value: number }
  | { kind: "at-least"; value: number }
  | { kind: "unknown" };

interface TableExtent {
  rows: AxisExtent;
  columns: AxisExtent;
}
```

For the first JavaScript API, every externally visible coordinate and count
must be a non-negative safe integer. Rust may use `u64` internally, but the
protocol must reject values that would lose precision instead of silently
rounding them. A `bigint` API can be designed later if real sources require it.

### Schema and values

The minimum schema contains:

- Stable column ID within the table revision.
- Display name.
- Zero-based logical column index.
- Logical data type.
- Nullable flag when the adapter can determine it.
- Optional source-specific metadata under a namespaced extension field.

The initial logical types are:

```text
unknown, utf8, boolean, int64, float64, decimal, date, datetime, binary
```

Adapters may support only a subset. CSV/TSV starts as `utf8`; automatic type
inference is not part of the first parser contract because it can change values
and schema after the first paint.

The model must distinguish:

- An empty string.
- A missing or null value.
- An invalid value for a declared type.
- A value that was truncated or could not be decoded.

Parse diagnostics are separate from display text so the renderer can show a
safe fallback without losing structured error information.

### Ranges and batches

All ranges use zero-based, half-open coordinates: `[start, end)`. A range is
rectangular and bounded by a runtime maximum so one request cannot allocate an
unbounded response.

The conceptual table API is deliberately small:

```ts
interface TableHandle {
  metadata(): Promise<TableMetadata>;
  readRange(request: RangeRequest): Promise<TableBatch>;
  close(): Promise<void>;
}
```

`AbortSignal` is accepted by the JavaScript facade. The facade maps it to a
protocol cancellation request; signals themselves do not cross the Worker
boundary.

`TableBatch` is column-oriented. It must not be represented as one object per
cell. Physical encodings may include:

- Typed numeric buffers plus a validity bitmap.
- UTF-8 data plus offset and validity buffers.
- Dictionary-encoded strings when an adapter can produce them cheaply.
- A display-text encoding for render and clipboard requests.

Every batch identifies its table, revision, actual returned range, schema
version, and whether the requested range is complete. Transferable buffers are
owned by the response; transferring them must not detach the runtime's cache
backing storage.

### Capabilities

Capabilities prevent optional operations from becoming assumptions. Examples
include:

- Known or progressively discovered row count.
- Random range access.
- Typed values versus display-only values.
- Search, sort, or filter pushdown.
- Source styles or row/column sizing metadata.
- Multi-table enumeration.

The MVP renderer relies only on metadata and range-read capabilities.

## 5. Worker protocol

The wire protocol is a versioned product boundary, independent of Rust traits
and JavaScript class layouts. Rust and JavaScript implementations should share
generated definitions or, at minimum, golden protocol fixtures and compatibility
tests.

Every request contains:

- Protocol version.
- Unique request ID.
- Operation name and serializable payload.
- Relevant dataset or table handle.

The first operations are:

| Operation | Purpose |
| --- | --- |
| `hello` | Negotiate protocol and runtime capabilities. |
| `openSource` | Select an explicit source format and create a dataset session. |
| `listTables` | Return table descriptors for a dataset. |
| `openTable` | Create a handle for one logical table. |
| `getMetadata` | Return current extent, schema, revision, and capabilities. |
| `readRange` | Return a bounded columnar or display batch. |
| `cancel` | Best-effort cancellation of an outstanding request. |
| `closeTable` | Release a logical table handle. |
| `closeSource` | Release the dataset and all child resources. |
| `shutdown` | Dispose the runtime instance. |

The Worker may emit interleaved events:

- Open and parse progress.
- Extent or schema metadata updates.
- Recoverable source warnings.
- Runtime-fatal failure.

Errors are serializable values with a stable code, safe message, retryability,
and optional structured details. Raw exceptions and implementation stack traces
are not the public error contract.

Protocol rules:

- Responses are matched by request ID; global response ordering is not assumed.
- Cancellation is best effort and always produces a terminal request state.
- Closing a handle invalidates all outstanding requests for that handle.
- Unknown operations or incompatible protocol versions fail explicitly.
- Large binary payloads use transfer lists. `SharedArrayBuffer` is not a baseline
  requirement because it adds cross-origin isolation constraints.

## 6. Scheduling and caching

The controller converts viewport state into normalized range requests. It
requests the visible range first and a small overscan range second. A generation
number allows responses from an older scroll position or table view to be
discarded without painting stale data.

There are two distinct caches:

### Worker cache

- Owns parser blocks, source indexes, decoded columns, and reusable values.
- Uses an explicit byte budget and LRU-style eviction.
- Coalesces identical in-flight reads when possible.
- Keeps internal backing memory separate from transferred response buffers.

### Main-thread range cache

- Retains only visible and nearby render-ready batches.
- Is keyed by table ID, revision, schema version, normalized range, and requested
  representation.
- Evicts by byte cost, not item count.
- Drops stale generations before layout or painting.

Persistent caching is disabled by default. A future `CacheStore` port may use
IndexedDB or OPFS and should key entries by a source fingerprint, adapter name
and version, open options, and schema version. Storage consent and eviction
policy belong to the host application.

## 7. Viewport and rendering

Rendering is split into reusable headless stages:

```text
Table metadata
    -> TableController
    -> ViewportModel
    -> LayoutEngine
    -> Range requests / cached batches
    -> PaintPlan
    -> CanvasRenderer
```

### TableController

The controller is an explicit state machine rather than a framework store. The
M2 snapshot currently exposes `loading`, `ready`, `error`, and `closed`; error
values preserve structured cancellation, unsupported-input, malformed-input,
and runtime failures. Dedicated presentation states and retry UX remain M3
hardening work. The controller owns:

- Source and view lifecycle.
- Selected table and current metadata.
- Viewport dimensions, scroll position, and device-pixel ratio.
- Active cell, selection, hover, and column widths.
- Request generation and pending work.

Framework bindings subscribe to snapshots of this state. A React binding can
use `useSyncExternalStore`; high-frequency scroll and paint work remains in the
controller and renderer.

### LayoutEngine

The layout engine has no Canvas dependency. It calculates:

- Visible and overscan rows and columns.
- Logical-to-pixel and pixel-to-logical coordinate mapping.
- Header and cell rectangles.
- Hit testing and selection geometry.
- Column width measurement constraints.
- Logical scrolling when the full table exceeds browser pixel limits.

Frozen regions and variable row heights are extension points, not MVP
requirements.

### CanvasRenderer

The initial renderer:

- Paints only the current viewport and overscan needed for a frame.
- Scales correctly for device-pixel ratio.
- Clips and truncates text predictably.
- Schedules work through `requestAnimationFrame`.
- Exposes theme tokens instead of hard-coding application styling.
- Never parses data or mutates controller state during paint.

`OffscreenCanvas` may become an optimization, but the first design does not
depend on it. Moving parsing and data ownership to a Worker provides the most
important responsiveness boundary first.

### Interaction and accessibility

The Canvas is a visual layer, not the sole semantic layer. The renderer package
must provide or integrate with a bounded virtual DOM grid that:

- Owns keyboard focus while the Canvas remains `aria-hidden`.
- Exposes the active cell, row and column indexes, selection, and known extents.
- Supports arrow keys, Page Up/Down, Home/End, Escape, and copy shortcuts.
- Keeps the DOM proportional to the viewport, never to the full table.
- Announces parsing progress and errors without excessive live-region updates.

Selection cannot be communicated by color alone, focus must remain visible, and
reduced-motion and high-contrast preferences must be respected.

## 8. Security and resilience

All source data is untrusted. Each runtime and adapter must support limits for:

- Input bytes and decompressed bytes.
- Columns, field length, rows retained, and cells returned per request.
- Parser nesting or recursion where a format permits it.
- Worker memory and outstanding requests.
- Time spent probing an unsupported source.

Malformed input yields structured errors or diagnostics, never a panic exposed
to the host. Formula text and external links are treated as data; no embedded
code is executed. Network access and persistent storage are opt-in extension
ports rather than implicit adapter privileges.

If a Worker terminates unexpectedly, the facade fails pending requests with a
runtime error and allows the host to create a new session. Automatic reopening
is deferred until source replay and side effects are well defined.

## 9. Package and repository evolution

The M0-M2 implementation stays in one root Rust crate and one npm package so
the experimental contracts can change quickly:

```text
src/
  model.rs
  error.rs
  protocol.rs
  runtime.rs
  csv.rs
  wasm.rs

js/
  index.ts
  client.ts
  protocol.ts
  range-cache.ts
  rpc-client.ts
  worker/
  worker.ts
  view/

examples/
  csv-preview/

test/
  fixtures/
  browser/
  performance/
```

After the adapter and Worker contracts survive an end-to-end implementation
and a second source type, the repository can split along these boundaries:

```text
crates/
  tabulark-core/
  tabulark-protocol/
  tabulark-runtime/
  tabulark-csv/
  tabulark-wasm/

packages/
  tabulark/              # public facade
  protocol/
  worker/
  adapter-csv/
  renderer-canvas/
  controller/
  react/                 # optional binding
```

The split is a release and ownership boundary, not a prerequisite for the first
working prototype. Premature package separation would make contract iteration
slower without proving extensibility.

## 10. Engineering validation

Each boundary needs its own evidence:

- Model and protocol: Rust/JavaScript golden fixtures and compatibility tests.
- CSV/TSV: standards-oriented fixtures, malformed-input tests, property tests,
  and fuzzing on the Rust parser boundary.
- Worker: real-browser tests for transfer, cancellation, close, crash, and
  out-of-order responses.
- Renderer: deterministic layout tests, screenshot tests, keyboard tests, and
  accessibility checks against the semantic layer.
- Performance: reproducible local-file datasets, first-paint timing, scroll
  frame time, peak memory, transferred bytes, and package size.

The existing contract, Node, and Chromium suites provide M0-M2 prototype
evidence. The broader compatibility corpus, fuzzing, browser crash matrix,
screenshot/accessibility automation, and reproducible performance measurements
listed above are unfinished M3 work. Performance numbers remain engineering
targets until benchmark hardware, datasets, and harnesses are committed.

## 11. Architectural decisions for the first prototype

The M0-M2 prototype follows these decisions:

1. A source opens a dataset session; a dataset contains one or more tables.
2. Tables are immutable snapshots with progressively discovered metadata.
3. The Worker protocol, not a Rust trait, is the cross-runtime contract.
4. External coordinates are JavaScript safe integers in the first API.
5. Range responses are bounded, column-oriented, and transferable.
6. CSV/TSV values remain strings until explicit type inference is designed.
7. Parsing and data ownership stay in a Worker; Canvas painting starts on the
   main thread.
8. Caches are memory-bounded and persistence is opt-in.
9. The Canvas renderer ships with a bounded semantic DOM layer.
10. Package splitting happens only after a working vertical slice validates the
    contracts.

The implementation roadmap and release-level acceptance criteria are defined in
[MVP roadmap](mvp.md).
