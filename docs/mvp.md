# MVP Roadmap

> Status: the M0-M2 local CSV/TSV path remains an experimental prototype. An
> M3.1 lifecycle/protocol hardening and an M3.2 CSV compatibility and
> parser-fuzzing baseline are implemented, but M3 and M4 are not complete and
> the MVP is not a stable API promise.

## Goal

The first meaningful Tabulark release should prove one complete path:

```text
local CSV/TSV source
    -> Worker-hosted adapter
    -> common dataset and table model
    -> bounded range batches
    -> viewport controller and cache
    -> accessible Canvas preview
```

The goal is not broad format coverage. It is evidence that the common model,
Worker protocol, and renderer cooperate without copying the whole table onto the
main thread.

## MVP user flow

1. The host explicitly selects the CSV or TSV source format.
2. A user chooses a local `File`, or the host supplies a `Blob`/`ArrayBuffer`.
3. The engine opens a dataset session in a Worker and reports progress.
4. The dataset exposes one logical table and progressively updated metadata.
5. The preview paints headers and visible cells while parsing continues.
6. The user scrolls in both directions, navigates with the keyboard, selects a
   cell or range, and copies display text.
7. The host can cancel opening or a range read, close the table, and dispose the
   engine; a fresh engine can be created after a terminal Worker failure.

## Included

### Sources and parsing

- `File`/`Blob` and `ArrayBuffer` inputs.
- UTF-8 CSV and TSV, including a UTF-8 BOM.
- Quoted fields, escaped quotes, CRLF/LF line endings, and embedded newlines.
- Explicit delimiter and header-row options with conservative defaults.
- Configurable handling for ragged rows and malformed records.
- Progressive row discovery and structured diagnostics.

All CSV/TSV values are initially exposed as strings. Empty fields, missing
fields, and invalid records remain distinguishable.

### Runtime

- Module Worker and WASM initialization.
- Version handshake and typed request/response protocol.
- Dataset and table handle lifecycle.
- Metadata, progress, range reads, cancellation, close, and shutdown.
- Bounded requests, transferable response buffers, and byte-budgeted caches.
- Stale-generation suppression during rapid scrolling.

### Preview surface

- Column header and row number gutters.
- High-DPI Canvas painting.
- Horizontal and vertical virtual scrolling.
- Visible-range prefetch and loading placeholders.
- Active cell and rectangular selection.
- Keyboard navigation and copy as TSV display text.
- Basic column autosizing and manual resizing.
- Loading, ready, error, and closed states with structured cancellation,
  unsupported-input, malformed-input, and Worker-failure errors.
- A viewport-sized semantic DOM grid for keyboard and screen-reader access.

### Developer experience

- Framework-neutral JavaScript facade.
- One runnable browser example for local CSV preview.
- Rust and JavaScript API documentation for the experimental contract.
- Browser integration tests and a deterministic large-CSV generator.

## Deferred

- XLSX, XLS, Parquet, Arrow, Feather, SQLite, and DuckDB adapters.
- Automatic type inference and locale-aware value formatting.
- Remote URL fetching, streaming network sources, and compressed archives.
- Search, sorting, filtering, grouping, and derived views.
- Editing, formulas, validation, styles, merged cells, charts, and export.
- Frozen panes, variable row heights, and rich cell renderers.
- Persistent caches, SharedArrayBuffer, and OffscreenCanvas optimizations.
- React/Vue bindings and a full documentation application.

## Milestones

### M0: Contract skeleton

Status: the model, errors, version-one protocol, and shared fixtures are
implemented. The prototype moved directly to the CSV/TSV runtime rather than
adding the originally proposed test-only in-memory adapter.

Deliver:

- Core model for source, dataset, table, extent, schema, range, batch,
  capabilities, and errors.
- Versioned protocol messages and golden Rust/JavaScript fixtures.
- An in-memory reference adapter used only for contract tests.

Exit criteria:

- Rust and JavaScript agree on every serialized protocol fixture.
- Lifecycle and invalid-range behavior are documented and tested.
- No browser or Canvas work is required to validate the model.

### M1: Worker and CSV vertical slice

Status: implemented experimentally for local `Blob`/`File` and bounded
`ArrayBuffer` sources. Broader failure matrices and performance evidence belong
to M3.

Deliver:

- Worker client/runtime handshake and lifecycle.
- Rust CSV/TSV parser compiled to WebAssembly.
- Progressive metadata and bounded range reads.
- Cancellation, structured errors, and resource limits.

Exit criteria:

- A real browser can open a local CSV and read multiple non-adjacent ranges.
- Source bytes and parsed tables are not copied wholesale to the main thread.
- Closing a session releases handles and terminates pending work cleanly.

### M2: Viewport preview

Status: implemented experimentally. The first version uses fixed row heights,
main-thread Canvas painting, a bounded semantic grid, and native scroll hosts
with logical scroll compression for very large extents.

Deliver:

- Headless table controller and layout engine.
- Main-thread range cache and overscan scheduling.
- Canvas headers, cells, scrolling, resize, selection, and copy.
- Semantic DOM viewport and keyboard navigation.

Exit criteria:

- Rapid scrolling cannot paint an older request generation.
- DOM size stays proportional to the viewport.
- The preview remains usable while a large file is still being parsed.

### M3: Hardening and measurement

Status: partially implemented. The M3.1 slice provides:

- Terminal handling for delayed/background scan failures: live child tables
  close, controllers enter a terminal error state, the dataset closes, and the
  Worker releases the source.
- Bounded lifecycle-close waits. An unresponsive close or shutdown falls back
  to terminating the unusable Worker instead of waiting indefinitely.
- Defensive validation of Worker envelopes, response kinds, and returned
  handles; malformed or incompatible protocol state is terminal.
- Initial lenient diagnostics delivered after the dataset session is observable,
  with structured row and byte-offset context.
- `File.name` inferred as the default `sourceName` and table display name, plus
  an explicit `sourceName` option for other inputs or host overrides.
- A browser example with parse options, cancel, retry, strict-to-lenient
  recovery, and fresh-Worker recovery after terminal runtime failure, covered by
  `test/browser/example.spec.mjs`.

The M3.2 baseline adds:

- A versioned CSV/TSV corpus under `test/fixtures/csv/v1`, with expected
  metadata, rows, warnings, and errors declared in a manifest.
- Scanner and range-decoder checks for every manifest case across multiple
  source chunk sizes, including one-byte and other tiny chunks.
- A bounded `cargo-fuzz` `csv_lifecycle` target with checked-in seeds. Stable
  Rust provides a deterministic smoke path on Windows; this repository's real
  libFuzzer campaigns currently require Linux or WSL, nightly Rust, and
  `cargo-fuzz`.
- A scheduled `.github/workflows/fuzz.yml` campaign configured for 10 minutes
  each week, with manual dispatch support, once the workflow is on the default
  branch.

M3 remains incomplete. External and broader compatibility cases, continuous
corpus evolution, deterministic visual/screenshot and axe accessibility
coverage, and a committed reproducible performance baseline are still pending.
The current corpus and fuzz target are a foundation, not a broad compatibility
or performance claim.

Deliver:

- Continue expanding externally sourced compatibility fixtures and evolve the
  parser fuzz corpus as failures are discovered.
- Add CJK regressions for Chinese, Japanese, and Korean headers and cell text,
  including mixed Latin/CJK content, full-width punctuation, UTF-8 BOM/CRLF,
  one-byte scanner chunks, Canvas rendering, and TSV copy behavior.
- Worker failure, cancellation, and malformed-input browser tests.
- Deterministic layout, screenshot, keyboard, and accessibility tests.
- Benchmark harnesses for first paint, scroll frame time, memory, transfer
  volume, WASM startup, and package size.

Exit criteria:

- Performance claims are tied to committed datasets and documented hardware.
- Memory and input limits fail predictably instead of crashing the page.
- The example app covers empty, progress, error, cancel, and retry states.

### M4: Extension validation

Deliver one second source implementation, selected for architectural value
rather than market coverage. An in-memory Arrow batch adapter is a strong
candidate because it tests typed, already-columnar data without first requiring
the complexity of XLSX.

Exit criteria:

- The second adapter uses the same table, batch, lifecycle, and renderer APIs.
- Adapter-specific behavior remains behind capabilities and extension metadata.
- Only after this milestone are the adapter API and package boundaries candidates
  for stabilization.

## Historical implementation order

The prototype was organized around this dependency order:

1. Replace the exact-only shape assumption with the proposed extent model while
   retaining `TableShape` as a convenience for exact tables.
2. Define error, range, schema, batch, and capability values without adding a
   parser dependency.
3. Define protocol fixtures and test them from Rust and JavaScript.
4. Implement the in-memory adapter and Worker request lifecycle.
5. Add CSV/TSV parsing and progressive row discovery.
6. Build the layout engine before the Canvas painter.
7. Add selection, clipboard, semantic DOM, and framework examples only after
   viewport reads are stable.

This order keeps the first risky decisions observable and testable before more
formats or framework-specific APIs depend on them.
