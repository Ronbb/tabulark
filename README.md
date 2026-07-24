# Tabulark

> A WebAssembly-first engine for fast, format-agnostic tabular data preview in the browser.

**One table model for every tabular source.**

**Status: pre-alpha local CSV/TSV M0–M2 prototype.**

> [!IMPORTANT]
> Tabulark has an experimental CSV/TSV Worker, WebAssembly runtime, and
> accessible Canvas viewport. There is no stable public API or production-ready
> release yet. M3 hardening and measurement, M4 second-adapter validation, and
> the broader format roadmap described below are not shipped.

## Why Tabulark?

Tabular data reaches web applications through many formats, but preview
interfaces repeatedly reimplement parsing, data transfer, caching, and
rendering for each one.

Tabulark is being designed as composable browser infrastructure that presents
those sources through one format-agnostic `Table` model. It is a preview engine,
not a spreadsheet application.

## Design principles

- One `Table` abstraction for every supported data source.
- Independently loadable source adapters, including format-specific parsers.
- Parsing and data ownership outside the browser main thread, with WebAssembly
  as the primary runtime for performance-sensitive components.
- Demand-driven access instead of copying an entire dataset into JavaScript.
- Viewport-oriented rendering, with Canvas as the first experimental renderer.
- Framework-neutral, composable building blocks.

## Target architecture

```text
Data source
    -> source adapter
    -> Worker / WebAssembly runtime
    -> unified Table model and cache
    -> viewport query API
    -> renderer
    -> application UI
```

This architecture is intentionally provisional while the first end-to-end
prototype is being developed.

## Current prototype

The repository currently contains:

- Rust table extent, schema, range, columnar batch, structured error, and
  version-one Worker protocol models.
- An incremental CSV/TSV parser and sparse row index compiled to WebAssembly.
- A browser ESM facade backed by a dedicated module Worker, with progressive
  metadata, bounded range reads, cancellation, and explicit lifecycle cleanup.
- A framework-neutral viewport controller, high-DPI Canvas painter, native
  virtual scrolling, selection, clipboard, column resize, and bounded semantic
  DOM grid.
- Golden protocol fixtures, Node contract tests, and Chromium Worker
  integration tests.
- An interactive Canvas browser example and a deterministic large-CSV
  generator.

M3 production hardening and reproducible measurements, M4 extension validation
with a second adapter, persistent caches, additional formats, and framework
bindings remain future milestones.

## Experimental browser API

The experimental data API opens `File`, `Blob`, or bounded `ArrayBuffer`
sources and returns columnar batches. All names and wire formats may change
before stabilization.
`ArrayBuffer` ownership is transferred to the Worker and the caller's buffer is
detached; use `File` or `Blob` for large sources.

```js
import { createEngine } from "tabulark";

const engine = await createEngine();
const dataset = await engine.open(file, {
  format: "csv",
  header: "first-row",
  mode: "lenient",
});
const table = await dataset.openTable(dataset.tables[0].id);
const batch = await table.readRange({
  rowStart: 0,
  rowCount: 100,
  columnStart: 0,
  columnCount: table.metadata.schema.columns.length,
});

console.table(batch.toRows());

await table.close();
await dataset.close();
await engine.close();
```

## Experimental Canvas viewport

Mount the viewport into a container with an explicit height. The returned view
owns only its DOM and controller; the host remains responsible for closing the
table, dataset, and engine.

```js
import { createCanvasTableView } from "tabulark";

const view = createCanvasTableView({
  container: document.querySelector("#preview"),
  table,
});

view.focus();

// When unmounting the preview:
view.destroy();
```

The visual Canvas is paired with a viewport-sized ARIA grid. Arrow keys,
Page Up/Down, Home/End, Shift-selection, copy as TSV, horizontal and vertical
scrolling, and pointer column resizing are part of the experimental M2 surface.
Advanced integrations can create a headless controller with
`createTableController(table, options)` and pass it to the Canvas view.

Run `npm run example`, then open
`http://127.0.0.1:4173/examples/csv-preview/` to try a local file or the
generated sample dataset.

## Planned data sources

CSV and TSV are the only implemented source formats in this prototype.
Longer-term candidates include XLSX, XLS, Parquet, Apache Arrow, Feather,
SQLite query results, DuckDB query results, and third-party data sources.

A format should not be considered supported until a released adapter is backed
by compatibility tests.

## Non-goals

Tabulark is not intended to be:

- A spreadsheet editor or Excel replacement.
- A formula calculation or workbook recalculation engine.
- A VBA, macro, or arbitrary workbook-code runtime.
- A pixel-perfect implementation of every Office document feature.
- A pivot table, chart authoring, BI, or database product.
- A mandatory all-formats bundle or complete application framework.

Editing, analysis, and application-specific UI may be built on top of Tabulark,
but they are outside the core project's scope.

## Development

Requirements:

- Rust 1.85 or later.
- Node.js 20 or later.
- npm 10 or later.
- `wasm-bindgen-cli` matching the `wasm-bindgen` version in `Cargo.lock`.
- Playwright Chromium for browser integration tests.

Run the local checks:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo check --target wasm32-unknown-unknown --no-default-features --features wasm --locked
cargo package --allow-dirty --locked
npm ci
npm run build
npm run check
npm run test:browser
```

After the first registry release, consumers will be able to install the base
packages with:

```bash
cargo add tabulark
npm install tabulark
```

## Repository layout

```text
tabulark/
├── src/                  # Rust crate
├── js/                   # Browser facade, Worker, controller, and Canvas view
├── test/                 # Contract, browser, and performance test harnesses
├── examples/csv-preview/ # Browser Canvas-preview example
├── scripts/              # Repository validation scripts
├── docs/                 # Vision and release documentation
└── .github/workflows/    # CI and registry publication
```

See the [project vision](docs/vision.md) for the long-term design intent, the
[architecture notes](docs/architecture.md) for implemented and planned system
boundaries, the
[MVP roadmap](docs/mvp.md) for the first vertical slice, and the
[testing guide](docs/testing.md) for protocol, Chromium, and large-file checks.
See the
[release guide](docs/releasing.md) for registry setup and publishing.

## Project status

- [x] Draft the overall architecture and MVP boundary.
- [x] Implement the experimental unified `Table` model.
- [x] Define the version-one Worker protocol.
- [x] Implement the first CSV/TSV Worker and WebAssembly vertical slice.
- [x] Prototype viewport-driven accessible Canvas rendering.
- [ ] Complete M3 hardening, browser failure coverage, and reproducible measurement.
- [ ] Validate the extension boundary with an M4 second adapter.
- [ ] Publish the first crates.io and npm packages.
- [ ] Stabilize extension APIs.

## Contributing

Tabulark is not yet ready for broad feature contributions. Design discussion,
representative datasets, and concrete browser-preview use cases are welcome in
[GitHub Issues](https://github.com/Ronbb/tabulark/issues).

## AI-assisted development

Tabulark makes extensive use of generative AI throughout project design,
implementation, testing, documentation, and code review. AI-generated output is
treated as a draft rather than trusted work: maintainers remain responsible for
every change, and the same review, testing, security, and licensing standards
apply regardless of how a contribution was produced.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.
