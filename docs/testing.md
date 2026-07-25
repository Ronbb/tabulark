# Testing and performance validation

> Tabulark is pre-alpha. Passing local tests creates an M4 candidate; it does
> not replace green CI, GitHub Pages deployment, or the smoke test against the
> deployment’s actual URL.

## Local command map

```sh
# Rust contracts, adapters, lifecycle, and fixtures
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --locked

# Stable deterministic fuzz-seed replay
cargo run --manifest-path fuzz/Cargo.toml --bin csv_lifecycle --locked
cargo run --manifest-path fuzz/Cargo.toml --bin arrow_lifecycle --locked

# Browser package
npm ci
npm run build
npm run typecheck
npm test
npm run package:check
npm run test:browser

# Performance and delivery size
npm run benchmark:smoke
npm run benchmark:arrow
npm run benchmark:size
npm run build:pages
```

`npm run check` combines the normal type, Node, packed-consumer, and Pages
assembly checks. The explicit sequence above is useful when diagnosing one
layer or producing release evidence.

## Rust evidence

Both built-in adapters run through the same operation and lifecycle surface.
The Rust suite covers successful open/read/close flows, cancellation, handle
cleanup, resource recovery, and isolation after an adapter failure.

Delimited coverage retains the versioned CSV/TSV corpus and multi-chunk matrix,
including BOM, CRLF, quoted delimiters/newlines, empty fields, missing final
newline, header-only/empty sources, ragged input, malformed quotes, Latin-1
failure/recovery, and CJK text. The external `rust-csv` subset retains its
upstream revision, license, and digests.

Arrow tests cover IPC File and Stream with no compression, LZ4, and Zstd;
schema/data type families; extension storage metadata; empty/zero/multi-batch
sources; ranges spanning RecordBatches; dictionaries and run-end encoding;
malformed/truncated framing; nesting and metadata limits; decompression limits;
low-budget recovery; and lifecycle cleanup. The exact supported/error matrix is
tested in Rust because JavaScript does not parse Arrow framing.

The `arrow_lifecycle` fuzz target has valid compressed and targeted malformed
seeds. Scheduled sanitizer-backed fuzzing runs on Linux/nightly; stable seed
replay runs in ordinary CI and on Windows.

## Fixture provenance

`test/fixtures/arrow/v1/m4-sample.arrow` is the committed Playground fixture.
It contains 64-bit integers, decimal, timestamp, nulls, dictionary values,
nested list/struct values, and CJK text. Browser JavaScript only fetches these
bytes; it never generates IPC. Its byte length and SHA-256 are locked in
`test/fixtures/arrow/v1/provenance.json`.

The same directory includes a byte-for-byte Apache Arrow cross-language
integration fixture, its upstream revision/path/blob ID, digest, and license.
This prevents the suite from relying exclusively on files produced by the same
arrow-rs implementation under test.

Performance uses six additional deterministic fixtures under
`test/performance/fixtures/arrow/`: File/Stream crossed with
none/LZ4/Zstd. `provenance.json` locks the generator, Arrow version, container,
compression, size, and SHA-256 for each file. Rebuild them with the checked-in
Rust generator, never in the browser.

## Protocol and JavaScript contracts

The Rust and TypeScript sides share protocol-v2 golden fixtures. Rust tests
deserialize and reserialize the exact fixture shape; JavaScript tests validate
the same version-2 hello/open/metadata envelopes, adapter API version 1, batch
layout version 1, and explicit rejection of protocol v1.

Node tests cover:

- Required immutable adapter registration, duplicate rejection, official IDs,
  and removal of arbitrary URLs/legacy `format` selection.
- Default `ArrayBuffer` retention, explicit detach, and invalid Blob/File
  transfer.
- Recursive `dataType`, native `toRows()`, stable `toDisplayRows()`, special
  floats, binary, decimals, temporal/nested values, dictionary/run-end logical
  decoding, buffer deduplication, validation, and cache accounting.
- Range limits, cancellation, bounded queueing, source/table lifecycle, and
  independent recovery when one adapter fails.

## Browser integration

Playwright Chromium exercises the real module Worker and both WebAssembly
artifacts. The suite includes:

- CSV and TSV options, strict/lenient errors, warnings, cancellation, retry,
  terminal Worker recovery, and repeated source replacement.
- Arrow native/display values, the pinned nested CJK fixture, transfer
  semantics, and lazy artifact network assertions.
- Canvas paint, vertical/horizontal virtualization, selection, exact TSV copy,
  pointer/keyboard resize, terminal error behavior, and a bounded ARIA grid.
- CJK through parser, Worker/WASM, display rows, Canvas `fillText` and
  `measureText`, semantic grid, and clipboard.
- Axe WCAG 2.1 A/AA scans for idle, ready, error, dark, and forced-colors
  states, plus explicit system-color/focus/selection/resize tests.
- 375px portrait and 667x375 landscape layouts, page-level overflow checks,
  visible 44px controls, explicit source-specific options, reduced-motion
  media behavior, and no hover-only action.

Strict visual snapshots use Playwright Chromium on Ubuntu 24.04 with one device
pixel per CSS pixel. They intentionally stabilize Canvas geometry rather than
claiming cross-platform glyph rasterization.

## Lazy-loading assertions

Network tests establish the delivery contract rather than inferring it from
source structure:

1. Loading the page and constructing an engine requests no `.wasm` file.
2. Opening CSV/TSV requests Delimited WASM once and not Arrow WASM.
3. The first Arrow open requests Arrow WASM once.
4. Later Arrow opens reuse that artifact.

The same assertions run against the assembled Pages artifact. The deployed-URL
smoke repeats them on the real Pages origin.

## CSV performance baseline

`test/performance/scenarios.json` keeps the M3 deterministic CSV scenarios:

- `smoke`: a 2 MiB CI invariant pass.
- `canonical`: a 16 MiB-target, complete-row dataset with one warm-up and five
  measured iterations.

`npm run benchmark:canonical` records Worker/WASM startup, first usable data
paint, completed scan throughput, non-adjacent ranges, scroll-frame distribution,
transferred batch bytes, and `measureUserAgentSpecificMemory` samples after
forced GC. The committed Windows/Chromium report remains the M3 reference and
is not rewritten by routine CI.

## Arrow performance matrix

`npm run benchmark:arrow` runs all six SHA-pinned File/Stream ×
none/LZ4/Zstd scenarios. Each scenario records:

- Engine construction separately from the first Arrow open, so cold adapter
  load is visible and engine creation remains a no-WASM operation.
- First usable Arrow Canvas data paint.
- Projected range reads at the start, middle, and end of the indexed rows.
- Scroll frame distribution plus a non-zero scroll range, observed scroll
  travel, and changed-frame count. The harness fails if the fixture fits in the
  540px viewport or `scrollTop` never changes.
- Worker batch transfer volume.
- Memory at idle, engine ready, adapter open, first paint, range read, scroll,
  and closed phases.

Stream scenarios use the same runner and record the table’s random-access
capability after indexing. Every deterministic fixture repeats the semantic
four-row pattern across 512 rows and eight RecordBatches, so range reads cross
batch boundaries and Canvas scrolling moves through a real overflow range. The
CI matrix remains an invariant/smoke measurement rather than a throughput
guarantee for production-sized Arrow files. Larger cold-load and indexed-stream
reports can be recorded on stable hardware without weakening the deterministic
CI gate.

Reports are written as `target/bench/performance-arrow-*.json`, with an index at
`target/bench/performance-arrow-matrix.json`.

## Size budgets

`npm run benchmark:size` measures Brotli quality 11 and raw bytes for:

- Core runtime: root entry, generic Worker, Delimited glue, and Delimited WASM.
- Optional Arrow runtime: `/arrow` entry, Arrow glue, and Arrow WASM.
- npm packed and unpacked totals.
- The assembled Pages artifact.

The M3 core caps remain unchanged. Arrow and total delivery budgets are based
on a clean measured artifact plus 15%, rounded upward to a 64 KiB boundary.
`test/performance/baselines/package-sizes.json` records the measured files and
budget comparisons; `test/performance/size-budget.json` is the enforced limit.
Hosted-runner timing is recorded but not thresholded; deterministic sizes and
structural invariants are hard failures.

## Package and Pages evidence

`npm run package:check` creates a real npm tarball, installs it in a temporary
consumer, checks the root and `/arrow` export map, declarations, source maps,
generic Worker, both WASM artifacts, licenses/notices, absence of production
dependencies, runtime imports, and TypeScript consumer resolution.

`npm run build:pages` creates `target/pages`, rejects links and root-absolute
runtime URLs, validates relative imports, checks fixture digests, and requires
both adapter artifacts, declarations/maps, licenses, and notices. The Pages
workflow runs browser tests against that assembled directory before upload.

After deployment, `test/browser/pages-deployed.spec.mjs` runs only when
`TABULARK_DEPLOYED_BASE_URL` is present. It opens CSV, TSV, and Arrow; switches
and copies; checks nested CJK; asserts lazy/single WASM requests; and fails on
console, page, or request errors. A skipped test, local server, or guessed URL
does not count as deployed evidence.

## Completion rule

M4 may be marked complete only when the candidate commit has green CI, a
successful Pages deployment, and a successful deployed-URL smoke. Until then,
documentation and status reports must say “M4 candidate” or “deployment
verification pending.”
