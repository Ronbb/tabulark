# Third-party notices

The optional `tabulark/arrow` and `tabulark/parquet` WebAssembly artifacts use
Apache Arrow Rust 59.1.0. This includes the `arrow-*` crates used for logical
arrays and IPC plus the `parquet` crate. Apache Arrow Rust is distributed under
Apache-2.0, with some Arrow component crates additionally carrying MIT terms.

Arrow IPC and Parquet compression support uses `brotli` (BSD-3-Clause AND MIT),
`flate2` (MIT OR Apache-2.0), `lz4_flex` (MIT), `snap` (BSD-3-Clause), and
`ruzstd` 0.8.1 (MIT). A narrow in-tree compatibility crate exposes
the `zstd` 0.13 bulk API required by Arrow/Parquet while remaining Rust-only;
its hashing dependency is `twox-hash` (MIT). `zstd-sys` and `zstd-safe` are not
part of the official production WebAssembly dependency graph.

The optional `tabulark/excel` artifact uses `calamine` 0.35.0 (MIT) for
workbook values, formulas, and worksheet discovery. Its bounded container and
static-presentation readers also use `cfb` (MIT), `zip` (MIT), and `quick-xml`
(MIT).

The Arrow IPC integration fixture under `test/fixtures/arrow/v1` is copied
byte-for-byte from `apache/arrow-testing` at the revision recorded in its
`provenance.json`. The exact upstream Apache-2.0 license is stored next to the
fixture.

The independent Parquet fixture under `test/fixtures/parquet/v1` is copied
byte-for-byte from `apache/parquet-testing` at the pinned revision recorded in
its `provenance.json`. Its Apache-2.0 license is stored next to the fixture.

The independent XLSX fixture under `test/fixtures/excel/v1` is copied
byte-for-byte from the XlsxWriter comparison corpus at the pinned revision
recorded in its `provenance.json`. XlsxWriter is distributed under BSD-2-Clause;
the upstream license is stored next to the fixture.

The complete dependency versions and checksums are locked in `Cargo.lock`.
`cargo deny check advisories licenses` is a release gate, and the release workflow emits
an SPDX SBOM. Nothing in this notice changes the license terms supplied by an
upstream project.
