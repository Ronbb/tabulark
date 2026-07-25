# Arrow performance fixtures

These IPC binaries are deterministic outputs from the checked-in Rust fixture
generator. They repeat the Playground sample's four-row semantic pattern across
512 rows and eight RecordBatches. This preserves BigInt, decimal, timestamp,
nullable, dictionary, nested, escaped-text, and CJK coverage while making the
Canvas benchmark exercise real vertical scrolling and cross-batch ranges. The
six files vary only by IPC container and body compression.

Rebuild one fixture with:

```sh
cargo run --locked --example generate_arrow_fixture --features arrow -- \
  test/performance/fixtures/arrow/m4-stream-zstd.arrows \
  --container stream --compression zstd --rows 512 --batch-rows 64
```

`provenance.json` locks every byte length and SHA-256. Browser performance code
loads these committed files; it does not create Arrow IPC in JavaScript.
