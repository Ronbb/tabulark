//! Handle-owning runtime built around the incremental delimited adapter.
//!
//! This module is deliberately source-transport agnostic. A browser Worker
//! owns `Blob` slicing and feeds chunks to [`Runtime`]; native tests can use
//! [`crate::csv::MemorySource`] instead.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::csv::{
    CsvDiagnostic, CsvScanner, DelimitedOptions, RangeDecodeStatus, RangeDecoder, RangePlan,
    ScanUpdate,
};
use crate::error::{ErrorCode, Result, TabularkError};
use crate::model::{RangeRequest, TableBatch, TableMetadata};

/// Resource limits for source and range handle registries.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// Total memory budget advertised by the engine.
    pub memory_budget_bytes: usize,
    /// Budget reserved for sparse indexes and parser state.
    pub index_budget_bytes: usize,
    /// Budget reserved for Worker-side decoded tiles.
    pub tile_cache_budget_bytes: usize,
    /// Preferred source chunk size used by the Worker.
    pub chunk_bytes: usize,
    /// Sparse checkpoint interval for delimited sources.
    pub checkpoint_rows: u64,
    /// Global maximum bytes in one decoded field.
    pub max_field_bytes: usize,
    /// Global maximum columns in one delimited record.
    pub max_columns: usize,
    /// Global maximum cells in one range response.
    pub max_range_cells: u64,
    /// Global maximum encoded bytes in one range response.
    pub max_batch_bytes: usize,
    /// Maximum concurrently open source sessions.
    pub max_sources: usize,
    /// Maximum concurrently decoding range requests.
    pub max_active_ranges: usize,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            memory_budget_bytes: 256 * 1024 * 1024,
            index_budget_bytes: 64 * 1024 * 1024,
            tile_cache_budget_bytes: 96 * 1024 * 1024,
            chunk_bytes: 1024 * 1024,
            checkpoint_rows: 1_024,
            max_field_bytes: 16 * 1024 * 1024,
            max_columns: 16_384,
            max_range_cells: 250_000,
            max_batch_bytes: 32 * 1024 * 1024,
            max_sources: 8,
            max_active_ranges: 2,
        }
    }
}

/// Opaque source handle used by low-level runtime APIs.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SourceHandle(u32);

impl SourceHandle {
    /// Returns the numeric opaque handle for a transport that supports numbers.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    /// Reconstructs a handle received from the trusted Worker wire boundary.
    #[must_use]
    #[cfg(feature = "wasm")]
    pub(crate) const fn from_raw(value: u32) -> Self {
        Self(value)
    }
}

/// Opaque in-flight range decoder handle.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RangeHandle(u32);

impl RangeHandle {
    /// Returns the numeric opaque handle for a transport that supports numbers.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    /// Reconstructs a handle received from the trusted Worker wire boundary.
    #[must_use]
    #[cfg(feature = "wasm")]
    pub(crate) const fn from_raw(value: u32) -> Self {
        Self(value)
    }
}

/// Result returned after creating a checkpoint-backed range decoder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginRangeResult {
    /// Opaque range handle. It is already closed when `batch` is present.
    pub range_handle: RangeHandle,
    /// Source slice plan the Worker must satisfy.
    pub plan: RangePlan,
    /// Immediate zero-row result, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<TableBatch>,
}

/// Terminal or intermediate result returned after feeding a range chunk.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum FeedRangeResult {
    /// The source must provide another contiguous slice.
    NeedMore {
        /// Absolute source byte offset expected next.
        expected_offset: u64,
        /// New range-level diagnostics.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<CsvDiagnostic>,
    },
    /// The range is complete or was truncated at end-of-file.
    Complete {
        /// Encoded, bounded columnar response.
        batch: TableBatch,
        /// New range-level diagnostics.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<CsvDiagnostic>,
    },
}

/// Source and range handle registry used by the WASM Worker facade.
#[derive(Debug)]
pub struct Runtime {
    config: RuntimeConfig,
    next_handle: u32,
    sources: HashMap<SourceHandle, CsvScanner>,
    ranges: HashMap<RangeHandle, ActiveRange>,
}

#[derive(Debug)]
struct ActiveRange {
    source: SourceHandle,
    decoder: RangeDecoder,
    diagnostic_count: usize,
}

impl Runtime {
    /// Creates an empty runtime handle registry.
    pub fn new(config: RuntimeConfig) -> Result<Self> {
        if config.memory_budget_bytes == 0
            || config.index_budget_bytes == 0
            || config.tile_cache_budget_bytes == 0
            || config.chunk_bytes == 0
            || config.checkpoint_rows == 0
            || config.max_field_bytes == 0
            || config.max_columns == 0
            || config.max_range_cells == 0
            || config.max_batch_bytes == 0
            || config.max_sources == 0
            || config.max_active_ranges == 0
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "runtime resource limits must be greater than zero",
            ));
        }
        let sub_budget_bytes = config
            .index_budget_bytes
            .checked_add(config.tile_cache_budget_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "runtime sub-budget total exceeds the supported byte range",
                )
            })?;
        if sub_budget_bytes > config.memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "runtime sub-budget total must not exceed the total memory budget",
            )
            .with_detail("subBudgetBytes", sub_budget_bytes)
            .with_detail("memoryBudgetBytes", config.memory_budget_bytes));
        }
        Ok(Self {
            config,
            next_handle: 1,
            sources: HashMap::new(),
            ranges: HashMap::new(),
        })
    }

    /// Opens a new empty source scanner. The caller then supplies source chunks.
    pub fn open_delimited(&mut self, mut options: DelimitedOptions) -> Result<SourceHandle> {
        if self.sources.len() >= self.config.max_sources {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "runtime has reached its open-source limit",
            )
            .with_detail("maxSources", self.config.max_sources));
        }
        options.checkpoint_interval = self.config.checkpoint_rows;
        options.limits.max_field_bytes = options
            .limits
            .max_field_bytes
            .min(self.config.max_field_bytes);
        options.limits.max_columns = options.limits.max_columns.min(self.config.max_columns);
        options.limits.max_cells_per_range = options
            .limits
            .max_cells_per_range
            .min(self.config.max_range_cells);
        options.limits.max_batch_bytes = options
            .limits
            .max_batch_bytes
            .min(self.config.max_batch_bytes);
        let handle = SourceHandle(self.allocate_handle()?);
        self.sources.insert(handle, CsvScanner::new(options)?);
        Ok(handle)
    }

    /// Feeds one contiguous chunk into an open source scanner.
    pub fn scan_chunk(
        &mut self,
        source: SourceHandle,
        absolute_offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<ScanUpdate> {
        let update = self
            .source_mut(source)?
            .feed_chunk(absolute_offset, bytes, eof)?;
        let estimated_bytes = self.sources.values().fold(0_usize, |total, scanner| {
            total.saturating_add(scanner.estimated_index_bytes())
        });
        if estimated_bytes > self.config.index_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "runtime sparse index and parser state exceed the configured byte budget",
            )
            .with_detail("estimatedBytes", estimated_bytes)
            .with_detail("indexBudgetBytes", self.config.index_budget_bytes));
        }
        Ok(update)
    }

    /// Returns the latest progressive metadata for an open source.
    pub fn metadata(&self, source: SourceHandle) -> Result<TableMetadata> {
        self.source(source)?.metadata()
    }

    /// Starts a range decoder and returns the source slice plan.
    pub fn begin_range(
        &mut self,
        source: SourceHandle,
        request: RangeRequest,
    ) -> Result<BeginRangeResult> {
        if self.ranges.len() >= self.config.max_active_ranges {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "runtime has reached its active-range limit",
            )
            .with_detail("maxActiveRanges", self.config.max_active_ranges));
        }
        let (plan, mut decoder) = {
            let scanner = self.source(source)?;
            let plan = scanner.plan_range(request)?;
            let decoder = scanner.range_decoder(plan)?;
            (plan, decoder)
        };
        let handle = RangeHandle(self.allocate_handle()?);
        if let Some(batch) = decoder.immediate_batch()? {
            return Ok(BeginRangeResult {
                range_handle: handle,
                plan,
                batch: Some(batch),
            });
        }
        self.ranges.insert(
            handle,
            ActiveRange {
                source,
                decoder,
                diagnostic_count: 0,
            },
        );
        Ok(BeginRangeResult {
            range_handle: handle,
            plan,
            batch: None,
        })
    }

    /// Feeds a range decoder with a contiguous source slice.
    pub fn feed_range(
        &mut self,
        range: RangeHandle,
        absolute_offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<FeedRangeResult> {
        let mut active = self
            .ranges
            .remove(&range)
            .ok_or_else(|| TabularkError::new(ErrorCode::HandleClosed, "range handle is closed"))?;
        if !self.sources.contains_key(&active.source) {
            return Err(TabularkError::new(
                ErrorCode::HandleClosed,
                "source owning this range has been closed",
            ));
        }
        let status = active.decoder.feed_chunk(absolute_offset, bytes, eof)?;
        let warnings = active.decoder.diagnostics()[active.diagnostic_count..].to_vec();
        active.diagnostic_count = active.decoder.diagnostics().len();
        match status {
            RangeDecodeStatus::NeedMore => {
                let expected_offset = active.decoder.expected_offset();
                self.ranges.insert(range, active);
                Ok(FeedRangeResult::NeedMore {
                    expected_offset,
                    warnings,
                })
            }
            RangeDecodeStatus::Complete(batch) => Ok(FeedRangeResult::Complete { batch, warnings }),
        }
    }

    /// Cancels and removes one active range. Calling this again is harmless.
    pub fn cancel(&mut self, range: RangeHandle) -> bool {
        self.ranges.remove(&range).is_some()
    }

    /// Closes one active range. Calling this again is harmless.
    pub fn close_range(&mut self, range: RangeHandle) -> bool {
        self.ranges.remove(&range).is_some()
    }

    /// Closes a source and every range it owns. Calling this again is harmless.
    pub fn close_source(&mut self, source: SourceHandle) -> bool {
        let was_open = self.sources.remove(&source).is_some();
        self.ranges.retain(|_, range| range.source != source);
        was_open
    }

    /// Closes every source and range owned by this runtime.
    pub fn shutdown(&mut self) {
        self.ranges.clear();
        self.sources.clear();
    }

    /// Returns the number of open source sessions.
    #[must_use]
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Returns the number of active range decoders.
    #[must_use]
    pub fn active_range_count(&self) -> usize {
        self.ranges.len()
    }

    fn source(&self, source: SourceHandle) -> Result<&CsvScanner> {
        self.sources
            .get(&source)
            .ok_or_else(|| TabularkError::new(ErrorCode::HandleClosed, "source handle is closed"))
    }

    fn source_mut(&mut self, source: SourceHandle) -> Result<&mut CsvScanner> {
        self.sources
            .get_mut(&source)
            .ok_or_else(|| TabularkError::new(ErrorCode::HandleClosed, "source handle is closed"))
    }

    fn allocate_handle(&mut self) -> Result<u32> {
        let handle = self.next_handle;
        self.next_handle = self.next_handle.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "runtime handle space exhausted")
        })?;
        Ok(handle)
    }
}

impl Default for Runtime {
    fn default() -> Self {
        // The literal default is known valid and cannot fail.
        Self::new(RuntimeConfig::default()).expect("default runtime config is valid")
    }
}

#[cfg(test)]
mod tests {
    use super::{FeedRangeResult, Runtime, RuntimeConfig};
    use crate::csv::{CsvScanner, DelimitedOptions};
    use crate::error::ErrorCode;
    use crate::model::RangeRequest;

    #[test]
    fn runtime_handles_scan_non_contiguous_reads_and_lifecycle() {
        let mut runtime = Runtime::default();
        let source = runtime
            .open_delimited(DelimitedOptions::csv())
            .expect("open source");
        runtime
            .scan_chunk(source, 0, b"value\nr0\nr1\nr2\n", true)
            .expect("scan source");

        let begin = runtime
            .begin_range(source, RangeRequest::new(2, 1, 0, 1).expect("range"))
            .expect("plan range");
        assert_eq!(begin.plan.rows_to_skip(), 2);
        let bytes = b"value\nr0\nr1\nr2\n";
        let offset = usize::try_from(begin.plan.source_offset()).expect("offset");
        let result = runtime
            .feed_range(
                begin.range_handle,
                begin.plan.source_offset(),
                &bytes[offset..],
                true,
            )
            .expect("feed range");
        let FeedRangeResult::Complete { batch, .. } = result else {
            panic!("range must complete");
        };
        assert_eq!(batch.columns()[0].value(0), Some(Some("r2")));

        assert!(runtime.close_source(source));
        assert!(!runtime.close_source(source));
        assert_eq!(runtime.source_count(), 0);
    }

    #[test]
    fn closing_source_invalidates_ranges() {
        let mut runtime = Runtime::new(RuntimeConfig {
            max_sources: 1,
            max_active_ranges: 1,
            ..RuntimeConfig::default()
        })
        .expect("runtime");
        let source = runtime
            .open_delimited(DelimitedOptions::csv())
            .expect("source");
        runtime
            .scan_chunk(source, 0, b"a\nr0\n", true)
            .expect("scan");
        let range = runtime
            .begin_range(source, RangeRequest::new(0, 1, 0, 1).expect("range"))
            .expect("begin")
            .range_handle;
        runtime.close_source(source);

        let error = runtime
            .feed_range(range, 2, b"r0\n", true)
            .expect_err("closed range");
        assert_eq!(error.code(), ErrorCode::HandleClosed);
    }

    #[test]
    fn runtime_rejects_sub_budget_totals_above_memory_budget() {
        let error = Runtime::new(RuntimeConfig {
            memory_budget_bytes: 100,
            index_budget_bytes: 60,
            tile_cache_budget_bytes: 50,
            ..RuntimeConfig::default()
        })
        .expect_err("sub-budget total must fit within the memory budget");

        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(error.details()["subBudgetBytes"], 110);
        assert_eq!(error.details()["memoryBudgetBytes"], 100);
    }

    #[test]
    fn scan_rejects_a_source_that_exceeds_a_low_index_budget() {
        let mut runtime = Runtime::new(RuntimeConfig {
            memory_budget_bytes: 2,
            index_budget_bytes: 1,
            tile_cache_budget_bytes: 1,
            ..RuntimeConfig::default()
        })
        .expect("runtime");
        let source = runtime
            .open_delimited(DelimitedOptions::csv())
            .expect("source");

        let error = runtime
            .scan_chunk(source, 0, b"column\nvalue\n", true)
            .expect_err("retained scanner state must exceed one byte");

        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        let estimated = error.details()["estimatedBytes"]
            .as_u64()
            .expect("numeric estimate");
        assert!(estimated > 1);
        assert_eq!(error.details()["indexBudgetBytes"], 1);
    }

    #[test]
    fn scan_enforces_the_index_budget_across_multiple_sources() {
        let options = DelimitedOptions::csv();
        let baseline_bytes = CsvScanner::new(options.clone())
            .expect("baseline scanner")
            .estimated_index_bytes();
        let mut populated = CsvScanner::new(options.clone()).expect("populated scanner");
        populated
            .feed_chunk(0, b"column\nvalue\n", true)
            .expect("populate scanner");
        let populated_bytes = populated.estimated_index_bytes();
        assert!(populated_bytes > baseline_bytes);

        let index_budget_bytes = populated_bytes
            .checked_add(baseline_bytes)
            .expect("test budget");
        let mut runtime = Runtime::new(RuntimeConfig {
            memory_budget_bytes: index_budget_bytes + 1,
            index_budget_bytes,
            tile_cache_budget_bytes: 1,
            max_sources: 2,
            ..RuntimeConfig::default()
        })
        .expect("runtime");
        let first = runtime
            .open_delimited(options.clone())
            .expect("first source");
        let second = runtime.open_delimited(options).expect("second source");

        runtime
            .scan_chunk(first, 0, b"column\nvalue\n", true)
            .expect("one populated source remains within the aggregate budget");
        let error = runtime
            .scan_chunk(second, 0, b"column\nvalue\n", true)
            .expect_err("two populated sources must exceed the aggregate budget");

        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert!(
            error.details()["estimatedBytes"]
                .as_u64()
                .expect("numeric estimate")
                > u64::try_from(index_budget_bytes).expect("u64 budget")
        );
        assert_eq!(error.details()["indexBudgetBytes"], index_budget_bytes);
    }
}
