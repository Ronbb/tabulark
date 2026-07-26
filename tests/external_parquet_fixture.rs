//! Cross-producer Parquet fixture compatibility.

#![cfg(feature = "parquet")]

use tabulark::RangeRequest;
use tabulark::parquet::{
    OpenedParquetSource, ParquetLimits, ParquetOpenOperation, ParquetOptions, ParquetReadStart,
};

const SOURCE: &[u8] =
    include_bytes!("../test/fixtures/parquet/v1/apache-parquet-testing-alltypes-plain.parquet");

#[test]
fn opens_and_projects_the_pinned_impala_parquet_file() {
    let source = open_source(SOURCE);
    let metadata = source.metadata();
    let rows = metadata
        .extent()
        .rows()
        .value()
        .expect("Parquet rows are exact");
    let columns = metadata
        .extent()
        .columns()
        .value()
        .expect("Parquet columns are exact");
    assert!(rows > 0);
    assert!(columns > 1);

    let request =
        RangeRequest::new(0, rows.min(4), 1, (columns - 1).min(3)).expect("bounded projection");
    let batch = match source.begin_read(request).expect("begin projected read") {
        ParquetReadStart::Complete(batch) => batch,
        ParquetReadStart::Pending(mut operation) => loop {
            let action = operation.next_action().expect("pending read action");
            let start = usize::try_from(action.offset).expect("fixture offset");
            let length = usize::try_from(action.length).expect("fixture length");
            let end = start.checked_add(length).expect("fixture range");
            let batch = operation
                .feed_owned(
                    action.offset,
                    SOURCE[start..end].to_vec(),
                    end == SOURCE.len(),
                )
                .expect("feed projected source range");
            if let Some(batch) = batch {
                break batch;
            }
        },
    };

    assert_eq!(batch.range().row_count(), request.row_count());
    assert_eq!(batch.range().column_count(), request.column_count());
    assert_eq!(batch.columns().len(), request.column_count() as usize);
}

fn open_source(bytes: &[u8]) -> OpenedParquetSource {
    let limits =
        ParquetLimits::from_memory_budget(16 * 1024 * 1024).expect("bounded fixture limits");
    let mut operation =
        ParquetOpenOperation::new(bytes.len() as u64, ParquetOptions::default(), limits)
            .expect("begin upstream Parquet open");
    loop {
        let action = operation.next_action().expect("pending open action");
        let start = usize::try_from(action.offset).expect("fixture offset");
        let length = usize::try_from(action.length).expect("fixture length");
        let end = start.checked_add(length).expect("fixture range");
        let opened = operation
            .feed_owned(
                action.offset,
                bytes[start..end].to_vec(),
                end == bytes.len(),
            )
            .expect("feed upstream Parquet range");
        if let Some(opened) = opened {
            return opened;
        }
    }
}
