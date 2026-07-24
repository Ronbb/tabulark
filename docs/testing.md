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
npm test
npm run test:browser
npm run package:check
```

Run the two focused Chromium specs that cover M3.1 engine diagnostics and the
interactive example with:

```bash
npm run test:browser -- test/browser/engine.spec.mjs
npm run test:browser -- test/browser/example.spec.mjs
```

The browser suite requires the Playwright Chromium build. Install it once with:

```bash
npx --no-install playwright install chromium
```

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

M3 does not yet have a committed performance baseline. The broader CSV corpus
and parser fuzzing, deterministic visual/screenshot checks, and axe
accessibility automation also remain pending; do not infer cross-browser or
performance guarantees from the current Chromium suite.
