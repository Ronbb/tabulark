//! Bounded parser lifecycle checks shared by the cargo-fuzz target and its
//! deterministic stable-Cargo smoke binary.

use tabulark::arrow::{
    ArrowIpcContainer, ArrowIpcLimits, ArrowIpcOpenOperation, ArrowIpcOptions, ArrowIpcRuntime,
    ArrowReadStart, ArrowRuntimeConfig,
};
use tabulark::csv::{CsvLimits, CsvScanner, DelimitedOptions, ParseMode, RangeDecodeStatus};
use tabulark::{AxisExtent, ErrorCode, RangeRequest, TableBatch};

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_FIELD_BYTES: usize = 8 * 1024;
const MAX_COLUMNS: usize = 256;
const MAX_CELLS_PER_RANGE: u64 = 4_096;
const MAX_BATCH_BYTES: usize = 128 * 1024;
const MAX_DIAGNOSTICS: usize = 64;
const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;

/// Exercises bounded incremental scan and range-decoder lifecycles.
///
/// The target treats parser errors caused by the deliberately tight resource
/// limits and strict parsing as normal outcomes. Any other error on a valid
/// contiguous lifecycle is an invariant failure: it risks hiding a parser
/// state-machine bug from libFuzzer.
pub fn exercise(input: &[u8]) {
    let source = &input[..input.len().min(MAX_SOURCE_BYTES)];
    let controls = Controls::from_input(source);

    // Every input goes through a broadly compatible CSV/lenient path so a
    // malformed derived configuration cannot starve the deep range lifecycle.
    exercise_case(source, canonical_options(&controls), controls.scan_salt);

    // A second configuration exercises headerless tables, strict diagnostics,
    // TSV/semicolon/pipe delimiters, and tighter (but still bounded) limits.
    exercise_case(
        source,
        derived_options(source, &controls),
        controls.range_salt,
    );
}

/// Exercises bounded Arrow IPC File/Stream parsing, range reads, and cleanup.
///
/// Invalid or over-budget bytes are normal fuzz outcomes. A successful open is
/// driven through table open, projected reads, idempotent close, and shutdown
/// so libFuzzer also covers post-error handle-registry invariants.
pub fn exercise_arrow(input: &[u8]) {
    const MAX_ARROW_SOURCE_BYTES: usize = 64 * 1024;
    let source = &input[..input.len().min(MAX_ARROW_SOURCE_BYTES)];
    for container in [
        ArrowIpcContainer::Auto,
        ArrowIpcContainer::File,
        ArrowIpcContainer::Stream,
    ] {
        let mut runtime = ArrowIpcRuntime::new(ArrowRuntimeConfig {
            memory_budget_bytes: 4 * 1024 * 1024,
            max_sources: 2,
        })
        .expect("bounded Arrow fuzz runtime config");
        let options = ArrowIpcOptions {
            container,
            table_name: "fuzz-arrow".into(),
            limits: ArrowIpcLimits {
                max_source_bytes: MAX_ARROW_SOURCE_BYTES,
                max_decoded_bytes: 2 * 1024 * 1024,
                max_output_bytes: 512 * 1024,
                max_metadata_bytes: 64 * 1024,
                max_block_bytes: 1024 * 1024,
                stream_chunk_bytes: 4 * 1024,
                max_fields: 256,
                max_nesting_depth: 32,
                max_range_cells: 256,
                max_display_cell_bytes: 16 * 1024,
            },
        };
        exercise_incremental_arrow(source, options.clone());
        let source_handle = match runtime.open_source(source, options) {
            Ok(handle) => handle,
            Err(error) => {
                assert_arrow_fuzz_error(error.code());
                assert_eq!(runtime.source_count(), 0);
                runtime.shutdown();
                continue;
            }
        };
        assert_eq!(runtime.source_count(), 1);
        let table = runtime
            .open_table(source_handle, "table-0")
            .expect("valid Arrow source must expose table-0");
        let metadata = runtime.metadata(table).expect("open Arrow metadata");
        let rows = metadata.extent().rows().value().unwrap_or(0);
        let columns = metadata.extent().columns().value().unwrap_or(0);
        if columns > 0 {
            let row_start = if rows == 0 {
                0
            } else {
                u64::from(control(source, 0)) % rows.saturating_add(1)
            };
            let row_count = u64::from(control(source, 1) % 8);
            let column_start = u64::from(control(source, 2)) % columns;
            let column_count =
                (1 + u64::from(control(source, 3) % 4)).min(columns.saturating_sub(column_start));
            let request = RangeRequest::new(row_start, row_count, column_start, column_count)
                .expect("bounded Arrow fuzz range");
            match runtime.read_range(table, request) {
                Ok(batch) => {
                    assert!(batch.range().row_count() <= row_count);
                    assert_eq!(batch.range().column_count(), column_count);
                    assert_eq!(batch.columns().len(), column_count as usize);
                    assert!(
                        batch
                            .buffers()
                            .iter()
                            .map(|buffer| buffer.data().len())
                            .sum::<usize>()
                            <= 512 * 1024
                    );
                }
                Err(error) => assert_arrow_fuzz_error(error.code()),
            }
        }
        assert!(runtime.close_table(table));
        assert!(!runtime.close_table(table));
        assert!(runtime.close_source(source_handle));
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.table_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
        runtime.shutdown();
    }
}

fn exercise_incremental_arrow(source: &[u8], options: ArrowIpcOptions) {
    let mut open = match ArrowIpcOpenOperation::new(source.len(), options) {
        Ok(open) => open,
        Err(error) => return assert_arrow_fuzz_error(error.code()),
    };
    let opened = (0..4_096).find_map(|_| {
        let action = match open.next_action() {
            Ok(Some(action)) => action,
            Ok(None) => return None,
            Err(error) => {
                assert_arrow_fuzz_error(error.code());
                return None;
            }
        };
        let offset = usize::try_from(action.offset).expect("bounded Arrow action offset");
        let length = usize::try_from(action.length).expect("bounded Arrow action length");
        let end = offset
            .checked_add(length)
            .expect("bounded Arrow action range");
        assert!(end <= source.len());
        match open.feed(action.offset, &source[offset..end], end == source.len()) {
            Ok(source) => source,
            Err(error) => {
                assert_arrow_fuzz_error(error.code());
                None
            }
        }
    });
    let Some(opened) = opened else {
        return;
    };

    let mut runtime = ArrowIpcRuntime::new(ArrowRuntimeConfig {
        memory_budget_bytes: 4 * 1024 * 1024,
        max_sources: 2,
    })
    .expect("bounded incremental Arrow runtime config");
    let source_handle = match runtime.open_incremental_source(opened) {
        Ok(handle) => handle,
        Err(error) => return assert_arrow_fuzz_error(error.code()),
    };
    let table = runtime
        .open_table(source_handle, "table-0")
        .expect("incremental Arrow source exposes table-0");
    let metadata = runtime.metadata(table).expect("incremental Arrow metadata");
    let rows = metadata.extent().rows().value().unwrap_or(0);
    let columns = metadata.extent().columns().value().unwrap_or(0);
    if columns > 0 {
        let request = RangeRequest::new(0, rows.min(4), 0, columns.min(4))
            .expect("incremental Arrow fuzz range");
        match runtime.begin_read(table, request) {
            Ok(ArrowReadStart::Complete(batch)) => {
                assert!(batch.range().row_count() <= rows.min(4));
                assert!(batch.range().column_count() <= columns.min(4));
            }
            Ok(ArrowReadStart::File(mut read)) => {
                for _ in 0..4_096 {
                    let action = match read.next_action() {
                        Ok(Some(action)) => action,
                        Ok(None) => break,
                        Err(error) => {
                            assert_arrow_fuzz_error(error.code());
                            break;
                        }
                    };
                    let offset = usize::try_from(action.offset).expect("bounded read offset");
                    let length = usize::try_from(action.length).expect("bounded read length");
                    let end = offset.checked_add(length).expect("bounded read range");
                    assert!(end <= source.len());
                    match read.feed(action.offset, &source[offset..end], end == source.len()) {
                        Ok(Some(batch)) => {
                            assert!(batch.range().row_count() <= rows.min(4));
                            assert!(batch.range().column_count() <= columns.min(4));
                            break;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            assert_arrow_fuzz_error(error.code());
                            break;
                        }
                    }
                }
            }
            Err(error) => assert_arrow_fuzz_error(error.code()),
        }
    }
    assert!(runtime.close_table(table));
    assert!(runtime.close_source(source_handle));
    assert_eq!(runtime.source_count(), 0);
    assert_eq!(runtime.table_count(), 0);
    runtime.shutdown();
}

fn assert_arrow_fuzz_error(code: ErrorCode) {
    assert!(
        matches!(
            code,
            ErrorCode::ParseFailed
                | ErrorCode::UnsupportedFeature
                | ErrorCode::ResourceLimit
                | ErrorCode::InvalidRange
                | ErrorCode::InvalidArgument
        ),
        "bounded Arrow lifecycle returned unexpected {code:?}"
    );
}

/// Exercises bounded sparse Parquet open/read and lifecycle cleanup.
pub fn exercise_parquet(input: &[u8]) {
    use tabulark::parquet::{
        ParquetLimits, ParquetOpenOperation, ParquetOptions, ParquetReadStart, ParquetRuntime,
        ParquetRuntimeConfig,
    };

    const MAX_PARQUET_SOURCE_BYTES: usize = 64 * 1024;
    const MEMORY_BUDGET_BYTES: usize = 4 * 1024 * 1024;
    let source = &input[..input.len().min(MAX_PARQUET_SOURCE_BYTES)];
    let limits = ParquetLimits::from_memory_budget(MEMORY_BUDGET_BYTES)
        .expect("bounded Parquet fuzz limits");
    let mut open =
        match ParquetOpenOperation::new(source.len() as u64, ParquetOptions::default(), limits) {
            Ok(open) => open,
            Err(error) => return assert_format_fuzz_error(error.code()),
        };
    let opened = loop {
        let Some(action) = open.next_action() else {
            panic!("pending Parquet open has no byte action");
        };
        let start = usize::try_from(action.offset).expect("bounded Parquet offset");
        let length = usize::try_from(action.length).expect("bounded Parquet length");
        let Some(end) = start.checked_add(length) else {
            panic!("bounded Parquet range overflowed");
        };
        assert!(end <= source.len());
        match open.feed_owned(
            action.offset,
            source[start..end].to_vec(),
            end == source.len(),
        ) {
            Ok(Some(opened)) => break opened,
            Ok(None) => {}
            Err(error) => return assert_format_fuzz_error(error.code()),
        }
    };

    let mut runtime = ParquetRuntime::new(ParquetRuntimeConfig {
        memory_budget_bytes: MEMORY_BUDGET_BYTES,
        max_sources: 2,
    })
    .expect("bounded Parquet fuzz runtime");
    let source_handle = match runtime.open_source(opened) {
        Ok(handle) => handle,
        Err(error) => return assert_format_fuzz_error(error.code()),
    };
    let table = runtime
        .open_table(source_handle, "table-0")
        .expect("valid Parquet source exposes table-0");
    let metadata = runtime.metadata(table).expect("Parquet metadata");
    let rows = metadata.extent().rows().value().unwrap_or(0);
    let columns = metadata.extent().columns().value().unwrap_or(0);
    if columns > 0 {
        let row_count = rows.min(4);
        let column_count = columns.min(4);
        let request =
            RangeRequest::new(0, row_count, 0, column_count).expect("bounded Parquet fuzz range");
        match runtime.begin_read(table, request) {
            Ok(ParquetReadStart::Complete(batch)) => {
                assert!(batch.range().row_count() <= row_count);
                assert_eq!(batch.range().column_count(), column_count);
            }
            Ok(ParquetReadStart::Pending(mut read)) => {
                for _ in 0..4_096 {
                    let Some(action) = read.next_action() else {
                        panic!("pending Parquet read has no byte action");
                    };
                    let start = usize::try_from(action.offset).expect("bounded read offset");
                    let length = usize::try_from(action.length).expect("bounded read length");
                    let end = start.checked_add(length).expect("bounded read range");
                    assert!(end <= source.len());
                    match read.feed_owned(
                        action.offset,
                        source[start..end].to_vec(),
                        end == source.len(),
                    ) {
                        Ok(Some(batch)) => {
                            assert!(batch.range().row_count() <= row_count);
                            assert_eq!(batch.range().column_count(), column_count);
                            break;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            assert_format_fuzz_error(error.code());
                            break;
                        }
                    }
                }
            }
            Err(error) => assert_format_fuzz_error(error.code()),
        }
    }
    assert!(runtime.close_table(table));
    assert!(!runtime.close_table(table));
    assert!(runtime.close_source(source_handle));
    assert!(!runtime.close_source(source_handle));
    assert_eq!(runtime.source_count(), 0);
    assert_eq!(runtime.table_count(), 0);
    runtime.shutdown();
}

/// Exercises bounded XLS/XLSX recognition, worksheet reads, and cleanup.
pub fn exercise_excel(input: &[u8]) {
    use tabulark_excel::{ExcelLimits, ExcelOptions, ExcelRuntime, ExcelRuntimeConfig};

    const MAX_EXCEL_SOURCE_BYTES: usize = 64 * 1024;
    const MEMORY_BUDGET_BYTES: usize = 4 * 1024 * 1024;
    let source = &input[..input.len().min(MAX_EXCEL_SOURCE_BYTES)];
    let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
        memory_budget_bytes: MEMORY_BUDGET_BYTES,
        max_sources: 2,
        limits: ExcelLimits {
            max_source_bytes: MAX_EXCEL_SOURCE_BYTES,
            max_zip_entries: 512,
            max_zip_entry_bytes: 1024 * 1024,
            max_zip_uncompressed_bytes: 2 * 1024 * 1024,
            max_cfb_entries: 512,
            max_cfb_stream_bytes: 2 * 1024 * 1024,
            max_worksheets: 64,
            max_worksheet_rows: 65_536,
            max_worksheet_columns: 1_024,
            max_worksheet_cells: 65_536,
            max_range_cells: 256,
            max_batch_bytes: 512 * 1024,
            max_warnings: 64,
            max_styles: 4_096,
            max_merged_cells: 4_096,
            max_layout_entries: 4_096,
            max_styled_cells: 65_536,
        },
    })
    .expect("bounded Excel fuzz runtime");
    let source_handle = match runtime.open_source(source.to_vec(), ExcelOptions::default()) {
        Ok(handle) => handle,
        Err(error) => {
            assert_format_fuzz_error(error.code());
            assert_eq!(runtime.source_count(), 0);
            assert_eq!(runtime.retained_bytes(), 0);
            return;
        }
    };
    let first_table = runtime
        .list_tables(source_handle)
        .expect("valid Excel source tables")
        .first()
        .map(|table| table.id().to_owned());
    if let Some(table_id) = first_table {
        match runtime.open_table(source_handle, &table_id) {
            Ok(opened) => {
                let rows = opened.metadata.extent().rows().value().unwrap_or(0);
                let columns = opened.metadata.extent().columns().value().unwrap_or(0);
                if columns > 0 {
                    let request = RangeRequest::new(0, rows.min(4), 0, columns.min(4))
                        .expect("bounded Excel fuzz range");
                    match runtime.read_range(opened.table_handle, request) {
                        Ok(batch) => {
                            assert!(batch.range().row_count() <= rows.min(4));
                            assert!(batch.range().column_count() <= columns.min(4));
                        }
                        Err(error) => assert_format_fuzz_error(error.code()),
                    }
                }
                assert!(runtime.close_table(opened.table_handle));
                assert!(!runtime.close_table(opened.table_handle));
            }
            Err(error) => assert_format_fuzz_error(error.code()),
        }
    }
    assert!(runtime.close_source(source_handle));
    assert!(!runtime.close_source(source_handle));
    assert_eq!(runtime.source_count(), 0);
    assert_eq!(runtime.table_count(), 0);
    assert_eq!(runtime.retained_bytes(), 0);
    runtime.shutdown();
}

fn assert_format_fuzz_error(code: ErrorCode) {
    assert!(
        matches!(
            code,
            ErrorCode::ParseFailed
                | ErrorCode::UnsupportedFeature
                | ErrorCode::ResourceLimit
                | ErrorCode::InvalidRange
                | ErrorCode::InvalidArgument
        ),
        "bounded format lifecycle returned unexpected {code:?}"
    );
}

#[derive(Clone, Copy)]
struct Controls {
    scan_salt: usize,
    range_salt: usize,
    delimiter_selector: usize,
    header: bool,
    strict: bool,
    checkpoint_interval: u64,
    field_limit: usize,
    column_limit: usize,
}

impl Controls {
    fn from_input(input: &[u8]) -> Self {
        Self {
            scan_salt: usize::from(control(input, 0)).saturating_add(1),
            range_salt: usize::from(control(input, 1)).saturating_add(17),
            delimiter_selector: usize::from(control(input, 2)),
            header: control(input, 3) & 1 == 0,
            strict: control(input, 4) & 1 == 1,
            checkpoint_interval: u64::from(control(input, 5) % 32).saturating_add(1),
            field_limit: usize::from(control(input, 6))
                .saturating_mul(32)
                .saturating_add(64)
                .min(MAX_FIELD_BYTES),
            column_limit: usize::from(control(input, 7) % 64).saturating_add(1),
        }
    }
}

fn control(input: &[u8], index: usize) -> u8 {
    input.get(index).copied().unwrap_or(0)
}

fn canonical_options(controls: &Controls) -> DelimitedOptions {
    DelimitedOptions {
        delimiter: b',',
        header: true,
        mode: ParseMode::Lenient,
        checkpoint_interval: controls.checkpoint_interval,
        table_name: "fuzz-csv".into(),
        limits: bounded_limits(MAX_FIELD_BYTES, MAX_COLUMNS),
    }
}

fn derived_options(source: &[u8], controls: &Controls) -> DelimitedOptions {
    DelimitedOptions {
        delimiter: inferred_delimiter(source, controls.delimiter_selector),
        header: controls.header,
        mode: if controls.strict {
            ParseMode::Strict
        } else {
            ParseMode::Lenient
        },
        checkpoint_interval: controls.checkpoint_interval,
        table_name: "fuzz-derived".into(),
        limits: bounded_limits(controls.field_limit, controls.column_limit),
    }
}

fn bounded_limits(max_field_bytes: usize, max_columns: usize) -> CsvLimits {
    CsvLimits {
        max_field_bytes,
        max_columns,
        max_cells_per_range: MAX_CELLS_PER_RANGE,
        max_batch_bytes: MAX_BATCH_BYTES,
        max_diagnostics: MAX_DIAGNOSTICS,
    }
}

fn inferred_delimiter(source: &[u8], selector: usize) -> u8 {
    const CANDIDATES: [u8; 4] = [b',', b'\t', b';', b'|'];
    let mut best = selector % CANDIDATES.len();
    let mut best_count = 0_usize;
    for (index, delimiter) in CANDIDATES.into_iter().enumerate() {
        let count = source
            .iter()
            .take(2_048)
            .filter(|byte| **byte == delimiter)
            .count();
        if count > best_count {
            best = index;
            best_count = count;
        }
    }
    CANDIDATES[best]
}

fn exercise_case(source: &[u8], options: DelimitedOptions, salt: usize) {
    let mut scanner = CsvScanner::new(options.clone()).expect("fuzz options must be valid");

    // Rejected calls must not poison a scanner before its legitimate stream.
    let bad_offset = scanner
        .feed_chunk(1, &[], false)
        .expect_err("scanner must reject a nonzero initial offset");
    assert_eq!(bad_offset.code(), ErrorCode::InvalidArgument);
    assert_eq!(scanner.bytes_scanned(), 0);

    let mut offset = 0_usize;
    let mut previous_rows = 0_u64;
    if source.is_empty() {
        match scanner.feed_chunk(0, &[], true) {
            Ok(update) => validate_scan_update(&scanner, &options, &update, 0, previous_rows),
            Err(error) => return assert_expected_parser_error(error.code(), options.mode),
        }
    } else {
        while offset < source.len() {
            let end = offset
                .saturating_add(next_chunk_len(source, offset, salt))
                .min(source.len());
            let eof = end == source.len();
            match scanner.feed_chunk(offset as u64, &source[offset..end], eof) {
                Ok(update) => {
                    validate_scan_update(&scanner, &options, &update, end as u64, previous_rows);
                    previous_rows = update.rows_discovered;
                }
                Err(error) => return assert_expected_parser_error(error.code(), options.mode),
            }
            offset = end;
        }
    }

    assert!(scanner.is_finished());
    assert_eq!(scanner.bytes_scanned(), source.len() as u64);
    assert!(scanner.estimated_index_bytes() <= MAX_INDEX_BYTES);

    let closed = scanner
        .feed_chunk(source.len() as u64, &[], false)
        .expect_err("finished scanner must be terminal");
    assert_eq!(closed.code(), ErrorCode::HandleClosed);

    let metadata = scanner.metadata().expect("final scanner metadata");
    let AxisExtent::Exact { value: rows } = metadata.extent().rows() else {
        panic!("finished scanner must report an exact row extent");
    };
    let AxisExtent::Exact { value: columns } = metadata.extent().columns() else {
        panic!("finished scanner must report an exact column extent");
    };
    assert_eq!(columns, metadata.schema().len() as u64);
    assert!(columns <= options.limits.max_columns as u64);
    assert!(rows <= source.len() as u64 + 1);
    assert!(
        scanner
            .checkpoints()
            .iter()
            .all(|checkpoint| checkpoint.row() <= rows
                && checkpoint.byte_offset() <= source.len() as u64)
    );
    assert!(scanner.diagnostics().len() <= options.limits.max_diagnostics);

    exercise_range(
        &scanner,
        source,
        RangeRequest::new(0, 0, 0, 0).expect("zero range"),
        &options,
        salt,
    );
    if columns > 0 {
        exercise_range(
            &scanner,
            source,
            selected_range(rows, columns, salt),
            &options,
            salt.saturating_add(31),
        );
    }
}

fn validate_scan_update(
    scanner: &CsvScanner,
    options: &DelimitedOptions,
    update: &tabulark::csv::ScanUpdate,
    expected_bytes: u64,
    previous_rows: u64,
) {
    assert_eq!(update.bytes_scanned, expected_bytes);
    assert!(update.rows_discovered >= previous_rows);
    assert!(scanner.estimated_index_bytes() <= MAX_INDEX_BYTES);
    assert!(scanner.diagnostics().len() <= options.limits.max_diagnostics);
    assert!(update.warnings.len() <= options.limits.max_diagnostics);
    assert!(
        update
            .warnings
            .iter()
            .all(|warning| warning.byte_offset() <= update.bytes_scanned)
    );
    assert!(
        update
            .warnings
            .iter()
            // A field-level diagnostic can arrive before the current record is
            // committed, so its row may equal the complete-record count.
            .all(|warning| warning
                .row()
                .is_none_or(|row| row <= update.rows_discovered))
    );

    match update.metadata.extent().rows() {
        AxisExtent::Exact { value } => {
            assert!(update.done);
            assert_eq!(value, update.rows_discovered);
        }
        AxisExtent::AtLeast { value } => {
            assert!(!update.done);
            assert_eq!(value, update.rows_discovered);
        }
        AxisExtent::Unknown => panic!("CSV rows must be known after every scan update"),
    }
}

fn selected_range(rows: u64, columns: u64, salt: usize) -> RangeRequest {
    let max_columns = columns.min(16);
    let column_count = 1 + (salt as u64 % max_columns);
    let column_start = (salt as u64 / 7) % (columns - column_count + 1);
    let row_start = if rows == 0 {
        0
    } else {
        (salt as u64 / 13) % (rows + 2)
    };
    let row_count = 1 + (salt as u64 % 16);
    RangeRequest::new(row_start, row_count, column_start, column_count)
        .expect("bounded fuzz range must be valid")
}

fn exercise_range(
    scanner: &CsvScanner,
    source: &[u8],
    request: RangeRequest,
    options: &DelimitedOptions,
    salt: usize,
) {
    let plan = scanner
        .plan_range(request)
        .expect("finished scanner must plan a schema-valid range");
    assert!(plan.source_offset() <= source.len() as u64);
    assert!(plan.rows_to_skip() <= request.row_start());

    let mut decoder = scanner
        .range_decoder(plan)
        .expect("bounded range plan must create a decoder");
    let start_offset = usize::try_from(plan.source_offset()).expect("bounded source offset");
    assert_eq!(decoder.expected_offset(), plan.source_offset());

    if request.row_count() == 0 {
        let batch = decoder
            .immediate_batch()
            .expect("empty range must complete immediately")
            .expect("empty range must return a batch");
        validate_batch(&batch, request, options);
        assert!(decoder.is_done());
        assert_terminal_decoder(&mut decoder);
        return;
    }

    assert!(
        decoder
            .immediate_batch()
            .expect("non-empty immediate check")
            .is_none()
    );
    let wrong_offset = plan.source_offset().saturating_add(1);
    let bad_offset = decoder
        .feed_chunk(wrong_offset, &[], false)
        .expect_err("decoder must reject a non-contiguous source offset");
    assert_eq!(bad_offset.code(), ErrorCode::InvalidArgument);
    assert_eq!(decoder.expected_offset(), plan.source_offset());

    let mut offset = start_offset;
    loop {
        let (end, eof) = if offset >= source.len() {
            (offset, true)
        } else {
            let end = offset
                .saturating_add(next_chunk_len(source, offset, salt))
                .min(source.len());
            (end, end == source.len())
        };
        let bytes = &source[offset..end];
        match decoder.feed_chunk(offset as u64, bytes, eof) {
            Ok(RangeDecodeStatus::Complete(batch)) => {
                validate_batch(&batch, request, options);
                assert!(decoder.is_done());
                assert_terminal_decoder(&mut decoder);
                return;
            }
            Ok(RangeDecodeStatus::NeedMore) => {
                assert!(!eof, "decoder requested more bytes after EOF");
                assert_eq!(decoder.expected_offset(), end as u64);
                offset = end;
            }
            Err(error) => return assert_expected_parser_error(error.code(), options.mode),
        }
    }
}

fn validate_batch(batch: &TableBatch, request: RangeRequest, options: &DelimitedOptions) {
    let returned = batch.range();
    assert_eq!(returned.row_start(), request.row_start());
    assert_eq!(returned.column_start(), request.column_start());
    assert_eq!(returned.column_count(), request.column_count());
    assert!(returned.row_count() <= request.row_count());
    assert_eq!(
        batch.complete(),
        returned.row_count() == request.row_count()
    );
    assert_eq!(batch.columns().len(), request.column_count() as usize);

    let mut encoded_bytes = 0_usize;
    for column in batch.columns() {
        assert_eq!(column.len(), returned.row_count() as usize);
        assert_eq!(column.offsets().len(), column.len() + 1);
        assert_eq!(column.offsets().first(), Some(&0));
        assert_eq!(
            usize::try_from(*column.offsets().last().expect("offsets are nonempty")),
            Ok(column.data().len())
        );
        assert!(column.offsets().windows(2).all(|pair| pair[0] <= pair[1]));
        for index in 0..column.len() {
            assert!(column.value(index).is_some());
        }
        assert_eq!(column.value(column.len()), None);
        encoded_bytes = encoded_bytes
            .saturating_add(column.data().len())
            .saturating_add(
                column
                    .offsets()
                    .len()
                    .saturating_mul(std::mem::size_of::<u32>()),
            )
            .saturating_add(column.validity().len());
    }
    assert!(encoded_bytes <= options.limits.max_batch_bytes);
}

fn assert_terminal_decoder(decoder: &mut tabulark::csv::RangeDecoder) {
    let closed = decoder
        .feed_chunk(decoder.expected_offset(), &[], false)
        .expect_err("completed decoder must be terminal");
    assert_eq!(closed.code(), ErrorCode::HandleClosed);
}

fn assert_expected_parser_error(code: ErrorCode, mode: ParseMode) {
    assert!(
        code == ErrorCode::ResourceLimit
            || (code == ErrorCode::ParseFailed && mode == ParseMode::Strict),
        "contiguous parser lifecycle returned unexpected {code:?}"
    );
}

fn next_chunk_len(source: &[u8], offset: usize, salt: usize) -> usize {
    let control_index = offset.saturating_add(salt) % source.len();
    1 + (usize::from(source[control_index]).saturating_add(salt) % 257)
}

#[cfg(test)]
mod tests {
    use super::exercise;

    #[test]
    fn deterministic_mutation_smoke_exercises_the_same_invariants() {
        let mut state = 0xC5A5_1F27_u32;
        for length in [0, 1, 2, 7, 31, 257, 1_024, 8_193] {
            let mut input = Vec::with_capacity(length);
            for _ in 0..length {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                input.push(state as u8);
            }
            exercise(&input);
        }
    }
}
