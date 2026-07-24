# Testing and performance validation

Tabulark separates fast contract tests from real-browser Worker tests. Run a
complete local validation from the repository root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --locked
cargo check --target wasm32-unknown-unknown --no-default-features --features wasm --locked
npm ci
npm run build
npm run build:pages
npm test
npm run test:browser
npm run package:check
npm run benchmark:smoke
npm run benchmark:size
cargo run --manifest-path fuzz/Cargo.toml --bin csv_lifecycle --locked
```

Run the focused Chromium specs that cover engine diagnostics, the interactive
example, inclusive interaction, and the visual/accessibility baselines with:

```bash
npm run test:browser -- test/browser/engine.spec.mjs
npm run test:browser -- test/browser/example.spec.mjs
npm run test:browser -- test/browser/visual.spec.mjs
npm run test:browser -- test/browser/a11y.spec.mjs
npm run test:browser -- test/browser/view.spec.mjs
npm run test:browser -- test/browser/forced-colors.spec.mjs
npm run test:browser -- test/browser/cjk.spec.mjs
```

The browser suite requires the Playwright Chromium build. Install it once with:

```bash
npx --no-install playwright install chromium
```

The Playwright-managed Chromium build is the default for local and CI runs. To
diagnose a system Chrome-specific difference without changing the canonical
baseline environment, set `TABULARK_BROWSER_CHANNEL=chrome` for that command;
do not use a system channel to update committed visual snapshots.

The WebAssembly build invokes `wasm-bindgen` directly. Install a
`wasm-bindgen-cli` version identical to the `wasm-bindgen` package recorded in
`Cargo.lock`; version `0.2.100` is used by the current lockfile.

## Protocol fixtures

Version-one Worker messages live under `test/fixtures/protocol/v1`. They are
golden compatibility fixtures shared by Rust serialization tests and
JavaScript envelope tests. A protocol change must either preserve these files
or introduce a new versioned directory; silently changing an existing fixture
is not compatible.

`warning-event.json` locks the public diagnostic shape, including `row` and
`byteOffset`. Node lifecycle coverage also verifies that delayed/background scan
fatals close live tables and datasets exactly once, release the Worker source,
bound unresponsive close waits, and terminate on malformed protocol messages.

## CSV/TSV compatibility corpus

The versioned delimited-text corpus lives under `test/fixtures/csv`. Its
`v1/manifest.json` records parser options, optional source materialization and
byte-level transformations, expected metadata, complete rows or sampled row
checkpoints, warnings, and structured errors. Source fixtures remain reviewable
UTF-8 files; the manifest can materialize Latin-1 bytes or apply a UTF-8 BOM,
CRLF line endings, and removal of the final newline.

The Rust corpus test runs every manifest case with chunk sizes of 1, 2, 3, 5,
16, and 4096 bytes. It verifies complete scans and range decoding, including
checkpointed and overrun reads, so success does not depend on one convenient
source boundary. Add compatible cases to the current version; create a new
version directory when expected behavior intentionally changes.

Most cases are repository-owned and optimized for reviewable parser contracts.
M3 also pins a subset of `BurntSushi/rust-csv` at revision
`4a3997e91d668ea1d8595bdef15625a77cf2308a`. The fixture directory includes the
exact upstream MIT license plus revision-pinned paths/URLs and stored/upstream
SHA-256 provenance for `strange.csv`, `uspop-null.csv`, and
`uspop-latin1.csv`. Tests reconstruct the Latin-1 bytes from a reviewable UTF-8
fixture and verify every digest before applying the same chunk-size matrix.
This bounded external subset is concrete compatibility evidence, not a claim of
broad CSV compatibility. Continue to grow the corpus from real files, minimized
regressions, and fuzz findings.

The M3.4 corpus extension adds `tsv-cjk-crlf-bom`, with Chinese, Japanese, and
Korean headers and cells, mixed Latin text, and full-width punctuation. The
manifest applies UTF-8 BOM and CRLF transformations. Like every other case, it
runs through scanner and range decoding at chunk sizes 1, 2, 3, 5, 16, and
4096 bytes.

## Parser fuzzing

`fuzz/fuzz_targets/csv_lifecycle.rs` is the `cargo-fuzz` entry point. It feeds
arbitrary inputs up to 64 KiB through both lenient and derived parser options,
variable contiguous scan chunks, metadata invariants, range planning and
decoding, invalid-offset recovery, and terminal lifecycle checks. Checked-in
seeds live under `fuzz/corpus/csv_lifecycle`.

On Windows, run the deterministic stable-Rust smoke executable:

```bash
cargo run --manifest-path fuzz/Cargo.toml --bin csv_lifecycle --locked
```

This smoke path exercises the same invariant function over checked-in seeds,
but it is not a libFuzzer campaign. For this repository, real sanitizer-backed
fuzzing is currently supported on Linux or WSL with nightly Rust and
`cargo-fuzz`:

```bash
cargo +nightly install cargo-fuzz --version 0.12.0 --locked
cargo +nightly fuzz build csv_lifecycle
cargo +nightly fuzz run csv_lifecycle -- -max_total_time=600 -max_len=65536
```

`.github/workflows/fuzz.yml` runs a bounded 10-minute campaign weekly and
supports manual dispatch. Failures upload
the contents of `fuzz/artifacts` for seven days. Minimized regressions should be
reviewed and promoted into the versioned compatibility corpus or the fuzz seed
corpus as appropriate.

## Chromium integration tests

`npm run test:browser` builds the ESM, Worker, and WebAssembly artifacts before
Playwright opens the test harness and CSV preview through a small same-origin
HTTP server. The suite exercises the public `createEngine` facade with browser
`Blob` and transferable `ArrayBuffer` inputs, CSV and TSV options, non-adjacent
range reads, and `AbortSignal` cancellation for opening and reading, including a
request cancelled after it reaches the Worker. It also verifies predictable
input/field resource-limit errors, that a rejected oversized buffer is not
detached, same-engine recovery, strict malformed-quote codes and byte offsets,
`File.name`/`sourceName` propagation, replay of initial scan warnings with row
context, Worker-failure presentation, the Canvas view, bounded semantic grid,
keyboard selection, clipboard output, scrolling, and pointer/keyboard column
resize.
Chromium is the current compatibility target; Firefox and WebKit are
intentionally deferred.

`test/browser/cjk.spec.mjs` reads the same versioned CJK fixture and manifest,
applies its BOM/CRLF source transforms, and opens it through the real module
Worker and WebAssembly parser. It asserts exact schema, range rows, semantic
grid text, Canvas `fillText` paint and `measureText` autosize inputs, and a
six-cell keyboard selection copied as TSV. The test rejects Unicode replacement
characters. It intentionally does not add a text-pixel screenshot: system fonts
own glyph shaping and rasterization, while this regression locks the strings
Tabulark passes to the Canvas API.

`test/browser/example.spec.mjs` opens the real CSV preview example and checks
advanced parse options, cancellation followed by retry of the same `File`,
strict-to-lenient recovery with visible warnings, fresh-Worker retry after a
terminal runtime failure, a ready header-only source with a clear empty-state
message, and repeated local-session replacement without sending file contents
over the network.

The HTTP server is test-only. It serves the repository root with the correct
JavaScript and WebAssembly MIME types and disables caching so rebuilt artifacts
are always observed.

## Introduction and GitHub Pages artifact

The repository-root `index.html` is both the local introduction/playground and
the GitHub Pages entry point. `npm run build:pages` builds the package runtime
and assembles a static, link-free artifact under `target/pages`. The artifact
includes only the landing page, compatibility redirect, playground module,
licenses, and required ESM/Worker/WebAssembly files. The build rejects missing
runtime files and root-absolute asset URLs, because project Pages serves this
repository below `/tabulark/`.

`test/browser/site.spec.mjs` verifies the root page, a real sample preview from
the assembled artifact URL, and the 375-pixel mobile primary path with minimum
44-pixel actions and no document-level horizontal overflow. The existing
example, Canvas, error recovery, visual, and axe specs continue to exercise the
same playground DOM at its compatibility URL.

`.github/workflows/pages.yml` rebuilds the artifact on `main`, uploads it with
the official Pages artifact action, and deploys it through the protected
`github-pages` environment. The repository must use **GitHub Actions** as its
Pages source in Settings. Deployment is deliberately separate from pull-request
CI; pull requests validate the same artifact through `npm run check` and the
browser suite without publishing it.

## Visual regression baseline

`test/browser/visual.spec.mjs` renders a fixed 640-by-320 Canvas host at device
pixel ratio one from a deterministic 12-column source. Strict screenshots lock
the ready layout, keyboard selection, and horizontal-scroll states with no
pixel-difference allowance. The snapshot theme makes text foregrounds
transparent, so the baseline covers backgrounds, grid geometry, selection,
active-cell outlines, and scrolling without treating platform font
rasterization as stable.

Expected screenshots under `test/browser/visual.spec.mjs-snapshots` are
validated by bundled Playwright Chromium on Ubuntu 24.04. The CI browser job
and release verification job are pinned to that runner image, which is also the
canonical environment for intentional baseline generation or updates. Run the
following command in that Linux environment, review all three images, and
commit an update only when the visual change is intentional:

```bash
npm run test:browser -- test/browser/visual.spec.mjs --update-snapshots
```

Do not replace the canonical baseline with screenshots generated by a local
Windows or macOS browser. On CI or release failure, the uploaded
`playwright-report`/`test-results` artifact contains available traces and
screenshot actual/expected/diff output.

## Automated accessibility boundary

`test/browser/a11y.spec.mjs` runs `@axe-core/playwright` for WCAG 2.0 and 2.1 A
and AA tagged rules against six example states: idle light, ready light,
strict-parse error light, ready dark, ready forced-colors, and strict-error
forced-colors. Within that tag set the test disables no rule and excludes no
element; any violation fails the test and attaches the complete axe result as
JSON.

This is rule-based automation over the example UI and the bounded semantic DOM
grid. It does not inspect the `aria-hidden` Canvas pixels, replace manual screen
reader testing, validate every focus/announcement sequence, or establish a
complete WCAG conformance claim. Separate browser contracts exercise focusable
ARIA `separator` elements with keyboard resize and dynamic forced-colors paint
commands using system colors, distinct active/selection geometry, visible
resize focus, and textual error/retry behavior. That command-level contract is
deliberately more stable than a platform-dependent high-contrast screenshot.
CJK Canvas input and TSV copy are covered separately by the M3.4 regression.

## Performance and size baselines

The committed canonical measurement is generated with:

```bash
npm run build:pages
npm run benchmark:canonical
```

`benchmark:canonical` deterministically targets 16 MiB and finishes the current
CSV row, producing exactly 16,777,218 bytes. It verifies that byte count, row
count, and SHA-256 digest, performs one warm-up followed by five measured runs,
and writes
`test/performance/baselines/windows-chromium-16mib.json`. It records the source
revision, dirty-tree state, browser/Node/OS versions, CPU, logical cores, system
memory, viewport, and every raw sample. Regenerate that reviewed baseline only
on the documented Windows/Chromium environment; normal CI runs the 2 MiB smoke
scenario instead:

```bash
npm run benchmark:smoke
npm run benchmark:size
```

The browser harness measures the Worker/WASM ready handshake; the first real
data Canvas paint followed by the next animation frame; completed scan
throughput; three non-adjacent range reads; 120 scroll animation frames; exact
binary batch payload bytes observed at the Worker boundary; and memory at idle,
engine-ready, scan-complete, scroll-complete, and closed phases. Memory is the
implementation-dependent `measureUserAgentSpecificMemory()` delta for the whole
isolated benchmark page (including its Worker, WASM, and view), not a precise
engine-owned heap reading. The server supplies COOP/COEP, the harness uses the
full Playwright Chromium channel and forces garbage collection before every
sample, and a missing or failed memory measurement is a test failure. See the
[browser memory API guidance](https://web.dev/articles/monitor-total-page-memory-usage)
and [Playwright browser-channel documentation](https://playwright.dev/docs/browsers)
for those platform requirements.

The baseline recorded on 2026-07-24 at source revision `4775150d` used Chromium
149.0.7827.55 and Node 24.1.0 on Windows 10.0.26100, an Intel Core i5-14500 with
20 logical cores, and 34,031,316,992 bytes of system memory. Across five samples,
the medians were 13.79 ms startup, 69.60 ms first usable paint, 90.47 MiB/s
completed scan throughput, 4.73 ms range-read median, 18.22 ms scroll p95,
166,538 transferred batch bytes, and a 7,252,786-byte peak benchmark-page memory
delta; all samples had zero scroll frames over 33.4 ms. These numbers are a
reproducible engineering baseline for that environment, not a cross-machine
performance guarantee.

`benchmark:size` measures the four shipped runtime files and the assembled Pages
artifact as raw bytes and Brotli quality 11, runs `npm pack`, and enforces the
budgets in `test/performance/size-budget.json`. CI and release verification treat
budget overages as hard failures. Timing values are retained as artifacts and
invariants, not compared to noisy hosted-runner timing thresholds. The M3 close
report records 417,586 raw / 104,580 Brotli runtime bytes, a 220,529-byte packed
npm archive (842,670 bytes unpacked), and 887,166 raw / 194,848 Brotli Pages
bytes; `test/performance/baselines/package-sizes.json` records each budget and
remaining margin.

For an optional manual large-file extension, generate a deterministic CSV
incrementally without retaining it in memory. Do not commit generated large
files:

```bash
node test/performance/generate-csv.mjs --size 1GiB
```

The default output is `target/bench/tabulark-1g.csv`, which is ignored by Git.
Use `--output PATH` and `--size SIZE` to select another destination or a smaller
smoke-test input. The generator may finish one complete CSV row beyond the
requested byte size so the result remains valid CSV.

Report manual large-file results with the dataset digest and size, source
revision/dirty state, browser and hardware, first usable paint, completed scan
throughput, range latency, scroll frames, transfer volume, and benchmark-page
memory delta. The 1 GiB generator is an extension tool, not part of the bounded
M3 baseline or a published performance guarantee.
