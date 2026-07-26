//! Range-driven Apache Parquet adapter foundations.
//!
//! The browser boundary owns source bytes. This module exposes restartable
//! open and read operations backed by a sparse [`ChunkReader`], allowing
//! parquet-rs to request only the footer, metadata, selected row groups, and
//! projected top-level columns needed for one operation.

use std::collections::{HashMap, VecDeque};
use std::fmt::{self, Debug, Formatter};
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use ::parquet::arrow::ProjectionMask;
use ::parquet::arrow::arrow_reader::{
    ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder,
};
use ::parquet::basic::{Compression, LogicalType};
use ::parquet::errors::{ParquetError, Result as ParquetResult};
use ::parquet::file::reader::{ChunkReader, Length};
use bytes::Bytes;
use serde::{Deserialize, Serialize};

use crate::arrow::{ArrowIpcLimits, encode_projected_record_batches, exact_metadata};
use crate::error::{ErrorCode, Result, TabularkError, zstd_decompression_limit_error};
use crate::model::{RangeRequest, TableMetadata, TypedTableBatch};

const PARQUET_MAGIC: &[u8; 4] = b"PAR1";
const PARQUET_ENCRYPTED_FOOTER_MAGIC: &[u8; 4] = b"PARE";
const FOOTER_BYTES: u64 = 8;
const HEADER_BYTES: u64 = 4;
const MISSING_BYTES_SENTINEL: &str = "tabulark parquet source range is not cached";

/// Per-operation safety limits for the Parquet adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ParquetLimits {
    /// Maximum encoded source length accepted by the adapter.
    pub max_source_bytes: u64,
    /// Maximum encoded footer metadata retained by an open source.
    pub max_metadata_bytes: usize,
    /// Maximum compressed source bytes retained by one active range read.
    pub max_operation_bytes: usize,
    /// Maximum row groups described by a file footer.
    pub max_row_groups: usize,
    /// Maximum top-level columns exposed by one file.
    pub max_columns: usize,
    /// Maximum logical rows exposed by one file.
    pub max_rows: u64,
    /// Maximum rows decoded into one parquet-rs record batch.
    pub max_batch_rows: usize,
    /// Maximum bytes prefetched for a page header returned by `get_read`.
    pub read_prefetch_bytes: usize,
    /// Shared Arrow schema, decoded-array, display, and output limits.
    pub arrow: ArrowIpcLimits,
}

impl Default for ParquetLimits {
    fn default() -> Self {
        Self::from_memory_budget(256 * 1024 * 1024).expect("default Parquet memory budget is valid")
    }
}

impl ParquetLimits {
    /// Derives bounded Parquet and Arrow limits from one operation ceiling.
    pub fn from_memory_budget(memory_budget_bytes: usize) -> Result<Self> {
        if memory_budget_bytes < 3 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet memory budget must reserve at least three bytes",
            ));
        }
        let fraction = |divisor: usize, hard_max: usize| {
            memory_budget_bytes
                .checked_div(divisor)
                .unwrap_or(0)
                .max(1)
                .min(hard_max)
                .min(memory_budget_bytes)
        };
        let max_metadata_bytes = fraction(16, 8 * 1024 * 1024);
        let max_operation_bytes = fraction(4, 128 * 1024 * 1024);
        let arrow_budget = memory_budget_bytes
            .checked_sub(max_metadata_bytes)
            .and_then(|bytes| bytes.checked_sub(max_operation_bytes))
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Parquet memory budget cannot reserve metadata and compressed-page staging",
                )
            })?;
        let limits = Self {
            max_source_bytes: crate::model::MAX_SAFE_INTEGER,
            max_metadata_bytes,
            max_operation_bytes,
            max_row_groups: 16_384,
            max_columns: 16_384,
            max_rows: crate::model::MAX_SAFE_INTEGER,
            max_batch_rows: 8_192,
            read_prefetch_bytes: fraction(256, 1024 * 1024),
            arrow: ArrowIpcLimits::from_memory_budget(arrow_budget)?,
        };
        limits.validate_for_memory_budget(memory_budget_bytes)?;
        Ok(limits)
    }

    /// Validates every sublimit against the adapter runtime budget.
    pub fn validate_for_memory_budget(&self, memory_budget_bytes: usize) -> Result<()> {
        if memory_budget_bytes == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet memory budget must be greater than zero",
            ));
        }
        self.validate_internal()?;
        if self.max_operation_bytes > memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet operation sublimit exceeds its memory ceiling",
            )
            .with_detail("maxOperationBytes", self.max_operation_bytes)
            .with_detail("memoryBudgetBytes", memory_budget_bytes));
        }
        let reserved = self
            .max_metadata_bytes
            .checked_add(self.max_operation_bytes)
            .and_then(|bytes| bytes.checked_add(self.arrow.max_decoded_bytes))
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Parquet memory reservation accounting overflows",
                )
            })?;
        if reserved > memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet metadata, compressed-page, and decode limits exceed the runtime budget",
            )
            .with_detail("reservedBytes", reserved)
            .with_detail("memoryBudgetBytes", memory_budget_bytes));
        }
        self.arrow.validate_for_memory_budget(memory_budget_bytes)?;
        Ok(())
    }

    fn validate_internal(&self) -> Result<()> {
        if self.max_source_bytes == 0
            || self.max_metadata_bytes == 0
            || self.max_operation_bytes == 0
            || self.max_row_groups == 0
            || self.max_columns == 0
            || self.max_rows == 0
            || self.max_batch_rows == 0
            || self.read_prefetch_bytes == 0
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet resource limits must be greater than zero",
            ));
        }
        if self.max_metadata_bytes > self.max_operation_bytes
            || self.read_prefetch_bytes > self.max_operation_bytes
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet operation sublimit exceeds its memory ceiling",
            )
            .with_detail("maxMetadataBytes", self.max_metadata_bytes)
            .with_detail("maxOperationBytes", self.max_operation_bytes)
            .with_detail("readPrefetchBytes", self.read_prefetch_bytes));
        }
        self.arrow
            .validate_for_memory_budget(self.arrow.max_decoded_bytes)?;
        Ok(())
    }
}

/// Stable public options for opening one Parquet file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ParquetOptions {
    /// User-facing name for the file's single logical table.
    pub source_name: String,
}

impl Default for ParquetOptions {
    fn default() -> Self {
        Self {
            source_name: "Parquet".to_owned(),
        }
    }
}

/// One exact source byte range requested by a restartable Parquet operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParquetReadBytesAction {
    /// Absolute source byte offset.
    pub offset: u64,
    /// Exact requested byte length.
    pub length: u64,
}

impl ParquetReadBytesAction {
    fn end(self) -> Result<u64> {
        self.offset.checked_add(self.length).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet source byte action overflows u64",
            )
        })
    }
}

#[derive(Clone, Debug)]
struct Segment {
    offset: u64,
    bytes: Bytes,
}

#[derive(Clone)]
struct SparseChunkReader {
    source_length: u64,
    read_prefetch_bytes: usize,
    segments: Arc<Mutex<Vec<Segment>>>,
    missing: Arc<Mutex<Option<ParquetReadBytesAction>>>,
}

impl Debug for SparseChunkReader {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SparseChunkReader")
            .field("source_length", &self.source_length)
            .field("read_prefetch_bytes", &self.read_prefetch_bytes)
            .field(
                "retained_bytes",
                &self.retained_bytes().unwrap_or(usize::MAX),
            )
            .finish_non_exhaustive()
    }
}

impl SparseChunkReader {
    fn new(source_length: u64, read_prefetch_bytes: usize) -> Self {
        Self {
            source_length,
            read_prefetch_bytes,
            segments: Arc::new(Mutex::new(Vec::new())),
            missing: Arc::new(Mutex::new(None)),
        }
    }

    fn fork(&self) -> Result<Self> {
        let segments = self
            .segments
            .lock()
            .map_err(|_| runtime_lock_error())?
            .clone();
        Ok(Self {
            source_length: self.source_length,
            read_prefetch_bytes: self.read_prefetch_bytes,
            segments: Arc::new(Mutex::new(segments)),
            missing: Arc::new(Mutex::new(None)),
        })
    }

    fn insert(&self, action: ParquetReadBytesAction, bytes: Vec<u8>) -> Result<()> {
        if u64::try_from(bytes.len()).ok() != Some(action.length)
            || action.end()? > self.source_length
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet ingress bytes do not match the requested source range",
            )
            .with_detail("offset", action.offset)
            .with_detail("expectedLength", action.length)
            .with_detail("actualLength", bytes.len()));
        }
        let mut segments = self.segments.lock().map_err(|_| runtime_lock_error())?;
        let incoming_end = action.end()?;
        let mut first = segments.partition_point(|segment| segment.offset < action.offset);
        if first > 0 {
            let previous = &segments[first - 1];
            let previous_length = u64::try_from(previous.bytes.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet cached source segment length overflows u64",
                )
            })?;
            let previous_end = previous
                .offset
                .checked_add(previous_length)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Parquet cached source segment range overflows u64",
                    )
                })?;
            if previous_end >= action.offset {
                first -= 1;
            }
        }

        let mut merged_start = action.offset;
        let mut merged_end = incoming_end;
        let mut last = first;
        while let Some(segment) = segments.get(last) {
            if segment.offset > merged_end {
                break;
            }
            let segment_length = u64::try_from(segment.bytes.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet cached source segment length overflows u64",
                )
            })?;
            let segment_end = segment.offset.checked_add(segment_length).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet cached source segment range overflows u64",
                )
            })?;
            merged_start = merged_start.min(segment.offset);
            merged_end = merged_end.max(segment_end);
            last += 1;
        }

        if first == last {
            segments.insert(
                first,
                Segment {
                    offset: action.offset,
                    bytes: Bytes::from(bytes),
                },
            );
            return Ok(());
        }

        let merged_length = usize::try_from(merged_end - merged_start).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet merged source segment length overflows usize",
            )
        })?;
        let mut merged = vec![0_u8; merged_length];
        for segment in &segments[first..last] {
            let start = usize::try_from(segment.offset - merged_start).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet cached source segment offset overflows usize",
                )
            })?;
            let end = start.checked_add(segment.bytes.len()).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet cached source segment slice overflows usize",
                )
            })?;
            merged[start..end].copy_from_slice(&segment.bytes);
        }
        let incoming_start = usize::try_from(action.offset - merged_start).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet ingress source segment offset overflows usize",
            )
        })?;
        let incoming_end = incoming_start.checked_add(bytes.len()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet ingress source segment slice overflows usize",
            )
        })?;
        merged[incoming_start..incoming_end].copy_from_slice(&bytes);
        segments.splice(
            first..last,
            [Segment {
                offset: merged_start,
                bytes: Bytes::from(merged),
            }],
        );
        Ok(())
    }

    fn retained_bytes(&self) -> Result<usize> {
        self.segments
            .lock()
            .map_err(|_| runtime_lock_error())?
            .iter()
            .try_fold(0_usize, |total, segment| {
                total.checked_add(segment.bytes.len()).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Parquet sparse source byte accounting overflows",
                    )
                })
            })
    }

    fn locate(&self, offset: u64, length: usize) -> ParquetResult<Option<Bytes>> {
        let length_u64 = u64::try_from(length)
            .map_err(|_| ParquetError::General("source range length overflows u64".into()))?;
        let end = offset
            .checked_add(length_u64)
            .ok_or_else(|| ParquetError::General("source range overflows u64".into()))?;
        if end > self.source_length {
            return Err(ParquetError::EOF(format!(
                "source range {offset}..{end} exceeds file length {}",
                self.source_length
            )));
        }
        let segments = self
            .segments
            .lock()
            .map_err(|_| ParquetError::General("Parquet sparse source lock is poisoned".into()))?;
        let candidate = segments.partition_point(|segment| segment.offset <= offset);
        let Some(segment) = candidate
            .checked_sub(1)
            .and_then(|index| segments.get(index))
        else {
            return Ok(None);
        };
        let segment_length = u64::try_from(segment.bytes.len()).map_err(|_| {
            ParquetError::General("cached source segment length overflows u64".into())
        })?;
        let segment_end = segment.offset.checked_add(segment_length).ok_or_else(|| {
            ParquetError::General("cached source segment range overflows u64".into())
        })?;
        if end <= segment_end {
            let start = usize::try_from(offset - segment.offset).map_err(|_| {
                ParquetError::General("cached source slice offset overflows usize".into())
            })?;
            return Ok(Some(segment.bytes.slice(start..start + length)));
        }
        Ok(None)
    }

    fn locate_suffix(&self, offset: u64, max_length: usize) -> ParquetResult<Option<Bytes>> {
        if offset > self.source_length {
            return Err(ParquetError::EOF(format!(
                "source offset {offset} exceeds file length {}",
                self.source_length
            )));
        }
        let segments = self
            .segments
            .lock()
            .map_err(|_| ParquetError::General("Parquet sparse source lock is poisoned".into()))?;
        let candidate = segments.partition_point(|segment| segment.offset <= offset);
        let Some(segment) = candidate
            .checked_sub(1)
            .and_then(|index| segments.get(index))
        else {
            return Ok(None);
        };
        let segment_length = u64::try_from(segment.bytes.len()).map_err(|_| {
            ParquetError::General("cached source segment length overflows u64".into())
        })?;
        let segment_end = segment.offset.checked_add(segment_length).ok_or_else(|| {
            ParquetError::General("cached source segment range overflows u64".into())
        })?;
        if offset >= segment_end {
            return Ok(None);
        }
        let start = usize::try_from(offset - segment.offset).map_err(|_| {
            ParquetError::General("cached source slice offset overflows usize".into())
        })?;
        let end = start.saturating_add(max_length).min(segment.bytes.len());
        Ok(Some(segment.bytes.slice(start..end)))
    }

    fn request(&self, offset: u64, length: usize) -> ParquetResult<Bytes> {
        let length = u64::try_from(length)
            .map_err(|_| ParquetError::General("requested source range is too large".into()))?;
        let action = ParquetReadBytesAction { offset, length };
        if action
            .end()
            .map_err(|error| ParquetError::General(error.to_string()))?
            > self.source_length
        {
            return Err(ParquetError::EOF(
                "requested source range exceeds file length".into(),
            ));
        }
        let mut missing = self
            .missing
            .lock()
            .map_err(|_| ParquetError::General("Parquet missing-range lock is poisoned".into()))?;
        if missing.is_none() {
            *missing = Some(action);
        }
        Err(ParquetError::General(MISSING_BYTES_SENTINEL.into()))
    }

    fn set_missing(&self, action: ParquetReadBytesAction) -> Result<()> {
        *self.missing.lock().map_err(|_| runtime_lock_error())? = Some(action);
        Ok(())
    }

    fn clear_missing(&self) -> Result<()> {
        *self.missing.lock().map_err(|_| runtime_lock_error())? = None;
        Ok(())
    }

    fn take_missing(&self) -> Result<Option<ParquetReadBytesAction>> {
        Ok(self
            .missing
            .lock()
            .map_err(|_| runtime_lock_error())?
            .take())
    }
}

impl Length for SparseChunkReader {
    fn len(&self) -> u64 {
        self.source_length
    }
}

impl ChunkReader for SparseChunkReader {
    type T = Cursor<Bytes>;

    fn get_read(&self, start: u64) -> ParquetResult<Self::T> {
        if start > self.source_length {
            return Err(ParquetError::EOF(
                "Parquet reader start lies beyond the source".into(),
            ));
        }
        let remaining = self.source_length - start;
        let length = usize::try_from(
            remaining.min(u64::try_from(self.read_prefetch_bytes).unwrap_or(u64::MAX)),
        )
        .map_err(|_| ParquetError::General("Parquet read prefetch is too large".into()))?;
        match self.locate_suffix(start, length)? {
            Some(bytes) => Ok(Cursor::new(bytes)),
            None => self.request(start, length).map(Cursor::new),
        }
    }

    fn get_bytes(&self, start: u64, length: usize) -> ParquetResult<Bytes> {
        match self.locate(start, length)? {
            Some(bytes) => Ok(bytes),
            None => self.request(start, length),
        }
    }
}

/// Restartable footer and metadata discovery for one Parquet file.
#[derive(Debug)]
pub struct ParquetOpenOperation {
    options: ParquetOptions,
    limits: ParquetLimits,
    reader: SparseChunkReader,
    expected: Option<ParquetReadBytesAction>,
}

impl ParquetOpenOperation {
    /// Begins a sparse open operation without reading the full source.
    pub fn new(source_length: u64, options: ParquetOptions, limits: ParquetLimits) -> Result<Self> {
        // The runtime owns the aggregate budget.  Standalone operations still
        // validate internal sublimit relationships without inventing a second
        // aggregate ceiling.
        limits.validate_internal()?;
        if source_length < FOOTER_BYTES + HEADER_BYTES {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Parquet source is too short to contain a header and footer",
            ));
        }
        if source_length > limits.max_source_bytes {
            return Err(resource_limit(
                "encoded-source",
                source_length,
                limits.max_source_bytes,
            ));
        }
        let mut operation = Self {
            options,
            reader: SparseChunkReader::new(source_length, limits.read_prefetch_bytes),
            limits,
            expected: None,
        };
        if operation.advance()?.is_some() {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Parquet open completed before any source bytes were supplied",
            ));
        }
        Ok(operation)
    }

    /// Returns the next exact source range needed by this operation.
    #[must_use]
    pub const fn next_action(&self) -> Option<ParquetReadBytesAction> {
        self.expected
    }

    /// Supplies the requested source bytes and advances footer discovery.
    pub fn feed_owned(
        &mut self,
        offset: u64,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<OpenedParquetSource>> {
        let expected = self.expected.take().ok_or_else(|| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet open operation is not waiting for source bytes",
            )
        })?;
        validate_feed(
            expected,
            offset,
            bytes.len(),
            eof,
            self.reader.source_length,
        )?;
        self.reader.insert(expected, bytes)?;
        self.advance()
    }

    fn advance(&mut self) -> Result<Option<OpenedParquetSource>> {
        self.reader.clear_missing()?;
        let footer_offset = self.reader.source_length - HEADER_BYTES;
        let footer = match self
            .reader
            .locate(
                footer_offset,
                usize::try_from(HEADER_BYTES).expect("small constant"),
            )
            .map_err(|error| parquet_error("read Parquet footer magic", error))?
        {
            Some(bytes) => bytes,
            None => {
                return self
                    .set_expected(ParquetReadBytesAction {
                        offset: footer_offset,
                        length: HEADER_BYTES,
                    })
                    .map(|_| None);
            }
        };
        if footer.as_ref() == PARQUET_ENCRYPTED_FOOTER_MAGIC {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "encrypted Parquet files are not supported",
            ));
        }
        if footer.as_ref() != PARQUET_MAGIC {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Parquet footer magic is invalid",
            ));
        }

        let reader_metadata =
            match ArrowReaderMetadata::load(&self.reader, ArrowReaderOptions::default()) {
                Ok(metadata) => metadata,
                Err(error) => return self.resolve_missing_or_error(error).map(|_| None),
            };

        let header = match self
            .reader
            .locate(0, usize::try_from(HEADER_BYTES).expect("small constant"))
            .map_err(|error| parquet_error("read Parquet header magic", error))?
        {
            Some(bytes) => bytes,
            None => {
                return self
                    .set_expected(ParquetReadBytesAction {
                        offset: 0,
                        length: HEADER_BYTES,
                    })
                    .map(|_| None);
            }
        };
        if header.as_ref() != PARQUET_MAGIC {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Parquet header magic is invalid",
            ));
        }

        self.validate_metadata(&reader_metadata)?;
        let rows =
            u64::try_from(reader_metadata.metadata().file_metadata().num_rows()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Parquet footer contains a negative row count",
                )
            })?;
        let metadata = exact_metadata(
            reader_metadata.schema(),
            rows,
            self.options.source_name.clone(),
        )?;
        Ok(Some(OpenedParquetSource {
            source_length: self.reader.source_length,
            options: self.options.clone(),
            limits: self.limits.clone(),
            reader_metadata,
            reader: self.reader.clone(),
            metadata,
        }))
    }

    fn validate_metadata(&self, metadata: &ArrowReaderMetadata) -> Result<()> {
        let parquet = metadata.metadata();
        let metadata_bytes = parquet.memory_size();
        if metadata_bytes > self.limits.max_metadata_bytes {
            return Err(resource_limit(
                "parquet-metadata",
                u64::try_from(metadata_bytes).unwrap_or(u64::MAX),
                u64::try_from(self.limits.max_metadata_bytes).unwrap_or(u64::MAX),
            ));
        }
        if parquet.num_row_groups() > self.limits.max_row_groups {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet file contains too many row groups",
            )
            .with_detail("resource", "row-groups")
            .with_detail("required", parquet.num_row_groups())
            .with_detail("available", self.limits.max_row_groups));
        }
        let columns = metadata.schema().fields().len();
        if columns > self.limits.max_columns {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet file contains too many top-level columns",
            )
            .with_detail("resource", "columns")
            .with_detail("required", columns)
            .with_detail("available", self.limits.max_columns));
        }
        let rows = u64::try_from(parquet.file_metadata().num_rows()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Parquet footer contains a negative row count",
            )
        })?;
        if rows > self.limits.max_rows {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet file contains too many rows",
            )
            .with_detail("resource", "rows")
            .with_detail("required", rows)
            .with_detail("available", self.limits.max_rows));
        }
        let retained = self.reader.retained_bytes()?;
        let open_limit = self
            .limits
            .max_metadata_bytes
            .saturating_add(usize::try_from(FOOTER_BYTES + HEADER_BYTES).expect("small constants"));
        if retained > open_limit {
            return Err(resource_limit(
                "metadata-staging",
                u64::try_from(retained).unwrap_or(u64::MAX),
                u64::try_from(open_limit).unwrap_or(u64::MAX),
            ));
        }
        // Variant and Geo annotations are well-formed Parquet, but their
        // semantics are outside the 0.1 contract. Reject them before any
        // physical BYTE_ARRAY payload can be mistaken for generic binary.
        for column in parquet.file_metadata().schema_descr().columns() {
            if matches!(
                column.logical_type_ref(),
                Some(
                    LogicalType::Variant(_) | LogicalType::Geometry(_) | LogicalType::Geography(_)
                )
            ) {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "Parquet Variant and geospatial logical types are not supported",
                )
                .with_detail("column", column.name()));
            }
        }
        // LZO is intentionally absent from the promised codec set.
        // Surface that policy during open instead of deferring to a decoder
        // implementation error on the first range read.
        for row_group in parquet.row_groups() {
            for column in row_group.columns() {
                if column.compression() == Compression::LZO {
                    return Err(TabularkError::new(
                        ErrorCode::UnsupportedFeature,
                        "LZO-compressed Parquet files are not supported",
                    ));
                }
            }
        }
        Ok(())
    }

    fn resolve_missing_or_error(&mut self, error: ParquetError) -> Result<()> {
        if let Some(action) = self.reader.take_missing()? {
            self.set_expected(action)
        } else {
            Err(parquet_error("open Parquet metadata", error))
        }
    }

    fn set_expected(&mut self, action: ParquetReadBytesAction) -> Result<()> {
        ensure_action_budget(
            &self.reader,
            action,
            self.limits.max_metadata_bytes.saturating_add(
                usize::try_from(FOOTER_BYTES + HEADER_BYTES).expect("small constants"),
            ),
            "metadata-staging",
        )?;
        self.reader.set_missing(action)?;
        self.expected = Some(action);
        Ok(())
    }
}

/// A validated Parquet file retaining only footer metadata source ranges.
#[derive(Clone, Debug)]
pub struct OpenedParquetSource {
    source_length: u64,
    options: ParquetOptions,
    limits: ParquetLimits,
    reader_metadata: ArrowReaderMetadata,
    reader: SparseChunkReader,
    metadata: TableMetadata,
}

impl OpenedParquetSource {
    /// Returns exact metadata for the file's single logical table.
    #[must_use]
    pub const fn metadata(&self) -> &TableMetadata {
        &self.metadata
    }

    /// Returns the encoded source length without narrowing offsets to `usize`.
    #[must_use]
    pub const fn source_length(&self) -> u64 {
        self.source_length
    }

    /// Returns encoded footer ranges plus decoded footer metadata retained by the source.
    pub fn retained_bytes(&self) -> Result<usize> {
        self.reader
            .retained_bytes()?
            .checked_add(self.reader_metadata.metadata().memory_size())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet retained metadata reservation overflows",
                )
            })
    }

    /// Starts a projected range read that preplans, sorts, and coalesces the
    /// intersecting row-group/column-chunk ranges from the footer index.
    pub fn begin_read(&self, request: RangeRequest) -> Result<ParquetReadStart> {
        let plan = plan_range(
            request,
            self.metadata
                .extent()
                .rows()
                .value()
                .expect("Parquet metadata rows are exact"),
            self.metadata
                .extent()
                .columns()
                .value()
                .expect("Parquet metadata columns are exact"),
            self.limits.arrow.max_range_cells,
        )?;
        if plan.returned_range.column_count() == 0 {
            return Ok(ParquetReadStart::Complete(TypedTableBatch::new(
                "table-0",
                0,
                1,
                plan.returned_range,
                plan.complete,
                Vec::new(),
                Vec::new(),
            )?));
        }
        let source_columns = projected_source_columns(&plan)?;
        let projection = ProjectionMask::roots(
            self.reader_metadata.parquet_schema(),
            source_columns.iter().copied(),
        );
        let projected = plan_projected_ranges(
            &self.reader_metadata,
            &self.reader,
            &plan,
            &projection,
            &self.limits,
        )?;
        let mut operation = ParquetReadOperation {
            options: self.options.clone(),
            limits: self.limits.clone(),
            reader_metadata: self.reader_metadata.clone(),
            reader: self.reader.fork()?,
            plan,
            source_columns,
            projection,
            row_groups: projected.row_groups,
            row_offset: projected.row_offset,
            planned_ranges: projected.ranges.into(),
            expected: None,
            decode_attempts: 0,
        };
        match operation.advance()? {
            Some(batch) => Ok(ParquetReadStart::Complete(batch)),
            None => Ok(ParquetReadStart::Pending(Box::new(operation))),
        }
    }
}

/// Initial state of a Parquet range read.
#[derive(Debug)]
pub enum ParquetReadStart {
    /// The requested range required no additional source bytes.
    Complete(TypedTableBatch),
    /// The range read needs one or more source actions.
    Pending(Box<ParquetReadOperation>),
}

/// Restartable projected Parquet range decoder.
#[derive(Debug)]
pub struct ParquetReadOperation {
    options: ParquetOptions,
    limits: ParquetLimits,
    reader_metadata: ArrowReaderMetadata,
    reader: SparseChunkReader,
    plan: RangePlan,
    source_columns: Vec<usize>,
    projection: ProjectionMask,
    row_groups: Vec<usize>,
    row_offset: usize,
    planned_ranges: VecDeque<ParquetReadBytesAction>,
    expected: Option<ParquetReadBytesAction>,
    decode_attempts: usize,
}

impl ParquetReadOperation {
    /// Returns the next exact source range needed by parquet-rs.
    #[must_use]
    pub const fn next_action(&self) -> Option<ParquetReadBytesAction> {
        self.expected
    }

    /// Returns a bounded prefix of the preplanned compressed-page ranges.
    pub fn next_actions(
        &self,
        max_ranges: usize,
        max_bytes: u64,
    ) -> Result<Vec<ParquetReadBytesAction>> {
        if max_ranges == 0 || max_bytes == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet read action batch limits must be greater than zero",
            ));
        }
        let Some(first) = self.expected else {
            return Ok(Vec::new());
        };
        let mut actions =
            Vec::with_capacity(max_ranges.min(self.planned_ranges.len().saturating_add(1)));
        let mut total = 0_u64;
        for action in std::iter::once(&first)
            .chain(self.planned_ranges.iter())
            .take(max_ranges)
        {
            let next_total = total.checked_add(action.length).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet read action batch byte total overflows",
                )
            })?;
            if next_total > max_bytes {
                break;
            }
            total = next_total;
            actions.push(*action);
        }
        if actions.is_empty() {
            return Err(resource_limit("compressed-pages", first.length, max_bytes));
        }
        Ok(actions)
    }

    /// Supplies one preplanned source range. Decoding starts only after every
    /// projected column-chunk range has arrived.
    pub fn feed_owned(
        &mut self,
        offset: u64,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<TypedTableBatch>> {
        self.feed_many_owned(vec![(offset, bytes, eof)])
    }

    /// Supplies one complete batch of preplanned compressed-page ranges.
    /// Every result is validated before any range is inserted.
    pub fn feed_many_owned(
        &mut self,
        results: Vec<(u64, Vec<u8>, bool)>,
    ) -> Result<Option<TypedTableBatch>> {
        if results.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet read operation result set must not be empty",
            ));
        }
        let expected = self.next_actions(results.len(), u64::MAX)?;
        if expected.len() != results.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet read result set has an unexpected range count",
            )
            .with_detail("expectedResults", expected.len())
            .with_detail("actualResults", results.len()));
        }
        for (action, (offset, bytes, eof)) in expected.iter().copied().zip(&results) {
            validate_feed(
                action,
                *offset,
                bytes.len(),
                *eof,
                self.reader.source_length,
            )?;
        }
        self.expected.take().ok_or_else(|| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet read operation is not waiting for source bytes",
            )
        })?;
        for (index, (action, (_, bytes, _))) in expected.into_iter().zip(results).enumerate() {
            if index > 0 {
                let planned = self.planned_ranges.pop_front().ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Parquet preplanned range queue is inconsistent",
                    )
                })?;
                if planned != action {
                    return Err(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Parquet preplanned range order changed",
                    ));
                }
            }
            self.reader.insert(action, bytes)?;
        }
        self.advance()
    }

    fn advance(&mut self) -> Result<Option<TypedTableBatch>> {
        if let Some(action) = self.planned_ranges.pop_front() {
            self.expected = Some(action);
            return Ok(None);
        }
        self.decode_attempts = self.decode_attempts.checked_add(1).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet decode-attempt accounting overflows",
            )
        })?;
        self.reader.clear_missing()?;
        let row_count =
            usize::try_from(self.plan.returned_range.row_count()).map_err(|_| invalid_range())?;
        let builder = ParquetRecordBatchReaderBuilder::new_with_metadata(
            self.reader.clone(),
            self.reader_metadata.clone(),
        )
        .with_projection(self.projection.clone())
        .with_row_groups(self.row_groups.clone())
        .with_offset(self.row_offset)
        .with_limit(row_count)
        .with_batch_size(self.limits.max_batch_rows.min(row_count.max(1)));
        let reader = match builder.build() {
            Ok(reader) => reader,
            Err(error) => return self.resolve_missing_or_error(error).map(|_| None),
        };
        let mut decoded_bytes = 0_usize;
        let mut batches = Vec::new();
        for batch in reader {
            let batch = match batch {
                Ok(batch) => batch,
                Err(error) => return self.resolve_missing_or_error(error.into()).map(|_| None),
            };
            decoded_bytes = decoded_bytes
                .checked_add(batch.get_array_memory_size())
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Parquet decoded array accounting overflows",
                    )
                })?;
            if decoded_bytes > self.limits.arrow.max_decoded_bytes {
                return Err(resource_limit(
                    "decompressed-pages",
                    u64::try_from(decoded_bytes).unwrap_or(u64::MAX),
                    u64::try_from(self.limits.arrow.max_decoded_bytes).unwrap_or(u64::MAX),
                ));
            }
            batches.push(batch);
        }
        let batch = encode_projected_record_batches(
            self.reader_metadata.schema(),
            &batches,
            &self.source_columns,
            self.plan.returned_range,
            self.plan.complete,
            &self.limits.arrow,
        )?;
        Ok(Some(batch))
    }

    fn resolve_missing_or_error(&mut self, error: ParquetError) -> Result<()> {
        if let Some(action) = self.reader.take_missing()? {
            Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Parquet preplanned column ranges did not cover a decoder request",
            )
            .with_detail("offset", action.offset)
            .with_detail("length", action.length)
            .with_detail("reason", error.to_string()))
        } else {
            Err(parquet_error(
                &format!("read Parquet range from {}", self.options.source_name),
                error,
            ))
        }
    }
}

fn projected_source_columns(plan: &RangePlan) -> Result<Vec<usize>> {
    let column_start =
        usize::try_from(plan.returned_range.column_start()).map_err(|_| invalid_range())?;
    let column_count =
        usize::try_from(plan.returned_range.column_count()).map_err(|_| invalid_range())?;
    let column_end = column_start
        .checked_add(column_count)
        .ok_or_else(invalid_range)?;
    Ok((column_start..column_end).collect())
}

/// Plans the complete compressed ingress set before parquet-rs constructs a
/// reader. Column chunks are the physical containers for dictionary and data
/// pages; coalescing their byte ranges prevents repeated reader construction
/// while keeping unrelated row groups and columns outside the operation.
struct ProjectedReadPlan {
    ranges: Vec<ParquetReadBytesAction>,
    row_groups: Vec<usize>,
    row_offset: usize,
}

fn plan_projected_ranges(
    reader_metadata: &ArrowReaderMetadata,
    reader: &SparseChunkReader,
    plan: &RangePlan,
    projection: &ProjectionMask,
    limits: &ParquetLimits,
) -> Result<ProjectedReadPlan> {
    let request_start = plan.returned_range.row_start();
    let request_end = request_start
        .checked_add(plan.returned_range.row_count())
        .ok_or_else(invalid_range)?;
    let mut row_offset = 0_u64;
    let mut uncompressed_bytes = 0_u64;
    let mut ranges = Vec::new();
    let mut row_groups = Vec::new();
    let mut selected_row_offset = 0_usize;
    for (row_group_index, row_group) in reader_metadata.metadata().row_groups().iter().enumerate() {
        let rows = u64::try_from(row_group.num_rows()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Parquet row group contains a negative row count",
            )
        })?;
        let row_end = row_offset.checked_add(rows).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet row-group offsets overflow",
            )
        })?;
        if row_offset < request_end && row_end > request_start {
            if row_groups.is_empty() {
                selected_row_offset =
                    usize::try_from(request_start - row_offset).map_err(|_| invalid_range())?;
            }
            row_groups.push(row_group_index);
            for (leaf_index, column) in row_group.columns().iter().enumerate() {
                if !projection.leaf_included(leaf_index) {
                    continue;
                }
                let uncompressed = u64::try_from(column.uncompressed_size()).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ParseFailed,
                        "Parquet column chunk has a negative uncompressed size",
                    )
                })?;
                uncompressed_bytes =
                    uncompressed_bytes
                        .checked_add(uncompressed)
                        .ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Parquet decompressed-page reservation overflows",
                            )
                        })?;
                let (offset, length) = column.byte_range();
                let action = ParquetReadBytesAction { offset, length };
                if action.end()? > reader.source_length {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "Parquet column-chunk range exceeds the encoded source",
                    )
                    .with_detail("offset", offset)
                    .with_detail("length", length)
                    .with_detail("sourceLength", reader.source_length));
                }
                if length > 0 {
                    ranges.push(action);
                }
            }
        }
        row_offset = row_end;
        if row_offset >= request_end {
            break;
        }
    }

    let decoded_limit = u64::try_from(limits.arrow.max_decoded_bytes).unwrap_or(u64::MAX);
    if uncompressed_bytes > decoded_limit {
        return Err(resource_limit(
            "decompressed-pages",
            uncompressed_bytes,
            decoded_limit,
        ));
    }

    let ranges = coalesce_source_ranges(ranges)?;
    let compressed_bytes = ranges.iter().try_fold(0_u64, |total, action| {
        total.checked_add(action.length).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet compressed-page reservation overflows",
            )
        })
    })?;
    let compressed_limit = u64::try_from(limits.max_operation_bytes).unwrap_or(u64::MAX);
    if compressed_bytes > compressed_limit {
        return Err(resource_limit(
            "compressed-pages",
            compressed_bytes,
            compressed_limit,
        ));
    }
    Ok(ProjectedReadPlan {
        ranges,
        row_groups,
        row_offset: selected_row_offset,
    })
}

fn coalesce_source_ranges(
    mut ranges: Vec<ParquetReadBytesAction>,
) -> Result<Vec<ParquetReadBytesAction>> {
    ranges.sort_unstable_by_key(|action| action.offset);
    let mut merged: Vec<ParquetReadBytesAction> = Vec::with_capacity(ranges.len());
    for action in ranges {
        let action_end = action.end()?;
        let Some(previous) = merged.last_mut() else {
            merged.push(action);
            continue;
        };
        let previous_end = previous.end()?;
        if action.offset <= previous_end {
            let merged_end = previous_end.max(action_end);
            previous.length = merged_end.checked_sub(previous.offset).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet merged source range underflows",
                )
            })?;
        } else {
            merged.push(action);
        }
    }
    Ok(merged)
}

#[derive(Clone, Copy, Debug)]
struct RangePlan {
    returned_range: RangeRequest,
    complete: bool,
}

fn plan_range(
    request: RangeRequest,
    total_rows: u64,
    total_columns: u64,
    max_range_cells: u64,
) -> Result<RangePlan> {
    request.validate_public()?;
    let cells = request
        .row_count()
        .checked_mul(request.column_count())
        .ok_or_else(invalid_range)?;
    if cells > max_range_cells {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Parquet range exceeds the configured logical cell limit",
        )
        .with_detail("resource", "range-cells")
        .with_detail("required", cells)
        .with_detail("available", max_range_cells));
    }
    if request.row_start() > total_rows || request.column_start() > total_columns {
        return Err(invalid_range());
    }
    let rows = request
        .row_count()
        .min(total_rows.saturating_sub(request.row_start()));
    let columns = request
        .column_count()
        .min(total_columns.saturating_sub(request.column_start()));
    Ok(RangePlan {
        returned_range: RangeRequest::new(
            request.row_start(),
            rows,
            request.column_start(),
            columns,
        )?,
        complete: rows == request.row_count() && columns == request.column_count(),
    })
}

/// Configuration for the native Parquet source and table registry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ParquetRuntimeConfig {
    /// Aggregate retained metadata budget across open sources.
    pub memory_budget_bytes: usize,
    /// Maximum concurrently open Parquet sources.
    pub max_sources: usize,
}

impl Default for ParquetRuntimeConfig {
    fn default() -> Self {
        Self {
            memory_budget_bytes: 256 * 1024 * 1024,
            max_sources: 8,
        }
    }
}

/// Opaque native Parquet source handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ParquetSourceHandle(u32);

impl ParquetSourceHandle {
    /// Creates a handle from a WASM-boundary integer.
    #[must_use]
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }

    /// Returns the WASM-boundary integer.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Opaque native Parquet table handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ParquetTableHandle(u32);

impl ParquetTableHandle {
    /// Creates a handle from a WASM-boundary integer.
    #[must_use]
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }

    /// Returns the WASM-boundary integer.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Native lifecycle registry shared by tests and the Parquet WASM wrapper.
#[derive(Debug)]
pub struct ParquetRuntime {
    config: ParquetRuntimeConfig,
    next_handle: u32,
    retained_bytes: usize,
    sources: HashMap<ParquetSourceHandle, OpenedParquetSource>,
    tables: HashMap<ParquetTableHandle, ParquetSourceHandle>,
}

impl ParquetRuntime {
    /// Creates an empty Parquet runtime.
    pub fn new(config: ParquetRuntimeConfig) -> Result<Self> {
        if config.memory_budget_bytes == 0 || config.max_sources == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet runtime resource limits must be greater than zero",
            ));
        }
        Ok(Self {
            config,
            next_handle: 1,
            retained_bytes: 0,
            sources: HashMap::new(),
            tables: HashMap::new(),
        })
    }

    /// Registers a source completed by [`ParquetOpenOperation`].
    pub fn open_source(&mut self, source: OpenedParquetSource) -> Result<ParquetSourceHandle> {
        if self.sources.len() >= self.config.max_sources {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet runtime has reached its open-source limit",
            )
            .with_detail("maxSources", self.config.max_sources));
        }
        source
            .limits
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        let source_bytes = source.retained_bytes()?;
        let retained_bytes = self
            .retained_bytes
            .checked_add(source_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet runtime metadata accounting overflows",
                )
            })?;
        if retained_bytes > self.config.memory_budget_bytes {
            return Err(resource_limit(
                "parquet-metadata",
                u64::try_from(retained_bytes).unwrap_or(u64::MAX),
                u64::try_from(self.config.memory_budget_bytes).unwrap_or(u64::MAX),
            ));
        }
        let handle = ParquetSourceHandle(self.allocate_handle()?);
        self.sources.insert(handle, source);
        self.retained_bytes = retained_bytes;
        Ok(handle)
    }

    /// Returns source metadata before a table handle exists.
    pub fn source_metadata(&self, source: ParquetSourceHandle) -> Result<&TableMetadata> {
        self.sources
            .get(&source)
            .map(OpenedParquetSource::metadata)
            .ok_or_else(|| closed_handle("source"))
    }

    /// Opens the file's sole logical table (`table-0`).
    pub fn open_table(
        &mut self,
        source: ParquetSourceHandle,
        table_id: &str,
    ) -> Result<ParquetTableHandle> {
        if table_id != "table-0" {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet source exposes only table-0",
            ));
        }
        if !self.sources.contains_key(&source) {
            return Err(closed_handle("source"));
        }
        let handle = ParquetTableHandle(self.allocate_handle()?);
        self.tables.insert(handle, source);
        Ok(handle)
    }

    /// Returns exact metadata for an open table.
    pub fn metadata(&self, table: ParquetTableHandle) -> Result<&TableMetadata> {
        Ok(self.source_for_table(table)?.metadata())
    }

    /// Starts a sparse projected range read.
    pub fn begin_read(
        &self,
        table: ParquetTableHandle,
        request: RangeRequest,
    ) -> Result<ParquetReadStart> {
        self.source_for_table(table)?.begin_read(request)
    }

    /// Idempotently closes one table handle.
    pub fn close_table(&mut self, table: ParquetTableHandle) -> bool {
        self.tables.remove(&table).is_some()
    }

    /// Idempotently closes a source and every child table.
    pub fn close_source(&mut self, source: ParquetSourceHandle) -> bool {
        let Some(source_value) = self.sources.remove(&source) else {
            return false;
        };
        self.retained_bytes = self
            .retained_bytes
            .saturating_sub(source_value.retained_bytes().unwrap_or(0));
        self.tables.retain(|_, owner| *owner != source);
        true
    }

    /// Releases every source and table handle.
    pub fn shutdown(&mut self) {
        self.tables.clear();
        self.sources.clear();
        self.retained_bytes = 0;
    }

    /// Returns the number of open sources.
    #[must_use]
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Returns the number of open tables.
    #[must_use]
    pub fn table_count(&self) -> usize {
        self.tables.len()
    }

    /// Returns retained footer-metadata bytes.
    #[must_use]
    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    fn source_for_table(&self, table: ParquetTableHandle) -> Result<&OpenedParquetSource> {
        let source = self
            .tables
            .get(&table)
            .ok_or_else(|| closed_handle("table"))?;
        self.sources
            .get(source)
            .ok_or_else(|| closed_handle("source"))
    }

    fn allocate_handle(&mut self) -> Result<u32> {
        let handle = self.next_handle;
        self.next_handle = self.next_handle.checked_add(1).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet runtime handle space exhausted",
            )
        })?;
        Ok(handle)
    }
}

impl Default for ParquetRuntime {
    fn default() -> Self {
        Self::new(ParquetRuntimeConfig::default()).expect("default Parquet runtime config is valid")
    }
}

fn ensure_action_budget(
    reader: &SparseChunkReader,
    action: ParquetReadBytesAction,
    limit: usize,
    category: &'static str,
) -> Result<()> {
    let requested = usize::try_from(action.length).map_err(|_| {
        resource_limit(
            category,
            action.length,
            u64::try_from(limit).unwrap_or(u64::MAX),
        )
    })?;
    let required = reader
        .retained_bytes()?
        .checked_add(requested)
        .ok_or_else(|| {
            resource_limit(category, u64::MAX, u64::try_from(limit).unwrap_or(u64::MAX))
        })?;
    if required > limit {
        return Err(resource_limit(
            category,
            u64::try_from(required).unwrap_or(u64::MAX),
            u64::try_from(limit).unwrap_or(u64::MAX),
        ));
    }
    Ok(())
}

fn validate_feed(
    expected: ParquetReadBytesAction,
    offset: u64,
    actual_length: usize,
    eof: bool,
    source_length: u64,
) -> Result<()> {
    let actual_length = u64::try_from(actual_length).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Parquet ingress byte length exceeds u64",
        )
    })?;
    let expected_eof = expected.end()? == source_length;
    if offset != expected.offset || actual_length != expected.length || eof != expected_eof {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "Parquet ingress bytes do not match the requested source action",
        )
        .with_detail("expectedOffset", expected.offset)
        .with_detail("expectedLength", expected.length)
        .with_detail("expectedEof", expected_eof));
    }
    Ok(())
}

fn parquet_error(context: &str, error: ParquetError) -> TabularkError {
    let reason = error.to_string();
    if let Some(error) = zstd_decompression_limit_error(&reason) {
        return error;
    }
    let normalized = reason.to_ascii_lowercase();
    let unsupported = [
        "lzo",
        "encrypt",
        "variant",
        "geometry",
        "geography",
        "geospatial",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    TabularkError::new(
        if unsupported {
            ErrorCode::UnsupportedFeature
        } else {
            ErrorCode::ParseFailed
        },
        format!("failed to {context}"),
    )
    .with_detail("reason", reason)
}

fn resource_limit(category: &'static str, required: u64, available: u64) -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        format!("Parquet {category} exceeds the configured resource limit"),
    )
    .with_detail("resource", category)
    .with_detail("requiredBytes", required)
    .with_detail("availableBytes", available)
}

fn runtime_lock_error() -> TabularkError {
    TabularkError::new(
        ErrorCode::RuntimeFailure,
        "Parquet sparse source lock is poisoned",
    )
}

fn invalid_range() -> TabularkError {
    TabularkError::new(
        ErrorCode::InvalidRange,
        "requested Parquet range is outside the table extent",
    )
}

fn closed_handle(kind: &str) -> TabularkError {
    TabularkError::new(
        ErrorCode::HandleClosed,
        format!("Parquet {kind} handle is closed"),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use ::parquet::arrow::ArrowWriter;
    use ::parquet::basic::Compression;
    use ::parquet::data_type::{Int96, Int96Type};
    use ::parquet::errors::ParquetError;
    use ::parquet::file::properties::WriterProperties;
    use ::parquet::file::writer::SerializedFileWriter;
    use ::parquet::schema::parser::parse_message_type;
    use arrow_array::types::Int32Type;
    use arrow_array::{Decimal128Array, Int32Array, ListArray, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};

    use super::{
        OpenedParquetSource, ParquetLimits, ParquetOpenOperation, ParquetOptions,
        ParquetReadBytesAction, ParquetReadStart, SparseChunkReader, coalesce_source_ranges,
        parquet_error,
    };
    use crate::error::ErrorCode;
    use crate::model::{ArrayLayout, RangeRequest, TableDataType, TimeUnit, TypedTableBatch};

    #[test]
    fn maps_wrapped_zstd_capacity_errors_before_generic_parquet_classification() {
        let error = parquet_error(
            "decode Parquet pages",
            ParquetError::General(
                "zstd resource limit: output required 8192 available 4096".into(),
            ),
        );
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decompression");
        assert_eq!(error.details()["requiredBytes"], 8192);
        assert_eq!(error.details()["availableBytes"], 4096);

        let malformed = parquet_error(
            "decode Parquet pages",
            ParquetError::General("zstd content checksum mismatch".into()),
        );
        assert_eq!(malformed.code(), ErrorCode::ParseFailed);
    }

    fn cache_segment(reader: &SparseChunkReader, offset: u64, bytes: &[u8]) {
        reader
            .insert(
                ParquetReadBytesAction {
                    offset,
                    length: u64::try_from(bytes.len()).expect("segment length"),
                },
                bytes.to_vec(),
            )
            .expect("cache source segment");
    }

    #[test]
    fn sparse_reader_sorts_and_coalesces_adjacent_and_overlapping_segments() {
        let reader = SparseChunkReader::new(32, 8);
        cache_segment(&reader, 8, &[8, 9]);
        cache_segment(&reader, 0, &[0, 1]);

        {
            let segments = reader.segments.lock().expect("segments");
            assert_eq!(
                segments
                    .iter()
                    .map(|segment| segment.offset)
                    .collect::<Vec<_>>(),
                vec![0, 8]
            );
        }

        cache_segment(&reader, 2, &[2, 3, 4]);
        cache_segment(&reader, 4, &[4, 5, 6, 7, 8]);

        let segments = reader.segments.lock().expect("segments");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].offset, 0);
        assert_eq!(segments[0].bytes.as_ref(), &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        drop(segments);
        assert_eq!(reader.retained_bytes().expect("retained bytes"), 10);
        assert_eq!(
            reader
                .locate(1, 8)
                .expect("locate merged range")
                .expect("merged range is cached")
                .as_ref(),
            &[1, 2, 3, 4, 5, 6, 7, 8]
        );
    }

    #[test]
    fn sparse_reader_binary_lookup_handles_gaps_and_latest_overlap() {
        let reader = SparseChunkReader::new(40, 8);
        cache_segment(&reader, 20, &[20, 21, 22, 23]);
        cache_segment(&reader, 4, &[4, 5, 6, 7]);
        cache_segment(&reader, 12, &[12, 13, 14, 15]);

        assert_eq!(
            reader
                .segments
                .lock()
                .expect("segments")
                .iter()
                .map(|segment| segment.offset)
                .collect::<Vec<_>>(),
            vec![4, 12, 20]
        );
        assert!(
            reader
                .locate(11, 1)
                .expect("lookup before segment")
                .is_none()
        );
        assert!(
            reader
                .locate(16, 1)
                .expect("lookup after segment")
                .is_none()
        );
        assert_eq!(
            reader
                .locate(20, 4)
                .expect("lookup final segment")
                .expect("final segment is cached")
                .as_ref(),
            &[20, 21, 22, 23]
        );

        cache_segment(&reader, 13, &[113, 114]);
        assert_eq!(reader.retained_bytes().expect("retained bytes"), 12);
        assert_eq!(
            reader
                .locate(12, 4)
                .expect("lookup overwritten segment")
                .expect("overwritten segment is cached")
                .as_ref(),
            &[12, 113, 114, 15]
        );
    }

    #[test]
    fn projected_source_ranges_sort_and_coalesce_without_filling_gaps() {
        let merged = coalesce_source_ranges(vec![
            ParquetReadBytesAction {
                offset: 20,
                length: 5,
            },
            ParquetReadBytesAction {
                offset: 4,
                length: 6,
            },
            ParquetReadBytesAction {
                offset: 0,
                length: 4,
            },
            ParquetReadBytesAction {
                offset: 8,
                length: 6,
            },
        ])
        .expect("coalesced ranges");
        assert_eq!(
            merged,
            vec![
                ParquetReadBytesAction {
                    offset: 0,
                    length: 14,
                },
                ParquetReadBytesAction {
                    offset: 20,
                    length: 5,
                },
            ]
        );
    }

    fn fixture(compression: Compression) -> Vec<u8> {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2, 3, 4, 5, 6])),
                Arc::new(StringArray::from(vec![
                    Some("a"),
                    Some("b"),
                    None,
                    Some("d"),
                    Some("e"),
                    Some("f"),
                ])),
            ],
        )
        .expect("fixture batch");
        let properties = WriterProperties::builder()
            .set_compression(compression)
            .set_max_row_group_row_count(Some(2))
            .build();
        let mut bytes = Vec::new();
        let mut writer =
            ArrowWriter::try_new(&mut bytes, schema, Some(properties)).expect("fixture writer");
        writer.write(&batch).expect("write fixture");
        writer.close().expect("close fixture");
        bytes
    }

    fn open(bytes: &[u8], limits: ParquetLimits) -> (OpenedParquetSource, usize) {
        let mut operation = ParquetOpenOperation::new(
            u64::try_from(bytes.len()).expect("fixture length"),
            ParquetOptions {
                source_name: "fixture.parquet".into(),
            },
            limits,
        )
        .expect("start open");
        let mut requested = 0_usize;
        loop {
            let action = operation.next_action().expect("open action");
            assert!(
                action.length < u64::try_from(bytes.len()).expect("fixture length"),
                "open must not stage the whole file"
            );
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            requested += length;
            let completed = operation
                .feed_owned(
                    action.offset,
                    bytes[start..start + length].to_vec(),
                    start + length == bytes.len(),
                )
                .expect("advance open");
            if let Some(source) = completed {
                return (source, requested);
            }
        }
    }

    fn read(source: &OpenedParquetSource, bytes: &[u8], request: RangeRequest) -> TypedTableBatch {
        let mut operation = match source.begin_read(request).expect("begin read") {
            ParquetReadStart::Pending(operation) => operation,
            ParquetReadStart::Complete(batch) => return batch,
        };
        loop {
            let action = operation.next_action().expect("read action");
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            let result = operation
                .feed_owned(
                    action.offset,
                    bytes[start..start + length].to_vec(),
                    start + length == bytes.len(),
                )
                .expect("advance read");
            if let Some(batch) = result {
                return batch;
            }
        }
    }

    fn int96_fixture(nanos_since_epoch: u64) -> Vec<u8> {
        let schema = Arc::new(
            parse_message_type("message schema { REQUIRED INT96 ts; }").expect("INT96 schema"),
        );
        let properties = Arc::new(
            WriterProperties::builder()
                .set_compression(Compression::UNCOMPRESSED)
                .build(),
        );
        let mut bytes = Vec::new();
        {
            let mut writer =
                SerializedFileWriter::new(&mut bytes, schema, properties).expect("INT96 writer");
            let mut row_group = writer.next_row_group().expect("INT96 row group");
            let mut column = row_group
                .next_column()
                .expect("INT96 column")
                .expect("INT96 column exists");
            let value = Int96::from(vec![
                nanos_since_epoch as u32,
                (nanos_since_epoch >> 32) as u32,
                2_440_588,
            ]);
            column
                .typed::<Int96Type>()
                .write_batch(&[value], None, None)
                .expect("write INT96 value");
            column.close().expect("close INT96 column");
            row_group.close().expect("close INT96 row group");
            writer.close().expect("close INT96 writer");
        }
        bytes
    }

    fn nested_logical_fixture() -> Vec<u8> {
        let list = ListArray::from_iter_primitive::<Int32Type, _, _>([
            Some(vec![Some(1), Some(2)]),
            None,
            Some(vec![Some(3)]),
        ]);
        let decimal = Decimal128Array::from(vec![Some(1_234_i128), None, Some(-500_i128)])
            .with_precision_and_scale(10, 2)
            .expect("decimal metadata");
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "items",
                DataType::List(Arc::new(Field::new("item", DataType::Int32, true))),
                true,
            ),
            Field::new("amount", DataType::Decimal128(10, 2), true),
        ]));
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(list), Arc::new(decimal)])
            .expect("nested/logical batch");
        let mut bytes = Vec::new();
        let mut writer = ArrowWriter::try_new(
            &mut bytes,
            schema,
            Some(
                WriterProperties::builder()
                    .set_compression(Compression::ZSTD(Default::default()))
                    .build(),
            ),
        )
        .expect("nested/logical writer");
        writer.write(&batch).expect("write nested/logical batch");
        writer.close().expect("close nested/logical writer");
        bytes
    }

    #[test]
    fn opens_footer_first_and_reads_only_projected_rows_and_columns() {
        let bytes = fixture(Compression::SNAPPY);
        let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        let (source, open_bytes) = open(&bytes, limits);
        assert!(open_bytes < bytes.len());
        assert_eq!(source.metadata().extent().rows().value(), Some(6));
        assert_eq!(source.metadata().extent().columns().value(), Some(2));

        let request = RangeRequest::new(2, 3, 1, 1).expect("range");
        let mut operation = match source.begin_read(request).expect("begin read") {
            ParquetReadStart::Pending(operation) => operation,
            ParquetReadStart::Complete(_) => panic!("data range should need column bytes"),
        };
        let mut planned_actions = Vec::new();
        let mut operation_steps = 0_usize;
        let batch = loop {
            let actions = operation.next_actions(32, u64::MAX).expect("read actions");
            operation_steps += 1;
            planned_actions.extend(actions.iter().copied());
            let ingress = actions
                .into_iter()
                .map(|action| {
                    let start = usize::try_from(action.offset).expect("offset");
                    let length = usize::try_from(action.length).expect("length");
                    (
                        action.offset,
                        bytes[start..start + length].to_vec(),
                        start + length == bytes.len(),
                    )
                })
                .collect();
            let result = operation.feed_many_owned(ingress).expect("advance read");
            if let Some(batch) = result {
                break batch;
            }
        };
        assert_eq!(
            operation.decode_attempts, 1,
            "all planned column chunks must arrive before the sole decoder construction: {planned_actions:?}"
        );
        assert_eq!(operation_steps, 1, "planned ranges must share one ABI step");
        assert!(planned_actions.len() > 1);
        assert!(
            planned_actions.windows(2).all(|actions| {
                actions[0].end().expect("planned action end") < actions[1].offset
            })
        );
        assert_eq!(batch.range(), request);
        assert_eq!(batch.columns().len(), 1);
        assert_eq!(batch.columns()[0].column_id(), "c1");
        assert_eq!(
            batch.columns()[0].native().data_type(),
            &TableDataType::Utf8
        );
        assert!(matches!(
            batch.columns()[0].native().layout(),
            ArrayLayout::VariableWidth { .. }
        ));
    }

    #[test]
    fn zero_row_projection_completes_without_page_ingress() {
        let bytes = fixture(Compression::SNAPPY);
        let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        let (source, _) = open(&bytes, limits);
        let request = RangeRequest::new(6, 0, 0, 2).expect("zero-row range");
        let batch = match source.begin_read(request).expect("zero-row read") {
            ParquetReadStart::Complete(batch) => batch,
            ParquetReadStart::Pending(_) => panic!("zero rows must not request column pages"),
        };
        assert_eq!(batch.range(), request);
        assert_eq!(batch.columns().len(), 2);
    }

    #[test]
    fn supports_every_promised_codec_enabled_in_the_pinned_dependency() {
        for compression in [
            Compression::UNCOMPRESSED,
            Compression::SNAPPY,
            Compression::GZIP(Default::default()),
            Compression::BROTLI(Default::default()),
            Compression::LZ4,
            Compression::LZ4_RAW,
            Compression::ZSTD(Default::default()),
        ] {
            let bytes = fixture(compression);
            let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("codec limits");
            let (source, _) = open(&bytes, limits);
            assert_eq!(source.metadata().extent().rows().value(), Some(6));
            let batch = read(
                &source,
                &bytes,
                RangeRequest::new(0, 6, 0, 2).expect("full codec range"),
            );
            assert_eq!(batch.range().row_count(), 6);
            assert_eq!(batch.columns().len(), 2);
            assert!(
                batch
                    .buffers()
                    .iter()
                    .any(|buffer| !buffer.data().is_empty())
            );
        }
    }

    #[test]
    fn maps_int96_to_timezone_free_nanosecond_timestamp_and_decodes_it() {
        let expected_nanos = 1_234_567_890_u64;
        let bytes = int96_fixture(expected_nanos);
        let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        let (source, _) = open(&bytes, limits);
        assert_eq!(
            source.metadata().schema().columns()[0].data_type(),
            &TableDataType::Timestamp {
                unit: TimeUnit::Nanosecond,
                timezone: None,
            }
        );
        let batch = read(
            &source,
            &bytes,
            RangeRequest::new(0, 1, 0, 1).expect("INT96 range"),
        );
        let values = match batch.columns()[0].native().layout() {
            ArrayLayout::FixedWidth { values } => values,
            layout => panic!("INT96 must decode to fixed-width timestamps, got {layout:?}"),
        };
        let buffer = &batch.buffers()[usize::try_from(values.buffer_index()).expect("buffer")];
        let start = usize::try_from(values.byte_offset()).expect("offset");
        let end = start + usize::try_from(values.byte_length()).expect("length");
        let decoded = i64::from_le_bytes(
            buffer.data()[start..end]
                .try_into()
                .expect("one timestamp value"),
        );
        assert_eq!(
            decoded,
            i64::try_from(expected_nanos).expect("expected nanos")
        );
    }

    #[test]
    fn preserves_nested_and_decimal_logical_types_through_page_decode() {
        let bytes = nested_logical_fixture();
        let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        let (source, _) = open(&bytes, limits);
        assert!(matches!(
            source.metadata().schema().columns()[0].data_type(),
            TableDataType::List { .. }
        ));
        assert_eq!(
            source.metadata().schema().columns()[1].data_type(),
            &TableDataType::Decimal128 {
                precision: 10,
                scale: 2,
            }
        );
        let batch = read(
            &source,
            &bytes,
            RangeRequest::new(0, 3, 0, 2).expect("nested/logical range"),
        );
        assert!(matches!(
            batch.columns()[0].native().layout(),
            ArrayLayout::List { .. }
        ));
        assert!(matches!(
            batch.columns()[1].native().layout(),
            ArrayLayout::FixedWidth { .. }
        ));
    }

    #[test]
    fn rejects_oversized_metadata_cardinality_before_page_reads() {
        let bytes = fixture(Compression::UNCOMPRESSED);
        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        limits.max_row_groups = 2;
        let mut operation = ParquetOpenOperation::new(
            u64::try_from(bytes.len()).expect("length"),
            ParquetOptions::default(),
            limits,
        )
        .expect("start open");
        let error = loop {
            let action = operation.next_action().expect("open action");
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            match operation.feed_owned(
                action.offset,
                bytes[start..start + length].to_vec(),
                start + length == bytes.len(),
            ) {
                Ok(Some(_)) => panic!("oversized metadata cardinality must fail"),
                Ok(None) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "row-groups");
        assert_eq!(error.details()["required"], 3);
        assert_eq!(error.details()["available"], 2);
    }

    #[test]
    fn rejects_decoded_metadata_that_exceeds_its_encoded_footer_budget() {
        let bytes = fixture(Compression::UNCOMPRESSED);
        let encoded_metadata_bytes = usize::try_from(u32::from_le_bytes(
            bytes[bytes.len() - 8..bytes.len() - 4]
                .try_into()
                .expect("footer metadata length"),
        ))
        .expect("metadata length");
        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        // The sparse reader retains the initial eight-byte footer probe in
        // addition to the metadata range and four-byte header. Leave exactly
        // that staging overhead while keeping the decoded metadata budget
        // close to its compact Thrift representation.
        limits.max_metadata_bytes = encoded_metadata_bytes + 8;
        let mut operation = ParquetOpenOperation::new(
            u64::try_from(bytes.len()).expect("length"),
            ParquetOptions::default(),
            limits,
        )
        .expect("start open");
        let error = loop {
            let action = operation.next_action().expect("open action");
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            match operation.feed_owned(
                action.offset,
                bytes[start..start + length].to_vec(),
                start + length == bytes.len(),
            ) {
                Ok(Some(_)) => panic!("decoded metadata beyond the budget must fail"),
                Ok(None) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "parquet-metadata");
        assert_eq!(
            error.details()["availableBytes"],
            encoded_metadata_bytes + 8
        );
        assert!(
            error.details()["requiredBytes"]
                .as_u64()
                .expect("required metadata bytes")
                > u64::try_from(encoded_metadata_bytes + 8).expect("metadata length")
        );
    }

    #[test]
    fn rejects_declared_decompression_output_before_requesting_page_bytes() {
        let bytes = fixture(Compression::BROTLI(Default::default()));
        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        limits.arrow.max_decoded_bytes = 64;
        limits.arrow.max_output_bytes = 64;
        limits.arrow.max_metadata_bytes = 64;
        limits.arrow.max_block_bytes = 64;
        limits.arrow.stream_chunk_bytes = 64;
        limits.arrow.max_display_cell_bytes = 64;
        let (source, _) = open(&bytes, limits);
        let error = source
            .begin_read(RangeRequest::new(0, 6, 0, 2).expect("full range"))
            .expect_err("declared page output must be rejected before page reads");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decompressed-pages");
    }

    #[test]
    fn rejects_corrupt_magic_and_reports_resource_category_details() {
        let mut bytes = fixture(Compression::UNCOMPRESSED);
        let last = bytes.len() - 1;
        bytes[last] = b'X';
        let limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        let mut operation = ParquetOpenOperation::new(
            u64::try_from(bytes.len()).expect("length"),
            ParquetOptions::default(),
            limits,
        )
        .expect("start corrupt open");
        let error = loop {
            let action = operation.next_action().expect("action");
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            match operation.feed_owned(
                action.offset,
                bytes[start..start + length].to_vec(),
                start + length == bytes.len(),
            ) {
                Ok(Some(_)) => panic!("corrupt footer must not open"),
                Ok(None) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.code(), ErrorCode::ParseFailed);

        let mut encrypted = fixture(Compression::UNCOMPRESSED);
        let footer_start = encrypted.len().saturating_sub(4);
        encrypted[footer_start..].copy_from_slice(b"PARE");
        let mut operation = ParquetOpenOperation::new(
            u64::try_from(encrypted.len()).expect("length"),
            ParquetOptions::default(),
            ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits"),
        )
        .expect("start encrypted open");
        let action = operation.next_action().expect("footer action");
        let start = usize::try_from(action.offset).expect("offset");
        let length = usize::try_from(action.length).expect("length");
        let error = operation
            .feed_owned(
                action.offset,
                encrypted[start..start + length].to_vec(),
                start + length == encrypted.len(),
            )
            .expect_err("encrypted footer must be rejected before metadata parsing");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);

        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        limits.max_source_bytes = 8;
        let error = ParquetOpenOperation::new(
            u64::try_from(bytes.len()).expect("length"),
            ParquetOptions::default(),
            limits,
        )
        .expect_err("source limit");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "encoded-source");
    }
}
