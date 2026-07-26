# Testing and 0.2.0 release validation

> **Historical evidence is frozen.** Commit `1d79837` and its M4 record remain
> in [`m4-completion.md`](m4-completion.md); the immutable `v0.1.0` tag and its
> registry, Pages, recovery, and checksum evidence remain in
> [`release-0.1.0-evidence.md`](release-0.1.0-evidence.md). Do not rewrite
> either record for 0.2.0. Version 0.1.1 was never tagged or published; its
> compatible work is included in the finalized 0.2.0 release candidate.

## Stable release scope

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

# Three-browser functional gate plus Chromium-only performance/size gates
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
real WASM artifacts and locks Worker protocol v4, official adapter ABI v3, and
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

Excel tests cover incremental ZIP64 and CFB indexing, signature-based
BIFF8/XLSX selection, workbook-order tables, hidden-sheet metadata, cached
formula results, null cells, Unicode, dates, merged regions, frozen panes,
sparse layout, styles, and bounded open/read cleanup. They lock both 1900/1904
date epochs and reject sparse-but-enormous declared dimensions. XLSM, XLSB,
ODS, pre-BIFF8, encrypted CFB, unsafe ZIP paths, and XML DTD/entity inputs are
rejected structurally; resource exhaustion reports `RESOURCE_LIMIT` before the
prohibited allocation. Large range-backed opens compact only required workbook
content before using the same bounded Calamine table and presentation contract
as small compatibility opens.

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

Protocol-v1 fixtures remain immutable early evidence, protocol-v2 fixtures
remain immutable M4 evidence, and protocol-v3 fixtures remain immutable
presentation-era evidence. Protocol-v4 golden fixtures lock resumable
pending/progress/complete operations, monotonic revisions, bounded multi-range
actions, cooperative yields, and batch transfer. Adapter ABI v3 and batch
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
- The frozen `stable-declarations-v0.1.json` snapshot preserves the 0.1 API.
  `stable-declarations-v0.2.json` covers every file in the transitive
  declaration graph of the four finalized 0.2 stable entries.

The packed-consumer test creates a real npm tarball, installs it into a clean
temporary project, imports every entry point, and typechecks documented adapter
options and presentation types. CI repeats that consumer on Node 20, 22, and
24.

## Three-browser release gate

Chromium, Firefox, and WebKit are separate, release-blocking desktop projects.
CI and the release workflow install the pinned Playwright browsers and record
all three exact versions. Release evidence always runs with retries disabled;
a local diagnostic retry is not release evidence.

All three projects exercise the real module Worker and all four real WASM
artifacts:

- CSV/TSV and Arrow retain strict/lenient, native/display, CJK, source
  replacement, cancellation, retry, transfer, range, and recovery coverage.
- Parquet opens projected multi-row-group data, and XLS/XLSX cover signature
  selection, workbook data, independently produced fixtures, and the shared
  lazy Excel runtime.
- Spreadsheet presentation is asserted through worksheet visibility, frozen
  rows/columns, sparse dimensions/hidden state, styles, merge behavior, Canvas
  hit regions, bounded ARIA output, keyboard navigation, and exact copy.
- Canvas virtualization, scrolling, resize, terminal errors, CJK measurement,
  axe WCAG 2.1 A/AA scans, forced colors, reduced motion, visible focus,
  keyboard/pointer interaction, and touch targets remain release gates.
- Local Blob ranges, non-adjacent reads, cancellation/retry, repeated close,
  resource release, themes, ARIA, and Pages smoke are covered in Firefox and
  WebKit as well as Chromium.
- Chromium uses the real Clipboard API. Firefox and WebKit use the explicit
  clipboard-injection seam while asserting the same TSV result.

Only Chromium owns strict pixel snapshots, performance comparisons, and exact
2 GiB containers. Its Ubuntu 24.04 snapshots run at one device pixel per CSS
pixel and stabilize Canvas geometry rather than claiming cross-platform glyph
rasterization. Firefox and WebKit never generate replacement golden images.

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

The release-blocking relative gate compares the candidate with the frozen P0
SHA on the same Chromium runner. Baseline and candidate alternate after one
warm-up for five paired samples. If any comparison fails, the confirmation
pass uses two warm-ups and nine pairs. The median Worker/WASM startup, first
usable paint, non-adjacent range read, cache hit, and lifecycle close time may
be at most 10% slower than the baseline; the existing absolute timing and
memory ceilings are not relaxed.

`benchmark:size` measures raw and Brotli-quality-11 bytes in separate groups:

- Core: root entry, generic Worker, Delimited glue, and Delimited WASM.
- Arrow: `/arrow`, Arrow glue, and Arrow WASM.
- Parquet: `/parquet`, Parquet glue, and Parquet WASM.
- Excel: `/excel`, Excel glue, and Excel WASM.
- npm packed/unpacked totals and the complete Pages raw/Brotli totals.

The existing per-family, npm, and Pages caps remain in force. In addition, the
frozen P0 report requires all shipped `.js` measured with Brotli Q11 to be at
least 10% smaller than P0, requires `dist/worker.js` not to exceed its P0
Brotli size, and requires the removed `dist/worker/large-excel-adapter.js`
artifact to stay absent. None of these limits may be raised to make a release
candidate pass.

`wasm-resource-evidence.spec.mjs` runs each of the four real official runtimes
through 100 identical open/openTable/read/cancel/close lifecycles in every
release browser project. Runtime-owned bytes must be zero after every cycle,
cancellation and close must be idempotent, and the WebAssembly memory
high-water page count observed at cycle 10 must not grow through cycle 100.

## Release evidence and completion rule

The pre-tag CI matrix includes the dependency advisory/license policy. Its one
narrow exception is the maintenance-only `paste` advisory pulled by the
required Parquet 59.1.0 pin; vulnerability and unsoundness advisories remain
unignored, and the exception must be removed when that pin can move. The tag
workflow re-runs Rust stable/MSRV, fuzz seeds, four wrapper builds, Node
consumer, all three browser projects, Chromium performance, size, and package
checks. It records all browser versions, the npm tarball, tarball SHA-256, and
SPDX SBOM.
After protected-environment approval it publishes crates.io first, publishes
that same verified npm tarball with provenance, creates the GitHub Release, and
smoke-tests the registry package on Node 20/22/24, and compiles/runs a clean
Cargo consumer against the exact crates.io version.

The 0.2.0 preflight and tag workflow accept only successful `CI`, `GitHub
Pages`, and `M6 Large Files` runs for the exact same candidate SHA. A local
green run, a retry-only pass, or a small Pages fixture cannot substitute for
that evidence. Publishing remains behind protected approval and OIDC trusted
publishers. Version 0.1.1 must not be tagged or published, and `v0.1.0` must
never move.

## M6 exact large-file gate

The binary source ceiling is exactly `2^31 = 2,147,483,648` bytes. The
Chromium-only `M6 Large Files` workflow builds a native generator separately,
then creates, tests, and removes five real containers in sequence: CSV, Arrow
File, Parquet, XLSX, and XLS. Each file has an apparent size of exactly
`2^31`, and the browser reads a bounded final window ending at byte
`2^31 - 1`. No generated fixture or Cargo `target/` tree is uploaded.

The host must pass the original `File`/`Blob` to `engine.open()` in
`sourceMode: "large"`. It may call `Blob.slice()` only for bounded reads; a
whole-source `arrayBuffer()`, `FileReader`, upload, or source-sized budget
reservation fails review. Over-limit inputs are rejected before adapter load
with `RESOURCE_LIMIT` details `{ resource, requiredBytes, availableBytes }`.

Before each container the job requires at least 4 GiB free and records both
apparent and allocated size. The workflow timeout is 240 minutes; each
container has a 45-minute timeout, one Chromium worker, and zero retries. A
space shortage, timeout, or first-run failure is a release failure, not
permission to shrink the fixture.

The independent M6 budget is:

| Resource | Gate |
| --- | --- |
| Source size | at most 2,147,483,648 bytes |
| Engine retained working set | at most configured 256 MiB |
| Existing format and delivery budgets | unchanged |
| Index/cache/decoded batches | bounded and released exactly once on cancel, failure, and close |

Synthetic Rust/ABI tests separately cover `2^31 + 1`,
`Number.MAX_SAFE_INTEGER`, checked `offset + length`, and WASM `usize`
conversion without allocating giant buffers. The successful five-container
workflow is release evidence only for its own SHA and is mandatory alongside
CI and Pages before creating `v0.2.0`.
