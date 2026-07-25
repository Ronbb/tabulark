# Vision

Tabulark is a browser-native table preview engine: a small, composable layer
between local tabular bytes and an application’s table UI. It should make the
first usable viewport fast, keep memory bounded, preserve data meaning, and
remain accessible without requiring each application to rebuild parsing,
Worker orchestration, range caching, and Canvas virtualization.

## Product principles

### Local-first by default

A local `File`, `Blob`, or `ArrayBuffer` should remain local. Tabulark does not
need a server to preview it. Future network-backed sources must be explicit
capabilities with explicit application authority; they are not part of M4.

### One table contract, multiple source families

Renderers should not know whether a table came from delimited text or Arrow
IPC. Adapters normalize schema, capabilities, ranges, batches, errors, and
lifecycle into one public model while keeping format-specific options and
parsing behind their boundary.

M4 validates that idea with two independently loadable Rust/WASM adapters:

- CSV/TSV through `tabulark:delimited`.
- Apache Arrow IPC File/Stream through `tabulark:arrow-ipc`.

The M4 descriptors are intentionally official and closed. A third-party adapter
ecosystem, remote registry, or public adapter factory would require a separately
versioned security, packaging, and compatibility design after this boundary has
survived real use.

### Preserve semantics and render predictably

A table API should not flatten every value into a string. M4 therefore exposes
recursive Arrow data types and native values while producing a separate,
deterministic display representation for UI consumers. Dictionary and run-end
encodings remain inspectable; nested, decimal, temporal, interval, map, union,
binary, and extension-backed values retain their meaning.

### Pay only for the selected adapter

A CSV-only page should not load Arrow, FlatBuffers, LZ4, or Zstd. Engine
creation loads neither adapter artifact; the first source open selects and
coalesces one adapter load. Core and Arrow size budgets stay independent so a
large optional format cannot hide a regression in the everyday path.

### Keep work bounded and cancellable

Parsing, IPC framing, decompression, dictionary state, and decoded buffers can
all become denial-of-service surfaces. Limits must be derived from an engine
budget, every operation must be cancellable, and source/table handles must be
released after success, failure, cancellation, close, or Worker shutdown.

### Accessibility is part of the rendering architecture

Canvas speed cannot come at the cost of keyboard or screen-reader access. A
bounded semantic grid, visible focus, text-backed status, keyboard selection,
copy, and column resizing belong to the core view contract. Forced colors,
reduced motion, touch targets, and small-screen layouts are release gates rather
than optional polish.

### Evidence before milestone labels

Implementation is not completion. A milestone is complete only when its
fixtures, protocol tests, lifecycle tests, browser behavior, size/performance
measurements, assembled package, deployed static site, and real deployed-URL
smoke are green and attributable to the same revision.

## Near-term direction after M4

After the Arrow extension boundary is validated and deployed, likely work
includes:

- Hardening the experimental adapter ABI before any third-party surface.
- Persistent, opt-in caching keyed by source fingerprint and adapter version.
- Additional local formats such as Parquet, XLSX, and SQLite, each as an
  independently loadable adapter.
- Remote range providers and streaming sources with explicit authority and
  resource contracts.
- Framework bindings that wrap the same engine/table/view lifecycles rather
  than creating alternate data models.
- Firefox and WebKit validation after the Chromium-first contract is stable.

## Non-goals

Tabulark is not intended to become a full spreadsheet editor, formula engine,
database server, cloud upload service, or universal in-memory dataframe. It
provides dependable preview infrastructure on which applications can build
those higher-level experiences.
