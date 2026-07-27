# 0.2 JavaScript API stability

The compatibility promise applies to the documented browser-facing JavaScript
entry points only:

- `tabulark`
- `tabulark/arrow`
- `tabulark/parquet`
- `tabulark/excel`
- `tabulark/http`

Throughout 0.2.x, these entry points may receive compatible additions. Version
0.2 preserves the documented 0.1.0 calling patterns while adding diagnostics,
capability queries, performance observation, `SourceMode`, Canvas themes, and
the explicit `RangeSource`/HTTP source capability.
The historical v0.1 declaration snapshot and `v0.1.0` tag are immutable; the
tag is never moved or reused.

`tabulark/experimental` contains low-level painter, controller, layout, and
selection primitives. It has no compatibility promise. Rust APIs, official
adapter ABI v3, Worker protocol v4, and typed-buffer batch layout v1 remain
private/experimental even when constants or DTOs exist inside the repository.

## Stable source boundary

Local source inputs remain `File`, `Blob`, and `ArrayBuffer`.
`sourceMode: "auto"` retains the conservative limits. `sourceMode: "large"`
accepts only a local `File`/`Blob` up to and including exactly
`2,147,483,648` bytes (`2^31`); it does not relax `ArrayBuffer` limits. The
release evidence exercises exact-size CSV, Arrow File, Parquet, XLSX, and XLS
containers and reads the final bounded window.

The stable `RangeSource` contract is a repeatably openable, bounded byte
capability:

```ts
interface ByteRange { readonly offset: number; readonly length: number }
interface RangeSourceSnapshot {
  readonly id: string;
  readonly strength: "strong" | "weak";
}
interface RangeSourceReader {
  readonly size: number;
  readonly snapshot: RangeSourceSnapshot;
  readonly maxConcurrency?: number; // 1–4, default 1
  read(range: ByteRange, options: { signal: AbortSignal }):
    Promise<ArrayBuffer | ArrayBufferView>;
  close(): Promise<void> | void;
}
interface RangeSource {
  readonly kind: "range";
  readonly name?: string;
  open(options: {
    signal: AbortSignal;
    maxSourceBytes: number;
    maxStagingBytes: number;
  }): Promise<RangeSourceReader>;
}
```

`TabularkEngine.open()` accepts a `RangeSource` in addition to local inputs.
Every reader must report an exact size and return exactly the requested bytes;
unsafe values, out-of-bounds ranges, short/long reads, invalid snapshots, and
sizes above exactly `4,294,967,295` bytes (`2^32 - 1`) fail structurally.
Each open gets an independent reader, and the reader is closed exactly once on
failed/cancelled open, dataset close, engine close, or Worker failure.
`sourceMode` and `transferInput` do not apply to `RangeSource` inputs.

The Worker sees only an opaque reader handle, size, and bounded transferable
buffers. Main-thread network/auth policy is never exposed to it. A dataset
merges overlapping or adjacent requests, allows at most four provider reads in
flight, and uses a byte-budgeted range cache with singleflight. The public
performance sample adds `sourceReads` and `sourceCacheHitBytes`; `cacheHit`
continues to mean only logical batch-cache hits.

`tabulark/http` exports `httpRangeSource(url, options)`. It probes with
`GET Range: bytes=0-0`, requires a precise `Content-Range`, and defaults to a
strong ETag validator with a `Last-Modified` plus total-length fallback when
allowed. Every `206` is revalidated; a later `200` or `416` is an error. The
helper retries only transient network/status failures with bounded backoff.
Full-response fallback is opt-in through
`fallback: { mode: "bounded-download", maxBytes }` and must fit the engine's
staging budget. Error and performance payloads omit URLs, query parameters,
headers, validators, and snapshot IDs. Inputs larger than `2^31` for local
large mode or larger than `2^32 - 1` for `RangeSource`, unsafe JavaScript
integers, checked-add overflow, and WASM `usize` conversion remain rejection
tests rather than supported allocations.

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
fields, including `sourceReads` and `sourceCacheHitBytes` for range-backed
operations. Source actions, overread, copying, re-decode counts,
cache/singleflight state, resource-ledger categories, and WASM page counts are
private release evidence and may change without a public API transition.

## Error compatibility

Callers should branch on `TabularkError.code`, not message text. Resource-limit
errors identify the resource category and report required and available bytes
where byte accounting applies. Unsupported format features use
`UNSUPPORTED_FEATURE`; budget exhaustion uses `RESOURCE_LIMIT`. Range providers
also use the structured `SOURCE_UNAVAILABLE`, `SOURCE_CHANGED`, and
`RANGE_UNSUPPORTED` codes. Their messages and details are sanitized and must
not be used to recover a URL, query string, header, validator, or snapshot ID.
