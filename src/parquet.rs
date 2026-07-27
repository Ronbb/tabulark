//! Range-driven Apache Parquet adapter foundations.
//!
//! The browser boundary owns source bytes. This module exposes restartable
//! open and read operations backed by a sparse [`ChunkReader`], allowing
//! parquet-rs to request only the footer, metadata, selected row groups, and
//! projected top-level columns needed for one operation.

use std::collections::{BTreeMap, HashMap, VecDeque};
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
const PAGE_DECOMPRESSION_LIMIT_SENTINEL: &str = "tabulark parquet page decompression limit";
const PAGE_HEADER_GUARD_SENTINEL: &str = "tabulark parquet page header guard failed";
const PAGE_TRACKING_LIMIT_SENTINEL: &str = "tabulark parquet page tracking limit";
const LAZY_PAGE_TRACKING_BYTES: usize = 256;
const MIN_LAZY_TRACKED_PAGES: usize = 32;
const MAX_LAZY_TRACKED_PAGES: usize = 8_192;
const MAX_LAZY_PAGE_HEADER_OBSERVATIONS: usize = 32_768;
const MAX_COMPACT_PARSE_STEPS: usize = 16_384;
const MIN_LAZY_DECODE_ATTEMPTS: usize = 32;
const MAX_LAZY_DECODE_ATTEMPTS: usize = 128;
const LAZY_DECODE_ATTEMPTS_PER_PREFETCH_WINDOW: usize = 4;

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

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct PageBodyRange {
    offset: u64,
    length: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PendingPage {
    length: u64,
    uncompressed_bytes: u64,
}

#[derive(Debug)]
struct PageDecompressionGuard {
    max_uncompressed_bytes: u64,
    max_tracked_pages: usize,
    pending_pages: BTreeMap<u64, PendingPage>,
    pending_ends: BTreeMap<u64, u64>,
    reserved_pages: HashMap<PageBodyRange, u64>,
    reserved_uncompressed_bytes: u64,
    header_observations: usize,
}

impl PageDecompressionGuard {
    fn new(max_uncompressed_bytes: usize) -> Self {
        Self {
            max_uncompressed_bytes: u64::try_from(max_uncompressed_bytes).unwrap_or(u64::MAX),
            max_tracked_pages: max_uncompressed_bytes
                .checked_div(LAZY_PAGE_TRACKING_BYTES)
                .unwrap_or(0)
                .clamp(MIN_LAZY_TRACKED_PAGES, MAX_LAZY_TRACKED_PAGES),
            pending_pages: BTreeMap::new(),
            pending_ends: BTreeMap::new(),
            reserved_pages: HashMap::new(),
            reserved_uncompressed_bytes: 0,
            header_observations: 0,
        }
    }

    fn associate(&mut self, page: PageBodyRange, uncompressed_bytes: u64) -> ParquetResult<()> {
        let pending = PendingPage {
            length: page.length,
            uncompressed_bytes,
        };
        if let Some(previous) = self.pending_pages.get(&page.offset) {
            if *previous != pending {
                return Err(page_header_guard_error(
                    "the same page range reported conflicting header sizes",
                ));
            }
            return Ok(());
        }
        if let Some(previous) = self.reserved_pages.get(&page) {
            if *previous != uncompressed_bytes {
                return Err(page_header_guard_error(
                    "the same page range reported conflicting decompressed sizes",
                ));
            }
        } else {
            self.ensure_tracking_capacity()?;
        }
        let end = page
            .offset
            .checked_add(page.length)
            .ok_or_else(|| page_header_guard_error("recorded page body range overflows u64"))?;
        if self
            .pending_ends
            .get(&end)
            .is_some_and(|start| *start != page.offset)
        {
            return Err(page_header_guard_error(
                "recorded page body ranges have a conflicting end offset",
            ));
        }
        self.pending_pages.insert(page.offset, pending);
        self.pending_ends.insert(end, page.offset);
        Ok(())
    }

    /// A sequential page skipped by parquet-rs never requests its body. The
    /// next header starts at or after that body's end, which is the only
    /// observable cleanup signal exposed through `ChunkReader`.
    fn discard_skipped_through(&mut self, offset: u64) -> ParquetResult<()> {
        while let Some((&end, &start)) = self.pending_ends.first_key_value() {
            // A zero-byte body starts and ends at the next header offset. Keep
            // that exact association until get_bytes(offset, 0) proves it was
            // decoded, or a later offset proves it was skipped. Non-empty
            // bodies ending at this offset were necessarily skipped.
            if end > offset || (end == offset && start == offset) {
                break;
            }
            self.pending_ends.pop_first();
            let pending = self.pending_pages.remove(&start).ok_or_else(|| {
                page_header_guard_error("page-header association indexes are inconsistent")
            })?;
            if start.checked_add(pending.length) != Some(end) {
                return Err(page_header_guard_error(
                    "page-header association range is inconsistent",
                ));
            }
        }
        Ok(())
    }

    fn take_association(&mut self, page: PageBodyRange) -> ParquetResult<Option<u64>> {
        let Some(pending) = self.pending_pages.get(&page.offset).copied() else {
            return Ok(None);
        };
        if pending.length != page.length {
            return Err(page_header_guard_error(
                "recorded page header does not match the requested body length",
            ));
        }
        self.pending_pages.remove(&page.offset);
        let end = page
            .offset
            .checked_add(page.length)
            .ok_or_else(|| page_header_guard_error("recorded page body range overflows u64"))?;
        if self.pending_ends.remove(&end) != Some(page.offset) {
            return Err(page_header_guard_error(
                "page-header association indexes are inconsistent",
            ));
        }
        Ok(Some(pending.uncompressed_bytes))
    }

    fn reserve(&mut self, page: PageBodyRange, uncompressed_bytes: u64) -> ParquetResult<()> {
        if let Some(previous) = self.reserved_pages.get(&page) {
            if *previous != uncompressed_bytes {
                return Err(page_header_guard_error(
                    "the same page range reported conflicting decompressed sizes",
                ));
            }
            return Ok(());
        }
        self.ensure_tracking_capacity()?;
        let required = self
            .reserved_uncompressed_bytes
            .checked_add(uncompressed_bytes)
            .ok_or_else(|| {
                ParquetError::General(format!(
                    "{PAGE_DECOMPRESSION_LIMIT_SENTINEL}: output required {} available {}",
                    u64::MAX,
                    self.max_uncompressed_bytes,
                ))
            })?;
        if required > self.max_uncompressed_bytes {
            return Err(ParquetError::General(format!(
                "{PAGE_DECOMPRESSION_LIMIT_SENTINEL}: output required {required} available {}",
                self.max_uncompressed_bytes,
            )));
        }
        self.reserved_pages.insert(page, uncompressed_bytes);
        self.reserved_uncompressed_bytes = required;
        Ok(())
    }

    fn ensure_tracking_capacity(&self) -> ParquetResult<()> {
        let tracked = self
            .pending_pages
            .len()
            .saturating_add(self.reserved_pages.len());
        if tracked >= self.max_tracked_pages {
            return Err(ParquetError::General(format!(
                "{PAGE_TRACKING_LIMIT_SENTINEL}: pages required {} available {}",
                tracked.saturating_add(1),
                self.max_tracked_pages,
            )));
        }
        Ok(())
    }

    fn observe_page_header(&mut self) -> ParquetResult<()> {
        let required = self.header_observations.saturating_add(1);
        if required > MAX_LAZY_PAGE_HEADER_OBSERVATIONS {
            return Err(ParquetError::General(format!(
                "{PAGE_TRACKING_LIMIT_SENTINEL}: pages required {required} available {MAX_LAZY_PAGE_HEADER_OBSERVATIONS}",
            )));
        }
        self.header_observations = required;
        Ok(())
    }

    fn is_reserved(&self, page: PageBodyRange) -> bool {
        self.reserved_pages.contains_key(&page)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PageBodyGuardDecision {
    Ready,
    RequestHeaderPrefix(usize),
}

#[derive(Clone)]
struct SparseChunkReader {
    source_length: u64,
    read_prefetch_bytes: usize,
    page_guard: Option<Arc<Mutex<PageDecompressionGuard>>>,
    segments: Arc<Mutex<Vec<Segment>>>,
    missing: Arc<Mutex<Option<ParquetReadBytesAction>>>,
}

impl Debug for SparseChunkReader {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SparseChunkReader")
            .field("source_length", &self.source_length)
            .field("read_prefetch_bytes", &self.read_prefetch_bytes)
            .field("page_guard", &self.page_guard.as_ref().map(|_| "enabled"))
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
            page_guard: None,
            segments: Arc::new(Mutex::new(Vec::new())),
            missing: Arc::new(Mutex::new(None)),
        }
    }

    fn fork(&self, max_page_uncompressed_bytes: Option<usize>) -> Result<Self> {
        let segments = self
            .segments
            .lock()
            .map_err(|_| runtime_lock_error())?
            .clone();
        Ok(Self {
            source_length: self.source_length,
            read_prefetch_bytes: self.read_prefetch_bytes,
            page_guard: max_page_uncompressed_bytes
                .map(PageDecompressionGuard::new)
                .map(|guard| Arc::new(Mutex::new(guard))),
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

    /// Returns the maximum compressed-byte allocation live while `insert`
    /// admits this action. Adjacent and overlapping segments are rebuilt into
    /// one allocation, so the old cache, ingress vector, and merged vector all
    /// coexist until the splice drops the old segments.
    fn insertion_peak_bytes(&self, action: ParquetReadBytesAction) -> Result<usize> {
        let incoming = usize::try_from(action.length).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet ingress source segment length overflows usize",
            )
        })?;
        let incoming_end = action.end()?;
        if incoming_end > self.source_length {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Parquet ingress source segment exceeds the source length",
            ));
        }
        let segments = self.segments.lock().map_err(|_| runtime_lock_error())?;
        let retained = segments.iter().try_fold(0_usize, |total, segment| {
            total.checked_add(segment.bytes.len()).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet sparse source byte accounting overflows",
                )
            })
        })?;

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

        let ingress_peak = retained.checked_add(incoming).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet ingress source byte accounting overflows",
            )
        })?;
        if first == last {
            return Ok(ingress_peak);
        }
        let merged = usize::try_from(merged_end - merged_start).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet merged source segment length overflows usize",
            )
        })?;
        ingress_peak.checked_add(merged).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet merged source byte peak accounting overflows",
            )
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
        let requested = ParquetReadBytesAction { offset, length };
        if requested
            .end()
            .map_err(|error| ParquetError::General(error.to_string()))?
            > self.source_length
        {
            return Err(ParquetError::EOF(
                "requested source range exceeds file length".into(),
            ));
        }
        let action = self.first_missing_action(requested)?.ok_or_else(|| {
            ParquetError::General(
                "Parquet sparse source coverage is inconsistent with its lookup".into(),
            )
        })?;
        let mut missing = self
            .missing
            .lock()
            .map_err(|_| ParquetError::General("Parquet missing-range lock is poisoned".into()))?;
        if missing.is_none() {
            *missing = Some(action);
        }
        Err(ParquetError::General(MISSING_BYTES_SENTINEL.into()))
    }

    fn first_missing_action(
        &self,
        requested: ParquetReadBytesAction,
    ) -> ParquetResult<Option<ParquetReadBytesAction>> {
        let requested_end = requested
            .end()
            .map_err(|error| ParquetError::General(error.to_string()))?;
        let segments = self
            .segments
            .lock()
            .map_err(|_| ParquetError::General("Parquet sparse source lock is poisoned".into()))?;
        let mut cursor = requested.offset;
        for segment in segments.iter() {
            let segment_length = u64::try_from(segment.bytes.len()).map_err(|_| {
                ParquetError::General("cached source segment length overflows u64".into())
            })?;
            let segment_end = segment.offset.checked_add(segment_length).ok_or_else(|| {
                ParquetError::General("cached source segment range overflows u64".into())
            })?;
            if segment_end <= cursor {
                continue;
            }
            if segment.offset >= requested_end {
                break;
            }
            if segment.offset > cursor {
                return Ok(Some(ParquetReadBytesAction {
                    offset: cursor,
                    length: segment.offset.min(requested_end) - cursor,
                }));
            }
            cursor = cursor.max(segment_end);
            if cursor >= requested_end {
                return Ok(None);
            }
        }
        Ok((cursor < requested_end).then_some(ParquetReadBytesAction {
            offset: cursor,
            length: requested_end - cursor,
        }))
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

    fn remember_page_header(&self, offset: u64, bytes: &[u8]) -> ParquetResult<()> {
        let Some(guard) = &self.page_guard else {
            return Ok(());
        };
        // When parquet-rs has peeked a header, get_next_page still calls
        // get_read at the already-associated body offset before using the
        // buffered header. This is safe only when an exact prior association
        // exists; otherwise every guarded get_read must parse as a header.
        {
            let mut guard = guard.lock().map_err(|_| {
                ParquetError::General("Parquet page-header guard lock is poisoned".into())
            })?;
            guard.discard_skipped_through(offset)?;
            if let Some(pending) = guard.pending_pages.get(&offset) {
                if pending.length > 0 {
                    return Ok(());
                }
            }
            guard.observe_page_header()?;
        }
        let page_header = compact_page_header(bytes).ok_or_else(|| {
            page_header_guard_error("page header prefix is malformed or incomplete")
        })?;
        // parquet-rs deliberately skips INDEX_PAGE bodies in its sequential
        // reader path, so they must not leave an association behind.
        if page_header.page_type == 1 {
            return Ok(());
        }
        let body_offset = offset
            .checked_add(
                u64::try_from(page_header.encoded_bytes)
                    .map_err(|_| page_header_guard_error("page header length overflows u64"))?,
            )
            .ok_or_else(|| page_header_guard_error("page body offset overflows u64"))?;
        guard
            .lock()
            .map_err(|_| {
                ParquetError::General("Parquet page-header guard lock is poisoned".into())
            })?
            .associate(
                PageBodyRange {
                    offset: body_offset,
                    length: page_header.compressed_bytes,
                },
                page_header.uncompressed_bytes,
            )
    }

    /// Validates and reserves a page before its compressed body is returned to
    /// parquet-rs. In the sequential reader path, `get_read` records the exact
    /// header start. The page-index path obtains a small header prefix here and
    /// restarts before asking for the rest of the declared page range.
    fn prepare_page_body(
        &self,
        data_start: u64,
        data_length: usize,
    ) -> ParquetResult<PageBodyGuardDecision> {
        let Some(guard) = &self.page_guard else {
            return Ok(PageBodyGuardDecision::Ready);
        };
        let data_length = u64::try_from(data_length)
            .map_err(|_| page_header_guard_error("page body length overflows u64"))?;
        let page = PageBodyRange {
            offset: data_start,
            length: data_length,
        };
        let (associated, already_reserved) = {
            let mut guard = guard.lock().map_err(|_| {
                ParquetError::General("Parquet page-header guard lock is poisoned".into())
            })?;
            let associated = guard.take_association(page)?;
            let already_reserved = guard.is_reserved(page);
            (associated, already_reserved)
        };

        let (page, uncompressed_bytes) = if let Some(uncompressed_bytes) = associated {
            (page, uncompressed_bytes)
        } else if already_reserved {
            return Ok(PageBodyGuardDecision::Ready);
        } else {
            // Page-index reads ask ChunkReader for a page range that starts at
            // the header. Stage only a bounded prefix first, then verify that
            // its declared header plus body exactly matches the indexed range.
            let prefix_length = usize::try_from(data_length)
                .ok()
                .map(|length| length.min(self.read_prefetch_bytes))
                .filter(|length| *length > 0)
                .ok_or_else(|| page_header_guard_error("indexed page range is empty"))?;
            let Some(prefix) = self.locate(data_start, prefix_length)? else {
                return Ok(PageBodyGuardDecision::RequestHeaderPrefix(prefix_length));
            };
            guard
                .lock()
                .map_err(|_| {
                    ParquetError::General("Parquet page-header guard lock is poisoned".into())
                })?
                .observe_page_header()?;
            let page_header = compact_page_header(prefix.as_ref()).ok_or_else(|| {
                page_header_guard_error("indexed page header is malformed or incomplete")
            })?;
            let indexed_length = u64::try_from(page_header.encoded_bytes)
                .ok()
                .and_then(|header_length| header_length.checked_add(page_header.compressed_bytes))
                .ok_or_else(|| page_header_guard_error("indexed page range overflows u64"))?;
            if indexed_length != data_length {
                return Err(page_header_guard_error(
                    "indexed page header does not match the requested range",
                ));
            }
            let header_length = u64::try_from(page_header.encoded_bytes)
                .map_err(|_| page_header_guard_error("indexed page header length overflows u64"))?;
            let body_offset = data_start
                .checked_add(header_length)
                .ok_or_else(|| page_header_guard_error("indexed page body offset overflows u64"))?;
            (
                PageBodyRange {
                    offset: body_offset,
                    length: page_header.compressed_bytes,
                },
                page_header.uncompressed_bytes,
            )
        };
        guard
            .lock()
            .map_err(|_| {
                ParquetError::General("Parquet page-header guard lock is poisoned".into())
            })?
            .reserve(page, uncompressed_bytes)?;
        Ok(PageBodyGuardDecision::Ready)
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
        if start == self.source_length {
            if let Some(guard) = &self.page_guard {
                let guard = guard.lock().map_err(|_| {
                    ParquetError::General("Parquet page-header guard lock is poisoned".into())
                })?;
                if guard
                    .pending_pages
                    .get(&start)
                    .is_some_and(|pending| pending.length == 0)
                {
                    return Ok(Cursor::new(Bytes::new()));
                }
            }
        }
        let remaining = self.source_length - start;
        let length = usize::try_from(
            remaining.min(u64::try_from(self.read_prefetch_bytes).unwrap_or(u64::MAX)),
        )
        .map_err(|_| ParquetError::General("Parquet read prefetch is too large".into()))?;
        match self.locate_suffix(start, length)? {
            Some(bytes) => {
                self.remember_page_header(start, bytes.as_ref())?;
                Ok(Cursor::new(bytes))
            }
            None => self.request(start, length).map(Cursor::new),
        }
    }

    fn get_bytes(&self, start: u64, length: usize) -> ParquetResult<Bytes> {
        if let PageBodyGuardDecision::RequestHeaderPrefix(prefix_length) =
            self.prepare_page_body(start, length)?
        {
            return self.request(start, prefix_length);
        }
        match self.locate(start, length)? {
            Some(bytes) => Ok(bytes),
            None => self.request(start, length),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CompactPageHeader {
    encoded_bytes: usize,
    page_type: i32,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
}

fn compact_page_header(bytes: &[u8]) -> Option<CompactPageHeader> {
    let mut input = CompactInput::new(bytes);
    let mut previous_field = 0_i16;
    let mut page_type = None;
    let mut uncompressed = None;
    let mut compressed = None;
    loop {
        let header = input.byte()?;
        let value_type = header & 0x0f;
        if value_type == 0 {
            if header != 0 {
                return None;
            }
            break;
        }
        let delta = i16::from(header >> 4);
        let field = if delta == 0 {
            input.zigzag_i16()?
        } else {
            previous_field.checked_add(delta)?
        };
        if field <= 0 {
            return None;
        }
        previous_field = field;
        match field {
            1 => {
                if value_type != 5 || page_type.is_some() {
                    return None;
                }
                page_type = Some(input.zigzag_i32()?);
            }
            2 => {
                if value_type != 5 || uncompressed.is_some() {
                    return None;
                }
                uncompressed = Some(input.zigzag_i32()?);
            }
            3 => {
                if value_type != 5 || compressed.is_some() {
                    return None;
                }
                compressed = Some(input.zigzag_i32()?);
            }
            _ => input.skip(value_type, 0, CompactValueContext::StructField)?,
        }
    }
    let page_type = page_type?;
    let uncompressed = uncompressed?;
    let compressed = compressed?;
    if !(0..=3).contains(&page_type) || uncompressed < 0 || compressed < 0 {
        return None;
    }
    Some(CompactPageHeader {
        encoded_bytes: input.offset,
        page_type,
        compressed_bytes: compressed as u64,
        uncompressed_bytes: uncompressed as u64,
    })
}

struct CompactInput<'a> {
    bytes: &'a [u8],
    offset: usize,
    remaining_steps: usize,
}

impl<'a> CompactInput<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            remaining_steps: MAX_COMPACT_PARSE_STEPS,
        }
    }

    fn byte(&mut self) -> Option<u8> {
        let value = *self.bytes.get(self.offset)?;
        self.offset += 1;
        Some(value)
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0_u64;
        for index in 0..10 {
            let byte = self.byte()?;
            if index == 9 && byte & 0xfe != 0 {
                return None;
            }
            let shift = index * 7;
            value |= u64::from(byte & 0x7f).checked_shl(shift)?;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn zigzag_i16(&mut self) -> Option<i16> {
        let value = u16::try_from(self.varint()?).ok()?;
        Some(((value >> 1) as i16) ^ -((value & 1) as i16))
    }

    fn zigzag_i32(&mut self) -> Option<i32> {
        let value = u32::try_from(self.varint()?).ok()?;
        Some(((value >> 1) as i32) ^ -((value & 1) as i32))
    }

    fn skip(&mut self, value_type: u8, depth: usize, context: CompactValueContext) -> Option<()> {
        const MAX_COMPACT_CONTAINER_ITEMS: usize = 4_096;

        if depth >= 32 {
            return None;
        }
        self.remaining_steps = self.remaining_steps.checked_sub(1)?;
        match value_type {
            1 | 2 => match context {
                CompactValueContext::StructField => Some(()),
                CompactValueContext::CollectionElement => {
                    matches!(self.byte()?, 0..=2).then_some(())
                }
            },
            3 => {
                self.byte()?;
                Some(())
            }
            4..=6 => {
                self.varint()?;
                Some(())
            }
            7 => self.skip_bytes(8),
            8 => {
                let length = usize::try_from(self.varint()?).ok()?;
                self.skip_bytes(length)
            }
            9 | 10 => {
                let header = self.byte()?;
                let element_type = header & 0x0f;
                let inline_length = usize::from(header >> 4);
                let length = if inline_length == 15 {
                    usize::try_from(self.varint()?).ok()?
                } else {
                    inline_length
                };
                if length > MAX_COMPACT_CONTAINER_ITEMS || (length > 0 && element_type == 0) {
                    return None;
                }
                for _ in 0..length {
                    self.skip(
                        element_type,
                        depth + 1,
                        CompactValueContext::CollectionElement,
                    )?;
                }
                Some(())
            }
            11 => {
                let length = usize::try_from(self.varint()?).ok()?;
                if length == 0 {
                    return Some(());
                }
                if length > MAX_COMPACT_CONTAINER_ITEMS {
                    return None;
                }
                let types = self.byte()?;
                let key_type = types >> 4;
                let value_type = types & 0x0f;
                if key_type == 0 || value_type == 0 {
                    return None;
                }
                for _ in 0..length {
                    self.skip(key_type, depth + 1, CompactValueContext::CollectionElement)?;
                    self.skip(
                        value_type,
                        depth + 1,
                        CompactValueContext::CollectionElement,
                    )?;
                }
                Some(())
            }
            12 => {
                let mut previous_field = 0_i16;
                loop {
                    let header = self.byte()?;
                    let nested_type = header & 0x0f;
                    if nested_type == 0 {
                        if header != 0 {
                            return None;
                        }
                        return Some(());
                    }
                    let delta = i16::from(header >> 4);
                    previous_field = if delta == 0 {
                        self.zigzag_i16()?
                    } else {
                        previous_field.checked_add(delta)?
                    };
                    if previous_field <= 0 {
                        return None;
                    }
                    self.skip(nested_type, depth + 1, CompactValueContext::StructField)?;
                }
            }
            _ => None,
        }
    }

    fn skip_bytes(&mut self, length: usize) -> Option<()> {
        self.offset = self.offset.checked_add(length)?;
        (self.offset <= self.bytes.len()).then_some(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CompactValueContext {
    StructField,
    CollectionElement,
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
        ensure_action_peak_budget(
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

    /// Starts a projected range read for the intersecting row groups.
    ///
    /// Small projections retain the single-step column-chunk fast path. When
    /// complete column chunks exceed the operation budget but the request is
    /// only a partial row-group viewport, parquet-rs discovers page bytes
    /// lazily instead.
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
            reader: self.reader.fork(
                projected
                    .lazy_page_reads
                    .then_some(self.limits.arrow.max_decoded_bytes),
            )?,
            plan,
            source_columns,
            projection,
            row_groups: projected.row_groups,
            row_offset: projected.row_offset,
            planned_ranges: projected.ranges.into(),
            lazy_page_reads: projected.lazy_page_reads,
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
    lazy_page_reads: bool,
    expected: Option<ParquetReadBytesAction>,
    decode_attempts: usize,
}

impl ParquetReadOperation {
    /// Returns the next exact source range needed by parquet-rs.
    #[must_use]
    pub const fn next_action(&self) -> Option<ParquetReadBytesAction> {
        self.expected
    }

    /// Returns a bounded prefix of preplanned chunks or a decoder-discovered
    /// page range.
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
        let live_ingress = actions.iter().try_fold(0_usize, |total, action| {
            let length = usize::try_from(action.length).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet ingress source segment length overflows usize",
                )
            })?;
            total.checked_add(length).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet ingress action byte accounting overflows",
                )
            })
        })?;
        for action in actions.iter().copied() {
            let incoming = usize::try_from(action.length).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet ingress source segment length overflows usize",
                )
            })?;
            ensure_action_peak_budget_with_ingress(
                &self.reader,
                action,
                live_ingress.saturating_sub(incoming),
                self.limits.max_operation_bytes,
                "compressed-pages",
            )?;
        }
        Ok(actions)
    }

    /// Supplies one requested source range and resumes decoding.
    pub fn feed_owned(
        &mut self,
        offset: u64,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<TypedTableBatch>> {
        self.feed_many_owned(vec![(offset, bytes, eof)])
    }

    /// Supplies one complete batch of requested ranges. Every result is
    /// validated before any range is inserted.
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
        let mut live_ingress_bytes = results.iter().try_fold(0_usize, |total, (_, bytes, _)| {
            total.checked_add(bytes.len()).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet ingress result byte accounting overflows",
                )
            })
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
            let incoming = usize::try_from(action.length).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet ingress source segment length overflows usize",
                )
            })?;
            let other_live_ingress = live_ingress_bytes.checked_sub(incoming).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Parquet ingress result byte accounting is inconsistent",
                )
            })?;
            ensure_action_peak_budget_with_ingress(
                &self.reader,
                action,
                other_live_ingress,
                self.limits.max_operation_bytes,
                "compressed-pages",
            )?;
            self.reader.insert(action, bytes)?;
            live_ingress_bytes = other_live_ingress;
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
            Err(error) => return self.resolve_missing_or_error(error),
        };
        let mut decoded_bytes = 0_usize;
        let mut batches = Vec::new();
        for batch in reader {
            let batch = match batch {
                Ok(batch) => batch,
                Err(error) => return self.resolve_missing_or_error(error.into()),
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

    fn resolve_missing_or_error(&mut self, error: ParquetError) -> Result<Option<TypedTableBatch>> {
        if let Some(action) = self.reader.take_missing()? {
            if !self.lazy_page_reads {
                return Err(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Parquet preplanned column ranges did not cover a decoder request",
                )
                .with_detail("offset", action.offset)
                .with_detail("length", action.length)
                .with_detail("reason", error.to_string()));
            }
            ensure_lazy_decode_attempt_budget(self.decode_attempts, &self.limits)?;
            ensure_action_peak_budget(
                &self.reader,
                action,
                self.limits.max_operation_bytes,
                "compressed-pages",
            )?;
            self.expected = Some(action);
            Ok(None)
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

/// Plans the compressed ingress set before parquet-rs constructs a reader.
///
/// Small row-group projections stage complete column chunks in one ABI step.
/// A partial viewport of a larger row group instead lets parquet-rs discover
/// only the headers and pages it needs. Fully selected row groups still keep
/// their declared-size reservation, so lazy reads never bypass a known full
/// decode requirement.
struct ProjectedReadPlan {
    ranges: Vec<ParquetReadBytesAction>,
    row_groups: Vec<usize>,
    row_offset: usize,
    lazy_page_reads: bool,
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
    let mut fully_selected_uncompressed_bytes = 0_u64;
    let mut ranges = Vec::new();
    let mut fully_selected_ranges = Vec::new();
    let mut row_groups = Vec::new();
    let mut selected_row_offset = 0_usize;
    let mut has_partial_row_group = false;
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
            let selected_start = row_offset.max(request_start);
            let selected_end = row_end.min(request_end);
            let fully_selected = selected_start == row_offset && selected_end == row_end;
            has_partial_row_group |= !fully_selected;
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
                if fully_selected {
                    fully_selected_uncompressed_bytes = fully_selected_uncompressed_bytes
                        .checked_add(uncompressed)
                        .ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Parquet required decompressed-page reservation overflows",
                            )
                        })?;
                }
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
                    if fully_selected {
                        fully_selected_ranges.push(action);
                    }
                }
            }
        }
        row_offset = row_end;
        if row_offset >= request_end {
            break;
        }
    }

    let decoded_limit = u64::try_from(limits.arrow.max_decoded_bytes).unwrap_or(u64::MAX);
    let ranges = coalesce_source_ranges(ranges)?;
    let compressed_bytes = source_range_bytes(&ranges, "compressed-page reservation")?;
    let compressed_limit = u64::try_from(limits.max_operation_bytes).unwrap_or(u64::MAX);
    if uncompressed_bytes <= decoded_limit && compressed_bytes <= compressed_limit {
        return Ok(ProjectedReadPlan {
            ranges,
            row_groups,
            row_offset: selected_row_offset,
            lazy_page_reads: false,
        });
    }

    if !has_partial_row_group {
        if uncompressed_bytes > decoded_limit {
            return Err(resource_limit(
                "decompressed-pages",
                uncompressed_bytes,
                decoded_limit,
            ));
        }
        return Err(resource_limit(
            "compressed-pages",
            compressed_bytes,
            compressed_limit,
        ));
    }

    if fully_selected_uncompressed_bytes > decoded_limit {
        return Err(resource_limit(
            "decompressed-pages",
            fully_selected_uncompressed_bytes,
            decoded_limit,
        ));
    }
    let fully_selected_ranges = coalesce_source_ranges(fully_selected_ranges)?;
    let fully_selected_compressed_bytes = source_range_bytes(
        &fully_selected_ranges,
        "required compressed-page reservation",
    )?;
    if fully_selected_compressed_bytes > compressed_limit {
        return Err(resource_limit(
            "compressed-pages",
            fully_selected_compressed_bytes,
            compressed_limit,
        ));
    }

    Ok(ProjectedReadPlan {
        ranges: Vec::new(),
        row_groups,
        row_offset: selected_row_offset,
        lazy_page_reads: true,
    })
}

fn source_range_bytes(ranges: &[ParquetReadBytesAction], reservation: &'static str) -> Result<u64> {
    ranges.iter().try_fold(0_u64, |total, action| {
        total.checked_add(action.length).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                format!("Parquet {reservation} overflows"),
            )
        })
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

fn max_lazy_decode_attempts(limits: &ParquetLimits) -> usize {
    // Sequential pages normally need one header-window restart and at most one
    // body restart. Indexed pages can add a prefix-validation restart. Four
    // attempts per cache-sized window leaves headroom for column transitions,
    // while the hard ceiling bounds pathological tiny-page layouts.
    let prefetch_windows = limits
        .max_operation_bytes
        .div_ceil(limits.read_prefetch_bytes);
    prefetch_windows
        .saturating_mul(LAZY_DECODE_ATTEMPTS_PER_PREFETCH_WINDOW)
        .saturating_add(8)
        .clamp(MIN_LAZY_DECODE_ATTEMPTS, MAX_LAZY_DECODE_ATTEMPTS)
}

fn ensure_lazy_decode_attempt_budget(
    completed_attempts: usize,
    limits: &ParquetLimits,
) -> Result<()> {
    let attempt_limit = max_lazy_decode_attempts(limits);
    let required_attempts = completed_attempts.checked_add(1).ok_or_else(|| {
        count_limit(
            "decode-attempts",
            u64::MAX,
            u64::try_from(attempt_limit).unwrap_or(u64::MAX),
        )
    })?;
    if required_attempts > attempt_limit {
        return Err(count_limit(
            "decode-attempts",
            u64::try_from(required_attempts).unwrap_or(u64::MAX),
            u64::try_from(attempt_limit).unwrap_or(u64::MAX),
        ));
    }
    Ok(())
}

fn ensure_action_peak_budget(
    reader: &SparseChunkReader,
    action: ParquetReadBytesAction,
    limit: usize,
    category: &'static str,
) -> Result<()> {
    ensure_action_peak_budget_with_ingress(reader, action, 0, limit, category)
}

fn ensure_action_peak_budget_with_ingress(
    reader: &SparseChunkReader,
    action: ParquetReadBytesAction,
    other_live_ingress: usize,
    limit: usize,
    category: &'static str,
) -> Result<()> {
    let required = reader
        .insertion_peak_bytes(action)?
        .checked_add(other_live_ingress)
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
    if let Some(error) = page_decompression_limit_error(&reason) {
        return error;
    }
    if let Some(error) = page_tracking_limit_error(&reason) {
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

fn page_decompression_limit_error(message: &str) -> Option<TabularkError> {
    let mut fields = message
        .split_once(PAGE_DECOMPRESSION_LIMIT_SENTINEL)?
        .1
        .strip_prefix(": ")?
        .split_ascii_whitespace();
    if fields.next() != Some("output") || fields.next() != Some("required") {
        return None;
    }
    let required = fields.next()?.parse::<u64>().ok()?;
    if fields.next() != Some("available") {
        return None;
    }
    let available = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some(resource_limit("decompressed-pages", required, available))
}

fn page_tracking_limit_error(message: &str) -> Option<TabularkError> {
    let mut fields = message
        .split_once(PAGE_TRACKING_LIMIT_SENTINEL)?
        .1
        .strip_prefix(": ")?
        .split_ascii_whitespace();
    if fields.next() != Some("pages") || fields.next() != Some("required") {
        return None;
    }
    let required = fields.next()?.parse::<u64>().ok()?;
    if fields.next() != Some("available") {
        return None;
    }
    let available = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some(count_limit("page-tracking", required, available))
}

fn page_header_guard_error(reason: &'static str) -> ParquetError {
    ParquetError::General(format!("{PAGE_HEADER_GUARD_SENTINEL}: {reason}"))
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

fn count_limit(category: &'static str, required: u64, available: u64) -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        format!("Parquet {category} exceeds the configured resource limit"),
    )
    .with_detail("resource", category)
    .with_detail("required", required)
    .with_detail("available", available)
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
    use ::parquet::file::properties::{WriterProperties, WriterVersion};
    use ::parquet::file::reader::ChunkReader;
    use ::parquet::file::writer::SerializedFileWriter;
    use ::parquet::schema::parser::parse_message_type;
    use arrow_array::types::Int32Type;
    use arrow_array::{Decimal128Array, Int32Array, ListArray, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};

    use super::{
        CompactPageHeader, LAZY_PAGE_TRACKING_BYTES, MAX_LAZY_DECODE_ATTEMPTS,
        MAX_LAZY_PAGE_HEADER_OBSERVATIONS, OpenedParquetSource, PAGE_HEADER_GUARD_SENTINEL,
        PageBodyGuardDecision, PageBodyRange, PageDecompressionGuard, ParquetLimits,
        ParquetOpenOperation, ParquetOptions, ParquetReadBytesAction, ParquetReadStart,
        SparseChunkReader, coalesce_source_ranges, compact_page_header, ensure_action_peak_budget,
        ensure_lazy_decode_attempt_budget, max_lazy_decode_attempts, parquet_error,
    };
    use crate::arrow::ArrowIpcLimits;
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

    fn compact_test_page_header(uncompressed_bytes: u64, compressed_bytes: u64) -> Vec<u8> {
        fn push_nonnegative_i32(bytes: &mut Vec<u8>, value: u64) {
            let mut value = value.checked_mul(2).expect("test zigzag value");
            loop {
                let mut byte = u8::try_from(value & 0x7f).expect("test varint byte");
                value >>= 7;
                if value != 0 {
                    byte |= 0x80;
                }
                bytes.push(byte);
                if value == 0 {
                    break;
                }
            }
        }

        let mut bytes = vec![0x15, 0]; // field 1: DATA_PAGE
        bytes.push(0x15); // field 2: uncompressed_page_size
        push_nonnegative_i32(&mut bytes, uncompressed_bytes);
        bytes.push(0x15); // field 3: compressed_page_size
        push_nonnegative_i32(&mut bytes, compressed_bytes);
        bytes.push(0); // root struct stop
        bytes
    }

    #[test]
    fn lazy_page_guard_reserves_unique_decompressed_pages_cumulatively() {
        let first_header = compact_test_page_header(60, 4);
        let second_header = compact_test_page_header(60, 4);
        let second_header_start = first_header.len() + 4;
        let mut bytes = first_header.clone();
        bytes.extend_from_slice(&[1, 2, 3, 4]);
        bytes.extend_from_slice(&second_header);
        bytes.extend_from_slice(&[5, 6, 7, 8]);
        let reader = SparseChunkReader::new(
            u64::try_from(bytes.len()).expect("source length"),
            bytes.len(),
        )
        .fork(Some(100))
        .expect("guarded reader");
        cache_segment(&reader, 0, &bytes);

        reader.get_read(0).expect("first page header");
        reader
            .get_bytes(
                u64::try_from(first_header.len()).expect("first body offset"),
                4,
            )
            .expect("first page body");
        reader.get_read(0).expect("repeat first page header");
        reader
            .get_bytes(
                u64::try_from(first_header.len()).expect("first body offset"),
                4,
            )
            .expect("repeated page must not reserve twice");

        reader
            .get_read(u64::try_from(second_header_start).expect("second header offset"))
            .expect("second page header");
        let error = reader
            .get_bytes(
                u64::try_from(second_header_start + second_header.len())
                    .expect("second body offset"),
                4,
            )
            .expect_err("cumulative decompressed pages must remain within the limit");
        let error = parquet_error("validate lazy page reservation", error);
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decompressed-pages");
        assert_eq!(error.details()["requiredBytes"], 120);
        assert_eq!(error.details()["availableBytes"], 100);
    }

    #[test]
    fn lazy_page_guard_prunes_headers_for_pages_skipped_without_body_reads() {
        const PAGES: usize = 1_024;

        let header = compact_test_page_header(1, 1);
        let mut offsets = Vec::with_capacity(PAGES);
        let mut bytes = Vec::with_capacity(PAGES * (header.len() + 1));
        for page in 0..PAGES {
            offsets.push(u64::try_from(bytes.len()).expect("page header offset"));
            bytes.extend_from_slice(&header);
            bytes.push(u8::try_from(page % 256).expect("page body byte"));
        }
        let reader = SparseChunkReader::new(
            u64::try_from(bytes.len()).expect("source length"),
            bytes.len(),
        )
        .fork(Some(4 * LAZY_PAGE_TRACKING_BYTES))
        .expect("guarded reader");
        cache_segment(&reader, 0, &bytes);

        for offset in offsets.iter().copied() {
            reader
                .get_read(offset)
                .expect("a skipped page header remains parseable");
            let guard = reader
                .page_guard
                .as_ref()
                .expect("page guard")
                .lock()
                .expect("page guard lock");
            assert_eq!(guard.pending_pages.len(), 1);
            assert_eq!(guard.pending_ends.len(), 1);
            assert!(guard.reserved_pages.is_empty());
        }

        let last_header = *offsets.last().expect("last page header");
        let body_offset = last_header + u64::try_from(header.len()).expect("header length");
        reader
            .get_bytes(body_offset, 1)
            .expect("the final non-skipped body remains associated");
        let guard = reader
            .page_guard
            .as_ref()
            .expect("page guard")
            .lock()
            .expect("page guard lock");
        assert!(guard.pending_pages.is_empty());
        assert!(guard.pending_ends.is_empty());
        assert_eq!(guard.reserved_pages.len(), 1);
    }

    #[test]
    fn lazy_page_guard_advances_past_a_zero_byte_page() {
        let zero_header = compact_test_page_header(0, 0);
        let next_header = compact_test_page_header(1, 1);
        let next_header_start = zero_header.len();
        let next_body_start = next_header_start + next_header.len();
        let mut bytes = zero_header;
        bytes.extend_from_slice(&next_header);
        bytes.push(0x2a);

        let guarded_reader = || {
            let reader = SparseChunkReader::new(
                u64::try_from(bytes.len()).expect("source length"),
                bytes.len(),
            )
            .fork(Some(64))
            .expect("guarded reader");
            cache_segment(&reader, 0, &bytes);
            reader
        };

        let skipped = guarded_reader();
        skipped.get_read(0).expect("zero-byte page header");
        skipped
            .get_read(u64::try_from(next_header_start).expect("next header offset"))
            .expect("next header after skipped zero-byte page");
        assert_eq!(
            skipped
                .get_bytes(u64::try_from(next_body_start).expect("next body offset"), 1,)
                .expect("next page body")
                .as_ref(),
            &[0x2a]
        );

        let decoded = guarded_reader();
        decoded.get_read(0).expect("zero-byte page header");
        decoded
            .get_read(u64::try_from(next_header_start).expect("zero-byte body offset"))
            .expect("unused decoder cursor at zero-byte body");
        decoded
            .get_bytes(
                u64::try_from(next_header_start).expect("zero-byte body offset"),
                0,
            )
            .expect("reserved zero-byte page body");
        {
            let guard = decoded
                .page_guard
                .as_ref()
                .expect("page guard")
                .lock()
                .expect("page guard lock");
            assert_eq!(guard.reserved_pages.len(), 1);
            assert_eq!(guard.reserved_uncompressed_bytes, 0);
        }
        decoded
            .get_read(u64::try_from(next_header_start).expect("next header offset"))
            .expect("next header after decoded zero-byte page");
        assert_eq!(
            decoded
                .get_bytes(u64::try_from(next_body_start).expect("next body offset"), 1,)
                .expect("next page body")
                .as_ref(),
            &[0x2a]
        );

        let final_zero_header = compact_test_page_header(0, 0);
        let final_zero = SparseChunkReader::new(
            u64::try_from(final_zero_header.len()).expect("final source length"),
            final_zero_header.len(),
        )
        .fork(Some(64))
        .expect("final guarded reader");
        cache_segment(&final_zero, 0, &final_zero_header);
        final_zero.get_read(0).expect("final zero-byte header");
        let final_body_offset =
            u64::try_from(final_zero_header.len()).expect("final zero-byte body offset");
        assert!(
            final_zero
                .get_read(final_body_offset)
                .expect("empty decoder cursor at EOF")
                .into_inner()
                .is_empty()
        );
        final_zero
            .get_bytes(final_body_offset, 0)
            .expect("final zero-byte body");
        let guard = final_zero
            .page_guard
            .as_ref()
            .expect("page guard")
            .lock()
            .expect("page guard lock");
        assert!(guard.pending_pages.is_empty());
        assert_eq!(guard.reserved_pages.len(), 1);
    }

    #[test]
    fn lazy_page_guard_prunes_long_runs_of_skipped_zero_byte_pages() {
        const ZERO_PAGES: usize = 1_024;

        let zero_header = compact_test_page_header(0, 0);
        let next_header = compact_test_page_header(1, 1);
        let mut header_offsets = Vec::with_capacity(ZERO_PAGES + 1);
        let mut bytes = Vec::with_capacity(ZERO_PAGES * zero_header.len() + next_header.len() + 1);
        for _ in 0..ZERO_PAGES {
            header_offsets.push(u64::try_from(bytes.len()).expect("zero-page header offset"));
            bytes.extend_from_slice(&zero_header);
        }
        header_offsets.push(u64::try_from(bytes.len()).expect("normal-page header offset"));
        bytes.extend_from_slice(&next_header);
        let next_body_offset = u64::try_from(bytes.len()).expect("normal-page body offset");
        bytes.push(0x2a);

        let reader = SparseChunkReader::new(
            u64::try_from(bytes.len()).expect("source length"),
            bytes.len(),
        )
        .fork(Some(4 * LAZY_PAGE_TRACKING_BYTES))
        .expect("guarded reader");
        cache_segment(&reader, 0, &bytes);

        for offset in header_offsets {
            reader
                .get_read(offset)
                .expect("header after skipped zero-byte page");
            let guard = reader
                .page_guard
                .as_ref()
                .expect("page guard")
                .lock()
                .expect("page guard lock");
            assert!(guard.pending_pages.len() <= 2);
            assert!(guard.pending_ends.len() <= 2);
            assert!(guard.reserved_pages.is_empty());
            assert_eq!(guard.reserved_uncompressed_bytes, 0);
        }

        assert_eq!(
            reader
                .get_bytes(next_body_offset, 1)
                .expect("normal page body")
                .as_ref(),
            &[0x2a]
        );
        let guard = reader
            .page_guard
            .as_ref()
            .expect("page guard")
            .lock()
            .expect("page guard lock");
        assert_eq!(guard.pending_pages.len(), 1);
        assert_eq!(guard.pending_ends.len(), 1);
        assert_eq!(guard.reserved_pages.len(), 1);
        assert_eq!(guard.reserved_uncompressed_bytes, 1);
    }

    #[test]
    fn lazy_page_guard_bounds_zero_byte_tracking_state() {
        let mut guard = PageDecompressionGuard::new(2 * LAZY_PAGE_TRACKING_BYTES);
        guard.max_tracked_pages = 2;
        assert_eq!(guard.max_tracked_pages, 2);
        for offset in [0_u64, 2] {
            guard
                .reserve(PageBodyRange { offset, length: 0 }, 0)
                .expect("tracked zero-byte page");
        }
        let error = guard
            .reserve(
                PageBodyRange {
                    offset: 4,
                    length: 0,
                },
                0,
            )
            .expect_err("zero-byte declarations must not grow tracking state without bound");
        let error = parquet_error("validate lazy page tracking", error);
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "page-tracking");
        assert_eq!(error.details()["required"], 3);
        assert_eq!(error.details()["available"], 2);
        assert_eq!(guard.reserved_pages.len(), 2);
    }

    #[test]
    fn lazy_page_guard_bounds_total_header_parser_work() {
        let mut guard = PageDecompressionGuard::new(1024 * 1024);
        guard.header_observations = MAX_LAZY_PAGE_HEADER_OBSERVATIONS;
        let error = guard
            .observe_page_header()
            .expect_err("page header work must have a hard operation ceiling");
        let error = parquet_error("validate lazy page header work", error);
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "page-tracking");
        assert_eq!(
            error.details()["required"],
            u64::try_from(MAX_LAZY_PAGE_HEADER_OBSERVATIONS + 1).expect("required headers")
        );
        assert_eq!(
            error.details()["available"],
            u64::try_from(MAX_LAZY_PAGE_HEADER_OBSERVATIONS).expect("available headers")
        );
    }

    #[test]
    fn lazy_page_guard_validates_indexed_page_ranges_before_body_ingress() {
        let header = compact_test_page_header(64, 4);
        let total_length = header.len() + 4;
        let reader = SparseChunkReader::new(
            u64::try_from(total_length).expect("source length"),
            header.len(),
        )
        .fork(Some(128))
        .expect("guarded reader");

        assert_eq!(
            reader
                .prepare_page_body(0, total_length)
                .expect("request indexed header prefix"),
            PageBodyGuardDecision::RequestHeaderPrefix(header.len())
        );
        cache_segment(&reader, 0, &header);
        assert_eq!(
            reader
                .prepare_page_body(0, total_length)
                .expect("validate indexed page range"),
            PageBodyGuardDecision::Ready
        );
        let guard = reader
            .page_guard
            .as_ref()
            .expect("page guard")
            .lock()
            .expect("page guard lock");
        assert_eq!(guard.reserved_uncompressed_bytes, 64);
        assert_eq!(guard.reserved_pages.len(), 1);
        assert_eq!(
            guard.reserved_pages.get(&PageBodyRange {
                offset: u64::try_from(header.len()).expect("body offset"),
                length: 4,
            }),
            Some(&64)
        );
        drop(guard);

        let mismatch = reader
            .prepare_page_body(0, total_length - 1)
            .expect_err("indexed range must exactly match its header and compressed body");
        assert!(mismatch.to_string().contains(PAGE_HEADER_GUARD_SENTINEL));
    }

    #[test]
    fn lazy_page_guard_fails_closed_on_missing_or_inexact_header_association() {
        let header = compact_test_page_header(4, 4);
        let mut bytes = header.clone();
        bytes.extend_from_slice(&[1, 2, 3, 4]);
        let reader = SparseChunkReader::new(
            u64::try_from(bytes.len()).expect("source length"),
            bytes.len(),
        )
        .fork(Some(64))
        .expect("guarded reader");
        cache_segment(&reader, 0, &bytes);

        let unassociated = reader
            .get_bytes(u64::try_from(header.len()).expect("body offset"), 4)
            .expect_err("an unassociated body must not bypass header validation");
        assert!(
            unassociated
                .to_string()
                .contains(PAGE_HEADER_GUARD_SENTINEL)
        );

        let mut padded_header = header;
        padded_header.push(0x7f);
        let mut padded_bytes = padded_header.clone();
        padded_bytes.extend_from_slice(&[1, 2, 3, 4]);
        let padded = SparseChunkReader::new(
            u64::try_from(padded_bytes.len()).expect("padded source length"),
            padded_bytes.len(),
        )
        .fork(Some(64))
        .expect("padded guarded reader");
        cache_segment(&padded, 0, &padded_bytes);
        padded.get_read(0).expect("padded page header");
        let inexact = padded
            .get_bytes(
                u64::try_from(padded_header.len()).expect("padded body offset"),
                4,
            )
            .expect_err("bytes after the root stop must not be accepted as header bytes");
        assert!(inexact.to_string().contains(PAGE_HEADER_GUARD_SENTINEL));
    }

    #[test]
    fn compact_page_header_accepts_reordered_fields_and_bounded_unknowns() {
        fn push_nonnegative(bytes: &mut Vec<u8>, value: u64) {
            let mut value = value.checked_mul(2).expect("test zigzag value");
            loop {
                let mut byte = u8::try_from(value & 0x7f).expect("test varint byte");
                value >>= 7;
                if value != 0 {
                    byte |= 0x80;
                }
                bytes.push(byte);
                if value == 0 {
                    break;
                }
            }
        }

        let mut bytes = Vec::new();
        for (field, value) in [(3_u64, 4_u64), (9, 17), (1, 0), (2, 8)] {
            bytes.push(0x05); // explicit field id with an i32 value
            push_nonnegative(&mut bytes, field);
            push_nonnegative(&mut bytes, value);
        }
        bytes.push(0);

        assert_eq!(
            compact_page_header(&bytes),
            Some(CompactPageHeader {
                encoded_bytes: bytes.len(),
                page_type: 0,
                compressed_bytes: 4,
                uncompressed_bytes: 8,
            })
        );

        let mut duplicate = compact_test_page_header(8, 4);
        duplicate.pop();
        duplicate.extend_from_slice(&[0x05, 0x02, 0x00, 0x00]);
        assert_eq!(compact_page_header(&duplicate), None);

        let mut malformed_stop = compact_test_page_header(8, 4);
        *malformed_stop.last_mut().expect("root stop") = 0x10;
        assert_eq!(compact_page_header(&malformed_stop), None);
    }

    #[test]
    fn compact_page_header_consumes_boolean_collections_and_bounds_total_work() {
        fn push_varint(bytes: &mut Vec<u8>, mut value: u64) {
            loop {
                let mut byte = u8::try_from(value & 0x7f).expect("test varint byte");
                value >>= 7;
                if value != 0 {
                    byte |= 0x80;
                }
                bytes.push(byte);
                if value == 0 {
                    break;
                }
            }
        }

        let mut valid = compact_test_page_header(8, 4);
        valid.pop();
        valid.extend_from_slice(&[
            0x09, 0x12, // explicit field 9: list
            0x32, // three boolean collection elements
            0x01, 0x00, 0x02, // true plus both accepted false encodings
            0x00, // root stop
        ]);
        assert!(compact_page_header(&valid).is_some());

        let mut invalid_boolean = valid.clone();
        *invalid_boolean
            .get_mut(valid.len() - 2)
            .expect("last boolean element") = 0x03;
        assert_eq!(compact_page_header(&invalid_boolean), None);

        let mut excessive = compact_test_page_header(8, 4);
        excessive.pop();
        excessive.extend_from_slice(&[0x09, 0x12, 0xfc]); // field 9: long list<struct>
        push_varint(&mut excessive, 4_096);
        for _ in 0..4_096 {
            excessive.extend_from_slice(&[
                0x11, // field 1: boolean true in the field header
                0x12, // field 2: boolean false in the field header
                0x11, // field 3: boolean true in the field header
                0x12, // field 4: boolean false in the field header
                0x00, // nested struct stop
            ]);
        }
        excessive.push(0); // root stop
        assert_eq!(compact_page_header(&excessive), None);
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
    fn sparse_reader_accounts_for_the_temporary_merge_allocation() {
        let reader = SparseChunkReader::new(32, 8);
        cache_segment(&reader, 0, &[0, 1, 2, 3]);
        let adjacent = ParquetReadBytesAction {
            offset: 4,
            length: 4,
        };
        assert_eq!(
            reader
                .insertion_peak_bytes(adjacent)
                .expect("adjacent insertion peak"),
            16,
            "the old four bytes, four ingress bytes, and merged eight-byte allocation coexist",
        );
        let error = ensure_action_peak_budget(&reader, adjacent, 15, "compressed-pages")
            .expect_err("the temporary merged allocation must remain inside the budget");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "compressed-pages");
        assert_eq!(error.details()["requiredBytes"], 16);
        assert_eq!(error.details()["availableBytes"], 15);

        let disjoint = ParquetReadBytesAction {
            offset: 12,
            length: 4,
        };
        assert_eq!(
            reader
                .insertion_peak_bytes(disjoint)
                .expect("disjoint insertion peak"),
            8,
            "a disjoint ingress vector becomes the cached Bytes without a merge allocation",
        );
    }

    #[test]
    fn lazy_decode_attempt_budget_has_a_hard_ceiling() {
        let limits = ParquetLimits {
            max_operation_bytes: usize::MAX,
            read_prefetch_bytes: 1,
            ..ParquetLimits::default()
        };
        assert_eq!(max_lazy_decode_attempts(&limits), MAX_LAZY_DECODE_ATTEMPTS);
        ensure_lazy_decode_attempt_budget(MAX_LAZY_DECODE_ATTEMPTS - 1, &limits)
            .expect("the final bounded decoder construction is allowed");
        let error = ensure_lazy_decode_attempt_budget(MAX_LAZY_DECODE_ATTEMPTS, &limits)
            .expect_err("another lazy decoder construction must be rejected");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decode-attempts");
        assert_eq!(
            error.details()["required"],
            u64::try_from(MAX_LAZY_DECODE_ATTEMPTS + 1).expect("attempt count")
        );
        assert_eq!(
            error.details()["available"],
            u64::try_from(MAX_LAZY_DECODE_ATTEMPTS).expect("attempt limit")
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
    fn sparse_reader_requests_only_the_first_uncovered_gap() {
        let reader = SparseChunkReader::new(32, 8);
        cache_segment(&reader, 4, &[4, 5, 6, 7]);
        cache_segment(&reader, 12, &[12, 13, 14, 15]);
        let requested = ParquetReadBytesAction {
            offset: 4,
            length: 12,
        };

        assert_eq!(
            reader
                .first_missing_action(requested)
                .expect("find uncovered gap"),
            Some(ParquetReadBytesAction {
                offset: 8,
                length: 4,
            })
        );

        cache_segment(&reader, 8, &[8, 9, 10, 11]);
        assert_eq!(
            reader
                .first_missing_action(requested)
                .expect("range is fully covered"),
            None
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

    fn large_nested_row_group_fixture() -> Vec<u8> {
        const ROWS: i32 = 64;
        const VALUES_PER_ROW: i32 = 256;

        let list = ListArray::from_iter_primitive::<Int32Type, _, _>((0..ROWS).map(|row| {
            Some(
                (0..VALUES_PER_ROW)
                    .map(|value| Some(row * VALUES_PER_ROW + value))
                    .collect::<Vec<_>>(),
            )
        }));
        let schema = Arc::new(Schema::new(vec![Field::new(
            "items",
            DataType::List(Arc::new(Field::new("item", DataType::Int32, true))),
            false,
        )]));
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(list)]).expect("large nested batch");
        let properties = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_dictionary_enabled(false)
            .set_data_page_row_count_limit(4)
            .set_write_batch_size(4)
            .set_offset_index_disabled(true)
            .build();
        let mut bytes = Vec::new();
        let mut writer =
            ArrowWriter::try_new(&mut bytes, schema, Some(properties)).expect("nested writer");
        writer.write(&batch).expect("write large nested batch");
        writer.close().expect("close large nested writer");
        bytes
    }

    fn viewport_limits() -> ParquetLimits {
        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("base limits");
        limits.max_metadata_bytes = 8 * 1024;
        limits.max_operation_bytes = 16 * 1024;
        limits.read_prefetch_bytes = 512;
        limits.arrow =
            ArrowIpcLimits::from_memory_budget(32 * 1024).expect("viewport Arrow limits");
        limits
    }

    fn oversized_nested_page_fixture() -> Vec<u8> {
        const ROWS: i32 = 4;
        const VALUES_PER_ROW: i32 = 16 * 1024;

        let list = ListArray::from_iter_primitive::<Int32Type, _, _>((0..ROWS).map(|row| {
            Some(
                (0..VALUES_PER_ROW)
                    .map(|value| Some(row * VALUES_PER_ROW + value))
                    .collect::<Vec<_>>(),
            )
        }));
        let schema = Arc::new(Schema::new(vec![Field::new(
            "items",
            DataType::List(Arc::new(Field::new("item", DataType::Int32, true))),
            false,
        )]));
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(list)])
            .expect("oversized nested batch");
        let properties = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .set_dictionary_enabled(false)
            .set_data_page_row_count_limit(1)
            .set_write_batch_size(1)
            .set_offset_index_disabled(true)
            .build();
        let mut bytes = Vec::new();
        let mut writer =
            ArrowWriter::try_new(&mut bytes, schema, Some(properties)).expect("nested writer");
        writer.write(&batch).expect("write oversized nested batch");
        writer.close().expect("close oversized nested writer");
        bytes
    }

    fn many_tiny_primitive_pages_fixture(version: WriterVersion) -> Vec<u8> {
        const ROWS: i32 = 1_024;

        let values = Int32Array::from_iter_values(0..ROWS);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "value",
            DataType::Int32,
            false,
        )]));
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(values)]).expect("tiny-page batch");
        let properties = WriterProperties::builder()
            .set_writer_version(version)
            .set_compression(Compression::SNAPPY)
            .set_dictionary_enabled(false)
            .set_data_page_row_count_limit(1)
            .set_write_batch_size(1)
            .set_offset_index_disabled(true)
            .build();
        let mut bytes = Vec::new();
        let mut writer =
            ArrowWriter::try_new(&mut bytes, schema, Some(properties)).expect("tiny-page writer");
        writer.write(&batch).expect("write tiny pages");
        writer.close().expect("close tiny-page writer");
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
    fn partial_large_row_group_reads_bounded_pages_and_truncates_nested_display() {
        let bytes = large_nested_row_group_fixture();
        let limits = viewport_limits();
        let (source, _) = open(&bytes, limits.clone());
        let column = source.reader_metadata.metadata().row_group(0).column(0);
        assert!(
            u64::try_from(column.uncompressed_size()).expect("uncompressed size")
                > u64::try_from(limits.arrow.max_decoded_bytes).expect("decoded limit")
        );
        assert!(
            column.byte_range().1
                > u64::try_from(limits.max_operation_bytes).expect("operation limit")
        );

        let request = RangeRequest::new(0, 1, 0, 1).expect("first-row viewport");
        let mut operation = match source.begin_read(request).expect("begin lazy read") {
            ParquetReadStart::Pending(operation) => operation,
            ParquetReadStart::Complete(_) => panic!("large row group must request page bytes"),
        };
        assert!(operation.lazy_page_reads);
        assert!(operation.planned_ranges.is_empty());
        let mut requested_bytes = 0_u64;
        let batch = loop {
            let action = operation.next_action().expect("lazy page action");
            requested_bytes += action.length;
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            if let Some(batch) = operation
                .feed_owned(
                    action.offset,
                    bytes[start..start + length].to_vec(),
                    start + length == bytes.len(),
                )
                .expect("advance lazy page read")
            {
                break batch;
            }
        };
        assert!(operation.decode_attempts > 1);
        assert!(requested_bytes < column.byte_range().1);
        assert!(
            operation.reader.retained_bytes().expect("retained bytes")
                <= limits.max_operation_bytes
        );
        assert_eq!(batch.range(), request);
        assert!(matches!(
            batch.columns()[0].native().layout(),
            ArrayLayout::List { .. }
        ));
        let display_bytes = match batch.columns()[0].display().layout() {
            ArrayLayout::VariableWidth { values, .. } => values.byte_length(),
            layout => panic!("nested display must be variable-width UTF-8, got {layout:?}"),
        };
        assert!(
            display_bytes <= u64::try_from(limits.arrow.max_display_cell_bytes).unwrap_or(u64::MAX)
        );
    }

    #[test]
    fn late_large_row_group_viewport_fails_at_the_compressed_page_budget() {
        let bytes = large_nested_row_group_fixture();
        let limits = viewport_limits();
        let (source, _) = open(&bytes, limits.clone());
        let request = RangeRequest::new(63, 1, 0, 1).expect("late-row viewport");
        let mut operation = match source.begin_read(request).expect("begin lazy read") {
            ParquetReadStart::Pending(operation) => operation,
            ParquetReadStart::Complete(_) => panic!("late row must request page bytes"),
        };
        assert!(operation.lazy_page_reads);

        let error = loop {
            let action = operation.next_action().expect("lazy page action");
            let start = usize::try_from(action.offset).expect("offset");
            let length = usize::try_from(action.length).expect("length");
            match operation.feed_owned(
                action.offset,
                bytes[start..start + length].to_vec(),
                start + length == bytes.len(),
            ) {
                Ok(Some(_)) => panic!("late row must not bypass the compressed-page budget"),
                Ok(None) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.code(), ErrorCode::ResourceLimit, "{error:?}");
        assert_eq!(error.details()["resource"], "compressed-pages");
        assert!(
            operation.reader.retained_bytes().expect("retained bytes")
                <= limits.max_operation_bytes
        );
    }

    #[test]
    fn late_tiny_page_viewports_prune_v1_and_v2_skipped_header_state() {
        for version in [WriterVersion::PARQUET_1_0, WriterVersion::PARQUET_2_0] {
            let bytes = many_tiny_primitive_pages_fixture(version);
            let mut limits =
                ParquetLimits::from_memory_budget(4 * 1024 * 1024).expect("base tiny-page limits");
            limits.max_metadata_bytes = 64 * 1024;
            limits.max_operation_bytes = 1024 * 1024;
            limits.read_prefetch_bytes = 1024 * 1024;
            limits.arrow =
                ArrowIpcLimits::from_memory_budget(2 * 1024).expect("tiny-page Arrow limits");
            let (source, _) = open(&bytes, limits.clone());
            let request = RangeRequest::new(1_023, 1, 0, 1).expect("late tiny-page viewport");
            let mut operation = match source.begin_read(request).expect("begin tiny-page read") {
                ParquetReadStart::Pending(operation) => operation,
                ParquetReadStart::Complete(_) => panic!("tiny pages must request source bytes"),
            };
            assert!(operation.lazy_page_reads, "writer version {version:?}");

            let batch = loop {
                let action = operation.next_action().expect("tiny-page source action");
                let start = usize::try_from(action.offset).expect("action offset");
                let length = usize::try_from(action.length).expect("action length");
                if let Some(batch) = operation
                    .feed_owned(
                        action.offset,
                        bytes[start..start + length].to_vec(),
                        start + length == bytes.len(),
                    )
                    .expect("advance tiny-page read")
                {
                    break batch;
                }
            };
            assert_eq!(batch.range(), request);
            let guard = operation
                .reader
                .page_guard
                .as_ref()
                .expect("page guard")
                .lock()
                .expect("page guard lock");
            assert!(guard.pending_pages.is_empty(), "writer version {version:?}");
            assert!(guard.pending_ends.is_empty(), "writer version {version:?}");
            assert!(
                guard.header_observations >= 1_024,
                "the late viewport must traverse tiny pages for writer version {version:?}"
            );
            assert!(
                guard.reserved_pages.len() <= guard.max_tracked_pages,
                "writer version {version:?}"
            );
        }
    }

    #[test]
    fn lazy_reads_reject_an_oversized_declared_page_before_page_ingress() {
        let bytes = oversized_nested_page_fixture();
        let mut limits = viewport_limits();
        limits.max_operation_bytes = 128 * 1024;
        let (source, _) = open(&bytes, limits.clone());
        let request = RangeRequest::new(0, 1, 0, 1).expect("first-row viewport");
        let mut operation = match source.begin_read(request).expect("begin lazy read") {
            ParquetReadStart::Pending(operation) => operation,
            ParquetReadStart::Complete(_) => panic!("oversized page must request a header"),
        };
        assert!(operation.lazy_page_reads);

        let header = operation.next_action().expect("page-header action");
        assert!(
            header.length <= u64::try_from(limits.read_prefetch_bytes).expect("prefetch limit")
        );
        let start = usize::try_from(header.offset).expect("offset");
        let length = usize::try_from(header.length).expect("length");
        let error = operation
            .feed_owned(
                header.offset,
                bytes[start..start + length].to_vec(),
                start + length == bytes.len(),
            )
            .expect_err("declared oversized page must fail before page-body ingress");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decompressed-pages");
        assert!(
            operation.reader.retained_bytes().expect("retained bytes")
                <= limits.max_operation_bytes
        );
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
        let baseline_limits =
            ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("baseline limits");
        let (baseline, _) = open(&bytes, baseline_limits);
        let decoded_metadata_bytes = baseline.reader_metadata.metadata().memory_size();
        assert!(decoded_metadata_bytes > encoded_metadata_bytes + 8);
        let mut limits = ParquetLimits::from_memory_budget(32 * 1024 * 1024).expect("limits");
        // Leave enough room for the encoded footer's transient merge peak but
        // one byte less than its decoded metadata representation.
        limits.max_metadata_bytes = decoded_metadata_bytes - 1;
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
            decoded_metadata_bytes - 1
        );
        assert_eq!(error.details()["requiredBytes"], decoded_metadata_bytes);
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
