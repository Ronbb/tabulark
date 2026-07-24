# MVP Roadmap

> Status: M3 is complete for the bounded experimental local CSV/TSV vertical
> slice. Its lifecycle, compatibility, inclusive-interaction, and measurement
> evidence is committed and enforced in CI. M4 is not complete, and neither the
> MVP nor its package API is a stability promise.

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

Status: implemented for the bounded CSV/TSV vertical slice. The M3.1 slice
provides:

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
  each week, with manual dispatch support.

The M3.3 baseline adds:

- Strict-pixel Canvas snapshots for ready, keyboard-selection, and horizontal
  scroll states, validated in CI and release verification with Playwright
  Chromium on Ubuntu 24.04; that runner is the canonical environment for
  intentional baseline updates.
- A fixed layout and device-pixel ratio plus text-transparent snapshot colors,
  which keep geometry deterministic while leaving glyph and CJK rendering for
  separate browser coverage.
- Automated axe checks for WCAG 2.0/2.1 A and AA tagged rules in idle, ready,
  strict-error, and dark-ready example states, without rule or element
  exclusions inside that tag set.
- CI and release browser verification pinned to the Linux baseline runner, with
  traces and screenshot diffs retained on failure.

The M3.4 CJK slice adds:

- A versioned TSV fixture with Chinese, Japanese, and Korean headers and cells,
  mixed Latin/CJK content, and full-width punctuation. Its manifest applies
  UTF-8 BOM and CRLF transformations before the existing scanner and range
  matrix runs with chunk sizes of 1, 2, 3, 5, 16, and 4096 bytes.
- A Chromium regression that opens the same transformed fixture through the
  real Worker/WebAssembly runtime and checks exact schema, rows, and bounded
  semantic-grid text without Unicode replacement characters.
- Exact assertions that every expected CJK string reaches the Canvas
  `fillText` paint and `measureText` autosize paths, and that keyboard selection
  copies the six-cell range as TSV without character or full-width-punctuation
  loss.
- A deliberate boundary around font behavior: the test verifies Canvas input,
  while glyph shaping and rasterization remain platform-owned and are not added
  to the strict Linux-Chromium pixel baseline.

The M3.5 compatibility and inclusive-interaction closure adds:

- A pinned subset of the external `BurntSushi/rust-csv` example corpus with the
  exact upstream MIT license, revision, provenance, and content digests. It
  covers unusual quoting, empty fields versus the literal `NULL`, and
  strict/lenient Latin-1 paths.
- Real Worker/WebAssembly browser tests for cancellation after a range request
  is sent, predictable input/field resource-limit failures, same-engine recovery,
  strict malformed-quote offsets, and a usable header-only example state.
- Stable focusable `separator` elements for every visible column boundary, with
  ARIA value/bounds/instructions and Arrow, Shift+Arrow, Home, End, and
  Enter-to-fit keyboard behavior. Focus survives updates and horizontal scrolling
  keeps the operated boundary visible.
- A dynamic forced-colors contract for Canvas system colors, non-color selection
  and active-cell cues, visible 44-by-44 CSS-pixel resize targets, focused error
  recovery, and axe coverage for ready and error states.

The M3.6 measurement closure adds:

- A deterministic, digest-checked 16 MiB-target CSV scenario (16,777,218
  generated bytes so it ends on a complete row) with one warm-up and five
  measured Chromium runs, plus a smaller smoke scenario for CI.
- Reproducible measurements for Worker/WASM startup, first usable Canvas paint,
  completed scan throughput, three non-adjacent range reads, scroll-frame
  latency, exact binary batch transfer, and benchmark-page memory deltas.
- Environment and source-revision metadata in the committed Windows/Chromium
  baseline. Memory measurement requires cross-origin isolation, a full Chromium
  channel, the browser's memory API, and forced garbage collection before each
  sample; missing required evidence fails the harness.
- Enforced raw and Brotli runtime/Pages budgets and npm packed/unpacked budgets
  in CI and release verification.

The repository also ships a responsive introduction and live local-file
playground as the high-priority public demonstration surface. A deterministic
static build is deployed from `main` to GitHub Pages and is covered at both the
repository root and the assembled project-Pages path, including a 375-pixel
mobile interaction check. This is a delivery surface for the prototype, not a
claim that the package API is stable.

M3 completion is intentionally bounded. Corpus and fuzz evolution continue as
maintenance when real failures are found; they are not an infinite exit gate.
Platform-font pixel equivalence, Firefox/WebKit compatibility, manual
screen-reader certification, broad-format compatibility, and cross-machine
performance guarantees are outside this milestone. The committed evidence must
not be presented as any of those broader claims.

Delivered:

- Reviewable internal, CJK, and externally sourced CSV/TSV fixtures plus bounded
  deterministic and scheduled fuzzing.
- Worker failure, cancellation, resource-limit recovery, malformed-input, and
  empty-state browser tests.
- Keyboard-operable column resizing and forced-colors-specific visual, semantic,
  error, and automated-accessibility coverage.
- Benchmark harnesses and committed evidence for first paint, scan and range
  timing, scroll frames, memory, transfer volume, WASM startup, and package size.

Exit criteria:

- [x] A versioned CJK case preserves exact headers and cells through single-byte
  parsing, Worker/WebAssembly decoding, the semantic grid, Canvas paint/autosize
  inputs, and keyboard-driven TSV copy without replacement characters.
- [x] Column resizing has a keyboard-operable semantic contract, not only pointer
  drag and double-click behavior.
- [x] Forced-colors mode preserves visible focus, selection, resize affordances,
  and error state meaning through explicit semantic and browser coverage.
- [x] Performance measurements are tied to a deterministic dataset, source
  revision, browser version, operating system, and documented hardware.
- [x] Memory and input limits fail predictably instead of crashing the page, and
  recoverable failures leave the engine usable.
- [x] The example app covers empty, progress, error, cancel, and retry states.

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
