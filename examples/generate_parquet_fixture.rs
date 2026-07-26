//! Generates the deterministic Parquet fixture used by browser and package smoke tests.

use std::fs::{self, File};
use std::sync::Arc;

use arrow_array::{ArrayRef, Int32Array, RecordBatch, StringArray, TimestampNanosecondArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::path::Path::new("test/fixtures/parquet/v1/tabulark-rust.parquet");
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("city", DataType::Utf8, true),
        Field::new(
            "observed_at",
            DataType::Timestamp(TimeUnit::Nanosecond, None),
            true,
        ),
    ]));
    let properties = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_max_row_group_row_count(Some(2))
        .build();
    let mut writer = ArrowWriter::try_new(File::create(output)?, schema.clone(), Some(properties))?;
    for (ids, cities, timestamps) in [
        (
            vec![1, 2],
            vec![Some("上海"), Some("London")],
            vec![
                Some(1_700_000_000_000_000_000),
                Some(1_700_000_001_000_000_000),
            ],
        ),
        (
            vec![3, 4],
            vec![None, Some("São Paulo")],
            vec![None, Some(1_700_000_003_000_000_000)],
        ),
    ] {
        let columns: Vec<ArrayRef> = vec![
            Arc::new(Int32Array::from(ids)),
            Arc::new(StringArray::from(cities)),
            Arc::new(TimestampNanosecondArray::from(timestamps)),
        ];
        writer.write(&RecordBatch::try_new(schema.clone(), columns)?)?;
        writer.flush()?;
    }
    writer.close()?;
    println!("generated {}", output.display());
    Ok(())
}
