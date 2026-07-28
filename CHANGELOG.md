# Changelog

All notable changes to Tabulark are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.2.1

- Read partial viewports from oversized Parquet row groups page by page instead
  of staging every projected column chunk. Lazy reads enforce cumulative page
  decompression, bounded page tracking and header parsing, compressed-cache
  peak, and decoder-restart limits before returning data to parquet-rs.
- Bound nested Arrow display previews without changing their native values;
  oversized list, struct, map, and union text ends with an explicit
  `... [truncated]` marker.
- Add a separately built, experimental document-preview source package with a
  Worker-isolated PDFium page pipeline, bounded RGBA page rendering, and an
  accessible framework-free paged view. It is not part of the stable root npm
  exports or official tabular-adapter manifest.

## 0.2.0

- Add bounded structured diagnostics and independent diagnostic subscriptions.
- Add logical dataset/table capability snapshots and opt-in privacy-safe
  performance samples.
- Add Canvas `colorScheme` support with dynamic dark mode and forced-colors
  precedence.
- Add opt-in `sourceMode: "large"` for local Blob/File inputs through exactly
  `2^31` bytes across CSV, Arrow File, Parquet, XLSX, and XLS; ArrayBuffer and
  automatic-mode limits remain unchanged.
- Add the stable `RangeSource` capability to every official format. Readers
  validate exact lengths and snapshots, support independent reopen/close
  lifecycles, and address at most `4,294,967,295` bytes (`2^32 - 1`).
- Add `tabulark/http` with a `GET Range: bytes=0-0` capability probe, strict
  `Content-Range` and validator checks, bounded transient retries, dynamic
  headers/credentials, and an explicit bounded-download fallback. Network and
  authentication remain on the main thread; no URL, headers, validator, or
  snapshot ID is exposed in Worker messages, errors, or performance samples.
- Add source-range request coalescing, dataset singleflight, a byte-budgeted
  range LRU, four-way maximum provider concurrency, exact reader cleanup, and
  cross-thread memory slices (75% Worker, 12.5% source staging, 12.5%
  retained batches/fallback).
- Add `SOURCE_UNAVAILABLE`, `SOURCE_CHANGED`, and `RANGE_UNSUPPORTED` source
  errors. Extend `PerformanceSample` with `sourceReads` and
  `sourceCacheHitBytes`; `cacheHit` remains the logical batch-cache metric.
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
- Add HTTP contract, virtual/sparse 4 GiB−1, cancellation/lifecycle,
  concurrency, cache, CORS, retry, validator-change, and explicit-fallback
  release evidence in Chromium, Firefox, and WebKit. Keep a separate measured
  raw/Brotli size budget for the new `/http` entry point.
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
