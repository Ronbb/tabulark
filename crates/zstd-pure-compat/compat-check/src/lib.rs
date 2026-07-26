//! Compile-only consumer proving that Arrow IPC and Parquet 59.1.0 accept the
//! narrow local `zstd` compatibility API.

/// References both consumers so their public crates remain part of this check.
pub fn consumer_versions_compile() {
    let _ = arrow_ipc::CompressionType::ZSTD;
    let _ = parquet::basic::Compression::ZSTD(parquet::basic::ZstdLevel::default());
}
