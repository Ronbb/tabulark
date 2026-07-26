# Testing and release-candidate validation

> **M4 evidence is frozen.** Commit `1d79837` passed CI, GitHub Pages
> deployment, and the deployed-URL smoke test; the exact record remains in
> [`m4-completion.md`](m4-completion.md). The current tree is the 0.1.0 release
> candidate, not a tagged or published npm/crates.io release.

## Release-candidate scope

The active matrix covers four official, independently lazy Rust/WASM adapters:

| Official ID | Stable entry point | Source formats |
| --- | --- | --- |
| `tabulark:delimited` | `tabulark` | CSV and TSV |
| `tabulark:arrow-ipc` | `tabulark/arrow` | Arrow IPC File and Stream |
| `tabulark:parquet` | `tabulark/parquet` | Parquet |
| `tabulark:excel` | `tabulark/excel` | BIFF8 XLS and OOXML XLSX |

The checked-in official-adapter manifest is the source of truth for IDs,
entry points, WASM artifacts, option keys, source policy, and runtime weighting.
Tests reject drift between that manifest, package exports, Worker loading,
Pages assembly, and delivery-size accounting.

## Local command map

```sh
# Rust stable: formatting, lint, tests, and every feature
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --locked

# Fuzz harness compilation and deterministic seed replay
cargo test --manifest-path fuzz/Cargo.toml --locked
cargo run --manifest-path fuzz/Cargo.toml --bin csv_lifecycle --locked
cargo run --manifest-path fuzz/Cargo.toml --bin arrow_lifecycle --locked
cargo run --manifest-path fuzz/Cargo.toml --bin parquet_lifecycle --locked
cargo run --manifest-path fuzz/Cargo.toml --bin excel_lifecycle --locked

# JavaScript, declarations, fixtures, and packed consumers
npm ci
npm run build
npm run typecheck
npm test
npm run package:check
npm run pages:check

# Chromium-only browser and delivery gates
npm run test:browser
npm run benchmark:smoke
npm run benchmark:arrow
npm run benchmark:formats
npm run benchmark:size
```

`npm run check` combines the normal build, synchronized-version, type, Node,
packed-consumer, and Pages-assembly checks. CI additionally runs the Rust
workspace on both Rust 1.85.0 and stable, checks all four
`wasm32-unknown-unknown` wrappers, runs dependency advisory/license policy, and
tests clean npm consumers on Node 20, 22, and 24.

## Rust and adapter evidence

All four wrappers expose the same private `WasmRuntime` operation surface.
Their conformance tests cover open/continue/read, invalid steps, cancellation,
idempotent close and shutdown, failure cleanup, reservation release, and
isolation between sources and tables. Browser conformance also loads the four
real WASM artifacts and locks Worker protocol v3, official adapter API v2, and
private batch layout v1.

Delimited retains the versioned CSV/TSV corpus and multi-chunk matrix,
including BOM, CRLF, quoted delimiters and newlines, empty fields, missing final
newline, header-only and empty sources, ragged input, malformed quotes,
Latin-1 failure/recovery, and CJK text.

Arrow tests cover IPC File and Stream, uncompressed/LZ4/Zstd messages, schema
and logical-type families, extensions, empty/zero/multi-batch sources, ranges
across RecordBatches, dictionaries and run-end encoding, malformed framing,
nesting and metadata limits, decompression budgets, and low-budget recovery.
The exact supported/error matrix is tested below JavaScript because JavaScript
does not parse Arrow framing.

Parquet tests exercise footer and metadata range reads, row-group selection,
top-level projection, nested/logical typed Arrow batches, INT96 mapping,
malformed footers, oversized metadata, and decompression reservation failures.
Codec coverage reads and validates data pages—not only footer metadata—for
uncompressed, Snappy, Gzip, Brotli, LZ4, LZ4_RAW, and Zstd. LZO, encrypted
Parquet, and unsupported experimental logical types must fail with
`UNSUPPORTED_FEATURE`, not silently degrade or trigger a whole-file read.

The pinned dependency boundary is also auditable directly:

```sh
cargo tree -p tabulark-parquet-wasm -i zstd --locked
! cargo tree -p tabulark-parquet-wasm --edges normal --locked | grep -E 'zstd-(sys|safe)'
! cargo tree -p tabulark-arrow-wasm --edges normal --locked | grep -E 'zstd-(sys|safe)'
cargo test --manifest-path crates/zstd-pure-compat/Cargo.toml --locked
cargo check --manifest-path crates/zstd-pure-compat/compat-check/Cargo.toml --locked
```

The expected path terminates at `zstd-pure-compat -> ruzstd`; `zstd-sys` and
`zstd-safe` are forbidden. Compatibility tests exercise cross-implementation
frames, declared and unknown content sizes, checksum failures, corrupt input,
trailing frames, output ceilings, and the pre-allocation window ceiling on
Rust 1.85. The packed crates.io artifact is separately checked with normal
edges and all features to confirm its experimental production graph does not
reintroduce upstream Zstd after Cargo strips the workspace patch.

Excel tests cover signature-based BIFF8/XLSX selection, workbook-order tables,
hidden-sheet metadata, cached formula results, null cells, Unicode, dates,
merged regions, frozen panes, sparse row/column layout, static styles, and
budgeted staging/open/read cleanup. They lock both 1900/1904 date epochs and
reject sparse-but-enormous declared dimensions. XLSM, XLSB, ODS, pre-BIFF8,
encrypted CFB, unsafe ZIP paths, and XML DTD/entity inputs are rejected
structurally; resource exhaustion reports `RESOURCE_LIMIT` before the
prohibited allocation. Post-parse worksheet accounting includes Calamine's
per-cell value/formula string heap capacities as well as dense vector slots.
XLSX source registration also verifies a capacity-derived conservative retained
estimate for its parsed presentation collections; BIFF8 keeps its record-count
preflight.

## Fixture provenance

Every committed browser fixture has byte length and SHA-256 recorded in its
adjacent `provenance.json`. External fixtures also pin repository revision,
upstream path/blob, license, and a bundled license copy.

- Delimited keeps the deterministic corpus plus its pinned external `rust-csv`
  cases.
- Arrow keeps `m4-sample.arrow` and the byte-for-byte Apache Arrow
  cross-language integration fixture. The six performance fixtures cover
  File/Stream crossed with none/LZ4/Zstd.
- Parquet keeps the two-row-group `tabulark-rust.parquet` fixture and the
  independently produced Apache `parquet-testing`/Impala fixture.
- Excel keeps deterministic BIFF8 XLS and OOXML XLSX workbooks plus the
  independently produced Microsoft Excel workbook from the pinned XlsxWriter
  comparison corpus.

Fixture tests require both Parquet and Excel corpora to name at least two
independent producers and verify every recorded digest. Fixtures are rebuilt by
their checked-in Rust generators or reacquired from the exact pinned upstream
blob; the browser never manufactures an input format under test.

## Fuzz evidence

`csv_lifecycle`, `arrow_lifecycle`, `parquet_lifecycle`, and `excel_lifecycle`
each have bounded valid and malformed seed corpora. Ordinary CI compiles every
harness and deterministically replays all four corpora. The scheduled Linux
nightly workflow runs a ten-minute sanitizer-backed campaign per target with a
64 KiB input cap and uploads failure artifacts.

The harnesses deliberately exercise lifecycle and cleanup around parser input,
not only parsing a byte slice. A seed may open, continue, read, cancel, close,
or fail, and every path must remain bounded and reusable.

## Protocol and stable JavaScript contracts

Protocol-v1 fixtures remain immutable early evidence, and protocol-v2 fixtures
remain immutable M4 evidence. New v3 golden fixtures lock the four official
adapter descriptors, table-scoped metadata/progress/revision envelopes, and
spreadsheet presentation requests and responses. Adapter API v2 and batch
layout v1 are private implementation seams; they are intentionally absent from
the stable package exports.

Node tests and snapshots cover:

- The exact stable entry points `tabulark`, `/arrow`, `/parquet`, and `/excel`,
  plus the explicitly unstable `/experimental` entry point.
- Immutable official adapter registration, duplicate/forged descriptor
  rejection, option validation, and the absence of arbitrary module URLs or
  third-party adapter injection.
- The logical `TableBatch` facade, recursive data types, logical column access,
  `toRows()`, deterministic `toDisplayRows()`, validation, and cache accounting,
  without exposing wire buffers or protocol/layout constants.
- Range limits, global memory reservations, bounded queueing, cancellation,
  cascading and idempotent close, and independent recovery after one source or
  adapter fails.
- Multi-table metadata and lifecycle plus `getPresentation()` and range-aligned
  `readPresentationRange()` normalization.
- The checked-in `stable-declarations-v0.1.json` snapshot covers every file in
  the transitive declaration graph of the four stable entries. During 0.1.x,
  changes require explicit compatibility review; incompatible changes wait
  for 0.2.0.

The packed-consumer test creates a real npm tarball, installs it into a clean
temporary project, imports every entry point, and typechecks documented adapter
options and presentation types. CI repeats that consumer on Node 20, 22, and
24.

## Chromium browser gate

Chromium is the sole browser compatibility gate for 0.1.0. Firefox and WebKit
are not implied by a passing release. CI records the exact Playwright/Chromium
version alongside its release evidence; the frozen M4 run used Playwright
1.61.1 and Chromium 149.0.7827.55.

Playwright exercises the real module Worker and all four real WASM artifacts:

- CSV/TSV and Arrow retain strict/lenient, native/display, CJK, source
  replacement, cancellation, retry, transfer, range, and recovery coverage.
- Parquet opens projected multi-row-group data, and XLS/XLSX cover signature
  selection, workbook data, independently produced fixtures, and the shared
  lazy Excel runtime.
- Spreadsheet presentation is asserted through worksheet visibility, frozen
  rows/columns, sparse dimensions/hidden state, styles, merge behavior, Canvas
  hit regions, bounded ARIA output, keyboard navigation, and exact copy.
- Canvas virtualization, scrolling, resize, terminal errors, CJK paint and
  measurement, axe WCAG 2.1 A/AA scans, forced colors, reduced motion, mobile
  layouts, visible focus, and 44px touch controls remain release gates.

Strict visual snapshots run on Ubuntu 24.04 at one device pixel per CSS pixel.
They stabilize Canvas geometry rather than claiming cross-platform glyph
rasterization.

## Lazy-loading and Pages assertions

Network tests establish observable delivery behavior:

1. Loading the page and constructing an engine requests no WASM artifact.
2. CSV or TSV requests only Delimited WASM, once.
3. Arrow requests only Arrow WASM, once.
4. Parquet requests only Parquet WASM, once.
5. XLS and XLSX share one Excel WASM load and do not request it twice.

The assertions run against the assembled `target/pages` directory before
upload. After deployment, `pages-deployed.spec.mjs` receives the actual URL from
the Pages action and opens CSV, TSV, Arrow, Parquet, XLS, and XLSX. It verifies
data/ARIA/copy behavior, single lazy artifact requests, and a clean console,
page, and network. A skipped test, local server, or guessed URL is not deployed
evidence.

## Performance and delivery size

The M3 CSV canonical benchmark remains the historical 16 MiB reference;
`benchmark:smoke` is the smaller deterministic CI invariant. The Arrow matrix
continues to measure File/Stream x none/LZ4/Zstd cold load, first paint,
projected ranges, scroll behavior, transferred bytes, and memory phases.

`benchmark:formats` opens the SHA-pinned Parquet, BIFF8 XLS, and OOXML XLSX
fixtures in separate fresh Chromium contexts. Parquet and Excel have separate,
versioned ceilings for engine startup, selected-adapter cold open, logical
range read, and forced-GC peak memory; the memory ceiling is 64 MiB for each
adapter family. The report records exact table counts and memory samples from
idle through close, and the gate fails when any ceiling is exceeded.

`benchmark:size` measures raw and Brotli-quality-11 bytes in separate groups:

- Core: root entry, generic Worker, Delimited glue, and Delimited WASM.
- Arrow: `/arrow`, Arrow glue, and Arrow WASM.
- Parquet: `/parquet`, Parquet glue, and Parquet WASM.
- Excel: `/excel`, Excel glue, and Excel WASM.
- npm packed/unpacked totals and the complete Pages raw/Brotli totals.

The existing core and Arrow caps are not widened by M5. Parquet, Excel, and
aggregate delivery each have independent limits derived from a clean measured
artifact plus 15%, rounded upward to 64 KiB. The checked-in baseline records
the exact measured files and comparisons; hosted-runner timing is recorded but
is not a hard threshold.

## Release evidence and completion rule

The pre-tag CI matrix includes the dependency advisory/license policy. Its one
narrow exception is the maintenance-only `paste` advisory pulled by the
required Parquet 59.1.0 pin; vulnerability and unsoundness advisories remain
unignored, and the exception must be removed when that pin can move. The tag
workflow re-runs Rust stable/MSRV, fuzz seeds, four wrapper builds, Node consumer,
Chromium, performance, size, and package checks. It records the exact Chromium
version, npm tarball, tarball SHA-256, and SPDX SBOM.
After protected-environment approval it publishes crates.io first, publishes
that same verified npm tarball with provenance, creates the GitHub Release, and
smoke-tests the registry package on Node 20/22/24, and compiles/runs a clean
Cargo consumer against the exact crates.io version.

None of those delivery steps has run for 0.1.0 yet. Do not create `v0.1.0` or
describe 0.1.0 as published until the exact candidate commit has green CI and
Pages/deployed smoke evidence and every pre-tag check in
[`releasing.md`](releasing.md) succeeds. A local green run is useful evidence,
but it neither replaces the protected release approvals nor publishes a
registry version.
