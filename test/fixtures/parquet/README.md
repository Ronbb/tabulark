# Parquet fixture corpus

`v1/tabulark-rust.parquet` is a deterministic, project-produced Parquet file
with two row groups, Snappy pages, UTF-8/null data, and a timezone-free
nanosecond timestamp. Regenerate it with:

```sh
cargo run --example generate_parquet_fixture --features parquet --locked
```

The Rust adapter tests separately construct fixtures for every promised codec,
projection, corrupt footer, oversized metadata, and decompression limits. The
small committed file exists for real-WASM browser and deployed Pages smoke.

`v1/apache-parquet-testing-alltypes-plain.parquet` is copied byte-for-byte
from the Apache `parquet-testing` cross-language corpus. Its file metadata names
Impala 1.3 as the producer, making it independent of the parquet-rs writer used
by the project fixture. The exact upstream revision, blob, digest, and bundled
Apache-2.0 license are locked in `provenance.json`.
