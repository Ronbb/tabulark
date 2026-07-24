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
```

Run the focused Chromium specs that cover M3.1 engine diagnostics and the
interactive example, plus the M3.3 visual and axe baselines, with:

```bash
npm run test:browser -- test/browser/engine.spec.mjs
npm run test:browser -- test/browser/example.spec.mjs
npm run test:browser -- test/browser/visual.spec.mjs
npm run test:browser -- test/browser/a11y.spec.mjs
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
`v1/manifest.json` records parser options, optional byte-level source
transformations, expected metadata and rows, warnings, and structured errors.
The source fixtures remain ordinary reviewable UTF-8 files; the manifest can
apply a UTF-8 BOM, CRLF line endings, or removal of the final newline.

The Rust corpus test runs every manifest case with chunk sizes of 1, 2, 3, 5,
16, and 4096 bytes. It verifies complete scans and range decoding, including
checkpointed and overrun reads, so success does not depend on one convenient
source boundary. Add compatible cases to the current version; create a new
version directory when expected behavior intentionally changes.

This is an initial repository-owned corpus. It does not yet represent broad
external compatibility evidence, and it should continue to grow from
real-world files, minimized regressions, and fuzz findings.

The next planned corpus extension is CJK coverage: Chinese, Japanese, and
Korean headers and cells with mixed Latin text, full-width punctuation, and
UTF-8 BOM/CRLF inputs. Those cases should retain the current one-byte chunk
checks and gain browser assertions for Canvas rendering and copied TSV text.

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

After `.github/workflows/fuzz.yml` is present on the default branch, it runs a
bounded 10-minute campaign weekly and supports manual dispatch. Failures upload
the contents of `fuzz/artifacts` for seven days. Minimized regressions should be
reviewed and promoted into the versioned compatibility corpus or the fuzz seed
corpus as appropriate.

## Chromium integration tests

`npm run test:browser` builds the ESM, Worker, and WebAssembly artifacts before
Playwright opens the test harness and CSV preview through a small same-origin
HTTP server. The suite exercises the public `createEngine` facade with browser
`Blob` and transferable `ArrayBuffer` inputs, CSV and TSV options, non-adjacent
range reads, and `AbortSignal` cancellation for opening and reading. It also
verifies `File.name`/`sourceName` propagation, replay of initial scan warnings
with row context, strict malformed-input errors, Worker-failure presentation,
the M2 Canvas view, bounded semantic grid, keyboard selection, clipboard
output, horizontal and vertical scrolling, and column resize.
Chromium is the current compatibility target; Firefox and WebKit are
intentionally deferred.

`test/browser/example.spec.mjs` opens the real CSV preview example and checks
advanced parse options, cancellation followed by retry of the same `File`,
strict-to-lenient recovery with visible warnings, fresh-Worker retry after a
terminal runtime failure, and repeated local-session replacement without
sending file contents over the network.

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
and AA tagged rules against four example states: idle light, ready light,
strict-parse error light, and ready dark. Within that tag set the test disables
no rule and excludes no element; any violation fails the test and attaches the
complete axe result as JSON.

This is rule-based automation over the example UI and the bounded semantic DOM
grid. It does not inspect the `aria-hidden` Canvas pixels, replace manual screen
reader testing, validate every focus/announcement sequence, or establish a
complete WCAG conformance claim. Column resizing is still exercised only by
pointer drag/double-click, with no keyboard resize contract, and there is no
committed forced-colors-specific visual baseline. CJK Canvas rendering and TSV
copy remain the next corpus/browser extension described above.

## Large-file data

Do not commit generated large files. Generate a deterministic CSV incrementally
without retaining it in memory:

```bash
node test/performance/generate-csv.mjs --size 1GiB
```

The default output is `target/bench/tabulark-1g.csv`, which is ignored by Git.
Use `--output PATH` and `--size SIZE` to select another destination or a smaller
smoke-test input. The generator may finish one complete CSV row beyond the
requested byte size so the result remains valid CSV.

Large-file measurements must report the dataset size, browser version,
hardware, time to first usable range, completed scan throughput, range-read
latency, and peak engine-owned memory. A generated file is test input, not a
published performance guarantee.

M3 does not yet have a committed performance baseline. External and broader
CSV/TSV corpus coverage, continuous corpus evolution, CJK visual/copy cases,
keyboard-operable resizing, and forced-colors-specific validation also remain
pending. The current corpus, fuzz target, Linux-Chromium screenshots, and axe
checks are bounded baselines only; do not infer broad compatibility,
cross-browser behavior, complete accessibility conformance, or performance
guarantees from them.
