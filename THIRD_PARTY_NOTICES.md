# Third-party notices

The optional `tabulark/arrow` WebAssembly artifact is built from the Apache
Arrow Rust implementation (`arrow-array`, `arrow-buffer`, `arrow-cast`,
`arrow-data`, `arrow-ipc`, `arrow-schema`, and `arrow-select` 59.1.0).
Apache Arrow is licensed under the Apache License 2.0.

Arrow IPC compression support includes `lz4_flex` (MIT) and the Rust `zstd`
bindings (`zstd`, `zstd-safe`, and `zstd-sys`; MIT or Apache-2.0, with the
vendored Zstandard implementation under BSD-3-Clause).

The Arrow IPC integration fixture under `test/fixtures/arrow/v1` is copied
byte-for-byte from `apache/arrow-testing` at the revision recorded in its
`provenance.json`. The exact upstream Apache-2.0 license is stored next to the
fixture.

The complete dependency versions and checksums are locked in `Cargo.lock`.
Nothing in this notice changes the license terms supplied by an upstream
project.
