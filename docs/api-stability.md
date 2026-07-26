# 0.1 JavaScript API stability

The compatibility promise applies to the documented browser-facing JavaScript
entry points only:

- `tabulark`
- `tabulark/arrow`
- `tabulark/parquet`
- `tabulark/excel`

Throughout 0.1.x, these entry points may receive compatible additions. An
export, method, accepted option, or documented logical value shape is not
removed or changed incompatibly until 0.2.0.

`tabulark/experimental` contains low-level painter, controller, layout, and
selection primitives. It has no compatibility promise. Rust APIs, official
adapter ABI v2, Worker protocol v3, and the typed-buffer wire layout remain
private/experimental even when constants or DTOs exist inside the repository.

## Stable data boundary

`TableBatch` exposes logical table identity, revision/schema version, returned
range, completion state, logical column accessors, `toRows()`, and
`toDisplayRows()`. Physical buffers, region descriptors, Worker transfer
objects, protocol constants, adapter ABI constants, and batch-layout constants
are not part of the stable package root.

`TableHandle.getPresentation()` and `readPresentationRange()` form the common
optional presentation contract. Callers must handle `null` for formats without
presentation metadata. The first presentation kind is `spreadsheet-v1`; new
kinds and optional fields may be added compatibly in 0.1.x.

## Error compatibility

Callers should branch on `TabularkError.code`, not message text. Resource-limit
errors identify the resource category and report required and available bytes
where byte accounting applies. Unsupported format features use
`UNSUPPORTED_FEATURE`; budget exhaustion uses `RESOURCE_LIMIT`.
