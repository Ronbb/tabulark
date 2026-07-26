# 0.2 JavaScript API stability

The compatibility promise applies to the documented browser-facing JavaScript
entry points only:

- `tabulark`
- `tabulark/arrow`
- `tabulark/parquet`
- `tabulark/excel`

Throughout 0.2.x, these entry points may receive compatible additions. Version
0.2 preserves the documented 0.1.0 calling patterns while adding diagnostics,
capability queries, performance observation, `SourceMode`, and Canvas themes.
The historical v0.1 declaration snapshot and `v0.1.0` tag are immutable; the
tag is never moved or reused.

`tabulark/experimental` contains low-level painter, controller, layout, and
selection primitives. It has no compatibility promise. Rust APIs, official
adapter ABI v3, Worker protocol v4, and typed-buffer batch layout v1 remain
private/experimental even when constants or DTOs exist inside the repository.

## Stable source boundary

The accepted source types remain local `File`, `Blob`, and `ArrayBuffer`.
`sourceMode: "auto"` retains the conservative limits. `sourceMode: "large"`
accepts only a local `File`/`Blob` up to and including exactly
`2,147,483,648` bytes (`2^31`); it does not relax `ArrayBuffer` limits. The
release evidence exercises exact-size CSV, Arrow File, Parquet, XLSX, and XLS
containers and reads the final bounded window. Inputs larger than `2^31`,
unsafe JavaScript integers, checked-add overflow, and WASM `usize` conversion
remain rejection tests rather than supported product sizes.

## Stable data boundary

`TableBatch` exposes logical table identity, revision/schema version, returned
range, completion state, logical column accessors, `toRows()`, and
`toDisplayRows()`. Physical buffers, immutable cache backings, cache keys,
singleflight state, region descriptors, Worker transfer objects, protocol
constants, adapter ABI constants, resource snapshots, and batch-layout
constants are not part of the stable package root. Binary getters return
defensive `Uint8Array` copies; callers must not depend on facade identity or
private backing identity across reads.

`TableHandle.getPresentation()` and `readPresentationRange()` form the common
optional presentation contract. Callers must handle `null` for formats without
presentation metadata and when Excel presentation exceeds its bounded budget;
logical table data remains available and a structured diagnostic explains that
degradation. The first presentation kind is `spreadsheet-v1`; new kinds and
optional fields may be added compatibly in 0.2.x.

Public `PerformanceSample` values retain only the documented privacy-safe
fields. Source actions, overread, copying, re-decode counts, cache/singleflight
state, resource-ledger categories, and WASM page counts are private release
evidence and may change without a public API transition.

## Error compatibility

Callers should branch on `TabularkError.code`, not message text. Resource-limit
errors identify the resource category and report required and available bytes
where byte accounting applies. Unsupported format features use
`UNSUPPORTED_FEATURE`; budget exhaustion uses `RESOURCE_LIMIT`.
