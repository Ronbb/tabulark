# Project Vision

## Purpose

Tabulark aims to become a high-performance, general-purpose table preview
engine for modern web applications. It is not an Excel editor or spreadsheet
application.

Its purpose is to give applications one way to read, parse, retain, and render
tabular data in the browser, regardless of the source format. Developers should
be able to work with a consistent data-access model and browsing experience
without coupling their UI to a specific file type.

Tabulark focuses on **preview**, not **editing**.

It will not attempt to reproduce every capability of Excel or LibreOffice.
Formula recalculation, macros, pivot tables, chart editing, and complex style
authoring are outside the core scope. The project instead concentrates on
displaying structured tabular data efficiently and extensibly.

## One model for many sources

Potential adapters include:

- XLSX and XLS
- CSV and TSV
- Parquet
- Apache Arrow and Feather
- SQLite query results
- DuckDB query results
- Third-party and application-specific sources

Every adapter should expose a shared table abstraction. To a renderer, an Excel
sheet and a Parquet dataset are both tables addressed through logical rows and
columns, with efficient range, tile, or batch access. Source-specific behavior
belongs in adapters rather than the UI.

SQLite and DuckDB adapters consume rows or batches produced by an external query
runtime. Tabulark does not plan or execute database queries itself.

These formats are roadmap candidates, not current support claims.

## Extensible parser architecture

Each data format should be implemented as an independently loadable adapter.
Applications should only download and initialize the formats they use. A
CSV-only application should not pay the size or startup cost of XLSX or Parquet
support.

Adapters should be independently compilable and publishable rather than forced
into a single all-formats release unit. The ecosystem's exact versioning policy
will be defined after the first adapter contract is validated.

The adapter contract should also allow third-party formats to join the ecosystem
without requiring changes to the core engine.

## WebAssembly-first runtime

Parsing and data ownership are intended to live outside the browser main thread
behind a Worker boundary. WebAssembly is the primary runtime for
performance-sensitive parsers and data operations; an adapter may use native
JavaScript when that is the more appropriate implementation. Parsed data should
remain close to the runtime that owns it and be queried on demand instead of
being copied wholesale into JavaScript.

The architecture should be designed for large datasets, low communication
overhead, responsive interaction, and bounded memory use. Performance targets
must be validated with reproducible benchmarks before they become guarantees.

Worker isolation is a responsiveness boundary, not a security sandbox.

## Viewport-oriented rendering

Canvas is the intended first renderer. Rendering should operate on the visible
viewport and draw only the rows and columns required for the current frame.

The renderer should be designed around:

- Large-dataset scrolling
- Low memory overhead
- Smooth interaction
- High-DPI output
- Fast first paint
- High-refresh-rate displays

The goal is a focused data preview surface rather than a feature-complete HTML
table replacement.

## Composable infrastructure

Tabulark should be a foundation rather than a complete application. Developers
should be able to combine the parts they need:

- Parser adapters
- Data caches
- Renderers
- Framework bindings
- Toolbars
- Selection, copying, search, sorting, and filtering
- Optional editing layers

The core should remain small, stable, and performance-oriented.

## Non-goals

Tabulark does not plan to become:

- An Excel replacement
- An Office suite
- A formula calculation engine
- A data analysis platform
- A business intelligence product
- A database or query engine

Features that substantially increase complexity without improving the preview
experience generally do not belong in the core project.

## Guiding principle

> **Treat every tabular data source as a table, regardless of where it comes
> from.**

This principle should guide format adapters, runtime boundaries, data access,
rendering, and extension APIs throughout the project.
