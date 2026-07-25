//! Rebuilds the committed M4 Arrow IPC Playground and benchmark fixtures.
//!
//! Run with:
//! `cargo run --example generate_arrow_fixture --features arrow -- <output> [--container file|stream] [--compression none|lz4|zstd] [--rows N] [--batch-rows N]`

use std::error::Error;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use arrow_array::builder::{ListBuilder, StringBuilder, StringDictionaryBuilder};
use arrow_array::types::Int8Type;
use arrow_array::{
    ArrayRef, Decimal128Array, Int32Array, Int64Array, RecordBatch, StringArray, StructArray,
    TimestampNanosecondArray,
};
use arrow_ipc::CompressionType;
use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
use arrow_schema::{DataType, Field};

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = FixtureArguments::parse()?;
    let mut batches = Vec::new();
    for row_start in (0..arguments.rows).step_by(arguments.batch_rows) {
        batches.push(build_batch(
            row_start,
            arguments.batch_rows.min(arguments.rows - row_start),
        )?);
    }
    let schema = batches
        .first()
        .ok_or("fixture generator did not create a RecordBatch")?
        .schema_ref();

    if let Some(parent) = arguments.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = File::create(&arguments.output)?;
    let options = IpcWriteOptions::default().try_with_compression(arguments.compression)?;
    match arguments.container {
        Container::File => {
            let mut writer = FileWriter::try_new_with_options(file, schema, options)?;
            for batch in &batches {
                writer.write(batch)?;
            }
            writer.finish()?;
        }
        Container::Stream => {
            let mut writer = StreamWriter::try_new_with_options(file, schema, options)?;
            for batch in &batches {
                writer.write(batch)?;
            }
            writer.finish()?;
        }
    }

    println!("wrote {}", arguments.output.display());
    Ok(())
}

/// Creates a deterministic slice of the four-row semantic pattern. Keeping the
/// first four rows byte-for-byte equivalent to the Playground fixture gives the
/// performance corpus representative BigInt, decimal, timestamp, nullable,
/// dictionary, nested, and CJK values while allowing it to overflow the Canvas
/// viewport and span several RecordBatches.
fn build_batch(row_start: usize, row_count: usize) -> Result<RecordBatch, Box<dyn Error>> {
    let mut ids = Vec::with_capacity(row_count);
    let mut amounts = Vec::with_capacity(row_count);
    let mut timestamps = Vec::with_capacity(row_count);
    let mut labels = Vec::with_capacity(row_count);
    let mut cities = Vec::with_capacity(row_count);
    let mut scores = Vec::with_capacity(row_count);
    let mut dictionary = StringDictionaryBuilder::<Int8Type>::new();
    let mut tags = ListBuilder::new(StringBuilder::new());

    for row in row_start..row_start + row_count {
        match row % 4 {
            0 => {
                ids.push(Some(9_007_199_254_740_993_i64));
                amounts.push(Some(1_234_567_i128));
                timestamps.push(Some(1_722_160_800_123_456_789_i64));
                labels.push(Some("你好，Arrow"));
                dictionary.append("待处理")?;
                tags.values().append_value("数据");
                tags.values().append_value("preview");
                tags.append(true);
                cities.push(Some("上海"));
                scores.push(Some(98));
            }
            1 => {
                ids.push(Some(-9_007_199_254_740_995_i64));
                amounts.push(Some(-42_i128));
                timestamps.push(Some(-1_i64));
                labels.push(None);
                dictionary.append("完成")?;
                tags.values().append_value("東京");
                tags.append(true);
                cities.push(Some("東京"));
                scores.push(None);
            }
            2 => {
                ids.push(None);
                amounts.push(None);
                timestamps.push(None);
                labels.push(Some("東京 / 서울"));
                dictionary.append_null();
                tags.append(false);
                cities.push(None);
                scores.push(Some(75));
            }
            _ => {
                ids.push(Some(42_i64));
                amounts.push(Some(9_999_999_999_999_i128));
                timestamps.push(Some(0_i64));
                labels.push(Some("line\tbreak\nis escaped for display"));
                dictionary.append("待处理")?;
                tags.values().append_value("서울");
                tags.values().append_value("嵌套");
                tags.append(true);
                cities.push(Some("서울"));
                scores.push(Some(88));
            }
        }
    }

    let ids: ArrayRef = Arc::new(Int64Array::from(ids));
    let amounts: ArrayRef =
        Arc::new(Decimal128Array::from(amounts).with_precision_and_scale(20, 4)?);
    let timestamps: ArrayRef =
        Arc::new(TimestampNanosecondArray::from(timestamps).with_timezone("Asia/Shanghai"));
    let labels: ArrayRef = Arc::new(StringArray::from(labels));
    let statuses: ArrayRef = Arc::new(dictionary.finish());
    let tags: ArrayRef = Arc::new(tags.finish());

    let city_field = Arc::new(Field::new("city", DataType::Utf8, true));
    let score_field = Arc::new(Field::new("score", DataType::Int32, true));
    let details: ArrayRef = Arc::new(StructArray::from(vec![
        (city_field, Arc::new(StringArray::from(cities)) as ArrayRef),
        (score_field, Arc::new(Int32Array::from(scores)) as ArrayRef),
    ]));

    Ok(RecordBatch::try_from_iter_with_nullable(vec![
        ("bigint", ids, true),
        ("amount", amounts, true),
        ("observed_at", timestamps, true),
        ("label", labels, true),
        ("status", statuses, true),
        ("tags", tags, true),
        ("details", details, true),
    ])?)
}

#[derive(Clone, Copy)]
enum Container {
    File,
    Stream,
}

struct FixtureArguments {
    output: PathBuf,
    container: Container,
    compression: Option<CompressionType>,
    rows: usize,
    batch_rows: usize,
}

impl FixtureArguments {
    fn parse() -> Result<Self, Box<dyn Error>> {
        let mut output = None;
        let mut container = Container::File;
        let mut compression = None;
        let mut rows = 4_usize;
        let mut batch_rows = None;
        let mut arguments = std::env::args().skip(1);
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--container" => {
                    container = match arguments.next().as_deref() {
                        Some("file") => Container::File,
                        Some("stream") => Container::Stream,
                        _ => return Err("--container must be file or stream".into()),
                    };
                }
                "--compression" => {
                    compression = match arguments.next().as_deref() {
                        Some("none") => None,
                        Some("lz4") => Some(CompressionType::LZ4_FRAME),
                        Some("zstd") => Some(CompressionType::ZSTD),
                        _ => return Err("--compression must be none, lz4, or zstd".into()),
                    };
                }
                "--rows" => rows = parse_positive_usize(arguments.next(), "--rows")?,
                "--batch-rows" => {
                    batch_rows = Some(parse_positive_usize(arguments.next(), "--batch-rows")?);
                }
                value if value.starts_with('-') => {
                    return Err(format!("unknown argument: {value}").into());
                }
                value if output.is_none() => output = Some(PathBuf::from(value)),
                value => return Err(format!("unexpected output path: {value}").into()),
            }
        }
        Ok(Self {
            output: output
                .unwrap_or_else(|| PathBuf::from("test/fixtures/arrow/v1/m4-sample.arrow")),
            container,
            compression,
            rows,
            batch_rows: batch_rows.unwrap_or(rows),
        })
    }
}

fn parse_positive_usize(value: Option<String>, option: &str) -> Result<usize, Box<dyn Error>> {
    let value = value.ok_or_else(|| format!("{option} requires a positive integer"))?;
    let value = value
        .parse::<usize>()
        .map_err(|_| format!("{option} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{option} must be a positive integer").into());
    }
    Ok(value)
}
