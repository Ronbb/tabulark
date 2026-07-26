# Changelog

All notable changes to Tabulark are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.2.0

- Add bounded structured diagnostics and independent diagnostic subscriptions.
- Add logical dataset/table capability snapshots and opt-in privacy-safe
  performance samples.
- Add Canvas `colorScheme` support with dynamic dark mode and forced-colors
  precedence.
- Add opt-in `sourceMode: "large"` for local Blob/File inputs through exactly
  `2^31` bytes across CSV, Arrow File, Parquet, XLSX, and XLS; ArrayBuffer and
  automatic-mode limits remain unchanged.
- Move every official adapter to private Worker protocol v4 and adapter ABI v3
  resumable operations with checked revisions, bounded multi-range actions,
  cooperative no-I/O yields, and one-transfer batch output.
- Make the main thread the sole decoded-batch cache owner, with immutable
  backings, logical-table keys, singleflight misses, and independent caller
  cancellation. Remove the Worker decoded LRU.
- Add Rust/WASM resource ledgers and native cache admission/reclamation
  evidence, including 100-cycle lifecycle and WebAssembly-memory high-water
  gates.
- Add incremental Arrow File/Stream indexing, coalesced Parquet projection
  reads, and Rust range-backed ZIP64/CFB Excel container indexing. Excel
  compacts only required workbook content into its bounded compatibility
  parser.
- Add release-blocking Chromium, Firefox, and WebKit functional projects.
  Chromium additionally owns pixel, performance, real-clipboard, and exact
  2 GiB evidence.
- Add paired baseline performance gates, shipped-JavaScript shrinkage gates,
  and a native five-container exact-size generator/workflow.
- Remove the private TypeScript large-XLSX parser and its shipped artifact.

Version 0.1.1 was never tagged or published; its compatible work is included
in 0.2.0. The immutable `v0.1.0` tag is unchanged.

## 0.1.0

- Establish the stable browser-facing API and the official local-format adapter
  host.
- Add local Apache Parquet and Excel (BIFF8/XLSX) preview adapters.
- Add spreadsheet presentation metadata for the Canvas view.

## 0.0.4

Published before the 0.1.0 release train.
