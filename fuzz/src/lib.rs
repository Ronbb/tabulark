//! Bounded parser lifecycle checks shared by the cargo-fuzz target and its
//! deterministic stable-Cargo smoke binary.

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
