//! Incremental CSV/TSV scanning and checkpoint-based range decoding.
//!
//! The scanner never retains the source. A browser Worker can keep a `Blob`,
//! feed bounded slices into [`CsvScanner`], and later use [`RangePlan`] to feed
//! a fresh [`RangeDecoder`] from the closest record boundary. [`MemorySource`]
//! is provided only as a convenient native reference implementation and test
//! fixture.

use std::borrow::Cow;

use csv_core::{ReadFieldResult, Reader, ReaderBuilder};
use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, Result, TabularkError};
use crate::model::{
    AxisExtent, Capabilities, ColumnSchema, LogicalType, RandomAccess, RangeRequest, Schema,
    StringColumnBatch, TableBatch, TableExtent, TableMetadata,
};

const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
const FIELD_SCRATCH_BYTES: usize = 16 * 1024;

/// Parsing behavior for recoverable source problems.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ParseMode {
    /// Preserve usable records and emit structured warnings.
    #[default]
    Lenient,
    /// Fail at the first malformed quote, invalid UTF-8 field, or ragged row.
    Strict,
}

/// Resource limits applied during scanning and range decoding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CsvLimits {
    /// Maximum decoded bytes in one field.
    pub max_field_bytes: usize,
    /// Maximum logical columns discovered in one record.
    pub max_columns: usize,
    /// Maximum cells returned by one range request.
    pub max_cells_per_range: u64,
    /// Maximum encoded bytes returned by one range request.
    pub max_batch_bytes: usize,
    /// Maximum diagnostics retained and returned by one parser.
    pub max_diagnostics: usize,
}

impl Default for CsvLimits {
    fn default() -> Self {
        Self {
            max_field_bytes: 16 * 1024 * 1024,
            max_columns: 16_384,
            max_cells_per_range: 250_000,
            max_batch_bytes: 32 * 1024 * 1024,
            max_diagnostics: 1_000,
        }
    }
}

/// Options shared by a progressive scan and all later range decoders.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DelimitedOptions {
    /// ASCII field delimiter encoded as a one-character string in JSON.
    #[serde(with = "ascii_byte")]
    pub delimiter: u8,
    /// Whether the first record supplies column display names.
    #[serde(with = "header_mode")]
    pub header: bool,
    /// Recoverable source handling mode.
    pub mode: ParseMode,
    /// Number of logical data rows between sparse checkpoints.
    pub checkpoint_interval: u64,
    /// Logical table display name.
    pub table_name: String,
    /// Parser and response resource limits.
    pub limits: CsvLimits,
}

impl Default for DelimitedOptions {
    fn default() -> Self {
        Self::csv()
    }
}

impl DelimitedOptions {
    /// Returns conservative CSV defaults.
    #[must_use]
    pub fn csv() -> Self {
        Self {
            delimiter: b',',
            header: true,
            mode: ParseMode::Lenient,
            checkpoint_interval: 1_024,
            table_name: "Table 1".into(),
            limits: CsvLimits::default(),
        }
    }

    /// Returns conservative TSV defaults.
    #[must_use]
    pub fn tsv() -> Self {
        Self {
            delimiter: b'\t',
            ..Self::csv()
        }
    }

    /// Validates delimiter and resource limit invariants.
    pub fn validate(&self) -> Result<()> {
        if !self.delimiter.is_ascii()
            || self.delimiter == 0
            || matches!(self.delimiter, b'\r' | b'\n' | b'"')
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "delimiter must be one non-NUL ASCII byte other than CR, LF, or quote",
            ));
        }
        if self.checkpoint_interval == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "checkpoint interval must be greater than zero",
            ));
        }
        if self.limits.max_field_bytes == 0
            || self.limits.max_columns == 0
            || self.limits.max_cells_per_range == 0
            || self.limits.max_batch_bytes == 0
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "CSV resource limits must be greater than zero",
            ));
        }
        Ok(())
    }
}

/// Stable kinds for recoverable CSV diagnostics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CsvDiagnosticKind {
    /// A row contains fewer or more fields than the current schema.
    RaggedRow,
    /// A field contains malformed UTF-8.
    InvalidUtf8,
    /// Quoting is malformed or a quoted field is not terminated.
    MalformedQuote,
}

/// A source diagnostic that is separate from display text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvDiagnostic {
    kind: CsvDiagnosticKind,
    row: Option<u64>,
    byte_offset: u64,
    message: String,
}

impl CsvDiagnostic {
    fn new(
        kind: CsvDiagnosticKind,
        row: Option<u64>,
        byte_offset: u64,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            row,
            byte_offset,
            message: message.into(),
        }
    }

    /// Returns the stable diagnostic kind.
    #[must_use]
    pub const fn kind(&self) -> CsvDiagnosticKind {
        self.kind
    }

    /// Returns the zero-based logical data row when known.
    #[must_use]
    pub const fn row(&self) -> Option<u64> {
        self.row
    }

    /// Returns the source byte offset nearest the problem.
    #[must_use]
    pub const fn byte_offset(&self) -> u64 {
        self.byte_offset
    }

    /// Returns a safe diagnostic message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// A sparse logical-row to source-byte mapping at a record boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvCheckpoint {
    row: u64,
    byte_offset: u64,
}

impl CsvCheckpoint {
    /// Returns the logical data row beginning at this checkpoint.
    #[must_use]
    pub const fn row(self) -> u64 {
        self.row
    }

    /// Returns the absolute source byte offset at the record boundary.
    #[must_use]
    pub const fn byte_offset(self) -> u64 {
        self.byte_offset
    }
}

/// State returned after accepting one source chunk.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanUpdate {
    /// Latest table metadata snapshot.
    pub metadata: TableMetadata,
    /// Raw source bytes accepted, including a possible BOM.
    pub bytes_scanned: u64,
    /// Logical data rows discovered so far.
    pub rows_discovered: u64,
    /// Checkpoints created while processing this chunk.
    pub checkpoints_added: Vec<CsvCheckpoint>,
    /// New recoverable diagnostics from this chunk.
    pub warnings: Vec<CsvDiagnostic>,
    /// Whether end-of-file was finalized.
    pub done: bool,
}

/// A source slice and logical skip plan for a non-contiguous range read.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangePlan {
    checkpoint: CsvCheckpoint,
    request: RangeRequest,
    rows_to_skip: u64,
}

impl RangePlan {
    /// Returns the nearest checkpoint at or before the requested row.
    #[must_use]
    pub const fn checkpoint(self) -> CsvCheckpoint {
        self.checkpoint
    }

    /// Returns the normalized requested range.
    #[must_use]
    pub const fn request(self) -> RangeRequest {
        self.request
    }

    /// Returns how many logical records precede the first requested row.
    #[must_use]
    pub const fn rows_to_skip(self) -> u64 {
        self.rows_to_skip
    }

    /// Returns the first absolute byte offset the Worker must read.
    #[must_use]
    pub const fn source_offset(self) -> u64 {
        self.checkpoint.byte_offset
    }
}

/// An incremental scanner that keeps metadata and sparse indexes, not source bytes.
#[derive(Debug)]
pub struct CsvScanner {
    options: DelimitedOptions,
    reader: Reader,
    lexical: QuoteTracker,
    bom_prefix: Vec<u8>,
    bom_resolved: bool,
    bytes_received: u64,
    parser_offset: u64,
    record_start_offset: u64,
    field: Vec<u8>,
    record_fields: usize,
    header_names: Vec<String>,
    header_pending: bool,
    rows: u64,
    columns: Vec<ColumnSchema>,
    column_string_bytes: usize,
    schema_version: u64,
    checkpoints: Vec<CsvCheckpoint>,
    diagnostics: Vec<CsvDiagnostic>,
    finished: bool,
}

impl CsvScanner {
    /// Creates a scanner ready to receive the source from absolute offset zero.
    pub fn new(options: DelimitedOptions) -> Result<Self> {
        options.validate()?;
        Ok(Self {
            reader: build_reader(options.delimiter),
            lexical: QuoteTracker::new(options.delimiter),
            bom_prefix: Vec::with_capacity(3),
            bom_resolved: false,
            bytes_received: 0,
            parser_offset: 0,
            record_start_offset: 0,
            field: Vec::new(),
            record_fields: 0,
            header_names: Vec::new(),
            header_pending: options.header,
            rows: 0,
            columns: Vec::new(),
            column_string_bytes: 0,
            schema_version: 0,
            checkpoints: Vec::new(),
            diagnostics: Vec::new(),
            finished: false,
            options,
        })
    }

    /// Accepts the next contiguous source chunk.
    ///
    /// `absolute_offset` is the chunk's position in the original source,
    /// including a possible UTF-8 BOM. Set `eof` only on the final chunk.
    pub fn feed_chunk(
        &mut self,
        absolute_offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<ScanUpdate> {
        if self.finished {
            return Err(TabularkError::new(
                ErrorCode::HandleClosed,
                "CSV scanner is already finalized",
            ));
        }
        if absolute_offset != self.bytes_received {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "CSV scan chunks must be contiguous and ordered",
            )
            .with_detail("expectedOffset", self.bytes_received)
            .with_detail("actualOffset", absolute_offset));
        }
        self.bytes_received = self
            .bytes_received
            .checked_add(u64::try_from(bytes.len()).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "source chunk is too large")
            })?)
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "source byte offset overflow")
            })?;

        let diagnostics_before = self.diagnostics.len();
        let checkpoints_before = self.checkpoints.len();
        let mut cursor = 0;
        if !self.bom_resolved {
            while cursor < bytes.len() && self.bom_prefix.len() < UTF8_BOM.len() {
                self.bom_prefix.push(bytes[cursor]);
                cursor += 1;
                if !UTF8_BOM.starts_with(&self.bom_prefix) {
                    break;
                }
            }
            let is_possible_bom = UTF8_BOM.starts_with(&self.bom_prefix);
            if !is_possible_bom || self.bom_prefix.len() == UTF8_BOM.len() || eof {
                self.bom_resolved = true;
                if self.bom_prefix == UTF8_BOM {
                    self.parser_offset = 3;
                    self.record_start_offset = 3;
                    self.bom_prefix.clear();
                } else {
                    let prefix = std::mem::take(&mut self.bom_prefix);
                    self.process_bytes(0, &prefix)?;
                }
            }
        }
        if self.bom_resolved && cursor < bytes.len() {
            let cursor_offset = u64::try_from(cursor).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "chunk cursor overflow")
            })?;
            self.process_bytes(absolute_offset + cursor_offset, &bytes[cursor..])?;
        }
        if eof {
            if !self.bom_resolved {
                self.bom_resolved = true;
                let prefix = std::mem::take(&mut self.bom_prefix);
                self.process_bytes(0, &prefix)?;
            }
            self.finish()?;
        }

        Ok(ScanUpdate {
            metadata: self.metadata()?,
            bytes_scanned: self.bytes_received,
            rows_discovered: self.rows,
            checkpoints_added: self.checkpoints[checkpoints_before..].to_vec(),
            warnings: self.diagnostics[diagnostics_before..].to_vec(),
            done: self.finished,
        })
    }

    /// Returns the latest progressive table metadata.
    pub fn metadata(&self) -> Result<TableMetadata> {
        let rows = if self.finished {
            AxisExtent::exact(self.rows)?
        } else {
            AxisExtent::at_least(self.rows)?
        };
        let column_count = u64::try_from(self.columns.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "column count exceeds u64")
        })?;
        let columns = if self.finished {
            AxisExtent::exact(column_count)?
        } else if self.columns.is_empty() {
            AxisExtent::Unknown
        } else {
            AxisExtent::at_least(column_count)?
        };
        Ok(TableMetadata::new(
            "table-0",
            self.options.table_name.clone(),
            0,
            TableExtent::new(rows, columns),
            Schema::new(self.schema_version, self.columns.clone())?,
            Capabilities::delimited(if self.finished {
                RandomAccess::Full
            } else {
                RandomAccess::IndexedPrefix
            }),
        ))
    }

    /// Returns all sparse checkpoints created so far.
    #[must_use]
    pub fn checkpoints(&self) -> &[CsvCheckpoint] {
        &self.checkpoints
    }

    /// Returns retained lenient-mode diagnostics.
    #[must_use]
    pub fn diagnostics(&self) -> &[CsvDiagnostic] {
        &self.diagnostics
    }

    /// Returns the accepted raw byte count.
    #[must_use]
    pub const fn bytes_scanned(&self) -> u64 {
        self.bytes_received
    }

    /// Returns whether the scanner reached end-of-file.
    #[must_use]
    pub const fn is_finished(&self) -> bool {
        self.finished
    }

    /// Returns a conservative estimate of heap bytes retained for scanning and indexing.
    ///
    /// The estimate uses allocated capacities rather than logical lengths for sparse
    /// checkpoints, schema columns, pending headers, diagnostics, the in-progress field,
    /// and the possible UTF-8 BOM prefix. Heap allocations owned by strings nested in
    /// those collections are included as well.
    #[must_use]
    pub fn estimated_index_bytes(&self) -> usize {
        let checkpoint_bytes = allocated_vec_bytes::<CsvCheckpoint>(&self.checkpoints);
        let column_bytes = allocated_vec_bytes::<ColumnSchema>(&self.columns)
            .saturating_add(self.column_string_bytes);
        let header_bytes = allocated_vec_bytes::<String>(&self.header_names).saturating_add(
            self.header_names
                .iter()
                .fold(0_usize, |bytes, name| bytes.saturating_add(name.capacity())),
        );
        let diagnostic_bytes = allocated_vec_bytes::<CsvDiagnostic>(&self.diagnostics)
            .saturating_add(self.diagnostics.iter().fold(0_usize, |bytes, diagnostic| {
                bytes.saturating_add(diagnostic.message.capacity())
            }));

        checkpoint_bytes
            .saturating_add(column_bytes)
            .saturating_add(header_bytes)
            .saturating_add(diagnostic_bytes)
            .saturating_add(self.field.capacity())
            .saturating_add(self.bom_prefix.capacity())
    }

    /// Produces a checkpoint-based source read plan.
    pub fn plan_range(&self, request: RangeRequest) -> Result<RangePlan> {
        self.validate_range(request)?;
        if request.row_count() > 0 && !self.finished && request.row_start() >= self.rows {
            return Err(TabularkError::new(
                ErrorCode::RangeNotIndexed,
                "requested row has not been indexed yet",
            )
            .with_retryable(true)
            .with_detail("indexedRows", self.rows));
        }

        let checkpoint = self
            .checkpoints
            .iter()
            .rev()
            .copied()
            .find(|checkpoint| checkpoint.row <= request.row_start())
            .unwrap_or(CsvCheckpoint {
                row: self.rows,
                byte_offset: self.parser_offset,
            });
        Ok(RangePlan {
            checkpoint,
            request,
            rows_to_skip: request.row_start().saturating_sub(checkpoint.row),
        })
    }

    /// Creates a fresh range decoder from a previously produced plan.
    pub fn range_decoder(&self, plan: RangePlan) -> Result<RangeDecoder> {
        RangeDecoder::new(
            self.options.clone(),
            plan,
            Schema::new(self.schema_version, self.columns.clone())?,
        )
    }

    fn validate_range(&self, request: RangeRequest) -> Result<()> {
        request.validate_public()?;
        if request.cell_count()? > self.options.limits.max_cells_per_range {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "range exceeds the configured cell limit",
            )
            .with_detail("maxCells", self.options.limits.max_cells_per_range));
        }
        let column_end = request.column_end()?;
        let schema_columns = u64::try_from(self.columns.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "column count exceeds u64")
        })?;
        if column_end > schema_columns {
            return Err(TabularkError::new(
                ErrorCode::InvalidRange,
                "requested columns exceed the current schema",
            )
            .with_detail("schemaColumns", schema_columns));
        }
        Ok(())
    }

    fn process_bytes(&mut self, base: u64, bytes: &[u8]) -> Result<()> {
        if base != self.parser_offset {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "parser input does not begin at the expected absolute offset",
            )
            .with_detail("expectedOffset", self.parser_offset)
            .with_detail("actualOffset", base));
        }
        for issue in self.lexical.consume(bytes, base) {
            self.handle_diagnostic(CsvDiagnostic::new(
                CsvDiagnosticKind::MalformedQuote,
                None,
                issue.offset,
                issue.message,
            ))?;
        }

        let mut input = bytes;
        let mut scratch = [0_u8; FIELD_SCRATCH_BYTES];
        while !input.is_empty() {
            let (result, consumed, written) = self.reader.read_field(input, &mut scratch);
            self.append_field(&scratch[..written])?;
            let consumed_u64 = u64::try_from(consumed).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "parser offset overflow")
            })?;
            self.parser_offset = self
                .parser_offset
                .checked_add(consumed_u64)
                .ok_or_else(|| {
                    TabularkError::new(ErrorCode::ResourceLimit, "parser offset overflow")
                })?;
            input = &input[consumed..];
            match result {
                ReadFieldResult::InputEmpty => break,
                ReadFieldResult::OutputFull => {}
                ReadFieldResult::Field { record_end } => {
                    self.finish_field()?;
                    if record_end {
                        self.finish_record()?;
                    }
                }
                ReadFieldResult::End => {
                    return Err(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "CSV parser reached end before the input chunk was exhausted",
                    ));
                }
            }
            if consumed == 0 && written == 0 {
                return Err(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "CSV parser made no progress",
                ));
            }
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        if let Some(offset) = self.lexical.unclosed_quote_offset() {
            self.handle_diagnostic(CsvDiagnostic::new(
                CsvDiagnosticKind::MalformedQuote,
                None,
                offset,
                "quoted field is not terminated before end-of-file",
            ))?;
        }

        let mut scratch = [0_u8; FIELD_SCRATCH_BYTES];
        for _ in 0..4 {
            let (result, consumed, written) = self.reader.read_field(&[], &mut scratch);
            debug_assert_eq!(consumed, 0);
            self.append_field(&scratch[..written])?;
            match result {
                ReadFieldResult::Field { record_end } => {
                    self.finish_field()?;
                    if record_end {
                        self.finish_record()?;
                    }
                }
                ReadFieldResult::End => {
                    self.finished = true;
                    return Ok(());
                }
                ReadFieldResult::OutputFull => continue,
                ReadFieldResult::InputEmpty => continue,
            }
        }
        Err(TabularkError::new(
            ErrorCode::RuntimeFailure,
            "CSV parser did not terminate at end-of-file",
        ))
    }

    fn append_field(&mut self, bytes: &[u8]) -> Result<()> {
        let new_len = self.field.len().checked_add(bytes.len()).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "CSV field length overflow")
        })?;
        if new_len > self.options.limits.max_field_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "CSV field exceeds the configured byte limit",
            )
            .with_detail("maxFieldBytes", self.options.limits.max_field_bytes));
        }
        self.field.extend_from_slice(bytes);
        Ok(())
    }

    fn finish_field(&mut self) -> Result<()> {
        self.record_fields = self.record_fields.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "CSV column count overflow")
        })?;
        if self.record_fields > self.options.limits.max_columns {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "CSV record exceeds the configured column limit",
            )
            .with_detail("maxColumns", self.options.limits.max_columns));
        }

        let bytes = std::mem::take(&mut self.field);
        let decoded = match std::str::from_utf8(&bytes) {
            Ok(value) => Cow::Borrowed(value),
            Err(_) => {
                self.handle_diagnostic(CsvDiagnostic::new(
                    CsvDiagnosticKind::InvalidUtf8,
                    (!self.header_pending).then_some(self.rows),
                    self.record_start_offset,
                    "field contains invalid UTF-8; replacement characters were used",
                ))?;
                String::from_utf8_lossy(&bytes)
            }
        };
        if self.header_pending {
            self.header_names.push(decoded.into_owned());
        }
        Ok(())
    }

    fn finish_record(&mut self) -> Result<()> {
        let fields = std::mem::take(&mut self.record_fields);
        if self.header_pending {
            let names = std::mem::take(&mut self.header_names);
            self.ensure_columns(fields, Some(&names))?;
            self.header_pending = false;
        } else {
            if self.rows % self.options.checkpoint_interval == 0 {
                self.checkpoints.push(CsvCheckpoint {
                    row: self.rows,
                    byte_offset: self.record_start_offset,
                });
            }
            if self.columns.is_empty() {
                self.ensure_columns(fields, None)?;
            } else if fields != self.columns.len() {
                self.handle_diagnostic(CsvDiagnostic::new(
                    CsvDiagnosticKind::RaggedRow,
                    Some(self.rows),
                    self.record_start_offset,
                    format!(
                        "row has {fields} fields but the current schema has {}",
                        self.columns.len()
                    ),
                ))?;
                if fields > self.columns.len() {
                    self.ensure_columns(fields, None)?;
                }
            }
            self.rows = self.rows.checked_add(1).ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "CSV row count overflow")
            })?;
        }
        self.record_start_offset = self.parser_offset;
        Ok(())
    }

    fn ensure_columns(&mut self, count: usize, header_names: Option<&[String]>) -> Result<()> {
        if count > self.options.limits.max_columns {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "CSV schema exceeds the configured column limit",
            ));
        }
        if count <= self.columns.len() {
            return Ok(());
        }
        for index in self.columns.len()..count {
            let name = header_names
                .and_then(|names| names.get(index))
                .filter(|name| !name.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("column_{}", index + 1));
            let id = format!("c{index}");
            let string_bytes = id.capacity().saturating_add(name.capacity());
            let index_u64 = u64::try_from(index).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "column index exceeds u64")
            })?;
            self.columns.push(ColumnSchema::new(
                id,
                name,
                index_u64,
                LogicalType::Utf8,
                true,
            )?);
            self.column_string_bytes = self.column_string_bytes.saturating_add(string_bytes);
        }
        self.schema_version = self.schema_version.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "schema version overflow")
        })?;
        Ok(())
    }

    fn handle_diagnostic(&mut self, diagnostic: CsvDiagnostic) -> Result<()> {
        if self.options.mode == ParseMode::Strict {
            return Err(
                TabularkError::new(ErrorCode::ParseFailed, diagnostic.message.clone())
                    .with_detail("kind", diagnostic_kind_name(diagnostic.kind))
                    .with_detail("byteOffset", diagnostic.byte_offset),
            );
        }
        if self.diagnostics.len() < self.options.limits.max_diagnostics {
            self.diagnostics.push(diagnostic);
        }
        Ok(())
    }
}

fn allocated_vec_bytes<T>(values: &Vec<T>) -> usize {
    values.capacity().saturating_mul(std::mem::size_of::<T>())
}

/// Result of feeding a range decoder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RangeDecodeStatus {
    /// More source bytes are required.
    NeedMore,
    /// The requested range or end-of-file was reached.
    Complete(TableBatch),
}

/// Incrementally decodes one requested range from a checkpoint source slice.
#[derive(Debug)]
pub struct RangeDecoder {
    options: DelimitedOptions,
    plan: RangePlan,
    schema: Schema,
    reader: Reader,
    lexical: QuoteTracker,
    expected_offset: u64,
    field: Vec<u8>,
    field_index: usize,
    current_row: u64,
    selected_values: Vec<Option<Vec<u8>>>,
    builders: Vec<StringColumnBuilder>,
    returned_rows: u64,
    batch_bytes: usize,
    diagnostics: Vec<CsvDiagnostic>,
    done: bool,
}

impl RangeDecoder {
    fn new(options: DelimitedOptions, plan: RangePlan, schema: Schema) -> Result<Self> {
        let selected = usize::try_from(plan.request.column_count()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "range column count exceeds usize")
        })?;
        let start = usize::try_from(plan.request.column_start()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "range column start exceeds usize")
        })?;
        let mut builders = Vec::with_capacity(selected);
        for column in &schema.columns()[start..start + selected] {
            builders.push(StringColumnBuilder::new(column.id()));
        }
        let batch_bytes = selected
            .checked_mul(std::mem::size_of::<u32>())
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "batch byte length overflow")
            })?;
        if batch_bytes > options.limits.max_batch_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "range response exceeds the configured byte limit",
            ));
        }
        Ok(Self {
            reader: build_reader(options.delimiter),
            lexical: QuoteTracker::new(options.delimiter),
            expected_offset: plan.source_offset(),
            field: Vec::new(),
            field_index: 0,
            current_row: plan.checkpoint.row,
            selected_values: vec![None; selected],
            builders,
            returned_rows: 0,
            batch_bytes,
            diagnostics: Vec::new(),
            done: plan.request.row_count() == 0,
            options,
            plan,
            schema,
        })
    }

    /// Returns diagnostics emitted during range decoding.
    #[must_use]
    pub fn diagnostics(&self) -> &[CsvDiagnostic] {
        &self.diagnostics
    }

    /// Returns the next absolute byte offset expected from the source.
    #[must_use]
    pub const fn expected_offset(&self) -> u64 {
        self.expected_offset
    }

    /// Returns whether the decoder already produced its terminal batch.
    #[must_use]
    pub const fn is_done(&self) -> bool {
        self.done
    }

    /// Returns an immediate empty batch for a zero-row request.
    pub fn immediate_batch(&mut self) -> Result<Option<TableBatch>> {
        if self.done && self.returned_rows == 0 && self.plan.request.row_count() == 0 {
            return self.build_batch(true).map(Some);
        }
        Ok(None)
    }

    /// Accepts the next contiguous source slice for this range.
    pub fn feed_chunk(
        &mut self,
        absolute_offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<RangeDecodeStatus> {
        if self.done {
            return Err(TabularkError::new(
                ErrorCode::HandleClosed,
                "range decoder is already complete",
            ));
        }
        if absolute_offset != self.expected_offset {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "range chunks must be contiguous and begin at the planned offset",
            )
            .with_detail("expectedOffset", self.expected_offset)
            .with_detail("actualOffset", absolute_offset));
        }
        for issue in self.lexical.consume(bytes, absolute_offset) {
            self.handle_diagnostic(CsvDiagnostic::new(
                CsvDiagnosticKind::MalformedQuote,
                Some(self.current_row),
                issue.offset,
                issue.message,
            ))?;
        }

        let mut input = bytes;
        let mut scratch = [0_u8; FIELD_SCRATCH_BYTES];
        while !input.is_empty() && !self.done {
            let (result, consumed, written) = self.reader.read_field(input, &mut scratch);
            self.append_field(&scratch[..written])?;
            let consumed_u64 = u64::try_from(consumed).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "range parser offset overflow")
            })?;
            self.expected_offset =
                self.expected_offset
                    .checked_add(consumed_u64)
                    .ok_or_else(|| {
                        TabularkError::new(ErrorCode::ResourceLimit, "range parser offset overflow")
                    })?;
            input = &input[consumed..];
            match result {
                ReadFieldResult::InputEmpty => break,
                ReadFieldResult::OutputFull => {}
                ReadFieldResult::Field { record_end } => {
                    self.finish_field()?;
                    if record_end {
                        self.finish_record()?;
                    }
                }
                ReadFieldResult::End => {
                    return Err(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "range parser reached end before its chunk was exhausted",
                    ));
                }
            }
            if consumed == 0 && written == 0 {
                return Err(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "range parser made no progress",
                ));
            }
        }
        if self.done {
            return Ok(RangeDecodeStatus::Complete(self.build_batch(true)?));
        }
        if eof {
            return self.finish_eof();
        }
        Ok(RangeDecodeStatus::NeedMore)
    }

    fn finish_eof(&mut self) -> Result<RangeDecodeStatus> {
        if let Some(offset) = self.lexical.unclosed_quote_offset() {
            self.handle_diagnostic(CsvDiagnostic::new(
                CsvDiagnosticKind::MalformedQuote,
                Some(self.current_row),
                offset,
                "quoted field is not terminated before end-of-file",
            ))?;
        }
        let mut scratch = [0_u8; FIELD_SCRATCH_BYTES];
        for _ in 0..4 {
            let (result, _, written) = self.reader.read_field(&[], &mut scratch);
            self.append_field(&scratch[..written])?;
            match result {
                ReadFieldResult::Field { record_end } => {
                    self.finish_field()?;
                    if record_end {
                        self.finish_record()?;
                    }
                }
                ReadFieldResult::End => {
                    self.done = true;
                    return Ok(RangeDecodeStatus::Complete(self.build_batch(
                        self.returned_rows == self.plan.request.row_count(),
                    )?));
                }
                ReadFieldResult::OutputFull | ReadFieldResult::InputEmpty => continue,
            }
            if self.done {
                return Ok(RangeDecodeStatus::Complete(self.build_batch(true)?));
            }
        }
        Err(TabularkError::new(
            ErrorCode::RuntimeFailure,
            "range parser did not terminate at end-of-file",
        ))
    }

    fn append_field(&mut self, bytes: &[u8]) -> Result<()> {
        let new_len = self.field.len().checked_add(bytes.len()).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "CSV field length overflow")
        })?;
        if new_len > self.options.limits.max_field_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "CSV field exceeds the configured byte limit",
            ));
        }
        self.field.extend_from_slice(bytes);
        Ok(())
    }

    fn finish_field(&mut self) -> Result<()> {
        self.field_index = self.field_index.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "CSV column count overflow")
        })?;
        if self.field_index > self.options.limits.max_columns {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "CSV record exceeds the configured column limit",
            ));
        }
        let logical_index = self.field_index - 1;
        let start = usize::try_from(self.plan.request.column_start()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "column start exceeds usize")
        })?;
        let end = start + self.selected_values.len();
        let field = std::mem::take(&mut self.field);
        if self.current_row >= self.plan.request.row_start()
            && self.current_row < self.plan.request.row_end()?
            && (start..end).contains(&logical_index)
        {
            let normalized = match std::str::from_utf8(&field) {
                Ok(_) => field,
                Err(_) => {
                    self.handle_diagnostic(CsvDiagnostic::new(
                        CsvDiagnosticKind::InvalidUtf8,
                        Some(self.current_row),
                        self.expected_offset,
                        "field contains invalid UTF-8; replacement characters were used",
                    ))?;
                    String::from_utf8_lossy(&field).into_owned().into_bytes()
                }
            };
            self.selected_values[logical_index - start] = Some(normalized);
        }
        Ok(())
    }

    fn finish_record(&mut self) -> Result<()> {
        if self.field_index != self.schema.len() {
            self.handle_diagnostic(CsvDiagnostic::new(
                CsvDiagnosticKind::RaggedRow,
                Some(self.current_row),
                self.expected_offset,
                format!(
                    "row has {} fields but the schema has {}",
                    self.field_index,
                    self.schema.len()
                ),
            ))?;
        }
        if self.current_row >= self.plan.request.row_start()
            && self.current_row < self.plan.request.row_end()?
        {
            for (builder, value) in self.builders.iter_mut().zip(&mut self.selected_values) {
                builder.push(
                    value.take(),
                    &mut self.batch_bytes,
                    self.options.limits.max_batch_bytes,
                )?;
            }
            self.returned_rows += 1;
        }
        self.field_index = 0;
        self.selected_values.fill(None);
        self.current_row = self.current_row.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "range row count overflow")
        })?;
        if self.returned_rows == self.plan.request.row_count() {
            self.done = true;
        }
        Ok(())
    }

    fn handle_diagnostic(&mut self, diagnostic: CsvDiagnostic) -> Result<()> {
        if self.options.mode == ParseMode::Strict {
            return Err(
                TabularkError::new(ErrorCode::ParseFailed, diagnostic.message.clone())
                    .with_detail("kind", diagnostic_kind_name(diagnostic.kind))
                    .with_detail("byteOffset", diagnostic.byte_offset),
            );
        }
        if self.diagnostics.len() < self.options.limits.max_diagnostics {
            self.diagnostics.push(diagnostic);
        }
        Ok(())
    }

    fn build_batch(&mut self, complete: bool) -> Result<TableBatch> {
        let returned_range = RangeRequest::new(
            self.plan.request.row_start(),
            self.returned_rows,
            self.plan.request.column_start(),
            self.plan.request.column_count(),
        )?;
        let builders = std::mem::take(&mut self.builders);
        let columns = builders
            .into_iter()
            .map(StringColumnBuilder::finish)
            .collect::<Result<Vec<_>>>()?;
        Ok(TableBatch::new(
            "table-0",
            0,
            self.schema.version(),
            returned_range,
            complete,
            columns,
        ))
    }
}

/// A native reference source that intentionally retains bytes for tests and examples.
#[derive(Debug)]
pub struct MemorySource {
    bytes: Vec<u8>,
    scanner: CsvScanner,
    chunk_size: usize,
}

impl MemorySource {
    /// Opens and fully scans an in-memory delimited source in bounded chunks.
    pub fn open(bytes: impl Into<Vec<u8>>, options: DelimitedOptions) -> Result<Self> {
        Self::open_with_chunk_size(bytes, options, 1_024 * 1_024)
    }

    /// Opens an in-memory source with a chosen scanner chunk size.
    pub fn open_with_chunk_size(
        bytes: impl Into<Vec<u8>>,
        options: DelimitedOptions,
        chunk_size: usize,
    ) -> Result<Self> {
        if chunk_size == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "memory source chunk size must be greater than zero",
            ));
        }
        let bytes = bytes.into();
        let mut scanner = CsvScanner::new(options)?;
        if bytes.is_empty() {
            scanner.feed_chunk(0, &[], true)?;
        } else {
            let mut offset = 0;
            while offset < bytes.len() {
                let end = offset.saturating_add(chunk_size).min(bytes.len());
                scanner.feed_chunk(
                    u64::try_from(offset).map_err(|_| {
                        TabularkError::new(ErrorCode::ResourceLimit, "source offset exceeds u64")
                    })?,
                    &bytes[offset..end],
                    end == bytes.len(),
                )?;
                offset = end;
            }
        }
        Ok(Self {
            bytes,
            scanner,
            chunk_size,
        })
    }

    /// Returns the final metadata snapshot.
    pub fn metadata(&self) -> Result<TableMetadata> {
        self.scanner.metadata()
    }

    /// Returns the underlying sparse index.
    #[must_use]
    pub fn checkpoints(&self) -> &[CsvCheckpoint] {
        self.scanner.checkpoints()
    }

    /// Reads a bounded range by decoding from the nearest sparse checkpoint.
    pub fn read_range(&self, request: RangeRequest) -> Result<TableBatch> {
        let plan = self.scanner.plan_range(request)?;
        let mut decoder = self.scanner.range_decoder(plan)?;
        if let Some(batch) = decoder.immediate_batch()? {
            return Ok(batch);
        }
        let mut offset = usize::try_from(plan.source_offset()).map_err(|_| {
            TabularkError::new(ErrorCode::InvalidRange, "range source offset exceeds usize")
        })?;
        if offset >= self.bytes.len() {
            return match decoder.feed_chunk(plan.source_offset(), &[], true)? {
                RangeDecodeStatus::Complete(batch) => Ok(batch),
                RangeDecodeStatus::NeedMore => Err(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "range decoder requested bytes beyond end-of-file",
                )),
            };
        }
        loop {
            let end = offset.saturating_add(self.chunk_size).min(self.bytes.len());
            let status = decoder.feed_chunk(
                u64::try_from(offset).map_err(|_| {
                    TabularkError::new(ErrorCode::ResourceLimit, "source offset exceeds u64")
                })?,
                &self.bytes[offset..end],
                end == self.bytes.len(),
            )?;
            match status {
                RangeDecodeStatus::Complete(batch) => return Ok(batch),
                RangeDecodeStatus::NeedMore => offset = end,
            }
        }
    }
}

#[derive(Debug)]
struct StringColumnBuilder {
    column_id: String,
    data: Vec<u8>,
    offsets: Vec<u32>,
    validity: Vec<u8>,
    values: usize,
}

impl StringColumnBuilder {
    fn new(column_id: &str) -> Self {
        Self {
            column_id: column_id.into(),
            data: Vec::new(),
            offsets: vec![0],
            validity: Vec::new(),
            values: 0,
        }
    }

    fn push(
        &mut self,
        value: Option<Vec<u8>>,
        batch_bytes: &mut usize,
        max_batch_bytes: usize,
    ) -> Result<()> {
        let validity_byte = usize::from(self.values % 8 == 0);
        let value_bytes = value.as_ref().map_or(0, Vec::len);
        let encoded_bytes = value_bytes
            .checked_add(std::mem::size_of::<u32>())
            .and_then(|bytes| bytes.checked_add(validity_byte))
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "batch byte length overflow")
            })?;
        let new_batch_bytes = batch_bytes.checked_add(encoded_bytes).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "batch byte length overflow")
        })?;
        if new_batch_bytes > max_batch_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "range response exceeds the configured byte limit",
            ));
        }
        if let Some(value) = value {
            self.data.extend_from_slice(&value);
            let byte = self.values / 8;
            if self.validity.len() <= byte {
                self.validity.push(0);
            }
            self.validity[byte] |= 1 << (self.values % 8);
        } else {
            let byte = self.values / 8;
            if self.validity.len() <= byte {
                self.validity.push(0);
            }
        }
        let offset = u32::try_from(self.data.len()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "one encoded string column exceeds the u32 offset limit",
            )
        })?;
        self.offsets.push(offset);
        self.values += 1;
        *batch_bytes = new_batch_bytes;
        Ok(())
    }

    fn finish(self) -> Result<StringColumnBatch> {
        StringColumnBatch::new(self.column_id, self.data, self.offsets, self.validity)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuoteState {
    StartField,
    Unquoted,
    Quoted { opening_offset: u64 },
    AfterQuote,
}

#[derive(Debug)]
struct QuoteIssue {
    offset: u64,
    message: &'static str,
}

#[derive(Debug)]
struct QuoteTracker {
    delimiter: u8,
    state: QuoteState,
    quoted_opening: Option<u64>,
}

impl QuoteTracker {
    const fn new(delimiter: u8) -> Self {
        Self {
            delimiter,
            state: QuoteState::StartField,
            quoted_opening: None,
        }
    }

    fn consume(&mut self, bytes: &[u8], base: u64) -> Vec<QuoteIssue> {
        let mut issues = Vec::new();
        for (index, byte) in bytes.iter().copied().enumerate() {
            let offset = base + u64::try_from(index).unwrap_or(u64::MAX);
            match self.state {
                QuoteState::StartField => match byte {
                    b'"' => {
                        self.state = QuoteState::Quoted {
                            opening_offset: offset,
                        };
                        self.quoted_opening = Some(offset);
                    }
                    b if b == self.delimiter || matches!(b, b'\r' | b'\n') => {}
                    _ => self.state = QuoteState::Unquoted,
                },
                QuoteState::Unquoted => {
                    if byte == b'"' {
                        issues.push(QuoteIssue {
                            offset,
                            message: "quote appears inside an unquoted field",
                        });
                    } else if byte == self.delimiter || matches!(byte, b'\r' | b'\n') {
                        self.state = QuoteState::StartField;
                    }
                }
                QuoteState::Quoted { .. } => {
                    if byte == b'"' {
                        self.state = QuoteState::AfterQuote;
                    }
                }
                QuoteState::AfterQuote => {
                    if byte == b'"' {
                        self.state = QuoteState::Quoted {
                            opening_offset: self.quoted_opening.unwrap_or(offset),
                        };
                    } else if byte == self.delimiter || matches!(byte, b'\r' | b'\n') {
                        self.state = QuoteState::StartField;
                        self.quoted_opening = None;
                    } else {
                        issues.push(QuoteIssue {
                            offset,
                            message: "unexpected data follows a closing quote",
                        });
                        self.state = QuoteState::Unquoted;
                        self.quoted_opening = None;
                    }
                }
            }
        }
        issues
    }

    const fn unclosed_quote_offset(&self) -> Option<u64> {
        match self.state {
            QuoteState::Quoted { opening_offset } => Some(opening_offset),
            _ => None,
        }
    }
}

fn build_reader(delimiter: u8) -> Reader {
    let mut builder = ReaderBuilder::new();
    builder.delimiter(delimiter);
    builder.build()
}

fn diagnostic_kind_name(kind: CsvDiagnosticKind) -> &'static str {
    match kind {
        CsvDiagnosticKind::RaggedRow => "ragged-row",
        CsvDiagnosticKind::InvalidUtf8 => "invalid-utf8",
        CsvDiagnosticKind::MalformedQuote => "malformed-quote",
    }
}

mod ascii_byte {
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};

    pub fn serialize<S>(value: &u8, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&char::from(*value).to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u8, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let bytes = value.as_bytes();
        if bytes.len() != 1 || !bytes[0].is_ascii() {
            return Err(D::Error::custom(
                "delimiter must be exactly one ASCII character",
            ));
        }
        Ok(bytes[0])
    }
}

mod header_mode {
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum HeaderValue {
        Boolean(bool),
        Name(String),
    }

    pub fn serialize<S>(value: &bool, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(if *value { "first-row" } else { "none" })
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<bool, D::Error>
    where
        D: Deserializer<'de>,
    {
        match HeaderValue::deserialize(deserializer)? {
            HeaderValue::Boolean(value) => Ok(value),
            HeaderValue::Name(value) if value == "first-row" => Ok(true),
            HeaderValue::Name(value) if value == "none" => Ok(false),
            HeaderValue::Name(_) => Err(D::Error::custom(
                "header must be first-row, none, true, or false",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CsvDiagnosticKind, CsvScanner, DelimitedOptions, MemorySource, ParseMode, RangeDecodeStatus,
    };
    use crate::error::ErrorCode;
    use crate::model::{AxisExtent, RangeRequest};

    #[test]
    fn scans_bom_crlf_quotes_and_embedded_newlines_across_tiny_chunks() {
        let source = MemorySource::open_with_chunk_size(
            b"\xEF\xBB\xBFname,note\r\nAlice,\"hello\r\nworld\"\r\nBob,\"a \"\"quote\"\"\"\r\n",
            DelimitedOptions::csv(),
            1,
        )
        .expect("scan source");

        let metadata = source.metadata().expect("metadata");
        assert_eq!(metadata.extent().rows(), AxisExtent::Exact { value: 2 });
        assert_eq!(metadata.schema().columns()[0].name(), "name");

        let batch = source
            .read_range(RangeRequest::new(0, 2, 0, 2).expect("range"))
            .expect("read range");
        assert_eq!(batch.columns()[0].value(0), Some(Some("Alice")));
        assert_eq!(batch.columns()[1].value(0), Some(Some("hello\r\nworld")));
        assert_eq!(batch.columns()[1].value(1), Some(Some("a \"quote\"")));
    }

    #[test]
    fn lenient_mode_distinguishes_missing_from_empty_and_expands_schema() {
        let source = MemorySource::open(b"a,b\n1\n2,,3\n".to_vec(), DelimitedOptions::csv())
            .expect("scan source");
        let batch = source
            .read_range(RangeRequest::new(0, 2, 0, 3).expect("range"))
            .expect("read range");

        assert_eq!(batch.columns()[1].value(0), Some(None));
        assert_eq!(batch.columns()[1].value(1), Some(Some("")));
        assert_eq!(batch.columns()[2].value(0), Some(None));
        assert_eq!(batch.columns()[2].value(1), Some(Some("3")));
        assert!(
            source
                .scanner
                .diagnostics()
                .iter()
                .all(|warning| { warning.kind() == CsvDiagnosticKind::RaggedRow })
        );
    }

    #[test]
    fn strict_mode_rejects_ragged_rows_and_invalid_utf8() {
        let mut strict = DelimitedOptions::csv();
        strict.mode = ParseMode::Strict;
        let ragged = MemorySource::open(b"a,b\n1\n".to_vec(), strict.clone())
            .expect_err("ragged row must fail");
        assert_eq!(ragged.code(), ErrorCode::ParseFailed);

        let invalid =
            MemorySource::open(b"a\n\xFF\n".to_vec(), strict).expect_err("invalid UTF-8 must fail");
        assert_eq!(invalid.code(), ErrorCode::ParseFailed);
    }

    #[test]
    fn lenient_mode_replaces_invalid_utf8_in_batches() {
        let source = MemorySource::open(b"a\n\xFF\n".to_vec(), DelimitedOptions::csv())
            .expect("scan source");
        let batch = source
            .read_range(RangeRequest::new(0, 1, 0, 1).expect("range"))
            .expect("range read");

        assert_eq!(batch.columns()[0].value(0), Some(Some("�")));
    }

    #[test]
    fn sparse_checkpoint_serves_non_adjacent_ranges() {
        let mut options = DelimitedOptions::csv();
        options.checkpoint_interval = 2;
        let source = MemorySource::open(b"value\nr0\nr1\nr2\nr3\nr4\n".to_vec(), options)
            .expect("scan source");

        assert_eq!(
            source
                .checkpoints()
                .iter()
                .map(|checkpoint| checkpoint.row())
                .collect::<Vec<_>>(),
            vec![0, 2, 4]
        );
        let late = source
            .read_range(RangeRequest::new(4, 1, 0, 1).expect("range"))
            .expect("late range");
        let early = source
            .read_range(RangeRequest::new(1, 2, 0, 1).expect("range"))
            .expect("early range");
        assert_eq!(late.columns()[0].value(0), Some(Some("r4")));
        assert_eq!(early.columns()[0].value(0), Some(Some("r1")));
        assert_eq!(early.columns()[0].value(1), Some(Some("r2")));
    }

    #[test]
    fn scanner_plans_only_the_indexed_prefix_until_eof() {
        let mut scanner = CsvScanner::new(DelimitedOptions::csv()).expect("scanner");
        scanner
            .feed_chunk(0, b"a\nfirst\n", false)
            .expect("partial scan");
        let error = scanner
            .plan_range(RangeRequest::new(1, 1, 0, 1).expect("range"))
            .expect_err("next row is not indexed");
        assert_eq!(error.code(), ErrorCode::RangeNotIndexed);
    }

    #[test]
    fn range_decoder_can_be_fed_independently_from_the_scan() {
        let bytes = b"a\nr0\nr1\n";
        let source = MemorySource::open(bytes.to_vec(), DelimitedOptions::csv()).expect("source");
        let plan = source
            .scanner
            .plan_range(RangeRequest::new(1, 1, 0, 1).expect("range"))
            .expect("plan");
        let mut decoder = source.scanner.range_decoder(plan).expect("decoder");
        let offset = usize::try_from(plan.source_offset()).expect("offset");
        let result = decoder
            .feed_chunk(plan.source_offset(), &bytes[offset..], true)
            .expect("decode");
        let RangeDecodeStatus::Complete(batch) = result else {
            panic!("expected completed batch");
        };
        assert_eq!(batch.columns()[0].value(0), Some(Some("r1")));
    }
}
