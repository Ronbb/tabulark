# Tabulark

> A WebAssembly-first engine for fast, format-agnostic tabular data preview in the browser.

**One table model for every tabular source.**

**Status: pre-alpha design and prototyping.**

> [!IMPORTANT]
> Tabulark is currently in the design and prototyping stage. There is no stable
> public API or production-ready release yet. The architecture, formats, and
> performance characteristics described below are goals, not shipped features.

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
- Viewport-oriented rendering, with Canvas as the first planned renderer.
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

## Current scaffold

The repository currently contains:

- A minimal Rust crate with an experimental `TableShape` value type.
- A minimal ESM npm entry point with matching shape metadata.
- Version synchronization and package dry-run checks.
- GitHub Actions prepared for OIDC-based publication to crates.io and npm after
  the initial registry bootstrap and Trusted Publisher configuration.

No parser, Worker runtime, WebAssembly bridge, cache, or renderer has been
implemented yet.

## Planned data sources

CSV and TSV are intended to be the first reference adapters. Longer-term
candidates include XLSX, XLS, Parquet, Apache Arrow, Feather, SQLite query
results, DuckDB query results, and third-party data sources.

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

Run the local checks:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo package --allow-dirty --locked
npm ci
npm run check
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
├── js/                   # Browser-facing ESM package entry point
├── test/                 # JavaScript tests
├── scripts/              # Repository validation scripts
├── docs/                 # Vision and release documentation
└── .github/workflows/    # CI and registry publication
```

See the [project vision](docs/vision.md) for the long-term design intent and
[release guide](docs/releasing.md) for registry setup and publishing.

## Project status

- [ ] Validate the unified `Table` model.
- [ ] Define the parser and Worker protocol.
- [ ] Implement a reference CSV/TSV parser.
- [ ] Prototype viewport-driven Canvas rendering.
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
