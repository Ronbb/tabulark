//! Safe Apache Arrow IPC adapter built on arrow-rs 59.1.0.
//!
//! The module is feature-gated so the default delimited WASM artifact does not
//! link Arrow, FlatBuffers, LZ4, or Zstd. It deliberately exposes a native
//! lifecycle separately from the Worker facade: the thin Arrow WASM wrapper is
//! responsible only for byte ingress and handle/RPC translation.

use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;
use std::io::Cursor;
use std::sync::Arc;

use arrow_array::builder::StringBuilder;
use arrow_array::{
    Array, ArrayRef, BinaryViewArray, Float16Array, Float32Array, Float64Array, RecordBatch,
    StringArray, StringViewArray, make_array, new_empty_array,
};
use arrow_buffer::Buffer;
use arrow_cast::display::{ArrayFormatter, FormatOptions};
use arrow_data::{ArrayData, ArrayDataBuilder};
use arrow_ipc::convert::fb_to_schema;
use arrow_ipc::reader::{
    FileDecoder, FileReaderBuilder, StreamDecoder, StreamReader, read_footer_length,
};
use arrow_ipc::{
    Block, MessageHeader, MetadataVersion, root_as_footer_with_opts, root_as_message_with_opts,
};
use arrow_schema::{
    ArrowError, DataType as ArrowDataType, Field as ArrowField, IntervalUnit as ArrowIntervalUnit,
    SchemaRef as ArrowSchemaRef, TimeUnit as ArrowTimeUnit, UnionMode as ArrowUnionMode,
};
use arrow_select::concat::concat;
use flatbuffers::{InvalidFlatbuffer, VerifierOptions};
use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, Result, TabularkError, zstd_decompression_limit_error};
use crate::model::{
    ArrayDescriptor, ArrayLayout, AxisExtent, BatchBuffer, BitmapSlice, BufferSlice, Capabilities,
    ColumnSchema, IntervalUnit, RandomAccess, RangeRequest, Schema, TableDataType, TableExtent,
    TableField, TableMetadata, TimeUnit, TypedColumnBatch, TypedTableBatch, UnionArray, UnionField,
    UnionMode,
};

const ARROW_MAGIC: &[u8; 6] = b"ARROW1";
const EXTENSION_NAME_KEY: &str = "ARROW:extension:name";
const EXTENSION_METADATA_KEY: &str = "ARROW:extension:metadata";
const DEFAULT_ARROW_MEMORY_BUDGET_BYTES: usize = 256 * 1024 * 1024;
const NESTED_DISPLAY_TRUNCATION_SUFFIX: &str = "... [truncated]";
// Canvas text is clipped to a small visible area. Keeping a generous 16 KiB
// ceiling still preserves useful nested previews while preventing one cell
// from dominating a display-only batch.
const DISPLAY_ONLY_MAX_CELL_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArrowBatchMode {
    Typed,
    DisplayOnly,
}

/// Selects which Arrow IPC container reader is used.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrowIpcContainer {
    /// Detect a File container by its leading and trailing magic; otherwise use Stream.
    #[default]
    Auto,
    /// Require the random-access IPC File container.
    File,
    /// Require the sequential IPC Stream container.
    Stream,
}

/// The container selected after opening an Arrow IPC source.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedArrowIpcContainer {
    /// Arrow IPC File.
    File,
    /// Arrow IPC Stream.
    Stream,
}

/// Resource limits applied before and while decoding one Arrow IPC source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArrowIpcLimits {
    /// Maximum encoded source bytes accepted by this in-memory adapter boundary.
    pub max_source_bytes: usize,
    /// Maximum Arrow array memory retained after decoding.
    pub max_decoded_bytes: usize,
    /// Maximum bytes copied into one typed batch's deduplicated output pool.
    pub max_output_bytes: usize,
    /// Maximum aggregate schema and field metadata bytes.
    pub max_metadata_bytes: usize,
    /// Maximum encoded bytes in one IPC dictionary or record-batch block.
    pub max_block_bytes: usize,
    /// Maximum bytes requested by one sequential Stream ingress action.
    pub stream_chunk_bytes: usize,
    /// Maximum recursively counted Arrow fields.
    pub max_fields: usize,
    /// Maximum schema data-type nesting depth.
    pub max_nesting_depth: usize,
    /// Maximum logical cells in one requested range.
    pub max_range_cells: u64,
    /// Maximum UTF-8 bytes generated for one display cell.
    pub max_display_cell_bytes: usize,
}

impl Default for ArrowIpcLimits {
    fn default() -> Self {
        Self::from_memory_budget(DEFAULT_ARROW_MEMORY_BUDGET_BYTES)
            .expect("default Arrow IPC memory budget is valid")
    }
}

impl ArrowIpcLimits {
    /// Derives every byte-oriented operation limit from one memory ceiling.
    ///
    /// The encoded source cap intentionally remains equal to the supplied
    /// ceiling for the current in-memory native API. The incremental WASM path
    /// still reads only bounded ranges from its Worker-owned source.
    pub fn from_memory_budget(memory_budget_bytes: usize) -> Result<Self> {
        if memory_budget_bytes == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC memory budget must be greater than zero",
            ));
        }
        let bounded_fraction = |divisor: usize, hard_max: usize| {
            memory_budget_bytes
                .checked_div(divisor)
                .unwrap_or(0)
                .max(1)
                .min(hard_max)
                .min(memory_budget_bytes)
        };
        let limits = Self {
            max_source_bytes: memory_budget_bytes,
            max_decoded_bytes: memory_budget_bytes,
            max_output_bytes: bounded_fraction(2, 128 * 1024 * 1024),
            max_metadata_bytes: bounded_fraction(32, 8 * 1024 * 1024),
            max_block_bytes: bounded_fraction(4, 64 * 1024 * 1024),
            stream_chunk_bytes: bounded_fraction(256, 1024 * 1024),
            max_fields: 16_384,
            max_nesting_depth: 64,
            max_range_cells: 250_000,
            max_display_cell_bytes: bounded_fraction(256, 1024 * 1024),
        };
        limits.validate()?;
        Ok(limits)
    }

    /// Validates this operation's limits against an engine-wide memory ceiling.
    pub fn validate_for_memory_budget(&self, memory_budget_bytes: usize) -> Result<()> {
        self.validate()?;
        if memory_budget_bytes == 0 || self.max_decoded_bytes > memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC decoded byte limit exceeds the runtime memory budget",
            )
            .with_detail("maxDecodedBytes", self.max_decoded_bytes)
            .with_detail("memoryBudgetBytes", memory_budget_bytes));
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        if self.max_source_bytes == 0
            || self.max_decoded_bytes == 0
            || self.max_output_bytes == 0
            || self.max_metadata_bytes == 0
            || self.max_block_bytes == 0
            || self.stream_chunk_bytes == 0
            || self.max_fields == 0
            || self.max_nesting_depth == 0
            || self.max_range_cells == 0
            || self.max_display_cell_bytes == 0
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC resource limits must be greater than zero",
            ));
        }
        for (name, value) in [
            ("maxOutputBytes", self.max_output_bytes),
            ("maxMetadataBytes", self.max_metadata_bytes),
            ("maxBlockBytes", self.max_block_bytes),
            ("streamChunkBytes", self.stream_chunk_bytes),
            ("maxDisplayCellBytes", self.max_display_cell_bytes),
        ] {
            if value > self.max_decoded_bytes {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Arrow IPC operation sublimit exceeds its decoded-memory ceiling",
                )
                .with_detail("limit", name)
                .with_detail("limitBytes", value)
                .with_detail("maxDecodedBytes", self.max_decoded_bytes));
            }
        }
        Ok(())
    }
}

/// Options for opening one Arrow IPC source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArrowIpcOptions {
    /// Container selection; defaults to Rust-side auto detection.
    pub container: ArrowIpcContainer,
    /// Stable user-facing table name.
    pub table_name: String,
    /// Per-source resource limits.
    pub limits: ArrowIpcLimits,
}

impl Default for ArrowIpcOptions {
    fn default() -> Self {
        Self {
            container: ArrowIpcContainer::Auto,
            table_name: "Arrow IPC".to_owned(),
            limits: ArrowIpcLimits::default(),
        }
    }
}

/// A fully validated logical table decoded from one Arrow IPC File or Stream.
///
/// Record batches remain separate internally, and range reads concatenate only
/// intersecting row slices and projected columns.
#[derive(Debug)]
pub struct ArrowIpcSource {
    container: ResolvedArrowIpcContainer,
    arrow_schema: ArrowSchemaRef,
    metadata: TableMetadata,
    batches: Vec<RecordBatch>,
    row_offsets: Vec<usize>,
    decoded_bytes: usize,
    limits: ArrowIpcLimits,
}

/// Newly decoded IPC Stream batches plus cumulative index metadata.
///
/// A delta starts at the batch count already published to a runtime source.
/// Record-batch clones retain Arrow buffers, so publishing a delta does not
/// copy decoded values or revisit earlier batches.
#[derive(Debug)]
pub struct ArrowStreamDelta {
    arrow_schema: ArrowSchemaRef,
    options: ArrowIpcOptions,
    batch_start: usize,
    batches: Vec<RecordBatch>,
    cumulative_rows: usize,
    cumulative_decoded_bytes: usize,
    exact: bool,
}

impl ArrowStreamDelta {
    /// Returns the first logical record-batch index carried by this delta.
    #[must_use]
    pub const fn batch_start(&self) -> usize {
        self.batch_start
    }

    /// Returns the number of newly published record batches.
    #[must_use]
    pub fn batch_count(&self) -> usize {
        self.batches.len()
    }

    /// Returns whether this delta closes the Stream at EOF.
    #[must_use]
    pub const fn is_exact(&self) -> bool {
        self.exact
    }
}

impl ArrowIpcSource {
    /// Opens and validates one complete IPC File or Stream byte sequence.
    pub fn open(bytes: &[u8], options: ArrowIpcOptions) -> Result<Self> {
        options.limits.validate()?;
        if bytes.len() > options.limits.max_source_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC source exceeds the configured encoded byte limit",
            )
            .with_detail("sourceBytes", bytes.len())
            .with_detail("maxSourceBytes", options.limits.max_source_bytes));
        }

        let container = match options.container {
            ArrowIpcContainer::Auto if is_file_container(bytes) => ResolvedArrowIpcContainer::File,
            ArrowIpcContainer::Auto => ResolvedArrowIpcContainer::Stream,
            ArrowIpcContainer::File => ResolvedArrowIpcContainer::File,
            ArrowIpcContainer::Stream => ResolvedArrowIpcContainer::Stream,
        };

        let (arrow_schema, batches) = match container {
            ResolvedArrowIpcContainer::File => decode_file(bytes, &options.limits)?,
            ResolvedArrowIpcContainer::Stream => {
                let mut wire = StreamWireValidator::new();
                wire.feed(bytes, &options.limits)?;
                wire.finish()?;
                decode_stream(bytes)?
            }
        };
        Self::from_batches(container, arrow_schema, batches, options)
    }

    fn from_batches(
        container: ResolvedArrowIpcContainer,
        arrow_schema: ArrowSchemaRef,
        batches: Vec<RecordBatch>,
        options: ArrowIpcOptions,
    ) -> Result<Self> {
        Self::from_batches_with_extent(container, arrow_schema, batches, options, true)
    }

    fn from_batches_with_extent(
        container: ResolvedArrowIpcContainer,
        arrow_schema: ArrowSchemaRef,
        batches: Vec<RecordBatch>,
        options: ArrowIpcOptions,
        exact: bool,
    ) -> Result<Self> {
        validate_schema(&arrow_schema, &options.limits)?;
        let mut row_offsets = Vec::with_capacity(batches.len().saturating_add(1));
        row_offsets.push(0);
        let mut rows = 0_usize;
        let mut decoded_bytes = 0_usize;
        for batch in &batches {
            if batch.schema_ref() != &arrow_schema {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC record batch schema changed within one source",
                ));
            }
            rows = rows.checked_add(batch.num_rows()).ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC row count overflows")
            })?;
            decoded_bytes = decoded_bytes
                .checked_add(batch.get_array_memory_size())
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow IPC decoded memory estimate overflows",
                    )
                })?;
            if decoded_bytes > options.limits.max_decoded_bytes {
                return Err(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC decoded arrays exceed the configured byte limit",
                )
                .with_detail("decodedBytes", decoded_bytes)
                .with_detail("maxDecodedBytes", options.limits.max_decoded_bytes));
            }
            row_offsets.push(rows);
        }

        let rows = u64::try_from(rows).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC row count exceeds the public range",
            )
        })?;
        let metadata = if exact {
            exact_metadata(&arrow_schema, rows, options.table_name)?
        } else {
            progressive_metadata(&arrow_schema, rows, options.table_name)?
        };

        Ok(Self {
            container,
            arrow_schema,
            metadata,
            batches,
            row_offsets,
            decoded_bytes,
            limits: options.limits,
        })
    }

    fn from_stream_delta(delta: ArrowStreamDelta) -> Result<Self> {
        if delta.batch_start != 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "initial Arrow IPC Stream delta must start at batch zero",
            )
            .with_detail("batchStart", delta.batch_start));
        }
        let expected_rows = delta.cumulative_rows;
        let expected_decoded_bytes = delta.cumulative_decoded_bytes;
        let source = Self::from_batches_with_extent(
            ResolvedArrowIpcContainer::Stream,
            delta.arrow_schema,
            delta.batches,
            delta.options,
            delta.exact,
        )?;
        let actual_rows = *source.row_offsets.last().unwrap_or(&0);
        if actual_rows != expected_rows || source.decoded_bytes != expected_decoded_bytes {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow IPC Stream delta cumulative metadata is inconsistent",
            )
            .with_detail("expectedRows", expected_rows)
            .with_detail("actualRows", actual_rows)
            .with_detail("expectedDecodedBytes", expected_decoded_bytes)
            .with_detail("actualDecodedBytes", source.decoded_bytes));
        }
        Ok(source)
    }

    fn append_stream_delta(&mut self, delta: ArrowStreamDelta) -> Result<usize> {
        if self.container != ResolvedArrowIpcContainer::Stream {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "only an Arrow IPC Stream source accepts batch deltas",
            ));
        }
        if delta.batch_start != self.batches.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC Stream delta is missing, duplicate, or stale",
            )
            .with_detail("expectedBatchStart", self.batches.len())
            .with_detail("actualBatchStart", delta.batch_start));
        }
        if delta.arrow_schema != self.arrow_schema || delta.options.limits != self.limits {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC Stream delta schema or limits changed",
            ));
        }

        let previous_rows = *self.row_offsets.last().unwrap_or(&0);
        let mut rows = previous_rows;
        let mut decoded_bytes = self.decoded_bytes;
        let mut appended_offsets = Vec::with_capacity(delta.batches.len());
        for batch in &delta.batches {
            if batch.schema_ref() != &self.arrow_schema {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC record batch schema changed within one Stream delta",
                ));
            }
            rows = rows.checked_add(batch.num_rows()).ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC row count overflows")
            })?;
            decoded_bytes = decoded_bytes
                .checked_add(batch.get_array_memory_size())
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow IPC decoded memory estimate overflows",
                    )
                })?;
            appended_offsets.push(rows);
        }
        if rows != delta.cumulative_rows || decoded_bytes != delta.cumulative_decoded_bytes {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow IPC Stream delta cumulative metadata is inconsistent",
            )
            .with_detail("expectedRows", delta.cumulative_rows)
            .with_detail("actualRows", rows)
            .with_detail("expectedDecodedBytes", delta.cumulative_decoded_bytes)
            .with_detail("actualDecodedBytes", decoded_bytes));
        }
        if decoded_bytes > self.limits.max_decoded_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC decoded arrays exceed the configured byte limit",
            )
            .with_detail("decodedBytes", decoded_bytes)
            .with_detail("maxDecodedBytes", self.limits.max_decoded_bytes));
        }
        let public_rows = u64::try_from(rows).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC row count exceeds the public range",
            )
        })?;
        let metadata = if delta.exact {
            exact_metadata(&self.arrow_schema, public_rows, delta.options.table_name)?
        } else {
            progressive_metadata(&self.arrow_schema, public_rows, delta.options.table_name)?
        };
        self.batches.try_reserve(delta.batches.len()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC Stream batch index allocation failed",
            )
        })?;
        self.row_offsets
            .try_reserve(appended_offsets.len())
            .map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream row index allocation failed",
                )
            })?;
        let appended_decoded_bytes =
            decoded_bytes
                .checked_sub(self.decoded_bytes)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Arrow IPC Stream decoded-byte accounting underflows",
                    )
                })?;
        self.batches.extend(delta.batches);
        self.row_offsets.extend(appended_offsets);
        self.decoded_bytes = decoded_bytes;
        self.metadata = metadata;
        Ok(appended_decoded_bytes)
    }

    /// Returns the selected File or Stream container.
    #[must_use]
    pub const fn container(&self) -> ResolvedArrowIpcContainer {
        self.container
    }

    /// Returns immutable exact metadata for the source's single logical table.
    #[must_use]
    pub const fn metadata(&self) -> &TableMetadata {
        &self.metadata
    }

    /// Returns the number of decoded record batches.
    #[must_use]
    pub fn batch_count(&self) -> usize {
        self.batches.len()
    }

    /// Returns the conservative retained Arrow array-memory estimate.
    #[must_use]
    pub const fn decoded_bytes(&self) -> usize {
        self.decoded_bytes
    }

    /// Reads a projected range into typed-buffer layout v1.
    pub fn read_range(&self, request: RangeRequest) -> Result<TypedTableBatch> {
        self.read_range_with_mode(request, ArrowBatchMode::Typed)
    }

    fn read_display_range(&self, request: RangeRequest) -> Result<TypedTableBatch> {
        self.read_range_with_mode(request, ArrowBatchMode::DisplayOnly)
    }

    fn read_range_with_mode(
        &self,
        request: RangeRequest,
        mode: ArrowBatchMode,
    ) -> Result<TypedTableBatch> {
        let total_rows = *self.row_offsets.last().unwrap_or(&0);
        let total_columns = self.arrow_schema.fields().len();
        let plan = plan_range(request, total_rows, total_columns, &self.limits)?;
        let mut arrays = Vec::with_capacity(plan.returned_columns);
        for column_index in plan.column_start..plan.column_start + plan.returned_columns {
            arrays.push((
                column_index,
                self.project_column(column_index, plan.row_start, plan.returned_rows)?,
            ));
        }
        encode_batch(
            &self.arrow_schema,
            arrays,
            plan.returned_range,
            plan.complete,
            &self.limits,
            mode,
        )
    }

    fn project_column(
        &self,
        column_index: usize,
        row_start: usize,
        row_count: usize,
    ) -> Result<ArrayRef> {
        if row_count == 0 {
            return Ok(new_empty_array(
                self.arrow_schema.field(column_index).data_type(),
            ));
        }

        let row_end = row_start.checked_add(row_count).ok_or_else(invalid_range)?;
        let mut slices = Vec::new();
        for (batch_index, batch) in self.batches.iter().enumerate() {
            let batch_start = self.row_offsets[batch_index];
            let batch_end = self.row_offsets[batch_index + 1];
            let start = row_start.max(batch_start);
            let end = row_end.min(batch_end);
            if start < end {
                slices.push(
                    batch
                        .column(column_index)
                        .slice(start - batch_start, end - start),
                );
            }
        }
        if slices.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow IPC row index did not cover an available range",
            ));
        }

        // `concat` returns a shallow slice for one input. Appending an empty
        // array forces normalized offset-zero buffers for every descriptor.
        let empty = new_empty_array(self.arrow_schema.field(column_index).data_type());
        let mut references = slices
            .iter()
            .map(|array| array.as_ref())
            .collect::<Vec<_>>();
        references.push(empty.as_ref());
        concat(&references).map_err(|error| arrow_error("concatenate range", error))
    }
}

/// One bounded byte range requested from the Worker-owned input source.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBytesAction {
    /// Absolute byte offset in the host-owned source accessor.
    pub offset: u64,
    /// Exact number of bytes requested.
    pub length: u64,
}

impl ReadBytesAction {
    fn new(offset: usize, length: usize, source_length: usize) -> Result<Self> {
        let end = offset.checked_add(length).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "Arrow ingress range overflows")
        })?;
        if end > source_length {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC metadata references bytes outside the source",
            ));
        }
        Ok(Self {
            offset: u64::try_from(offset).map_err(|_| ingress_range_too_large())?,
            length: u64::try_from(length).map_err(|_| ingress_range_too_large())?,
        })
    }

    fn end(self) -> Result<u64> {
        self.offset.checked_add(self.length).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "Arrow ingress range overflows")
        })
    }
}

/// A source produced by the incremental adapter open state machine.
#[derive(Debug)]
pub enum OpenedArrowIpcSource {
    /// Footer-indexed IPC File; record bodies remain in the Worker-owned input.
    File(ArrowIndexedFileSource),
    /// Sequential IPC Stream; decoded record batches form the indexed prefix.
    Stream(ArrowIpcSource),
}

impl OpenedArrowIpcSource {
    /// Returns immutable table metadata.
    #[must_use]
    pub fn metadata(&self) -> &TableMetadata {
        match self {
            Self::File(source) => source.metadata(),
            Self::Stream(source) => source.metadata(),
        }
    }

    /// Returns the resolved IPC container.
    #[must_use]
    pub const fn container(&self) -> ResolvedArrowIpcContainer {
        match self {
            Self::File(_) => ResolvedArrowIpcContainer::File,
            Self::Stream(_) => ResolvedArrowIpcContainer::Stream,
        }
    }

    /// Returns retained decoded-array bytes. Indexed Files retain no record bodies.
    #[must_use]
    pub const fn decoded_bytes(&self) -> usize {
        match self {
            Self::File(_) => 0,
            Self::Stream(source) => source.decoded_bytes(),
        }
    }

    fn limits(&self) -> &ArrowIpcLimits {
        match self {
            Self::File(source) => &source.limits,
            Self::Stream(source) => &source.limits,
        }
    }

    /// Starts a range read, either completing from Stream arrays or requesting File blocks.
    pub fn begin_read(&self, request: RangeRequest) -> Result<ArrowReadStart> {
        self.begin_read_with_mode(request, ArrowBatchMode::Typed)
    }

    fn begin_display_read(&self, request: RangeRequest) -> Result<ArrowReadStart> {
        self.begin_read_with_mode(request, ArrowBatchMode::DisplayOnly)
    }

    fn begin_read_with_mode(
        &self,
        request: RangeRequest,
        mode: ArrowBatchMode,
    ) -> Result<ArrowReadStart> {
        match self {
            Self::File(source) => {
                let operation = ArrowFileReadOperation::new(source.clone(), request, mode)?;
                if operation.is_ready() {
                    Ok(ArrowReadStart::Complete(operation.into_ready()?))
                } else {
                    Ok(ArrowReadStart::File(Box::new(operation)))
                }
            }
            Self::Stream(source) => Ok(ArrowReadStart::Complete(match mode {
                ArrowBatchMode::Typed => source.read_range(request)?,
                ArrowBatchMode::DisplayOnly => source.read_display_range(request)?,
            })),
        }
    }
}

/// Result of beginning a range read on an incrementally opened source.
#[derive(Debug)]
pub enum ArrowReadStart {
    /// The range was already available.
    Complete(TypedTableBatch),
    /// The range needs one or more File block byte actions.
    File(Box<ArrowFileReadOperation>),
}

/// Incremental open operation used by adapter ABI v3.
#[derive(Debug)]
pub struct ArrowIpcOpenOperation {
    source_length: usize,
    options: ArrowIpcOptions,
    state: OpenState,
    published_stream_batches: usize,
    stream_metadata_published: bool,
}

#[derive(Debug)]
enum OpenState {
    DetectFileMagic,
    DetectFileTrailer,
    FileFooter { footer_length: usize },
    FileIndex(FileIndexState),
    Stream(Box<StreamIndexState>),
    Complete,
}

#[derive(Debug)]
struct StreamIndexState {
    decoder: StreamDecoder,
    wire: StreamWireValidator,
    batches: Vec<RecordBatch>,
    row_offsets: Vec<usize>,
    next_offset: usize,
    rows: usize,
    decoded_bytes: usize,
    schema_validated: bool,
}

impl StreamIndexState {
    fn new() -> Self {
        Self {
            decoder: StreamDecoder::new(),
            wire: StreamWireValidator::new(),
            batches: Vec::new(),
            row_offsets: vec![0],
            next_offset: 0,
            rows: 0,
            decoded_bytes: 0,
            schema_validated: false,
        }
    }
}

/// One compressed IPC body buffer whose prefix declares the decoded size.
#[derive(Clone, Debug)]
struct CompressedBufferSpec {
    offset: usize,
    encoded_length: usize,
}

#[derive(Debug)]
struct PendingCompressedBuffer {
    spec: CompressedBufferSpec,
    prefix: [u8; 8],
    prefix_read: usize,
    accounted: bool,
}

impl From<CompressedBufferSpec> for PendingCompressedBuffer {
    fn from(spec: CompressedBufferSpec) -> Self {
        Self {
            spec,
            prefix: [0; 8],
            prefix_read: 0,
            accounted: false,
        }
    }
}

#[derive(Debug)]
struct StreamMessageValidation {
    header_type: MessageHeader,
    body_length: usize,
    compressed_buffers: Vec<CompressedBufferSpec>,
    memory_kind: StreamMessageMemoryKind,
    compressed: bool,
}

#[derive(Clone, Copy, Debug)]
enum StreamMessageMemoryKind {
    None,
    Record,
    Dictionary { id: i64, is_delta: bool },
}

/// Bounded framing validator for an IPC Stream.
///
/// `StreamDecoder` owns Arrow's dictionary and record-batch state, but it does
/// not expose limits for each message's FlatBuffer or encoded body.  This
/// companion state machine validates exactly the same byte stream before it is
/// handed to the decoder, without retaining record bodies.
#[derive(Debug)]
struct StreamWireValidator {
    state: StreamWireState,
    schema_seen: bool,
    declared_decompressed_bytes: usize,
    retained_record_body_bytes: usize,
    retained_dictionary_body_bytes: usize,
    dictionary_bytes: HashMap<i64, usize>,
    feed_peak_buffered_bytes: usize,
    feed_transient_record_bytes: usize,
    feed_delta_concat_bytes: usize,
}

#[derive(Debug)]
enum StreamWireState {
    Header {
        bytes: [u8; 8],
        read: usize,
        target: usize,
    },
    Metadata {
        bytes: Vec<u8>,
        target: usize,
    },
    Body {
        metadata_length: usize,
        remaining: usize,
        consumed: usize,
        compressed_buffers: Vec<PendingCompressedBuffer>,
        memory_kind: StreamMessageMemoryKind,
        decoded_body_bytes: usize,
    },
    Finished,
}

impl StreamWireValidator {
    fn new() -> Self {
        Self {
            state: StreamWireState::Header {
                bytes: [0; 8],
                read: 0,
                target: 4,
            },
            schema_seen: false,
            declared_decompressed_bytes: 0,
            retained_record_body_bytes: 0,
            retained_dictionary_body_bytes: 0,
            dictionary_bytes: HashMap::new(),
            feed_peak_buffered_bytes: 0,
            feed_transient_record_bytes: 0,
            feed_delta_concat_bytes: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8], limits: &ArrowIpcLimits) -> Result<()> {
        self.feed_peak_buffered_bytes = self.decoder_buffered_bytes()?;
        self.feed_transient_record_bytes = 0;
        self.feed_delta_concat_bytes = 0;
        let mut cursor = 0_usize;
        while cursor < bytes.len() {
            let mut completed_message = None;
            match &mut self.state {
                StreamWireState::Header {
                    bytes: header,
                    read,
                    target,
                } => {
                    let take = (*target - *read).min(bytes.len() - cursor);
                    header[*read..*read + take].copy_from_slice(&bytes[cursor..cursor + take]);
                    *read += take;
                    self.feed_peak_buffered_bytes = self.feed_peak_buffered_bytes.max(*read);
                    cursor += take;
                    if *read < *target {
                        continue;
                    }
                    if *target == 4 && header[..4] == ARROW_MAGIC[..4] {
                        return Err(TabularkError::new(
                            ErrorCode::ParseFailed,
                            "Arrow IPC File bytes were supplied to the Stream reader",
                        ));
                    }
                    if *target == 4 && header[..4] == [0xff; 4] {
                        *target = 8;
                        continue;
                    }
                    let length_offset = if *target == 8 { 4 } else { 0 };
                    let raw_length: [u8; 4] = header[length_offset..length_offset + 4]
                        .try_into()
                        .map_err(|_| {
                        TabularkError::new(
                            ErrorCode::RuntimeFailure,
                            "Arrow IPC Stream framing state is inconsistent",
                        )
                    })?;
                    let metadata_length =
                        usize::try_from(u32::from_le_bytes(raw_length)).map_err(|_| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Arrow IPC Stream message length exceeds the supported range",
                            )
                        })?;
                    if metadata_length == 0 {
                        self.state = StreamWireState::Finished;
                        continue;
                    }
                    if metadata_length > limits.max_metadata_bytes {
                        return Err(TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC Stream message metadata exceeds the configured limit",
                        )
                        .with_detail("metadataBytes", metadata_length)
                        .with_detail("maxMetadataBytes", limits.max_metadata_bytes));
                    }
                    self.state = StreamWireState::Metadata {
                        bytes: Vec::new(),
                        target: metadata_length,
                    };
                }
                StreamWireState::Metadata {
                    bytes: metadata,
                    target,
                } => {
                    let take = (*target - metadata.len()).min(bytes.len() - cursor);
                    metadata.extend_from_slice(&bytes[cursor..cursor + take]);
                    self.feed_peak_buffered_bytes =
                        self.feed_peak_buffered_bytes.max(metadata.len());
                    cursor += take;
                    if metadata.len() < *target {
                        continue;
                    }
                    let metadata = std::mem::take(metadata);
                    let validation = validate_stream_message(&metadata, limits, self.schema_seen)?;
                    if validation.header_type == MessageHeader::Schema {
                        self.schema_seen = true;
                    }
                    self.state = if validation.body_length == 0 {
                        completed_message = Some((validation.memory_kind, 0));
                        Self::header_state()
                    } else {
                        let buffered_message_bytes = validation
                            .body_length
                            .checked_add(metadata.len())
                            .ok_or_else(|| {
                                TabularkError::new(
                                    ErrorCode::ResourceLimit,
                                    "Arrow IPC Stream buffered ingress estimate overflows",
                                )
                            })?;
                        self.feed_peak_buffered_bytes =
                            self.feed_peak_buffered_bytes.max(buffered_message_bytes);
                        StreamWireState::Body {
                            metadata_length: metadata.len(),
                            remaining: validation.body_length,
                            consumed: 0,
                            compressed_buffers: validation
                                .compressed_buffers
                                .into_iter()
                                .map(PendingCompressedBuffer::from)
                                .collect(),
                            memory_kind: validation.memory_kind,
                            decoded_body_bytes: if validation.compressed {
                                0
                            } else {
                                validation.body_length
                            },
                        }
                    };
                }
                StreamWireState::Body {
                    metadata_length,
                    remaining,
                    consumed,
                    compressed_buffers,
                    memory_kind,
                    decoded_body_bytes,
                } => {
                    let take = (*remaining).min(bytes.len() - cursor);
                    let fragment = &bytes[cursor..cursor + take];
                    let fragment_start = *consumed;
                    let fragment_end = fragment_start.checked_add(take).ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC Stream body offset overflows",
                        )
                    })?;
                    for pending in compressed_buffers
                        .iter_mut()
                        .filter(|value| !value.accounted)
                    {
                        let prefix_start = pending.spec.offset;
                        let prefix_end = prefix_start.checked_add(8).ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Arrow IPC compressed buffer prefix offset overflows",
                            )
                        })?;
                        let overlap_start = fragment_start.max(prefix_start);
                        let overlap_end = fragment_end.min(prefix_end);
                        if overlap_start < overlap_end {
                            let source_start = overlap_start - fragment_start;
                            let destination_start = overlap_start - prefix_start;
                            let length = overlap_end - overlap_start;
                            pending.prefix[destination_start..destination_start + length]
                                .copy_from_slice(&fragment[source_start..source_start + length]);
                            pending.prefix_read =
                                pending.prefix_read.max(destination_start + length);
                        }
                        if pending.prefix_read == 8 {
                            let declared = declared_decompressed_buffer_bytes(
                                pending.prefix,
                                pending.spec.encoded_length,
                            )?;
                            reserve_declared_decompression(
                                &mut self.declared_decompressed_bytes,
                                declared,
                                limits,
                            )?;
                            *decoded_body_bytes =
                                decoded_body_bytes.checked_add(declared).ok_or_else(|| {
                                    TabularkError::new(
                                        ErrorCode::ResourceLimit,
                                        "Arrow IPC Stream decoded body estimate overflows",
                                    )
                                })?;
                            pending.accounted = true;
                        }
                    }
                    *remaining -= take;
                    *consumed = fragment_end;
                    self.feed_peak_buffered_bytes = self.feed_peak_buffered_bytes.max(
                        metadata_length.checked_add(*consumed).ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Arrow IPC Stream buffered ingress estimate overflows",
                            )
                        })?,
                    );
                    cursor += take;
                    if *remaining == 0 {
                        if compressed_buffers.iter().any(|value| !value.accounted) {
                            return Err(TabularkError::new(
                                ErrorCode::ParseFailed,
                                "Arrow IPC compressed body ended before a buffer prefix",
                            ));
                        }
                        completed_message = Some((*memory_kind, *decoded_body_bytes));
                        self.state = Self::header_state();
                    }
                }
                StreamWireState::Finished => {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "Arrow IPC Stream contains bytes after its end marker",
                    ));
                }
            }
            if let Some((memory_kind, decoded_body_bytes)) = completed_message {
                self.record_completed_message(memory_kind, decoded_body_bytes)?;
            }
        }
        Ok(())
    }

    fn record_completed_message(
        &mut self,
        memory_kind: StreamMessageMemoryKind,
        decoded_body_bytes: usize,
    ) -> Result<()> {
        match memory_kind {
            StreamMessageMemoryKind::None => {}
            StreamMessageMemoryKind::Record => {
                self.retained_record_body_bytes = self
                    .retained_record_body_bytes
                    .checked_add(decoded_body_bytes)
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC Stream retained record-body estimate overflows",
                        )
                    })?;
                self.feed_transient_record_bytes =
                    self.feed_transient_record_bytes.max(decoded_body_bytes);
            }
            StreamMessageMemoryKind::Dictionary { id, is_delta } => {
                let previous = self.dictionary_bytes.get(&id).copied().unwrap_or(0);
                let current = if is_delta {
                    previous.checked_add(decoded_body_bytes).ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC Stream dictionary delta estimate overflows",
                        )
                    })?
                } else {
                    decoded_body_bytes
                };
                self.retained_dictionary_body_bytes = self
                    .retained_dictionary_body_bytes
                    .checked_add(decoded_body_bytes)
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC Stream retained dictionary estimate overflows",
                        )
                    })?;
                self.dictionary_bytes.insert(id, current);
                if is_delta {
                    // arrow-rs concatenates the old dictionary and the delta
                    // into a new array while both inputs remain live.
                    self.feed_delta_concat_bytes = self.feed_delta_concat_bytes.max(current);
                }
            }
        }
        Ok(())
    }

    fn decoder_buffered_bytes(&self) -> Result<usize> {
        match &self.state {
            StreamWireState::Header { read, .. } => Ok(*read),
            StreamWireState::Metadata { bytes, .. } => Ok(bytes.len()),
            StreamWireState::Body {
                metadata_length,
                consumed,
                ..
            } => metadata_length.checked_add(*consumed).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream buffered ingress estimate overflows",
                )
            }),
            StreamWireState::Finished => Ok(0),
        }
    }

    fn ensure_decode_memory_budget(
        &self,
        decoded_bytes: usize,
        ingress_bytes: usize,
        limits: &ArrowIpcLimits,
    ) -> Result<()> {
        let retained_record_bytes = decoded_bytes.max(self.retained_record_body_bytes);
        let retained_bytes = retained_record_bytes
            .checked_add(self.retained_dictionary_body_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream retained-memory estimate overflows",
                )
            })?;
        let buffered_ingress_bytes = self.feed_peak_buffered_bytes;
        let transient_bytes = self
            .feed_transient_record_bytes
            .checked_add(self.feed_delta_concat_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream transient-memory estimate overflows",
                )
            })?;
        let peak_bytes = retained_bytes
            .checked_add(ingress_bytes)
            .and_then(|value| value.checked_add(buffered_ingress_bytes))
            .and_then(|value| value.checked_add(transient_bytes))
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream peak-memory estimate overflows",
                )
            })?;
        if peak_bytes > limits.max_decoded_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC Stream decode would exceed the configured peak-memory limit",
            )
            .with_detail("retainedRecordBytes", retained_record_bytes)
            .with_detail(
                "retainedDictionaryBytes",
                self.retained_dictionary_body_bytes,
            )
            .with_detail("ingressBytes", ingress_bytes)
            .with_detail("bufferedIngressBytes", buffered_ingress_bytes)
            .with_detail("transientBytes", transient_bytes)
            .with_detail("peakBytes", peak_bytes)
            .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
        }
        Ok(())
    }

    fn finish(&self) -> Result<()> {
        if !self.schema_seen {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC Stream ended before its schema message was complete",
            ));
        }
        match self.state {
            StreamWireState::Finished
            | StreamWireState::Header {
                read: 0, target: 4, ..
            } => Ok(()),
            _ => Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC Stream ended in the middle of a message",
            )),
        }
    }

    const fn header_state() -> StreamWireState {
        StreamWireState::Header {
            bytes: [0; 8],
            read: 0,
            target: 4,
        }
    }
}

#[derive(Clone, Debug)]
struct FileBlockSpec {
    offset: usize,
    metadata_length: usize,
    body_length: usize,
}

impl FileBlockSpec {
    fn total_length(&self) -> Result<usize> {
        self.metadata_length
            .checked_add(self.body_length)
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC block size overflows")
            })
    }

    fn as_arrow_block(&self) -> Result<Block> {
        Ok(Block::new(
            i64::try_from(self.offset).map_err(|_| ingress_range_too_large())?,
            i32::try_from(self.metadata_length).map_err(|_| ingress_range_too_large())?,
            i64::try_from(self.body_length).map_err(|_| ingress_range_too_large())?,
        ))
    }
}

#[derive(Clone, Debug)]
struct IndexedRecordBlock {
    block: FileBlockSpec,
    row_start: usize,
    row_count: usize,
}

#[derive(Debug)]
struct FileIndexState {
    schema: ArrowSchemaRef,
    version: MetadataVersion,
    dictionaries: Vec<FileBlockSpec>,
    records: Vec<IndexedRecordBlock>,
    next_dictionary: usize,
    next_record: usize,
    rows: usize,
}

impl FileIndexState {
    fn next_metadata_block(&self) -> Option<&FileBlockSpec> {
        self.dictionaries.get(self.next_dictionary).or_else(|| {
            self.records
                .get(self.next_record)
                .map(|record| &record.block)
        })
    }

    fn metadata_block_at(&self, relative_index: usize) -> Option<&FileBlockSpec> {
        let remaining_dictionaries = self.dictionaries.len().saturating_sub(self.next_dictionary);
        if relative_index < remaining_dictionaries {
            return self
                .dictionaries
                .get(self.next_dictionary.checked_add(relative_index)?);
        }
        self.records
            .get(
                self.next_record
                    .checked_add(relative_index - remaining_dictionaries)?,
            )
            .map(|record| &record.block)
    }

    fn metadata_complete(&self) -> bool {
        self.next_dictionary == self.dictionaries.len() && self.next_record == self.records.len()
    }
}

impl ArrowIpcOpenOperation {
    /// Creates a lazy open without reading input bytes.
    pub fn new(source_length: usize, options: ArrowIpcOptions) -> Result<Self> {
        options.limits.validate()?;
        if source_length > options.limits.max_source_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC source exceeds the configured encoded byte limit",
            )
            .with_detail("sourceBytes", source_length)
            .with_detail("maxSourceBytes", options.limits.max_source_bytes));
        }
        let state = match options.container {
            ArrowIpcContainer::Stream => OpenState::Stream(Box::new(StreamIndexState::new())),
            ArrowIpcContainer::Auto if source_length < 18 => {
                OpenState::Stream(Box::new(StreamIndexState::new()))
            }
            ArrowIpcContainer::File if source_length < 18 => {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC File is shorter than its magic and footer trailer",
                ));
            }
            ArrowIpcContainer::Auto | ArrowIpcContainer::File => OpenState::DetectFileMagic,
        };
        Ok(Self {
            source_length,
            options,
            state,
            published_stream_batches: 0,
            stream_metadata_published: false,
        })
    }

    /// Returns the next exact byte action, if the operation is not complete.
    pub fn next_action(&self) -> Result<Option<ReadBytesAction>> {
        let action = match &self.state {
            OpenState::DetectFileMagic => {
                ReadBytesAction::new(0, ARROW_MAGIC.len(), self.source_length)?
            }
            OpenState::DetectFileTrailer => ReadBytesAction::new(
                self.source_length.saturating_sub(10),
                10,
                self.source_length,
            )?,
            OpenState::FileFooter { footer_length } => ReadBytesAction::new(
                self.source_length
                    .checked_sub(10)
                    .and_then(|value| value.checked_sub(*footer_length))
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ParseFailed,
                            "Arrow IPC footer length exceeds the source",
                        )
                    })?,
                *footer_length,
                self.source_length,
            )?,
            OpenState::FileIndex(state) => {
                let Some(block) = state.next_metadata_block() else {
                    return Ok(None);
                };
                ReadBytesAction::new(block.offset, block.metadata_length, self.source_length)?
            }
            OpenState::Stream(state) => {
                let remaining = self.source_length.saturating_sub(state.next_offset);
                ReadBytesAction::new(
                    state.next_offset,
                    remaining.min(self.options.limits.stream_chunk_bytes),
                    self.source_length,
                )?
            }
            OpenState::Complete => return Ok(None),
        };
        Ok(Some(action))
    }

    /// Returns a bounded batch of independent File dictionary/record metadata ranges.
    /// Other open states retain their single sequential action.
    pub fn next_actions(&self, max_ranges: usize, max_bytes: u64) -> Result<Vec<ReadBytesAction>> {
        if max_ranges == 0 || max_bytes == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow open action batch limits must be greater than zero",
            ));
        }
        let OpenState::FileIndex(state) = &self.state else {
            let Some(action) = self.next_action()? else {
                return Ok(Vec::new());
            };
            if action.length > max_bytes {
                return Err(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow open action exceeds the operation byte budget",
                )
                .with_detail("requestedBytes", action.length)
                .with_detail("operationBudgetBytes", max_bytes));
            }
            return Ok(vec![action]);
        };

        let mut actions = Vec::with_capacity(
            max_ranges.min(state.dictionaries.len().saturating_add(state.records.len())),
        );
        let mut total = 0_u64;
        for relative_index in 0..max_ranges {
            let Some(block) = state.metadata_block_at(relative_index) else {
                break;
            };
            let action =
                ReadBytesAction::new(block.offset, block.metadata_length, self.source_length)?;
            let next_total = total.checked_add(action.length).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow open action batch byte total overflows",
                )
            })?;
            if next_total > max_bytes {
                break;
            }
            total = next_total;
            actions.push(action);
        }
        if actions.is_empty() && !state.metadata_complete() {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow File block metadata exceeds the operation byte budget",
            )
            .with_detail("operationBudgetBytes", max_bytes));
        }
        Ok(actions)
    }

    /// Returns progressive Stream metadata after the schema has been read.
    pub fn metadata(&self) -> Result<Option<TableMetadata>> {
        let OpenState::Stream(state) = &self.state else {
            return Ok(None);
        };
        let Some(schema) = state.decoder.schema() else {
            return Ok(None);
        };
        let rows = u64::try_from(state.rows).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "Arrow row count overflows")
        })?;
        Ok(Some(progressive_metadata(
            &schema,
            rows,
            self.options.table_name.clone(),
        )?))
    }

    /// Clones the currently decoded Stream prefix into a readable source.
    ///
    /// Record-batch clones retain Arrow's shared buffers, so publishing a new
    /// prefix does not copy the decoded values. The returned metadata remains
    /// `at-least`/`indexed-prefix` until the open operation reaches EOF.
    pub fn stream_prefix(&self) -> Result<Option<OpenedArrowIpcSource>> {
        let OpenState::Stream(state) = &self.state else {
            return Ok(None);
        };
        let Some(schema) = state.decoder.schema() else {
            return Ok(None);
        };
        let source = ArrowIpcSource::from_batches_with_extent(
            ResolvedArrowIpcContainer::Stream,
            schema,
            state.batches.clone(),
            self.options.clone(),
            false,
        )?;
        Ok(Some(OpenedArrowIpcSource::Stream(source)))
    }

    /// Takes only Stream batches decoded since the previous publication.
    ///
    /// The first delta may contain zero batches so the schema and a stable
    /// source handle can be published before the first record batch. Later
    /// empty deltas are suppressed until EOF.
    pub fn take_stream_delta(&mut self) -> Result<Option<ArrowStreamDelta>> {
        let OpenState::Stream(state) = &self.state else {
            return Ok(None);
        };
        let Some(schema) = state.decoder.schema() else {
            return Ok(None);
        };
        if self.stream_metadata_published && self.published_stream_batches == state.batches.len() {
            return Ok(None);
        }
        let batch_start = self.published_stream_batches;
        let batches = state.batches[batch_start..].to_vec();
        self.published_stream_batches = state.batches.len();
        self.stream_metadata_published = true;
        Ok(Some(ArrowStreamDelta {
            arrow_schema: schema,
            options: self.options.clone(),
            batch_start,
            batches,
            cumulative_rows: state.rows,
            cumulative_decoded_bytes: state.decoded_bytes,
            exact: false,
        }))
    }

    /// Converts a completed Stream source into its unpublished EOF delta.
    ///
    /// Previously published batches are dropped from the completed source
    /// without cloning; the returned delta updates cumulative metadata to an
    /// exact extent even when EOF contains no new record batch.
    pub fn take_completed_stream_delta(
        &mut self,
        source: OpenedArrowIpcSource,
    ) -> Result<ArrowStreamDelta> {
        let OpenedArrowIpcSource::Stream(mut source) = source else {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "only a completed Arrow IPC Stream can produce an EOF delta",
            ));
        };
        let batch_start = self.published_stream_batches;
        if batch_start > source.batches.len() {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "published Arrow IPC Stream batch count exceeds the completed source",
            ));
        }
        let batches = source.batches.split_off(batch_start);
        self.published_stream_batches =
            batch_start.checked_add(batches.len()).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC Stream batch count overflows",
                )
            })?;
        self.stream_metadata_published = true;
        Ok(ArrowStreamDelta {
            arrow_schema: source.arrow_schema,
            options: self.options.clone(),
            batch_start,
            batches,
            cumulative_rows: *source.row_offsets.last().unwrap_or(&0),
            cumulative_decoded_bytes: source.decoded_bytes,
            exact: true,
        })
    }

    /// Supplies exactly the bytes requested by [`Self::next_action`].
    pub fn feed(
        &mut self,
        offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<Option<OpenedArrowIpcSource>> {
        let expected = self.next_action()?.ok_or_else(|| {
            TabularkError::new(ErrorCode::HandleClosed, "Arrow open operation is complete")
        })?;
        validate_action_response(expected, offset, bytes, eof, self.source_length)?;
        let state = std::mem::replace(&mut self.state, OpenState::Complete);
        match state {
            OpenState::DetectFileMagic => self.feed_file_magic(bytes),
            OpenState::DetectFileTrailer => self.feed_file_trailer(bytes),
            OpenState::FileFooter { .. } => self.feed_file_footer(bytes),
            OpenState::FileIndex(state) => self.feed_file_metadata(state, bytes),
            OpenState::Stream(state) => self.feed_stream_owned(*state, bytes.to_vec(), eof),
            OpenState::Complete => Err(TabularkError::new(
                ErrorCode::HandleClosed,
                "Arrow open operation is complete",
            )),
        }
    }

    /// Supplies one owned open-operation response without copying Stream ingress again.
    pub fn feed_owned(
        &mut self,
        offset: u64,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<OpenedArrowIpcSource>> {
        let expected = self.next_action()?.ok_or_else(|| {
            TabularkError::new(ErrorCode::HandleClosed, "Arrow open operation is complete")
        })?;
        validate_action_response(expected, offset, &bytes, eof, self.source_length)?;
        let state = std::mem::replace(&mut self.state, OpenState::Complete);
        match state {
            OpenState::DetectFileMagic => self.feed_file_magic(&bytes),
            OpenState::DetectFileTrailer => self.feed_file_trailer(&bytes),
            OpenState::FileFooter { .. } => self.feed_file_footer(&bytes),
            OpenState::FileIndex(state) => self.feed_file_metadata(state, &bytes),
            OpenState::Stream(state) => self.feed_stream_owned(*state, bytes, eof),
            OpenState::Complete => Err(TabularkError::new(
                ErrorCode::HandleClosed,
                "Arrow open operation is complete",
            )),
        }
    }

    /// Supplies one complete batch of independently requested File metadata
    /// ranges. The full result set is validated before any index state moves.
    pub fn feed_many_owned(
        &mut self,
        results: Vec<(u64, Vec<u8>, bool)>,
    ) -> Result<Option<OpenedArrowIpcSource>> {
        if results.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow open operation result set must not be empty",
            ));
        }
        if !matches!(self.state, OpenState::FileIndex(_)) {
            if results.len() != 1 {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "sequential Arrow open states accept exactly one source result",
                ));
            }
            let (offset, bytes, eof) = results
                .into_iter()
                .next()
                .expect("one Arrow result was validated");
            return self.feed_owned(offset, bytes, eof);
        }

        let expected = self.next_actions(results.len(), u64::MAX)?;
        if expected.len() != results.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow File metadata result set has an unexpected range count",
            )
            .with_detail("expectedResults", expected.len())
            .with_detail("actualResults", results.len()));
        }
        for (action, (offset, bytes, eof)) in expected.iter().copied().zip(&results) {
            validate_action_response(action, *offset, bytes, *eof, self.source_length)?;
        }
        let OpenState::FileIndex(mut state) =
            std::mem::replace(&mut self.state, OpenState::Complete)
        else {
            unreachable!("validated Arrow File index state changed")
        };
        for (_, bytes, _) in results {
            index_file_metadata(&mut state, &bytes, &self.options.limits)?;
        }
        if state.metadata_complete() {
            self.complete_file(state).map(Some)
        } else {
            self.state = OpenState::FileIndex(state);
            Ok(None)
        }
    }

    fn feed_file_magic(&mut self, bytes: &[u8]) -> Result<Option<OpenedArrowIpcSource>> {
        if bytes == ARROW_MAGIC {
            self.state = OpenState::DetectFileTrailer;
            return Ok(None);
        }
        if self.options.container == ArrowIpcContainer::Auto {
            self.state = OpenState::Stream(Box::new(StreamIndexState::new()));
            return Ok(None);
        }
        Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC File has invalid leading magic",
        ))
    }

    fn feed_file_trailer(&mut self, bytes: &[u8]) -> Result<Option<OpenedArrowIpcSource>> {
        let trailer: [u8; 10] = bytes.try_into().map_err(|_| {
            TabularkError::new(ErrorCode::ParseFailed, "invalid Arrow IPC File trailer")
        })?;
        match read_footer_length(trailer) {
            Ok(footer_length) => {
                let max_footer = self.source_length.saturating_sub(18);
                if footer_length > max_footer {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "Arrow IPC footer length exceeds the source",
                    ));
                }
                if footer_length > self.options.limits.max_metadata_bytes {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow IPC footer exceeds the configured metadata limit",
                    )
                    .with_detail("footerBytes", footer_length)
                    .with_detail("maxMetadataBytes", self.options.limits.max_metadata_bytes));
                }
                self.state = OpenState::FileFooter { footer_length };
                Ok(None)
            }
            Err(error) if self.options.container == ArrowIpcContainer::Auto => {
                self.state = OpenState::Stream(Box::new(StreamIndexState::new()));
                let _ = error;
                Ok(None)
            }
            Err(error) => Err(arrow_error("read IPC File footer trailer", error)),
        }
    }

    fn feed_file_footer(&mut self, bytes: &[u8]) -> Result<Option<OpenedArrowIpcSource>> {
        let verifier_options = flatbuffer_verifier_options(&self.options.limits);
        let footer = root_as_footer_with_opts(&verifier_options, bytes)
            .map_err(|error| flatbuffer_error("parse Arrow IPC footer", error))?;
        let ipc_schema = footer.schema().ok_or_else(|| {
            TabularkError::new(ErrorCode::ParseFailed, "Arrow IPC footer has no schema")
        })?;
        if !ipc_schema.endianness().equals_to_target_endianness() {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "Arrow IPC source uses non-native endianness",
            ));
        }
        let schema = Arc::new(fb_to_schema(ipc_schema));
        validate_schema(&schema, &self.options.limits)?;
        let dictionaries = footer
            .dictionaries()
            .map(|blocks| {
                blocks
                    .iter()
                    .map(|block| file_block_spec(*block, self.source_length, &self.options.limits))
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        let records = footer
            .recordBatches()
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC footer has no record-batch index",
                )
            })?
            .iter()
            .map(|block| {
                Ok(IndexedRecordBlock {
                    block: file_block_spec(*block, self.source_length, &self.options.limits)?,
                    row_start: 0,
                    row_count: 0,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let state = FileIndexState {
            schema,
            version: footer.version(),
            dictionaries,
            records,
            next_dictionary: 0,
            next_record: 0,
            rows: 0,
        };
        if state.metadata_complete() {
            self.complete_file(state).map(Some)
        } else {
            self.state = OpenState::FileIndex(state);
            Ok(None)
        }
    }

    fn feed_file_metadata(
        &mut self,
        mut state: FileIndexState,
        bytes: &[u8],
    ) -> Result<Option<OpenedArrowIpcSource>> {
        index_file_metadata(&mut state, bytes, &self.options.limits)?;
        if state.metadata_complete() {
            self.complete_file(state).map(Some)
        } else {
            self.state = OpenState::FileIndex(state);
            Ok(None)
        }
    }

    fn complete_file(&mut self, state: FileIndexState) -> Result<OpenedArrowIpcSource> {
        let metadata = exact_metadata(
            &state.schema,
            u64::try_from(state.rows).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC row count overflows")
            })?,
            self.options.table_name.clone(),
        )?;
        self.state = OpenState::Complete;
        Ok(OpenedArrowIpcSource::File(ArrowIndexedFileSource {
            source_length: self.source_length,
            schema: state.schema,
            metadata,
            version: state.version,
            dictionaries: state.dictionaries,
            records: state.records,
            limits: self.options.limits.clone(),
        }))
    }

    fn feed_stream_owned(
        &mut self,
        mut state: StreamIndexState,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<OpenedArrowIpcSource>> {
        state.wire.feed(&bytes, &self.options.limits)?;
        state.wire.ensure_decode_memory_budget(
            state.decoded_bytes,
            bytes.len(),
            &self.options.limits,
        )?;
        let bytes_len = bytes.len();
        let mut buffer = Buffer::from_vec(bytes);
        while !buffer.is_empty() {
            if let Some(batch) = state
                .decoder
                .decode(&mut buffer)
                .map_err(|error| arrow_error("decode IPC Stream chunk", error))?
            {
                // StreamDecoder may zero-copy several columns from the same
                // ingress allocation. Retaining those views both pins the
                // whole chunk and makes Array::get_array_memory_size count
                // that shared allocation once per column. Compact the batch
                // before storing it so the operation retains only decoded
                // array buffers and can release this input chunk promptly.
                let batch = detach_record_batch_from_ingress(batch)?;
                state.decoded_bytes = state
                    .decoded_bytes
                    .checked_add(batch.get_array_memory_size())
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC decoded memory estimate overflows",
                        )
                    })?;
                state.rows = state.rows.checked_add(batch.num_rows()).ok_or_else(|| {
                    TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC row count overflows")
                })?;
                state.row_offsets.push(state.rows);
                if state.decoded_bytes > self.options.limits.max_decoded_bytes {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow IPC decoded arrays exceed the configured byte limit",
                    )
                    .with_detail("decodedBytes", state.decoded_bytes)
                    .with_detail("maxDecodedBytes", self.options.limits.max_decoded_bytes));
                }
                state.wire.ensure_decode_memory_budget(
                    state.decoded_bytes,
                    bytes_len,
                    &self.options.limits,
                )?;
                state.batches.push(batch);
            }
            if !state.schema_validated {
                if let Some(schema) = state.decoder.schema() {
                    validate_schema(&schema, &self.options.limits)?;
                    state.schema_validated = true;
                }
            }
        }
        state.next_offset = state.next_offset.checked_add(bytes_len).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "Arrow stream offset overflows")
        })?;
        if eof {
            state.wire.finish()?;
            state
                .decoder
                .finish()
                .map_err(|error| arrow_error("finish IPC Stream", error))?;
            let schema = state.decoder.schema().ok_or_else(|| {
                TabularkError::new(ErrorCode::ParseFailed, "Arrow IPC Stream has no schema")
            })?;
            let rows = u64::try_from(state.rows).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC row count exceeds the public range",
                )
            })?;
            let source = ArrowIpcSource {
                container: ResolvedArrowIpcContainer::Stream,
                arrow_schema: schema.clone(),
                metadata: exact_metadata(&schema, rows, self.options.table_name.clone())?,
                batches: state.batches,
                row_offsets: state.row_offsets,
                decoded_bytes: state.decoded_bytes,
                limits: self.options.limits.clone(),
            };
            self.state = OpenState::Complete;
            Ok(Some(OpenedArrowIpcSource::Stream(source)))
        } else {
            self.state = OpenState::Stream(Box::new(state));
            Ok(None)
        }
    }
}

/// Footer-indexed Arrow IPC File metadata without retained record bodies.
#[derive(Clone, Debug)]
pub struct ArrowIndexedFileSource {
    source_length: usize,
    schema: ArrowSchemaRef,
    metadata: TableMetadata,
    version: MetadataVersion,
    dictionaries: Vec<FileBlockSpec>,
    records: Vec<IndexedRecordBlock>,
    limits: ArrowIpcLimits,
}

impl ArrowIndexedFileSource {
    /// Returns exact File table metadata.
    #[must_use]
    pub const fn metadata(&self) -> &TableMetadata {
        &self.metadata
    }
}

#[derive(Debug)]
struct RequiredFileBlock {
    spec: FileBlockSpec,
    kind: RequiredBlockKind,
}

#[derive(Clone, Copy, Debug)]
enum RequiredBlockKind {
    Dictionary,
    Record(usize),
}

/// Range operation that requests only dictionaries and intersecting File blocks.
#[derive(Debug)]
pub struct ArrowFileReadOperation {
    source: ArrowIndexedFileSource,
    plan: RangePlan,
    mode: ArrowBatchMode,
    required: Vec<RequiredFileBlock>,
    decoder: Option<FileDecoder>,
    decoded: Vec<(usize, RecordBatch)>,
    decoded_bytes: usize,
    retained_dictionary_bytes: usize,
    declared_decompressed_bytes: usize,
    next_block: usize,
    ready: Option<TypedTableBatch>,
}

impl ArrowFileReadOperation {
    fn new(
        source: ArrowIndexedFileSource,
        request: RangeRequest,
        mode: ArrowBatchMode,
    ) -> Result<Self> {
        let total_rows = usize::try_from(source.metadata.extent().rows().value().unwrap_or(0))
            .map_err(|_| invalid_range())?;
        let plan = plan_range(
            request,
            total_rows,
            source.schema.fields().len(),
            &source.limits,
        )?;
        let mut required = Vec::new();
        if plan.returned_rows > 0 && plan.returned_columns > 0 {
            let projection_uses_dictionary = source.schema.fields()
                [plan.column_start..plan.column_start + plan.returned_columns]
                .iter()
                .any(|field| data_type_uses_dictionary(field.data_type()));
            if projection_uses_dictionary {
                required.extend(source.dictionaries.iter().cloned().map(|spec| {
                    RequiredFileBlock {
                        spec,
                        kind: RequiredBlockKind::Dictionary,
                    }
                }));
            }
            let row_end = plan.row_start + plan.returned_rows;
            required.extend(
                source
                    .records
                    .iter()
                    .enumerate()
                    .filter(|(_, record)| {
                        let record_end = record.row_start + record.row_count;
                        record.row_start < row_end && record_end > plan.row_start
                    })
                    .map(|(index, record)| RequiredFileBlock {
                        spec: record.block.clone(),
                        kind: RequiredBlockKind::Record(index),
                    }),
            );
        }
        let projection =
            (plan.column_start..plan.column_start + plan.returned_columns).collect::<Vec<_>>();
        let decoder = (!required.is_empty()).then(|| {
            FileDecoder::new(source.schema.clone(), source.version).with_projection(projection)
        });
        let mut operation = Self {
            source,
            plan,
            mode,
            required,
            decoder,
            decoded: Vec::new(),
            decoded_bytes: 0,
            retained_dictionary_bytes: 0,
            declared_decompressed_bytes: 0,
            next_block: 0,
            ready: None,
        };
        if operation.required.is_empty() {
            operation.ready = Some(operation.build_batch()?);
        }
        Ok(operation)
    }

    /// Returns whether no byte action is needed.
    #[must_use]
    pub const fn is_ready(&self) -> bool {
        self.ready.is_some()
    }

    /// Consumes an immediately ready operation.
    pub fn into_ready(mut self) -> Result<TypedTableBatch> {
        self.ready.take().ok_or_else(|| {
            TabularkError::new(ErrorCode::RuntimeFailure, "Arrow File range is not ready")
        })
    }

    /// Returns the next File block action.
    pub fn next_action(&self) -> Result<Option<ReadBytesAction>> {
        let Some(block) = self.required.get(self.next_block) else {
            return Ok(None);
        };
        Ok(Some(ReadBytesAction::new(
            block.spec.offset,
            block.spec.total_length()?,
            self.source.source_length,
        )?))
    }

    /// Supplies one exact File block and completes once all hits are decoded.
    pub fn feed(
        &mut self,
        offset: u64,
        bytes: &[u8],
        eof: bool,
    ) -> Result<Option<TypedTableBatch>> {
        self.feed_owned(offset, bytes.to_vec(), eof)
    }

    /// Supplies one owned File block without making another ingress copy.
    ///
    /// WASM callers should prefer this entry point after copying a JavaScript
    /// `Uint8Array` into linear memory so ownership can pass directly to
    /// arrow-rs.
    pub fn feed_owned(
        &mut self,
        offset: u64,
        bytes: Vec<u8>,
        eof: bool,
    ) -> Result<Option<TypedTableBatch>> {
        self.feed_buffer(offset, Buffer::from_vec(bytes), eof)
    }

    fn feed_buffer(
        &mut self,
        offset: u64,
        buffer: Buffer,
        eof: bool,
    ) -> Result<Option<TypedTableBatch>> {
        let bytes = buffer.as_slice();
        let expected = self.next_action()?.ok_or_else(|| {
            TabularkError::new(
                ErrorCode::HandleClosed,
                "Arrow File read operation is complete",
            )
        })?;
        validate_action_response(expected, offset, bytes, eof, self.source.source_length)?;

        let required = self.required.get(self.next_block).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow File read block plan is inconsistent",
            )
        })?;
        let spec = required.spec.clone();
        let kind = required.kind;
        let mut declared_decompressed_bytes = self.declared_decompressed_bytes;
        preflight_compressed_block(
            bytes,
            spec.metadata_length,
            spec.body_length,
            &self.source.limits,
            &mut declared_decompressed_bytes,
        )?;
        let declared_for_block = declared_decompressed_bytes
            .checked_sub(self.declared_decompressed_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Arrow File decompression accounting moved backwards",
                )
            })?;
        let decoded_for_block = spec.body_length.max(declared_for_block);
        ensure_file_read_transient_memory_budget(
            self.retained_dictionary_bytes,
            self.decoded_bytes,
            buffer.capacity().max(buffer.len()),
            decoded_for_block,
            &self.source.limits,
        )?;
        let block = spec.as_arrow_block()?;
        let decoder = self.decoder.as_mut().ok_or_else(|| {
            TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow File decoder is unavailable",
            )
        })?;
        match kind {
            RequiredBlockKind::Dictionary => {
                decoder
                    .read_dictionary(&block, &buffer)
                    .map_err(|error| arrow_error("decode IPC File dictionary", error))?;
                let retained_for_dictionary = spec.body_length.max(declared_for_block);
                let retained_dictionary_bytes = self
                    .retained_dictionary_bytes
                    .checked_add(retained_for_dictionary)
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC retained dictionary memory estimate overflows",
                        )
                    })?;
                ensure_file_read_memory_budget(
                    retained_dictionary_bytes,
                    self.decoded_bytes,
                    &self.source.limits,
                )?;
                self.retained_dictionary_bytes = retained_dictionary_bytes;
            }
            RequiredBlockKind::Record(index) => {
                let batch = decoder
                    .read_record_batch(&block, &buffer)
                    .map_err(|error| arrow_error("decode IPC File record batch", error))?
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ParseFailed,
                            "Arrow IPC File block did not contain a record batch",
                        )
                    })?;
                // FileDecoder may zero-copy each projected array from `buffer`.
                // Detach the projection before this iteration ends: otherwise a
                // tiny requested column can keep the entire (potentially wide)
                // record block alive until the final range batch is assembled.
                let batch = detach_record_batch_from_ingress(batch)?;
                let decoded_bytes = self
                    .decoded_bytes
                    .checked_add(batch.get_array_memory_size())
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Arrow IPC decoded memory estimate overflows",
                        )
                    })?;
                ensure_file_read_memory_budget(
                    self.retained_dictionary_bytes,
                    decoded_bytes,
                    &self.source.limits,
                )?;
                self.decoded_bytes = decoded_bytes;
                self.decoded.push((index, batch));
            }
        }
        drop(buffer);
        self.declared_decompressed_bytes = declared_decompressed_bytes;
        self.next_block += 1;
        if self.next_block == self.required.len() {
            // Record batches retain any dictionary arrays they reference. Drop
            // the decoder's dictionary map before constructing the output so
            // it does not add another owner during typed-batch encoding.
            self.decoder.take();
            Ok(Some(self.build_batch()?))
        } else {
            Ok(None)
        }
    }

    fn build_batch(&mut self) -> Result<TypedTableBatch> {
        if self.required.is_empty() {
            let arrays = (self.plan.column_start
                ..self.plan.column_start + self.plan.returned_columns)
                .map(|index| {
                    (
                        index,
                        new_empty_array(self.source.schema.field(index).data_type()),
                    )
                })
                .collect::<Vec<_>>();
            return encode_batch(
                &self.source.schema,
                arrays,
                self.plan.returned_range,
                self.plan.complete,
                &self.source.limits,
                self.mode,
            );
        }

        let projection = (self.plan.column_start
            ..self.plan.column_start + self.plan.returned_columns)
            .collect::<Vec<_>>();
        ensure_file_read_assembly_memory_budget(self.decoded_bytes, &self.source.limits)?;
        let decoded = std::mem::take(&mut self.decoded);

        let range_end = self.plan.row_start + self.plan.returned_rows;
        let mut arrays = Vec::with_capacity(projection.len());
        for (projected_index, original_index) in projection.iter().copied().enumerate() {
            let mut parts = Vec::new();
            for (record_index, batch) in &decoded {
                let record = &self.source.records[*record_index];
                let record_end = record.row_start + record.row_count;
                let start = self.plan.row_start.max(record.row_start);
                let end = range_end.min(record_end);
                if start < end {
                    parts.push(
                        batch
                            .column(projected_index)
                            .slice(start - record.row_start, end - start),
                    );
                }
            }
            arrays.push((
                original_index,
                normalize_array_parts(parts, self.source.schema.field(original_index).data_type())?,
            ));
        }
        drop(decoded);
        self.decoded_bytes = 0;
        self.retained_dictionary_bytes = 0;
        encode_batch(
            &self.source.schema,
            arrays,
            self.plan.returned_range,
            self.plan.complete,
            &self.source.limits,
            self.mode,
        )
    }
}

fn ensure_file_read_memory_budget(
    retained_dictionary_bytes: usize,
    decoded_bytes: usize,
    limits: &ArrowIpcLimits,
) -> Result<()> {
    let retained_bytes = retained_dictionary_bytes
        .checked_add(decoded_bytes)
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC File range retained-memory estimate overflows",
            )
        })?;
    if retained_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC File range retained arrays exceed the configured byte limit",
        )
        .with_detail("retainedDictionaryBytes", retained_dictionary_bytes)
        .with_detail("decodedBytes", decoded_bytes)
        .with_detail("retainedBytes", retained_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    Ok(())
}

fn ensure_file_read_assembly_memory_budget(
    decoded_bytes: usize,
    limits: &ArrowIpcLimits,
) -> Result<()> {
    // The final per-column concat allocates normalized arrays while all
    // detached per-block arrays are still live. The old batches are dropped
    // before typed-buffer encoding begins, which is budgeted separately by
    // `encode_typed_batch`.
    let peak_bytes = decoded_bytes.checked_mul(2).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC File range assembly-memory estimate overflows",
        )
    })?;
    if peak_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC File range assembly would exceed the configured peak-memory limit",
        )
        .with_detail("decodedBytes", decoded_bytes)
        .with_detail("peakBytes", peak_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    Ok(())
}

fn ensure_file_read_transient_memory_budget(
    retained_dictionary_bytes: usize,
    decoded_bytes: usize,
    ingress_bytes: usize,
    decoded_for_block: usize,
    limits: &ArrowIpcLimits,
) -> Result<()> {
    let retained_bytes = retained_dictionary_bytes
        .checked_add(decoded_bytes)
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC File range retained-memory estimate overflows",
            )
        })?;
    // A record can temporarily own decoded buffers and their compact
    // projection copy. Dictionary deltas likewise concatenate old and new
    // values while both inputs remain live. A projected dictionary record can
    // also copy the decoder's retained values, so reserve that state once more.
    let transient_decoded_bytes = decoded_for_block
        .checked_mul(2)
        .and_then(|value| value.checked_add(retained_dictionary_bytes))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC File block transient-memory estimate overflows",
            )
        })?;
    let peak_bytes = retained_bytes
        .checked_add(ingress_bytes)
        .and_then(|value| value.checked_add(transient_decoded_bytes))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC File range peak-memory estimate overflows",
            )
        })?;
    if peak_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC File block would exceed the configured peak-memory limit",
        )
        .with_detail("retainedBytes", retained_bytes)
        .with_detail("ingressBytes", ingress_bytes)
        .with_detail("decodedBlockBytes", decoded_for_block)
        .with_detail("transientDecodedBytes", transient_decoded_bytes)
        .with_detail("peakBytes", peak_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    Ok(())
}

fn detach_record_batch_from_ingress(batch: RecordBatch) -> Result<RecordBatch> {
    let schema = batch.schema_ref().clone();
    let columns = batch
        .columns()
        .iter()
        .cloned()
        .map(detach_array_from_ingress)
        .collect::<Result<Vec<_>>>()?;
    RecordBatch::try_new(schema, columns)
        .map_err(|error| arrow_error("detach decoded IPC arrays from ingress", error))
}

fn detach_array_from_ingress(array: ArrayRef) -> Result<ArrayRef> {
    // `concat` has a one-array zero-copy fast path, so normalize against a
    // second empty array to force a compact allocation. View arrays are a
    // special case: Arrow's concat builder reuses their external data buffers,
    // so recursively garbage-collect any view children after normalization.
    // This intentionally trades one bounded decoded-array copy for releasing
    // a full File block or Stream chunk as soon as it has been decoded.
    let data_type = array.data_type().clone();
    let normalized = normalize_array_parts(vec![array], &data_type)?;
    compact_view_buffers(normalized)
}

fn compact_view_buffers(array: ArrayRef) -> Result<ArrayRef> {
    Ok(make_array(compact_view_array_data(array.to_data())?))
}

fn compact_view_array_data(data: ArrayData) -> Result<ArrayData> {
    match data.data_type() {
        ArrowDataType::Utf8View => {
            let array = make_array(data);
            let view = array
                .as_any()
                .downcast_ref::<StringViewArray>()
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Arrow Utf8View array has an unexpected implementation",
                    )
                })?;
            Ok(view.gc().to_data())
        }
        ArrowDataType::BinaryView => {
            let array = make_array(data);
            let view = array
                .as_any()
                .downcast_ref::<BinaryViewArray>()
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Arrow BinaryView array has an unexpected implementation",
                    )
                })?;
            Ok(view.gc().to_data())
        }
        _ if data.child_data().is_empty() => Ok(data),
        _ => {
            let children = data
                .child_data()
                .iter()
                .cloned()
                .map(compact_view_array_data)
                .collect::<Result<Vec<_>>>()?;
            data.into_builder()
                .child_data(children)
                .build()
                .map_err(|error| arrow_error("compact projected Arrow view buffers", error))
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct RangePlan {
    row_start: usize,
    returned_rows: usize,
    column_start: usize,
    returned_columns: usize,
    returned_range: RangeRequest,
    complete: bool,
}

fn plan_range(
    request: RangeRequest,
    total_rows: usize,
    total_columns: usize,
    limits: &ArrowIpcLimits,
) -> Result<RangePlan> {
    request.validate_public()?;
    let cells = request.cell_count()?;
    if cells > limits.max_range_cells {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC range exceeds the configured cell limit",
        )
        .with_detail("rangeCells", cells)
        .with_detail("maxRangeCells", limits.max_range_cells));
    }
    let row_start = usize::try_from(request.row_start()).map_err(|_| invalid_range())?;
    let column_start = usize::try_from(request.column_start()).map_err(|_| invalid_range())?;
    if row_start > total_rows || column_start > total_columns {
        return Err(invalid_range());
    }
    let requested_rows = usize::try_from(request.row_count()).map_err(|_| invalid_range())?;
    let requested_columns = usize::try_from(request.column_count()).map_err(|_| invalid_range())?;
    let returned_rows = requested_rows.min(total_rows.saturating_sub(row_start));
    let returned_columns = requested_columns.min(total_columns.saturating_sub(column_start));
    Ok(RangePlan {
        row_start,
        returned_rows,
        column_start,
        returned_columns,
        returned_range: RangeRequest::new(
            request.row_start(),
            u64::try_from(returned_rows).map_err(|_| invalid_range())?,
            request.column_start(),
            u64::try_from(returned_columns).map_err(|_| invalid_range())?,
        )?,
        complete: returned_rows == requested_rows && returned_columns == requested_columns,
    })
}

/// Encodes projected Arrow record batches into Tabulark's private typed-buffer
/// layout while retaining the original top-level schema column identities.
///
/// This narrow bridge is shared by Arrow-backed official adapters such as
/// Parquet. Each input batch must contain exactly the projected columns in the
/// same order as `source_column_indices`.
pub fn encode_projected_record_batches(
    schema: &ArrowSchemaRef,
    batches: &[RecordBatch],
    source_column_indices: &[usize],
    returned_range: RangeRequest,
    complete: bool,
    limits: &ArrowIpcLimits,
) -> Result<TypedTableBatch> {
    encode_projected_record_batches_with_mode(
        schema,
        batches,
        source_column_indices,
        returned_range,
        complete,
        limits,
        ArrowBatchMode::Typed,
    )
}

/// Encodes only the bounded display representation for an Arrow-backed
/// preview. Native descriptors are null placeholders and retain no buffers.
#[cfg(feature = "parquet")]
pub(crate) fn encode_projected_record_batches_for_display(
    schema: &ArrowSchemaRef,
    batches: &[RecordBatch],
    source_column_indices: &[usize],
    returned_range: RangeRequest,
    complete: bool,
    limits: &ArrowIpcLimits,
) -> Result<TypedTableBatch> {
    encode_projected_record_batches_with_mode(
        schema,
        batches,
        source_column_indices,
        returned_range,
        complete,
        limits,
        ArrowBatchMode::DisplayOnly,
    )
}

/// Formats projected Arrow batches into bounded UTF-8 columns without
/// constructing native output descriptors. Parquet's display-only preview
/// decoder uses this for ordinary columns while decoding oversized fixed-width
/// lists through its bounded column path.
#[cfg(feature = "parquet")]
pub(crate) fn projected_record_batches_to_display_arrays(
    schema: &ArrowSchemaRef,
    batches: &[RecordBatch],
    source_column_indices: &[usize],
    returned_range: RangeRequest,
    limits: &ArrowIpcLimits,
) -> Result<Vec<(usize, StringArray)>> {
    let row_count = usize::try_from(returned_range.row_count()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "projected Arrow display row count exceeds usize",
        )
    })?;
    // Bounded-list previews use the other half of decoded memory while these
    // ordinary display columns remain live. Share one aggregate output budget
    // across all ordinary columns instead of applying it once per column.
    let decoded_array_bytes = batches.iter().try_fold(0_usize, |total, batch| {
        total
            .checked_add(batch.get_array_memory_size())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "projected Arrow display source size overflows",
                )
                .with_detail("resource", "typed-batch-decoded")
            })
    })?;
    if decoded_array_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "projected Arrow display source exceeds the decoded-memory limit",
        )
        .with_detail("resource", "typed-batch-decoded")
        .with_detail("arrayBytes", decoded_array_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    let mut remaining_display_bytes = limits
        .max_output_bytes
        .min(limits.max_decoded_bytes.checked_div(2).unwrap_or(0))
        .min(limits.max_decoded_bytes - decoded_array_bytes);
    let mut arrays = Vec::with_capacity(source_column_indices.len());
    for (projected_index, source_index) in source_column_indices.iter().copied().enumerate() {
        let data_type = schema
            .fields()
            .get(source_index)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidRange,
                    "projected Arrow display column lies outside the source schema",
                )
            })?
            .data_type();
        let mut parts = batches
            .iter()
            .map(|batch| {
                batch
                    .columns()
                    .get(projected_index)
                    .cloned()
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::InvalidArgument,
                            "projected Arrow display batch column count is inconsistent",
                        )
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        let array = match parts.len() {
            0 => new_empty_array(data_type),
            1 => parts.pop().expect("one projected array part"),
            _ => normalize_array_parts(parts, data_type)?,
        };
        if array.len() != row_count {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "projected Arrow display row count is inconsistent",
            ));
        }
        let display = display_array_with_total_limit(
            array.as_ref(),
            limits
                .max_display_cell_bytes
                .min(DISPLAY_ONLY_MAX_CELL_BYTES),
            remaining_display_bytes,
        )?;
        let display_bytes = display_structural_bytes(&display)?
            .checked_add(display.value_data().len())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "projected Arrow display byte total overflows",
                )
            })?;
        remaining_display_bytes = remaining_display_bytes.saturating_sub(display_bytes);
        arrays.push((source_index, display));
    }
    Ok(arrays)
}

/// Encodes already formatted UTF-8 display columns into one display-only
/// typed batch. All native arrays are null placeholders, so callers never
/// duplicate the source values at the Worker boundary.
#[cfg(feature = "parquet")]
pub(crate) fn encode_display_string_arrays(
    arrays: Vec<(usize, StringArray)>,
    returned_range: RangeRequest,
    complete: bool,
    limits: &ArrowIpcLimits,
) -> Result<TypedTableBatch> {
    if u64::try_from(arrays.len()).ok() != Some(returned_range.column_count()) {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "display-only Arrow column count does not match the returned range",
        ));
    }
    let retained_array_bytes = arrays.iter().try_fold(0_usize, |total, (_, array)| {
        total
            .checked_add(array.get_array_memory_size())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "display-only Arrow array size overflows",
                )
                .with_detail("resource", "typed-batch-decoded")
            })
    })?;
    if retained_array_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "display-only Arrow arrays exceed the configured decoded-memory limit",
        )
        .with_detail("resource", "typed-batch-decoded")
        .with_detail("arrayBytes", retained_array_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    let output_limit = limits
        .max_output_bytes
        .min(limits.max_decoded_bytes - retained_array_bytes);
    let mut pool = BufferPoolBuilder::new(output_limit);
    let mut columns = Vec::with_capacity(arrays.len());
    for (source_index, array) in arrays {
        if u64::try_from(array.len()).ok() != Some(returned_range.row_count()) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "display-only Arrow array length does not match the returned range",
            ));
        }
        let native = ArrayDescriptor::new(
            TableDataType::Null,
            returned_range.row_count(),
            None,
            ArrayLayout::Null,
        )?;
        let display = descriptor_from_array(&array, None, &mut pool)?;
        columns.push(TypedColumnBatch::new(
            format!("c{source_index}"),
            native,
            display,
        )?);
    }
    TypedTableBatch::new(
        "table-0",
        0,
        1,
        returned_range,
        complete,
        pool.finish(),
        columns,
    )
}

fn encode_projected_record_batches_with_mode(
    schema: &ArrowSchemaRef,
    batches: &[RecordBatch],
    source_column_indices: &[usize],
    returned_range: RangeRequest,
    complete: bool,
    limits: &ArrowIpcLimits,
    mode: ArrowBatchMode,
) -> Result<TypedTableBatch> {
    if u64::try_from(source_column_indices.len()).ok() != Some(returned_range.column_count()) {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "projected Arrow column count does not match the returned range",
        ));
    }
    let row_count = batches.iter().try_fold(0_usize, |total, batch| {
        if batch.num_columns() != source_column_indices.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "projected Arrow batch column count is inconsistent",
            ));
        }
        total.checked_add(batch.num_rows()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "projected Arrow batch row count overflows",
            )
        })
    })?;
    if u64::try_from(row_count).ok() != Some(returned_range.row_count()) {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "projected Arrow row count does not match the returned range",
        ));
    }

    let mut arrays = Vec::with_capacity(source_column_indices.len());
    for (projected_index, source_index) in source_column_indices.iter().copied().enumerate() {
        let data_type = schema
            .fields()
            .get(source_index)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidRange,
                    "projected Arrow column lies outside the source schema",
                )
            })?
            .data_type();
        let parts = batches
            .iter()
            .map(|batch| batch.column(projected_index).clone())
            .collect::<Vec<_>>();
        arrays.push((source_index, normalize_array_parts(parts, data_type)?));
    }
    encode_batch(schema, arrays, returned_range, complete, limits, mode)
}

fn encode_batch(
    schema: &ArrowSchemaRef,
    arrays: Vec<(usize, ArrayRef)>,
    returned_range: RangeRequest,
    complete: bool,
    limits: &ArrowIpcLimits,
    mode: ArrowBatchMode,
) -> Result<TypedTableBatch> {
    let array_bytes = arrays.iter().try_fold(0_usize, |total, (_, array)| {
        total
            .checked_add(array.get_array_memory_size())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "typed batch retained-array size overflows",
                )
                .with_detail("resource", "typed-batch-decoded")
            })
    })?;
    if array_bytes > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "typed batch arrays exceed the configured decoded-memory limit",
        )
        .with_detail("resource", "typed-batch-decoded")
        .with_detail("arrayBytes", array_bytes)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    let output_limit = limits
        .max_output_bytes
        .min(limits.max_decoded_bytes.saturating_sub(array_bytes));
    let mut pool = BufferPoolBuilder::new(output_limit);
    // Typed reads encode native descriptors before spending a byte on preview
    // text. Display-only reads intentionally omit those buffers and use null
    // native placeholders with the same logical length.
    let mut encoded = Vec::with_capacity(arrays.len());
    for (column_index, array) in arrays {
        let native = match mode {
            ArrowBatchMode::Typed => {
                let field = schema.field(column_index);
                descriptor_from_array(array.as_ref(), Some(field), &mut pool)?
            }
            ArrowBatchMode::DisplayOnly => ArrayDescriptor::new(
                TableDataType::Null,
                u64::try_from(array.len()).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "display-only batch row count exceeds u64",
                    )
                })?,
                None,
                ArrayLayout::Null,
            )?,
        };
        encoded.push((column_index, array, native));
    }
    let structural_bytes = encoded.iter().try_fold(0_usize, |total, (_, array, _)| {
        total
            .checked_add(display_structural_bytes(array.as_ref())?)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow display structural byte total overflows",
                )
            })
    })?;
    if structural_bytes > pool.remaining_bytes() {
        return Err(display_total_limit_error(
            structural_bytes,
            pool.remaining_bytes(),
        ));
    }
    let mut remaining_value_bytes = pool.remaining_bytes() - structural_bytes;
    let mut remaining_cells = encoded.iter().try_fold(0_usize, |total, (_, array, _)| {
        total
            .checked_add(logical_value_count(array.as_ref()))
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow display cell count overflows",
                )
            })
    })?;
    let mut columns = Vec::with_capacity(encoded.len());
    for (column_index, array, native) in encoded {
        let column_structural_bytes = display_structural_bytes(array.as_ref())?;
        let column_cells = logical_value_count(array.as_ref());
        let column_value_budget = if remaining_cells == 0 {
            0
        } else {
            remaining_value_bytes
                .saturating_mul(column_cells)
                .div_ceil(remaining_cells)
        };
        let max_display_cell_bytes = match mode {
            ArrowBatchMode::Typed => limits.max_display_cell_bytes,
            ArrowBatchMode::DisplayOnly => limits
                .max_display_cell_bytes
                .min(DISPLAY_ONLY_MAX_CELL_BYTES),
        };
        let display_array = display_array_with_total_limit(
            array.as_ref(),
            max_display_cell_bytes,
            column_structural_bytes.saturating_add(column_value_budget),
        )?;
        let display = descriptor_from_array(&display_array, None, &mut pool)?;
        let used_value_bytes = display_array.value_data().len();
        remaining_value_bytes = remaining_value_bytes.saturating_sub(used_value_bytes);
        remaining_cells = remaining_cells.saturating_sub(column_cells);
        columns.push(TypedColumnBatch::new(
            format!("c{column_index}"),
            native,
            display,
        )?);
    }
    TypedTableBatch::new(
        "table-0",
        0,
        1,
        returned_range,
        complete,
        pool.finish(),
        columns,
    )
}

fn normalize_array_parts(parts: Vec<ArrayRef>, data_type: &ArrowDataType) -> Result<ArrayRef> {
    if parts.is_empty() {
        return Ok(new_empty_array(data_type));
    }
    let empty = new_empty_array(data_type);
    let mut references = parts.iter().map(|array| array.as_ref()).collect::<Vec<_>>();
    references.push(empty.as_ref());
    concat(&references).map_err(|error| arrow_error("concatenate range", error))
}

/// Builds exact typed table metadata from an Arrow schema.
pub fn exact_metadata(
    arrow_schema: &ArrowSchemaRef,
    rows: u64,
    table_name: String,
) -> Result<TableMetadata> {
    table_metadata(arrow_schema, AxisExtent::exact(rows)?, table_name)
}

fn progressive_metadata(
    arrow_schema: &ArrowSchemaRef,
    rows: u64,
    table_name: String,
) -> Result<TableMetadata> {
    table_metadata(arrow_schema, AxisExtent::at_least(rows)?, table_name)
}

fn table_metadata(
    arrow_schema: &ArrowSchemaRef,
    rows: AxisExtent,
    table_name: String,
) -> Result<TableMetadata> {
    let columns = arrow_schema
        .fields()
        .iter()
        .enumerate()
        .map(|(index, field)| column_schema(index, field))
        .collect::<Result<Vec<_>>>()?;
    let schema = Schema::new(1, columns)?;
    let column_count = u64::try_from(arrow_schema.fields().len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC column count exceeds the public range",
        )
    })?;
    Ok(TableMetadata::new(
        "table-0",
        table_name,
        0,
        TableExtent::new(rows, AxisExtent::exact(column_count)?),
        schema,
        Capabilities::typed(if rows.is_exact() {
            RandomAccess::Full
        } else {
            RandomAccess::IndexedPrefix
        }),
    ))
}

fn file_block_spec(
    block: Block,
    source_length: usize,
    limits: &ArrowIpcLimits,
) -> Result<FileBlockSpec> {
    let offset = usize::try_from(block.offset()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block has a negative offset",
        )
    })?;
    let metadata_length = usize::try_from(block.metaDataLength()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block has a negative metadata length",
        )
    })?;
    let body_length = usize::try_from(block.bodyLength()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block has a negative body length",
        )
    })?;
    if metadata_length < 4 || metadata_length > limits.max_metadata_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC block metadata exceeds the configured limit",
        ));
    }
    let spec = FileBlockSpec {
        offset,
        metadata_length,
        body_length,
    };
    let total = spec.total_length()?;
    if total > limits.max_block_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC block exceeds the configured encoded byte limit",
        )
        .with_detail("blockBytes", total)
        .with_detail("maxBlockBytes", limits.max_block_bytes));
    }
    ReadBytesAction::new(offset, total, source_length)?;
    Ok(spec)
}

fn flatbuffer_verifier_options(limits: &ArrowIpcLimits) -> VerifierOptions {
    let max_tables = limits
        .max_fields
        .checked_mul(4)
        .and_then(|value| value.checked_add(1024))
        .unwrap_or(usize::MAX);
    VerifierOptions {
        max_depth: limits.max_nesting_depth,
        max_tables,
        max_apparent_size: limits.max_metadata_bytes.saturating_mul(16),
        ..VerifierOptions::default()
    }
}

fn validate_stream_message(
    metadata: &[u8],
    limits: &ArrowIpcLimits,
    schema_seen: bool,
) -> Result<StreamMessageValidation> {
    let verifier_options = flatbuffer_verifier_options(limits);
    let message = root_as_message_with_opts(&verifier_options, metadata)
        .map_err(|error| flatbuffer_error("parse Arrow IPC Stream message metadata", error))?;
    let header_type = message.header_type();
    if matches!(
        header_type,
        MessageHeader::Tensor | MessageHeader::SparseTensor
    ) {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "Arrow tensor and sparse-tensor IPC messages are not supported",
        ));
    }
    if !schema_seen && header_type != MessageHeader::Schema {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC Stream does not begin with a schema message",
        ));
    }
    if header_type == MessageHeader::Schema {
        if schema_seen {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC Stream contains more than one schema message",
            ));
        }
        let schema = message.header_as_schema().ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC Stream schema message has no schema header",
            )
        })?;
        if !schema.endianness().equals_to_target_endianness() {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "Arrow IPC source uses non-native endianness",
            ));
        }
    }
    let body_length = usize::try_from(message.bodyLength()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC Stream message has a negative body length",
        )
    })?;
    let block_length = metadata.len().checked_add(body_length).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC Stream block length overflows",
        )
    })?;
    if block_length > limits.max_block_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC Stream block exceeds the configured encoded byte limit",
        )
        .with_detail("blockBytes", block_length)
        .with_detail("maxBlockBytes", limits.max_block_bytes));
    }
    let (memory_kind, compressed) = match header_type {
        MessageHeader::RecordBatch => {
            let batch = message.header_as_record_batch().ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC record message has no RecordBatch header",
                )
            })?;
            (
                StreamMessageMemoryKind::Record,
                batch.compression().is_some(),
            )
        }
        MessageHeader::DictionaryBatch => {
            let dictionary = message.header_as_dictionary_batch().ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC dictionary message has no DictionaryBatch header",
                )
            })?;
            let batch = dictionary.data().ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC dictionary message has no RecordBatch body header",
                )
            })?;
            (
                StreamMessageMemoryKind::Dictionary {
                    id: dictionary.id(),
                    is_delta: dictionary.isDelta(),
                },
                batch.compression().is_some(),
            )
        }
        _ => (StreamMessageMemoryKind::None, false),
    };
    let compressed_buffers = compressed_buffer_specs(&message, body_length)?;
    Ok(StreamMessageValidation {
        header_type,
        body_length,
        compressed_buffers,
        memory_kind,
        compressed,
    })
}

fn compressed_buffer_specs(
    message: &arrow_ipc::Message<'_>,
    body_length: usize,
) -> Result<Vec<CompressedBufferSpec>> {
    let batch = match message.header_type() {
        MessageHeader::RecordBatch => message.header_as_record_batch(),
        MessageHeader::DictionaryBatch => message
            .header_as_dictionary_batch()
            .and_then(|dictionary| dictionary.data()),
        _ => None,
    };
    let Some(batch) = batch else {
        return Ok(Vec::new());
    };
    if batch.compression().is_none() {
        return Ok(Vec::new());
    }
    let buffers = batch.buffers().ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC compressed record batch has no buffer index",
        )
    })?;
    let mut specs = Vec::with_capacity(buffers.len());
    for buffer in buffers {
        let offset = usize::try_from(buffer.offset()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC compressed buffer has a negative offset",
            )
        })?;
        let encoded_length = usize::try_from(buffer.length()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC compressed buffer has a negative length",
            )
        })?;
        if encoded_length == 0 {
            continue;
        }
        if encoded_length < 8 {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC compressed buffer is shorter than its decoded-length prefix",
            ));
        }
        let end = offset.checked_add(encoded_length).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC compressed buffer range overflows",
            )
        })?;
        if end > body_length {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC compressed buffer points outside its message body",
            ));
        }
        specs.push(CompressedBufferSpec {
            offset,
            encoded_length,
        });
    }
    specs.sort_unstable_by_key(|value| value.offset);
    for pair in specs.windows(2) {
        let previous_end = pair[0]
            .offset
            .checked_add(pair[0].encoded_length)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC compressed buffer range overflows",
                )
            })?;
        if previous_end > pair[1].offset {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC compressed buffers overlap",
            ));
        }
    }
    Ok(specs)
}

fn declared_decompressed_buffer_bytes(prefix: [u8; 8], encoded_length: usize) -> Result<usize> {
    let declared = i64::from_le_bytes(prefix);
    match declared {
        -1 => Ok(encoded_length - 8),
        0 => Ok(0),
        value if value > 0 => usize::try_from(value).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC declared decompressed buffer size exceeds the supported range",
            )
        }),
        _ => Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC compressed buffer has an invalid decoded-length prefix",
        )),
    }
}

fn reserve_declared_decompression(
    total: &mut usize,
    bytes: usize,
    limits: &ArrowIpcLimits,
) -> Result<()> {
    let next = total.checked_add(bytes).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC declared decompressed byte total overflows",
        )
    })?;
    if next > limits.max_decoded_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC declared decompressed buffers exceed the configured byte limit",
        )
        .with_detail("declaredDecompressedBytes", next)
        .with_detail("maxDecodedBytes", limits.max_decoded_bytes));
    }
    *total = next;
    Ok(())
}

fn preflight_compressed_block(
    bytes: &[u8],
    metadata_length: usize,
    body_length: usize,
    limits: &ArrowIpcLimits,
    declared_total: &mut usize,
) -> Result<()> {
    let expected_length = metadata_length.checked_add(body_length).ok_or_else(|| {
        TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC block size overflows")
    })?;
    if bytes.len() != expected_length {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block bytes do not match its indexed length",
        ));
    }
    let metadata = bytes.get(..metadata_length).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block metadata is truncated",
        )
    })?;
    let message = encapsulated_message(metadata, limits)?;
    if usize::try_from(message.bodyLength()).ok() != Some(body_length) {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC block index and message body lengths disagree",
        ));
    }
    let body = bytes.get(metadata_length..).ok_or_else(|| {
        TabularkError::new(ErrorCode::ParseFailed, "Arrow IPC block body is truncated")
    })?;
    for spec in compressed_buffer_specs(&message, body_length)? {
        let prefix_end = spec.offset.checked_add(8).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC compressed buffer prefix offset overflows",
            )
        })?;
        let prefix: [u8; 8] = body
            .get(spec.offset..prefix_end)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC compressed buffer prefix is truncated",
                )
            })?
            .try_into()
            .map_err(|_| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "Arrow IPC compressed buffer prefix is truncated",
                )
            })?;
        let declared = declared_decompressed_buffer_bytes(prefix, spec.encoded_length)?;
        reserve_declared_decompression(declared_total, declared, limits)?;
    }
    Ok(())
}

fn record_batch_row_count(
    bytes: &[u8],
    block: &FileBlockSpec,
    limits: &ArrowIpcLimits,
) -> Result<usize> {
    let message = encapsulated_message(bytes, limits)?;
    if message.header_type() != MessageHeader::RecordBatch {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC File record index points to a non-record message",
        ));
    }
    if usize::try_from(message.bodyLength()).ok() != Some(block.body_length) {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC File footer and record message body lengths disagree",
        ));
    }
    let batch = message.header_as_record_batch().ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC record message has no RecordBatch header",
        )
    })?;
    usize::try_from(batch.length()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC record batch has a negative row count",
        )
    })
}

fn index_file_metadata(
    state: &mut FileIndexState,
    bytes: &[u8],
    limits: &ArrowIpcLimits,
) -> Result<()> {
    if let Some(block) = state.dictionaries.get(state.next_dictionary) {
        let message = encapsulated_message(bytes, limits)?;
        if message.header_type() != MessageHeader::DictionaryBatch {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File dictionary index points to a non-dictionary message",
            ));
        }
        let dictionary = message.header_as_dictionary_batch().ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File dictionary message has no DictionaryBatch header",
            )
        })?;
        if dictionary.data().is_none() {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File dictionary message has no RecordBatch body header",
            ));
        }
        if usize::try_from(message.bodyLength()).ok() != Some(block.body_length) {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File footer and dictionary message body lengths disagree",
            ));
        }
        state.next_dictionary += 1;
        return Ok(());
    }

    let record = state.records.get_mut(state.next_record).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::RuntimeFailure,
            "Arrow File metadata index is inconsistent",
        )
    })?;
    let row_count = record_batch_row_count(bytes, &record.block, limits)?;
    record.row_start = state.rows;
    record.row_count = row_count;
    state.rows = state.rows.checked_add(row_count).ok_or_else(|| {
        TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC row count overflows")
    })?;
    state.next_record += 1;
    Ok(())
}

fn encapsulated_message<'a>(
    bytes: &'a [u8],
    limits: &ArrowIpcLimits,
) -> Result<arrow_ipc::Message<'a>> {
    if bytes.len() < 4 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC encapsulated message is truncated",
        ));
    }
    let start = if bytes[..4] == [0xff; 4] {
        if bytes.len() < 8 {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC continuation marker is truncated",
            ));
        }
        8
    } else {
        4
    };
    let verifier_options = flatbuffer_verifier_options(limits);
    root_as_message_with_opts(&verifier_options, &bytes[start..])
        .map_err(|error| flatbuffer_error("parse Arrow IPC message metadata", error))
}

fn validate_action_response(
    action: ReadBytesAction,
    offset: u64,
    bytes: &[u8],
    eof: bool,
    source_length: usize,
) -> Result<()> {
    let length = u64::try_from(bytes.len()).map_err(|_| ingress_range_too_large())?;
    let expected_eof =
        action.end()? == u64::try_from(source_length).map_err(|_| ingress_range_too_large())?;
    if offset != action.offset || length != action.length || eof != expected_eof {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "Arrow ingress bytes do not match the requested read action",
        )
        .with_detail("expectedOffset", action.offset)
        .with_detail("expectedLength", action.length)
        .with_detail("expectedEof", expected_eof));
    }
    Ok(())
}

fn ingress_range_too_large() -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "Arrow ingress range exceeds the supported integer range",
    )
}

/// Configuration for the native Arrow adapter handle registry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArrowRuntimeConfig {
    /// Aggregate retained decoded-array budget across open sources.
    pub memory_budget_bytes: usize,
    /// Maximum concurrently open sources.
    pub max_sources: usize,
}

impl Default for ArrowRuntimeConfig {
    fn default() -> Self {
        Self {
            memory_budget_bytes: 512 * 1024 * 1024,
            max_sources: 8,
        }
    }
}

/// Opaque native Arrow source handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ArrowSourceHandle(u32);

impl ArrowSourceHandle {
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

/// Opaque native Arrow table handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ArrowTableHandle(u32);

impl ArrowTableHandle {
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

/// Native lifecycle implementation shared by tests and the thin Arrow WASM wrapper.
#[derive(Debug)]
pub struct ArrowIpcRuntime {
    config: ArrowRuntimeConfig,
    next_handle: u32,
    retained_bytes: usize,
    sources: HashMap<ArrowSourceHandle, RuntimeSource>,
    tables: HashMap<ArrowTableHandle, ArrowSourceHandle>,
}

#[derive(Debug)]
enum RuntimeSource {
    Decoded(ArrowIpcSource),
    Incremental(OpenedArrowIpcSource),
}

impl RuntimeSource {
    fn metadata(&self) -> &TableMetadata {
        match self {
            Self::Decoded(source) => source.metadata(),
            Self::Incremental(source) => source.metadata(),
        }
    }

    const fn decoded_bytes(&self) -> usize {
        match self {
            Self::Decoded(source) => source.decoded_bytes(),
            Self::Incremental(source) => source.decoded_bytes(),
        }
    }

    fn begin_read(&self, request: RangeRequest) -> Result<ArrowReadStart> {
        match self {
            Self::Decoded(source) => Ok(ArrowReadStart::Complete(source.read_range(request)?)),
            Self::Incremental(source) => source.begin_read(request),
        }
    }

    fn begin_display_read(&self, request: RangeRequest) -> Result<ArrowReadStart> {
        match self {
            Self::Decoded(source) => Ok(ArrowReadStart::Complete(
                source.read_display_range(request)?,
            )),
            Self::Incremental(source) => source.begin_display_read(request),
        }
    }
}

impl ArrowIpcRuntime {
    /// Creates an empty Arrow adapter registry.
    pub fn new(config: ArrowRuntimeConfig) -> Result<Self> {
        if config.memory_budget_bytes == 0 || config.max_sources == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow runtime resource limits must be greater than zero",
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

    /// Decodes and registers one source. Failed opens never consume a handle.
    pub fn open_source(
        &mut self,
        bytes: &[u8],
        options: ArrowIpcOptions,
    ) -> Result<ArrowSourceHandle> {
        if self.sources.len() >= self.config.max_sources {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow runtime has reached its open-source limit",
            )
            .with_detail("maxSources", self.config.max_sources));
        }
        options
            .limits
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        let source = ArrowIpcSource::open(bytes, options)?;
        self.register_source(RuntimeSource::Decoded(source))
    }

    /// Registers a source completed by [`ArrowIpcOpenOperation`].
    ///
    /// File record bodies remain outside WASM and are requested lazily by
    /// [`Self::begin_read`]. A Stream may be registered first as an indexed
    /// prefix and replaced under the same handle as sequential ingress grows.
    pub fn open_incremental_source(
        &mut self,
        source: OpenedArrowIpcSource,
    ) -> Result<ArrowSourceHandle> {
        source
            .limits()
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        self.register_source(RuntimeSource::Incremental(source))
    }

    /// Registers the first published prefix of an IPC Stream from a delta.
    pub fn open_incremental_stream(
        &mut self,
        delta: ArrowStreamDelta,
    ) -> Result<ArrowSourceHandle> {
        delta
            .options
            .limits
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        let source = ArrowIpcSource::from_stream_delta(delta)?;
        self.register_source(RuntimeSource::Incremental(OpenedArrowIpcSource::Stream(
            source,
        )))
    }

    /// Appends newly decoded Stream batches without rebuilding the published
    /// prefix, its prior row offsets, or prior metadata inputs.
    pub fn append_incremental_stream(
        &mut self,
        handle: ArrowSourceHandle,
        delta: ArrowStreamDelta,
    ) -> Result<()> {
        delta
            .options
            .limits
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        let previous = self
            .sources
            .get(&handle)
            .ok_or_else(|| closed_handle("source"))?;
        let RuntimeSource::Incremental(OpenedArrowIpcSource::Stream(previous)) = previous else {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "only a progressively opened Arrow IPC Stream accepts batch deltas",
            ));
        };
        let appended_decoded_bytes = delta
            .cumulative_decoded_bytes
            .checked_sub(previous.decoded_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Arrow IPC Stream delta decoded-byte total is stale",
                )
            })?;
        let retained_bytes = self
            .retained_bytes
            .checked_add(appended_decoded_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow runtime memory estimate overflows",
                )
            })?;
        if retained_bytes > self.config.memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow runtime exceeds its aggregate decoded-array budget",
            )
            .with_detail("retainedBytes", retained_bytes)
            .with_detail("memoryBudgetBytes", self.config.memory_budget_bytes));
        }
        let RuntimeSource::Incremental(OpenedArrowIpcSource::Stream(source)) = self
            .sources
            .get_mut(&handle)
            .expect("validated Arrow Stream source remains registered")
        else {
            unreachable!("validated Arrow Stream source changed while mutably borrowed")
        };
        let actual_appended = source.append_stream_delta(delta)?;
        debug_assert_eq!(actual_appended, appended_decoded_bytes);
        self.retained_bytes = retained_bytes;
        Ok(())
    }

    /// Replaces a progressively published Stream prefix without changing its
    /// source handle or any table handles that refer to it.
    ///
    /// The replacement is committed only after its retained-memory estimate
    /// fits the runtime budget, so a failed update leaves the prior prefix
    /// readable until the caller closes the failed open operation.
    pub fn replace_incremental_source(
        &mut self,
        handle: ArrowSourceHandle,
        source: OpenedArrowIpcSource,
    ) -> Result<()> {
        source
            .limits()
            .validate_for_memory_budget(self.config.memory_budget_bytes)?;
        if source.container() != ResolvedArrowIpcContainer::Stream {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "only an Arrow IPC Stream prefix can replace an open source",
            ));
        }
        let previous = self
            .sources
            .get(&handle)
            .ok_or_else(|| closed_handle("source"))?;
        let previous_is_stream = matches!(
            previous,
            RuntimeSource::Incremental(OpenedArrowIpcSource::Stream(_))
        );
        if !previous_is_stream {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "only a progressively opened Arrow IPC Stream can be replaced",
            ));
        }
        let retained_without_previous = self
            .retained_bytes
            .checked_sub(previous.decoded_bytes())
            .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow runtime retained-memory estimate is inconsistent",
            )
        })?;
        let retained_bytes = retained_without_previous
            .checked_add(source.decoded_bytes())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow runtime memory estimate overflows",
                )
            })?;
        if retained_bytes > self.config.memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow runtime exceeds its aggregate decoded-array budget",
            )
            .with_detail("retainedBytes", retained_bytes)
            .with_detail("memoryBudgetBytes", self.config.memory_budget_bytes));
        }
        self.sources
            .insert(handle, RuntimeSource::Incremental(source));
        self.retained_bytes = retained_bytes;
        Ok(())
    }

    /// Returns metadata for a registered source before a table handle exists.
    pub fn source_metadata(&self, source: ArrowSourceHandle) -> Result<&TableMetadata> {
        self.sources
            .get(&source)
            .map(RuntimeSource::metadata)
            .ok_or_else(|| closed_handle("source"))
    }

    fn register_source(&mut self, source: RuntimeSource) -> Result<ArrowSourceHandle> {
        if self.sources.len() >= self.config.max_sources {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow runtime has reached its open-source limit",
            )
            .with_detail("maxSources", self.config.max_sources));
        }
        let retained_bytes = self
            .retained_bytes
            .checked_add(source.decoded_bytes())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow runtime memory estimate overflows",
                )
            })?;
        if retained_bytes > self.config.memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow runtime exceeds its aggregate decoded-array budget",
            )
            .with_detail("retainedBytes", retained_bytes)
            .with_detail("memoryBudgetBytes", self.config.memory_budget_bytes));
        }
        let handle = ArrowSourceHandle(self.allocate_handle()?);
        self.retained_bytes = retained_bytes;
        self.sources.insert(handle, source);
        Ok(handle)
    }

    /// Opens the source's sole logical table (`table-0`).
    pub fn open_table(
        &mut self,
        source: ArrowSourceHandle,
        table_id: &str,
    ) -> Result<ArrowTableHandle> {
        if table_id != "table-0" {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Arrow IPC source exposes only table-0",
            ));
        }
        if !self.sources.contains_key(&source) {
            return Err(closed_handle("source"));
        }
        let handle = ArrowTableHandle(self.allocate_handle()?);
        self.tables.insert(handle, source);
        Ok(handle)
    }

    /// Returns metadata for an open table.
    pub fn metadata(&self, table: ArrowTableHandle) -> Result<&TableMetadata> {
        Ok(self.source_for_table(table)?.metadata())
    }

    /// Starts a typed range read. Footer-indexed Files may return a bounded
    /// byte operation; decoded Files and Streams complete immediately.
    pub fn begin_read(
        &self,
        table: ArrowTableHandle,
        request: RangeRequest,
    ) -> Result<ArrowReadStart> {
        self.source_for_table(table)?.begin_read(request)
    }

    /// Starts a display-only range read whose native descriptors contain no
    /// value buffers. This is reserved for bounded preview surfaces.
    pub fn begin_display_read(
        &self,
        table: ArrowTableHandle,
        request: RangeRequest,
    ) -> Result<ArrowReadStart> {
        self.source_for_table(table)?.begin_display_read(request)
    }

    /// Reads one range from an open table.
    pub fn read_range(
        &self,
        table: ArrowTableHandle,
        request: RangeRequest,
    ) -> Result<TypedTableBatch> {
        match self.begin_read(table, request)? {
            ArrowReadStart::Complete(batch) => Ok(batch),
            ArrowReadStart::File(_) => Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "footer-indexed Arrow Files require adapter byte actions",
            )),
        }
    }

    /// Idempotently closes one table handle.
    pub fn close_table(&mut self, table: ArrowTableHandle) -> bool {
        self.tables.remove(&table).is_some()
    }

    /// Idempotently closes one source and every child table.
    pub fn close_source(&mut self, source: ArrowSourceHandle) -> bool {
        let Some(source_value) = self.sources.remove(&source) else {
            return false;
        };
        self.retained_bytes = self
            .retained_bytes
            .saturating_sub(source_value.decoded_bytes());
        self.tables.retain(|_, owner| *owner != source);
        true
    }

    /// Releases every source and table handle.
    pub fn shutdown(&mut self) {
        self.tables.clear();
        self.sources.clear();
        self.retained_bytes = 0;
    }

    /// Returns the number of open source handles.
    #[must_use]
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Returns the number of open table handles.
    #[must_use]
    pub fn table_count(&self) -> usize {
        self.tables.len()
    }

    /// Returns the aggregate retained array-memory estimate.
    #[must_use]
    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    fn source_for_table(&self, table: ArrowTableHandle) -> Result<&RuntimeSource> {
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
                "Arrow runtime handle space exhausted",
            )
        })?;
        Ok(handle)
    }
}

impl Default for ArrowIpcRuntime {
    fn default() -> Self {
        Self::new(ArrowRuntimeConfig::default()).expect("default Arrow runtime config is valid")
    }
}

fn decode_file(
    bytes: &[u8],
    limits: &ArrowIpcLimits,
) -> Result<(ArrowSchemaRef, Vec<RecordBatch>)> {
    preflight_file_decompression(bytes, limits)?;
    let max_tables = limits
        .max_fields
        .checked_mul(4)
        .and_then(|value| value.checked_add(1024))
        .unwrap_or(usize::MAX);
    let mut reader = FileReaderBuilder::new()
        .with_max_footer_fb_depth(limits.max_nesting_depth)
        .with_max_footer_fb_tables(max_tables)
        .build(Cursor::new(bytes))
        .map_err(|error| arrow_error("open IPC File", error))?;
    let schema = reader.schema();
    let batches = reader
        .by_ref()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| arrow_error("decode IPC File record batch", error))?;
    Ok((schema, batches))
}

fn preflight_file_decompression(bytes: &[u8], limits: &ArrowIpcLimits) -> Result<()> {
    let trailer: [u8; 10] = bytes
        .get(bytes.len().saturating_sub(10)..)
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File trailer is truncated",
            )
        })?
        .try_into()
        .map_err(|_| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC File trailer is truncated",
            )
        })?;
    let footer_length = read_footer_length(trailer)
        .map_err(|error| arrow_error("read IPC File footer trailer", error))?;
    if footer_length > limits.max_metadata_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC footer exceeds the configured metadata limit",
        ));
    }
    let footer_end = bytes.len().checked_sub(10).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC File trailer is truncated",
        )
    })?;
    let footer_start = footer_end.checked_sub(footer_length).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Arrow IPC footer length exceeds the source",
        )
    })?;
    let footer_bytes = bytes.get(footer_start..footer_end).ok_or_else(|| {
        TabularkError::new(ErrorCode::ParseFailed, "Arrow IPC footer is truncated")
    })?;
    let verifier_options = flatbuffer_verifier_options(limits);
    let footer = root_as_footer_with_opts(&verifier_options, footer_bytes)
        .map_err(|error| flatbuffer_error("parse Arrow IPC footer", error))?;
    let mut declared_decompressed_bytes = 0_usize;
    let blocks = footer
        .dictionaries()
        .into_iter()
        .flat_map(|blocks| blocks.iter())
        .chain(
            footer
                .recordBatches()
                .into_iter()
                .flat_map(|blocks| blocks.iter()),
        );
    for block in blocks {
        let spec = file_block_spec(*block, bytes.len(), limits)?;
        let end = spec
            .offset
            .checked_add(spec.total_length()?)
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC block range overflows")
            })?;
        let block_bytes = bytes.get(spec.offset..end).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Arrow IPC block points outside the source",
            )
        })?;
        preflight_compressed_block(
            block_bytes,
            spec.metadata_length,
            spec.body_length,
            limits,
            &mut declared_decompressed_bytes,
        )?;
    }
    Ok(())
}

fn decode_stream(bytes: &[u8]) -> Result<(ArrowSchemaRef, Vec<RecordBatch>)> {
    let mut reader = StreamReader::try_new(Cursor::new(bytes), None)
        .map_err(|error| arrow_error("open IPC Stream", error))?;
    let schema = reader.schema();
    let batches = reader
        .by_ref()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| arrow_error("decode IPC Stream record batch", error))?;
    Ok((schema, batches))
}

fn is_file_container(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && bytes.starts_with(ARROW_MAGIC) && bytes.ends_with(ARROW_MAGIC)
}

fn validate_schema(schema: &ArrowSchemaRef, limits: &ArrowIpcLimits) -> Result<()> {
    let mut field_count = 0_usize;
    let mut metadata_bytes = metadata_size(schema.metadata())?;
    for field in schema.fields() {
        validate_field(field, 1, &mut field_count, &mut metadata_bytes, limits)?;
    }
    if metadata_bytes > limits.max_metadata_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC schema metadata exceeds the configured byte limit",
        )
        .with_detail("metadataBytes", metadata_bytes)
        .with_detail("maxMetadataBytes", limits.max_metadata_bytes));
    }
    Ok(())
}

fn validate_field(
    field: &ArrowField,
    depth: usize,
    field_count: &mut usize,
    metadata_bytes: &mut usize,
    limits: &ArrowIpcLimits,
) -> Result<()> {
    *field_count = field_count.checked_add(1).ok_or_else(|| {
        TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC field count overflows")
    })?;
    if *field_count > limits.max_fields {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC schema exceeds the configured field limit",
        )
        .with_detail("fieldCount", *field_count)
        .with_detail("maxFields", limits.max_fields));
    }
    if depth > limits.max_nesting_depth {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC schema exceeds the configured nesting-depth limit",
        )
        .with_detail("nestingDepth", depth)
        .with_detail("maxNestingDepth", limits.max_nesting_depth));
    }
    let recursive_depth = depth
        .saturating_sub(1)
        .saturating_add(model_field_data_type(field)?.nesting_depth());
    if recursive_depth > limits.max_nesting_depth {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC schema exceeds the configured nesting-depth limit",
        )
        .with_detail("nestingDepth", recursive_depth)
        .with_detail("maxNestingDepth", limits.max_nesting_depth));
    }
    *metadata_bytes = metadata_bytes
        .checked_add(field.name().len())
        .and_then(|value| value.checked_add(metadata_size(field.metadata()).ok()?))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow IPC metadata size overflows",
            )
        })?;
    if *metadata_bytes > limits.max_metadata_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC schema metadata exceeds the configured byte limit",
        ));
    }
    for child in child_fields(field.data_type()) {
        validate_field(
            child,
            depth.saturating_add(1),
            field_count,
            metadata_bytes,
            limits,
        )?;
    }
    Ok(())
}

fn child_fields(data_type: &ArrowDataType) -> Vec<&ArrowField> {
    match data_type {
        ArrowDataType::List(field)
        | ArrowDataType::ListView(field)
        | ArrowDataType::FixedSizeList(field, _)
        | ArrowDataType::LargeList(field)
        | ArrowDataType::LargeListView(field)
        | ArrowDataType::Map(field, _) => vec![field.as_ref()],
        ArrowDataType::Struct(fields) => fields.iter().map(|field| field.as_ref()).collect(),
        ArrowDataType::Union(fields, _) => fields.iter().map(|(_, field)| field.as_ref()).collect(),
        ArrowDataType::RunEndEncoded(run_ends, values) => {
            vec![run_ends.as_ref(), values.as_ref()]
        }
        ArrowDataType::Dictionary(_, values) => child_fields(values),
        _ => Vec::new(),
    }
}

fn data_type_uses_dictionary(data_type: &ArrowDataType) -> bool {
    match data_type {
        ArrowDataType::Dictionary(_, _) => true,
        ArrowDataType::List(field)
        | ArrowDataType::ListView(field)
        | ArrowDataType::FixedSizeList(field, _)
        | ArrowDataType::LargeList(field)
        | ArrowDataType::LargeListView(field)
        | ArrowDataType::Map(field, _) => data_type_uses_dictionary(field.data_type()),
        ArrowDataType::Struct(fields) => fields
            .iter()
            .any(|field| data_type_uses_dictionary(field.data_type())),
        ArrowDataType::Union(fields, _) => fields
            .iter()
            .any(|(_, field)| data_type_uses_dictionary(field.data_type())),
        ArrowDataType::RunEndEncoded(run_ends, values) => {
            data_type_uses_dictionary(run_ends.data_type())
                || data_type_uses_dictionary(values.data_type())
        }
        _ => false,
    }
}

fn metadata_size(metadata: &HashMap<String, String>) -> Result<usize> {
    metadata.iter().try_fold(0_usize, |total, (key, value)| {
        total
            .checked_add(key.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC metadata size overflows",
                )
            })
    })
}

fn column_schema(index: usize, field: &ArrowField) -> Result<ColumnSchema> {
    let index_u64 = u64::try_from(index).map_err(|_| {
        TabularkError::new(ErrorCode::ResourceLimit, "Arrow IPC column index overflows")
    })?;
    let mut column = ColumnSchema::new(
        format!("c{index}"),
        field.name(),
        index_u64,
        model_field_data_type(field)?,
        field.is_nullable(),
    )?;
    if !field.metadata().is_empty() {
        let metadata = field
            .metadata()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        column.insert_extension(
            "arrow:field-metadata",
            serde_json::to_value(metadata).map_err(|error| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "failed to serialize Arrow field metadata",
                )
                .with_detail("reason", error.to_string())
            })?,
        )?;
    }
    Ok(column)
}

fn model_field(field: &ArrowField) -> Result<TableField> {
    let mut model = TableField::new(
        field.name(),
        model_field_data_type(field)?,
        field.is_nullable(),
    );
    for (key, value) in field.metadata() {
        model.insert_metadata(key, value);
    }
    Ok(model)
}

fn model_field_data_type(field: &ArrowField) -> Result<TableDataType> {
    let storage = model_data_type(field.data_type())?;
    let Some(name) = field.metadata().get(EXTENSION_NAME_KEY) else {
        return Ok(storage);
    };
    Ok(TableDataType::Extension {
        name: name.clone(),
        metadata: field.metadata().get(EXTENSION_METADATA_KEY).cloned(),
        storage: Box::new(storage),
    })
}

fn model_data_type(data_type: &ArrowDataType) -> Result<TableDataType> {
    Ok(match data_type {
        ArrowDataType::Null => TableDataType::Null,
        ArrowDataType::Boolean => TableDataType::Boolean,
        ArrowDataType::Int8 => TableDataType::Int8,
        ArrowDataType::Int16 => TableDataType::Int16,
        ArrowDataType::Int32 => TableDataType::Int32,
        ArrowDataType::Int64 => TableDataType::Int64,
        ArrowDataType::UInt8 => TableDataType::UInt8,
        ArrowDataType::UInt16 => TableDataType::UInt16,
        ArrowDataType::UInt32 => TableDataType::UInt32,
        ArrowDataType::UInt64 => TableDataType::UInt64,
        ArrowDataType::Float16 => TableDataType::Float16,
        ArrowDataType::Float32 => TableDataType::Float32,
        ArrowDataType::Float64 => TableDataType::Float64,
        ArrowDataType::Timestamp(unit, timezone) => TableDataType::Timestamp {
            unit: model_time_unit(*unit),
            timezone: timezone.as_ref().map(ToString::to_string),
        },
        ArrowDataType::Date32 => TableDataType::Date32,
        ArrowDataType::Date64 => TableDataType::Date64,
        ArrowDataType::Time32(unit) => TableDataType::Time32 {
            unit: model_time_unit(*unit),
        },
        ArrowDataType::Time64(unit) => TableDataType::Time64 {
            unit: model_time_unit(*unit),
        },
        ArrowDataType::Duration(unit) => TableDataType::Duration {
            unit: model_time_unit(*unit),
        },
        ArrowDataType::Interval(unit) => TableDataType::Interval {
            unit: match unit {
                ArrowIntervalUnit::YearMonth => IntervalUnit::YearMonth,
                ArrowIntervalUnit::DayTime => IntervalUnit::DayTime,
                ArrowIntervalUnit::MonthDayNano => IntervalUnit::MonthDayNano,
            },
        },
        ArrowDataType::Binary => TableDataType::Binary,
        ArrowDataType::FixedSizeBinary(byte_width) => TableDataType::FixedSizeBinary {
            byte_width: *byte_width,
        },
        ArrowDataType::LargeBinary => TableDataType::LargeBinary,
        ArrowDataType::BinaryView => TableDataType::BinaryView,
        ArrowDataType::Utf8 => TableDataType::Utf8,
        ArrowDataType::LargeUtf8 => TableDataType::LargeUtf8,
        ArrowDataType::Utf8View => TableDataType::Utf8View,
        ArrowDataType::List(field) => TableDataType::List {
            field: Box::new(model_field(field)?),
        },
        ArrowDataType::ListView(field) => TableDataType::ListView {
            field: Box::new(model_field(field)?),
        },
        ArrowDataType::FixedSizeList(field, list_size) => TableDataType::FixedSizeList {
            field: Box::new(model_field(field)?),
            list_size: *list_size,
        },
        ArrowDataType::LargeList(field) => TableDataType::LargeList {
            field: Box::new(model_field(field)?),
        },
        ArrowDataType::LargeListView(field) => TableDataType::LargeListView {
            field: Box::new(model_field(field)?),
        },
        ArrowDataType::Struct(fields) => TableDataType::Struct {
            fields: fields
                .iter()
                .map(|field| model_field(field))
                .collect::<Result<Vec<_>>>()?,
        },
        ArrowDataType::Union(fields, mode) => TableDataType::Union {
            fields: fields
                .iter()
                .map(|(type_id, field)| Ok(UnionField::new(type_id, model_field(field)?)))
                .collect::<Result<Vec<_>>>()?,
            mode: match mode {
                ArrowUnionMode::Sparse => UnionMode::Sparse,
                ArrowUnionMode::Dense => UnionMode::Dense,
            },
        },
        ArrowDataType::Dictionary(key, value) => TableDataType::Dictionary {
            key: Box::new(model_data_type(key)?),
            value: Box::new(model_data_type(value)?),
        },
        ArrowDataType::Decimal32(precision, scale) => TableDataType::Decimal32 {
            precision: *precision,
            scale: *scale,
        },
        ArrowDataType::Decimal64(precision, scale) => TableDataType::Decimal64 {
            precision: *precision,
            scale: *scale,
        },
        ArrowDataType::Decimal128(precision, scale) => TableDataType::Decimal128 {
            precision: *precision,
            scale: *scale,
        },
        ArrowDataType::Decimal256(precision, scale) => TableDataType::Decimal256 {
            precision: *precision,
            scale: *scale,
        },
        ArrowDataType::Map(field, keys_sorted) => TableDataType::Map {
            field: Box::new(model_field(field)?),
            keys_sorted: *keys_sorted,
        },
        ArrowDataType::RunEndEncoded(run_ends, values) => TableDataType::RunEndEncoded {
            run_ends: Box::new(model_field(run_ends)?),
            values: Box::new(model_field(values)?),
        },
    })
}

const fn model_time_unit(unit: ArrowTimeUnit) -> TimeUnit {
    match unit {
        ArrowTimeUnit::Second => TimeUnit::Second,
        ArrowTimeUnit::Millisecond => TimeUnit::Millisecond,
        ArrowTimeUnit::Microsecond => TimeUnit::Microsecond,
        ArrowTimeUnit::Nanosecond => TimeUnit::Nanosecond,
    }
}

struct BufferPoolBuilder {
    buffers: Vec<BatchBuffer>,
    bytes: usize,
    max_bytes: usize,
    hash_builder: RandomState,
    buffer_index: HashMap<(usize, u64), Vec<usize>>,
}

impl BufferPoolBuilder {
    fn new(max_bytes: usize) -> Self {
        Self {
            buffers: Vec::new(),
            bytes: 0,
            max_bytes,
            hash_builder: RandomState::new(),
            buffer_index: HashMap::new(),
        }
    }

    fn intern(&mut self, bytes: &[u8]) -> Result<BufferSlice> {
        let key = (bytes.len(), self.fingerprint(bytes));
        if let Some(index) = self.buffer_index.get(&key).and_then(|candidates| {
            candidates
                .iter()
                .copied()
                .find(|index| self.buffers[*index].data() == bytes)
        }) {
            return BufferSlice::new(
                u32::try_from(index).map_err(|_| too_many_buffers())?,
                0,
                u64::try_from(bytes.len()).map_err(|_| too_many_buffers())?,
            );
        }
        let next_bytes = self.bytes.checked_add(bytes.len()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "typed batch output size overflows",
            )
            .with_detail("resource", "typed-batch-output")
        })?;
        if next_bytes > self.max_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "typed batch output exceeds the configured byte limit",
            )
            .with_detail("resource", "typed-batch-output")
            .with_detail("outputBytes", next_bytes)
            .with_detail("maxOutputBytes", self.max_bytes));
        }
        let index_usize = self.buffers.len();
        let index = u32::try_from(index_usize).map_err(|_| too_many_buffers())?;
        self.buffers.push(BatchBuffer::new(bytes.to_vec()));
        self.buffer_index.entry(key).or_default().push(index_usize);
        self.bytes = next_bytes;
        BufferSlice::new(
            index,
            0,
            u64::try_from(bytes.len()).map_err(|_| too_many_buffers())?,
        )
    }

    const fn remaining_bytes(&self) -> usize {
        self.max_bytes.saturating_sub(self.bytes)
    }

    fn fingerprint(&self, bytes: &[u8]) -> u64 {
        self.hash_builder.hash_one(bytes)
    }

    fn finish(self) -> Vec<BatchBuffer> {
        self.buffers
    }
}

fn descriptor_from_array(
    array: &dyn Array,
    field: Option<&ArrowField>,
    pool: &mut BufferPoolBuilder,
) -> Result<ArrayDescriptor> {
    descriptor_from_data(&array.to_data(), field, pool)
}

fn descriptor_from_data(
    data: &ArrayData,
    field: Option<&ArrowField>,
    pool: &mut BufferPoolBuilder,
) -> Result<ArrayDescriptor> {
    if data.offset() != 0 {
        return Err(TabularkError::new(
            ErrorCode::RuntimeFailure,
            "typed batch encoder requires normalized Arrow array offsets",
        )
        .with_detail("arrayOffset", data.offset()));
    }
    let data_type = match field {
        Some(field) => model_field_data_type(field)?,
        None => model_data_type(data.data_type())?,
    };
    let length = u64::try_from(data.len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow array length exceeds public range",
        )
    })?;
    let validity = data
        .nulls()
        .map(|nulls| {
            let buffer = pool.intern(nulls.inner().inner().as_slice())?;
            BitmapSlice::new(
                buffer,
                u64::try_from(nulls.offset()).map_err(|_| too_many_buffers())?,
            )
        })
        .transpose()?;

    let layout = match data.data_type() {
        ArrowDataType::Null => ArrayLayout::Null,
        ArrowDataType::Boolean => {
            let values = data_buffer(data, 0, pool)?;
            ArrayLayout::Bitmap {
                values: BitmapSlice::new(values, 0)?,
            }
        }
        ArrowDataType::Binary
        | ArrowDataType::LargeBinary
        | ArrowDataType::Utf8
        | ArrowDataType::LargeUtf8 => ArrayLayout::VariableWidth {
            offsets: data_buffer(data, 0, pool)?,
            values: data_buffer(data, 1, pool)?,
        },
        ArrowDataType::BinaryView | ArrowDataType::Utf8View => ArrayLayout::View {
            views: data_buffer(data, 0, pool)?,
            buffers: data
                .buffers()
                .iter()
                .skip(1)
                .map(|buffer| pool.intern(buffer.as_slice()))
                .collect::<Result<Vec<_>>>()?,
        },
        ArrowDataType::List(child) | ArrowDataType::LargeList(child) => ArrayLayout::List {
            offsets: data_buffer(data, 0, pool)?,
            values: Box::new(descriptor_from_data(
                child_data(data, 0)?,
                Some(child),
                pool,
            )?),
        },
        ArrowDataType::ListView(child) | ArrowDataType::LargeListView(child) => {
            ArrayLayout::ListView {
                offsets: data_buffer(data, 0, pool)?,
                sizes: data_buffer(data, 1, pool)?,
                values: Box::new(descriptor_from_data(
                    child_data(data, 0)?,
                    Some(child),
                    pool,
                )?),
            }
        }
        ArrowDataType::FixedSizeList(child, _) => ArrayLayout::FixedSizeList {
            values: Box::new(descriptor_from_data(
                child_data(data, 0)?,
                Some(child),
                pool,
            )?),
        },
        ArrowDataType::Struct(fields) => ArrayLayout::Struct {
            fields: fields
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    descriptor_from_data(child_data(data, index)?, Some(field), pool)
                })
                .collect::<Result<Vec<_>>>()?,
        },
        ArrowDataType::Union(fields, mode) => ArrayLayout::Union {
            type_ids: data_buffer(data, 0, pool)?,
            offsets: match mode {
                ArrowUnionMode::Sparse => None,
                ArrowUnionMode::Dense => Some(data_buffer(data, 1, pool)?),
            },
            fields: fields
                .iter()
                .enumerate()
                .map(|(index, (type_id, field))| {
                    Ok(UnionArray::new(
                        type_id,
                        descriptor_from_data(child_data(data, index)?, Some(field), pool)?,
                    ))
                })
                .collect::<Result<Vec<_>>>()?,
        },
        ArrowDataType::Dictionary(key_type, _) => {
            let key_buffer = data.buffers().first().ok_or_else(missing_array_buffer)?;
            let key_data = ArrayDataBuilder::new(key_type.as_ref().clone())
                .len(data.len())
                .nulls(data.nulls().cloned())
                .add_buffer(key_buffer.clone())
                .build()
                .map_err(|error| arrow_error("describe dictionary keys", error))?;
            ArrayLayout::Dictionary {
                keys: Box::new(descriptor_from_data(&key_data, None, pool)?),
                values: Box::new(descriptor_from_data(child_data(data, 0)?, None, pool)?),
            }
        }
        ArrowDataType::Map(child, _) => ArrayLayout::List {
            offsets: data_buffer(data, 0, pool)?,
            values: Box::new(descriptor_from_data(
                child_data(data, 0)?,
                Some(child),
                pool,
            )?),
        },
        ArrowDataType::RunEndEncoded(run_ends, values) => ArrayLayout::RunEndEncoded {
            run_ends: Box::new(descriptor_from_data(
                child_data(data, 0)?,
                Some(run_ends),
                pool,
            )?),
            values: Box::new(descriptor_from_data(
                child_data(data, 1)?,
                Some(values),
                pool,
            )?),
        },
        _ => ArrayLayout::FixedWidth {
            values: data_buffer(data, 0, pool)?,
        },
    };

    ArrayDescriptor::new(data_type, length, validity, layout)
}

fn data_buffer(
    data: &ArrayData,
    index: usize,
    pool: &mut BufferPoolBuilder,
) -> Result<BufferSlice> {
    let buffer = data.buffers().get(index).ok_or_else(missing_array_buffer)?;
    pool.intern(buffer.as_slice())
}

fn child_data(data: &ArrayData, index: usize) -> Result<&ArrayData> {
    data.child_data()
        .get(index)
        .ok_or_else(|| TabularkError::new(ErrorCode::ParseFailed, "Arrow array child is missing"))
}

#[cfg(test)]
fn display_array(array: &dyn Array, max_cell_bytes: usize) -> Result<StringArray> {
    display_array_with_total_limit(array, max_cell_bytes, usize::MAX)
}

fn display_array_with_total_limit(
    array: &dyn Array,
    max_cell_bytes: usize,
    max_total_bytes: usize,
) -> Result<StringArray> {
    let nested = is_nested_logical(array.data_type());
    let options = FormatOptions::new()
        .with_display_error(false)
        .with_quoted_strings(nested);
    let formatter = ArrayFormatter::try_new(array, &options)
        .map_err(|error| arrow_error("create display formatter", error))?;
    let binary = is_binary_logical(array.data_type());
    let structural_bytes = display_structural_bytes(array)?;
    if structural_bytes > max_total_bytes {
        return Err(display_total_limit_error(structural_bytes, max_total_bytes));
    }
    let mut total_bytes = structural_bytes;
    let mut remaining_cells = logical_value_count(array);
    let mut values = StringBuilder::new();
    // `Array::nulls` intentionally reports only physical validity. Encoded
    // arrays can be logically null through a referenced dictionary value or a
    // run value while having no top-level bitmap at all. The display column is
    // a logical representation, so preserve those nulls explicitly.
    let logical_nulls = array.logical_nulls();
    for index in 0..array.len() {
        if logical_nulls
            .as_ref()
            .is_some_and(|nulls| nulls.is_null(index))
        {
            values.append_null();
            continue;
        }
        let remaining_total_bytes = max_total_bytes.saturating_sub(total_bytes);
        let display_limit = if remaining_cells == 0 {
            0
        } else {
            max_cell_bytes.min(remaining_total_bytes.div_ceil(remaining_cells))
        };
        let value = if nested {
            format_bounded_nested_display(&formatter, index, display_limit)?.value
        } else {
            let mut value = match direct_float_display(array, index) {
                Some(value) => value,
                None => formatter
                    .value(index)
                    .try_to_string()
                    .map_err(|error| arrow_error("format Arrow display value", error))?,
            };
            value = normalize_special_float(value);
            if binary {
                value.insert_str(0, "0x");
            }
            truncate_utf8_display(value, display_limit)
        };
        total_bytes = total_bytes.checked_add(value.len()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow display output byte total overflows",
            )
        })?;
        if total_bytes > max_total_bytes {
            return Err(display_total_limit_error(total_bytes, max_total_bytes));
        }
        values.append_value(value);
        remaining_cells = remaining_cells.saturating_sub(1);
    }
    Ok(values.finish())
}

/// Formats a bounded nested preview and marks cells whose child values were
/// deliberately omitted by a format-specific decoder.
#[cfg(feature = "parquet")]
pub(crate) fn display_bounded_list_preview(
    array: &dyn Array,
    truncated: &[bool],
    max_cell_bytes: usize,
) -> Result<StringArray> {
    if array.len() != truncated.len() {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "bounded list preview truncation flags do not match the array length",
        ));
    }
    let max_cell_bytes = max_cell_bytes.min(DISPLAY_ONLY_MAX_CELL_BYTES);
    let options = FormatOptions::new()
        .with_display_error(false)
        .with_quoted_strings(true);
    let formatter = ArrayFormatter::try_new(array, &options)
        .map_err(|error| arrow_error("create bounded list display formatter", error))?;
    let logical_nulls = array.logical_nulls();
    let mut values = StringBuilder::new();
    for (index, was_truncated) in truncated.iter().copied().enumerate() {
        if logical_nulls
            .as_ref()
            .is_some_and(|nulls| nulls.is_null(index))
        {
            values.append_null();
        } else {
            let formatted = format_bounded_nested_display(&formatter, index, max_cell_bytes)?.value;
            if was_truncated {
                values.append_value(mark_bounded_nested_truncation(&formatted, max_cell_bytes));
            } else {
                values.append_value(formatted);
            }
        }
    }
    Ok(values.finish())
}

#[cfg(feature = "parquet")]
fn mark_bounded_nested_truncation(value: &str, max_bytes: usize) -> String {
    if value.ends_with(NESTED_DISPLAY_TRUNCATION_SUFFIX) {
        return value.to_owned();
    }
    let suffix = if max_bytes >= NESTED_DISPLAY_TRUNCATION_SUFFIX.len() {
        NESTED_DISPLAY_TRUNCATION_SUFFIX
    } else {
        ""
    };
    let mut prefix = value.to_owned();
    if prefix.ends_with(']') {
        prefix.pop();
    }
    if prefix != "[" && !prefix.ends_with("[ ") {
        prefix.push_str(", ");
    }
    while prefix.len().saturating_add(suffix.len()) > max_bytes {
        if prefix.pop().is_none() {
            break;
        }
    }
    prefix.push_str(suffix);
    prefix
}

fn display_structural_bytes(array: &dyn Array) -> Result<usize> {
    let offsets = array
        .len()
        .checked_add(1)
        .and_then(|value| value.checked_mul(std::mem::size_of::<i32>()))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow display offset buffer size overflows",
            )
        })?;
    let validity = array.len().checked_add(7).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow display validity buffer size overflows",
        )
    })? / 8;
    offsets.checked_add(validity).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow display structural buffer size overflows",
        )
    })
}

fn logical_value_count(array: &dyn Array) -> usize {
    array
        .len()
        .saturating_sub(array.logical_nulls().map_or(0, |nulls| nulls.null_count()))
}

fn truncate_utf8_display(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let suffix = if max_bytes >= NESTED_DISPLAY_TRUNCATION_SUFFIX.len() {
        NESTED_DISPLAY_TRUNCATION_SUFFIX
    } else {
        ""
    };
    let prefix_bytes = max_bytes - suffix.len();
    while value.len() > prefix_bytes {
        value.pop();
    }
    value.push_str(suffix);
    value
}

fn display_total_limit_error(display_bytes: usize, max_total_bytes: usize) -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "Arrow display output exceeds the remaining typed-batch byte limit",
    )
    .with_detail("resource", "typed-batch-output")
    .with_detail("displayBytes", display_bytes)
    .with_detail("maxDisplayBytes", max_total_bytes)
}

fn format_bounded_nested_display(
    formatter: &ArrayFormatter<'_>,
    index: usize,
    max_cell_bytes: usize,
) -> Result<BoundedNestedDisplay> {
    let mut writer = BoundedEscapedDisplayWriter::new(max_cell_bytes);
    let formatted = formatter.value(index).write(&mut writer);
    if let Err(error) = formatted {
        if !writer.truncated() {
            return Err(arrow_error("format Arrow display value", error));
        }
    }
    writer.finish()
}

struct BoundedNestedDisplay {
    value: String,
}

struct BoundedEscapedDisplayWriter {
    value: String,
    max_bytes: usize,
    truncated: bool,
}

impl BoundedEscapedDisplayWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            value: String::with_capacity(max_bytes.min(4096)),
            max_bytes,
            truncated: false,
        }
    }

    fn truncated(&self) -> bool {
        self.truncated
    }

    fn finish(mut self) -> Result<BoundedNestedDisplay> {
        if !self.truncated {
            return Ok(BoundedNestedDisplay { value: self.value });
        }
        let suffix = if self.max_bytes >= NESTED_DISPLAY_TRUNCATION_SUFFIX.len() {
            NESTED_DISPLAY_TRUNCATION_SUFFIX
        } else {
            ""
        };
        let prefix_bytes = self.max_bytes - suffix.len();
        while self.value.len() > prefix_bytes {
            self.value.pop();
        }
        self.value.push_str(suffix);
        Ok(BoundedNestedDisplay { value: self.value })
    }

    fn push_escaped(&mut self, value: &str) -> std::fmt::Result {
        let next_len = self
            .value
            .len()
            .checked_add(value.len())
            .ok_or(std::fmt::Error)?;
        if next_len > self.max_bytes {
            self.truncated = true;
            return Err(std::fmt::Error);
        }
        self.value.push_str(value);
        Ok(())
    }
}

impl std::fmt::Write for BoundedEscapedDisplayWriter {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        for character in value.chars() {
            match character {
                '\\' => self.push_escaped("\\\\")?,
                '\t' => self.push_escaped("\\t")?,
                '\r' => self.push_escaped("\\r")?,
                '\n' => self.push_escaped("\\n")?,
                _ => {
                    let mut encoded = [0_u8; 4];
                    self.push_escaped(character.encode_utf8(&mut encoded))?;
                }
            }
        }
        Ok(())
    }
}

fn direct_float_display(array: &dyn Array, index: usize) -> Option<String> {
    match array.data_type() {
        ArrowDataType::Float16 => array
            .as_any()
            .downcast_ref::<Float16Array>()
            .map(|array| format_float(f64::from(array.value(index).to_f32()))),
        ArrowDataType::Float32 => array
            .as_any()
            .downcast_ref::<Float32Array>()
            .map(|array| format_float(f64::from(array.value(index)))),
        ArrowDataType::Float64 => array
            .as_any()
            .downcast_ref::<Float64Array>()
            .map(|array| format_float(array.value(index))),
        _ => None,
    }
}

fn format_float(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value == f64::INFINITY {
        "Infinity".to_owned()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_owned()
    } else if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        value.to_string()
    }
}

fn normalize_special_float(value: String) -> String {
    match value.as_str() {
        "inf" | "+inf" | "Infinity" | "+Infinity" => "Infinity".to_owned(),
        "-inf" | "-Infinity" => "-Infinity".to_owned(),
        "NaN" | "nan" => "NaN".to_owned(),
        "-0.0" | "-0" => "-0".to_owned(),
        _ => value,
    }
}

fn is_binary_logical(data_type: &ArrowDataType) -> bool {
    match data_type {
        ArrowDataType::Binary
        | ArrowDataType::LargeBinary
        | ArrowDataType::BinaryView
        | ArrowDataType::FixedSizeBinary(_) => true,
        ArrowDataType::Dictionary(_, value) => is_binary_logical(value),
        ArrowDataType::RunEndEncoded(_, values) => is_binary_logical(values.data_type()),
        _ => false,
    }
}

fn is_nested_logical(data_type: &ArrowDataType) -> bool {
    match data_type {
        ArrowDataType::List(_)
        | ArrowDataType::ListView(_)
        | ArrowDataType::FixedSizeList(_, _)
        | ArrowDataType::LargeList(_)
        | ArrowDataType::LargeListView(_)
        | ArrowDataType::Struct(_)
        | ArrowDataType::Map(_, _)
        | ArrowDataType::Union(_, _) => true,
        ArrowDataType::Dictionary(_, value) => is_nested_logical(value),
        ArrowDataType::RunEndEncoded(_, values) => is_nested_logical(values.data_type()),
        _ => false,
    }
}

fn flatbuffer_error(stage: &str, error: InvalidFlatbuffer) -> TabularkError {
    let code = if matches!(
        error,
        InvalidFlatbuffer::TooManyTables
            | InvalidFlatbuffer::ApparentSizeTooLarge
            | InvalidFlatbuffer::DepthLimitReached
    ) {
        ErrorCode::ResourceLimit
    } else {
        ErrorCode::ParseFailed
    };
    TabularkError::new(code, format!("failed to {stage}"))
        .with_detail("reason", format!("{error:?}"))
}

fn arrow_error(stage: &str, error: ArrowError) -> TabularkError {
    let reason = error.to_string();
    if let Some(error) = zstd_decompression_limit_error(&reason) {
        return error;
    }
    let lowercase = reason.to_ascii_lowercase();
    let code = if lowercase.contains("endianness")
        || lowercase.contains("tensor")
        || lowercase.contains("sparse")
        || lowercase.contains("unsupported message header")
        || lowercase.contains("message type unsupported")
    {
        ErrorCode::UnsupportedFeature
    } else {
        ErrorCode::ParseFailed
    };
    TabularkError::new(code, format!("failed to {stage}")).with_detail("reason", reason)
}

fn invalid_range() -> TabularkError {
    TabularkError::new(
        ErrorCode::InvalidRange,
        "Arrow IPC range starts outside the table extent",
    )
}

fn closed_handle(kind: &str) -> TabularkError {
    TabularkError::new(
        ErrorCode::HandleClosed,
        format!("Arrow {kind} handle is closed"),
    )
}

fn missing_array_buffer() -> TabularkError {
    TabularkError::new(
        ErrorCode::ParseFailed,
        "Arrow array value buffer is missing",
    )
}

fn too_many_buffers() -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "typed batch contains too many or too-large buffers",
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;

    use arrow_array::builder::{
        FixedSizeBinaryBuilder, FixedSizeListBuilder, Int64Builder, LargeListBuilder,
        LargeListViewBuilder, ListBuilder, ListViewBuilder, MapBuilder, StringBuilder,
        StringDictionaryBuilder,
    };
    use arrow_array::types::{Int32Type, IntervalMonthDayNanoType};
    use arrow_array::{
        Array, ArrayRef, BinaryArray, BinaryViewArray, BooleanArray, Date32Array, Date64Array,
        Decimal32Array, Decimal64Array, Decimal128Array, Decimal256Array, DictionaryArray,
        DurationSecondArray, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
        Int64Array, IntervalMonthDayNanoArray, LargeBinaryArray, LargeStringArray, NullArray,
        RecordBatch, RunArray, StringArray, StringViewArray, StructArray, Time32MillisecondArray,
        Time64MicrosecondArray, TimestampMicrosecondArray, TimestampNanosecondArray, UInt8Array,
        UInt16Array, UInt32Array, UInt64Array, UnionArray,
    };
    use arrow_buffer::{NullBuffer, ScalarBuffer, i256};
    use arrow_ipc::reader::read_footer_length;
    use arrow_ipc::writer::{DictionaryHandling, FileWriter, StreamWriter};
    use arrow_ipc::{
        Buffer, CompressionType, Endianness, Int, IntArgs, Message, MessageArgs, MessageHeader,
        MetadataVersion, Schema as IpcSchema, SchemaArgs, SparseTensor, SparseTensorArgs,
        SparseTensorIndex, SparseTensorIndexCOO, SparseTensorIndexCOOArgs, Tensor, TensorArgs,
        TensorDim, Type, root_as_footer_with_opts, root_as_message_with_opts,
        writer::IpcWriteOptions,
    };
    use arrow_schema::{ArrowError, DataType, Field, Schema as ArrowSchema, TimeUnit, UnionFields};
    use flatbuffers::{FlatBufferBuilder, UnionWIPOffset, WIPOffset};

    use super::{
        ARROW_MAGIC, ArrowBatchMode, ArrowIpcContainer, ArrowIpcLimits, ArrowIpcOpenOperation,
        ArrowIpcOptions, ArrowIpcRuntime, ArrowIpcSource, ArrowReadStart, ArrowRuntimeConfig,
        BufferPoolBuilder, DISPLAY_ONLY_MAX_CELL_BYTES, NESTED_DISPLAY_TRUNCATION_SUFFIX,
        ResolvedArrowIpcContainer, arrow_error, compressed_buffer_specs, descriptor_from_array,
        display_array, display_array_with_total_limit, encapsulated_message, encode_batch,
        file_block_spec, flatbuffer_verifier_options, model_data_type, normalize_array_parts,
        validate_stream_message,
    };
    use crate::error::ErrorCode;
    use crate::model::{ArrayLayout, AxisExtent, RandomAccess, RangeRequest, TableDataType};

    #[derive(Clone, Copy)]
    enum TestContainer {
        File,
        Stream,
    }

    #[test]
    fn maps_wrapped_zstd_capacity_errors_before_generic_arrow_classification() {
        let error = arrow_error(
            "decode IPC record batch",
            ArrowError::IpcError(
                "zstd resource limit: output required 65536 available 32768".into(),
            ),
        );
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "decompression");
        assert_eq!(error.details()["requiredBytes"], 65_536);
        assert_eq!(error.details()["availableBytes"], 32_768);

        let malformed = arrow_error(
            "decode IPC record batch",
            ArrowError::IpcError("zstd content checksum mismatch".into()),
        );
        assert_eq!(malformed.code(), ErrorCode::ParseFailed);
    }

    fn fixture_batches() -> Vec<RecordBatch> {
        let identifiers: ArrayRef = Arc::new(Int64Array::from(vec![
            Some(9_007_199_254_740_993_i64),
            None,
            Some(-7),
        ]));
        let decimals: ArrayRef = Arc::new(
            Decimal128Array::from(vec![Some(12_340_i128), None, Some(-5_i128)])
                .with_precision_and_scale(12, 3)
                .expect("decimal metadata"),
        );
        let timestamps: ArrayRef = Arc::new(
            TimestampMicrosecondArray::from(vec![Some(1_704_067_200_123_456_i64), None, Some(0)])
                .with_timezone("Asia/Shanghai"),
        );
        let dictionary: DictionaryArray<Int32Type> =
            vec![Some("北京"), Some("東京"), None].into_iter().collect();
        let dictionary: ArrayRef = Arc::new(dictionary);
        let mut list = ListBuilder::new(StringBuilder::new());
        list.values().append_value("嵌套");
        list.values().append_value("CJK");
        list.append(true);
        list.append(false);
        list.values().append_value("line\nbreak");
        list.append(true);
        let nested: ArrayRef = Arc::new(list.finish());

        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("identifier", DataType::Int64, true),
            Field::new("amount", DataType::Decimal128(12, 3), true),
            Field::new(
                "observed_at",
                DataType::Timestamp(TimeUnit::Microsecond, Some("Asia/Shanghai".into())),
                true,
            ),
            Field::new(
                "city",
                DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
                true,
            ),
            Field::new(
                "tags",
                DataType::List(Arc::new(Field::new_list_field(DataType::Utf8, true))),
                true,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![identifiers, decimals, timestamps, dictionary, nested],
        )
        .expect("fixture batch");
        vec![batch.slice(0, 2), batch.slice(2, 1)]
    }

    fn encode(container: TestContainer, compression: Option<CompressionType>) -> Vec<u8> {
        let batches = fixture_batches();
        let options = IpcWriteOptions::default()
            .try_with_compression(compression)
            .expect("compression options");
        let mut bytes = Vec::new();
        match container {
            TestContainer::File => {
                let mut writer =
                    FileWriter::try_new_with_options(&mut bytes, batches[0].schema_ref(), options)
                        .expect("file writer");
                for batch in &batches {
                    writer.write(batch).expect("file batch");
                }
                writer.finish().expect("file finish");
            }
            TestContainer::Stream => {
                let mut writer = StreamWriter::try_new_with_options(
                    &mut bytes,
                    batches[0].schema_ref(),
                    options,
                )
                .expect("stream writer");
                for batch in &batches {
                    writer.write(batch).expect("stream batch");
                }
                writer.finish().expect("stream finish");
            }
        }
        bytes
    }

    fn finish_test_message(
        builder: &mut FlatBufferBuilder<'_>,
        header_type: MessageHeader,
        header: WIPOffset<UnionWIPOffset>,
    ) -> Vec<u8> {
        let message = Message::create(
            builder,
            &MessageArgs {
                version: MetadataVersion::V5,
                header_type,
                header: Some(header),
                bodyLength: 0,
                custom_metadata: None,
            },
        );
        builder.finish(message, None);
        builder.finished_data().to_vec()
    }

    fn tensor_message_metadata() -> Vec<u8> {
        let mut builder = FlatBufferBuilder::new();
        let value_type = Int::create(
            &mut builder,
            &IntArgs {
                bitWidth: 32,
                is_signed: true,
            },
        );
        let shape = builder.create_vector(&[] as &[WIPOffset<TensorDim<'_>>]);
        let data = Buffer::new(0, 0);
        let tensor = Tensor::create(
            &mut builder,
            &TensorArgs {
                type_type: Type::Int,
                type_: Some(value_type.as_union_value()),
                shape: Some(shape),
                strides: None,
                data: Some(&data),
            },
        );
        finish_test_message(&mut builder, MessageHeader::Tensor, tensor.as_union_value())
    }

    fn sparse_tensor_message_metadata() -> Vec<u8> {
        let mut builder = FlatBufferBuilder::new();
        let value_type = Int::create(
            &mut builder,
            &IntArgs {
                bitWidth: 32,
                is_signed: true,
            },
        );
        let index_type = Int::create(
            &mut builder,
            &IntArgs {
                bitWidth: 64,
                is_signed: true,
            },
        );
        let zero_buffer = Buffer::new(0, 0);
        let index = SparseTensorIndexCOO::create(
            &mut builder,
            &SparseTensorIndexCOOArgs {
                indicesType: Some(index_type),
                indicesStrides: None,
                indicesBuffer: Some(&zero_buffer),
                isCanonical: true,
            },
        );
        let shape = builder.create_vector(&[] as &[WIPOffset<TensorDim<'_>>]);
        let sparse = SparseTensor::create(
            &mut builder,
            &SparseTensorArgs {
                type_type: Type::Int,
                type_: Some(value_type.as_union_value()),
                shape: Some(shape),
                non_zero_length: 0,
                sparseIndex_type: SparseTensorIndex::SparseTensorIndexCOO,
                sparseIndex: Some(index.as_union_value()),
                data: Some(&zero_buffer),
            },
        );
        finish_test_message(
            &mut builder,
            MessageHeader::SparseTensor,
            sparse.as_union_value(),
        )
    }

    fn opposite_endian_schema_metadata() -> Vec<u8> {
        let mut builder = FlatBufferBuilder::new();
        let endianness = if cfg!(target_endian = "little") {
            Endianness::Big
        } else {
            Endianness::Little
        };
        let schema = IpcSchema::create(
            &mut builder,
            &SchemaArgs {
                endianness,
                ..SchemaArgs::default()
            },
        );
        finish_test_message(&mut builder, MessageHeader::Schema, schema.as_union_value())
    }

    fn assert_stream_metadata_unsupported(metadata: Vec<u8>, schema_seen: bool) {
        let error = validate_stream_message(&metadata, &ArrowIpcLimits::default(), schema_seen)
            .expect_err("stream metadata must be rejected as unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
    }

    fn replace_first_compressed_prefix(
        bytes: &mut [u8],
        container: TestContainer,
        declared_bytes: i64,
    ) {
        let limits = ArrowIpcLimits::default();
        let target = match container {
            TestContainer::File => {
                let trailer: [u8; 10] = bytes[bytes.len() - 10..].try_into().expect("file trailer");
                let footer_length = read_footer_length(trailer).expect("footer length");
                let footer_start = bytes.len() - 10 - footer_length;
                let footer = root_as_footer_with_opts(
                    &flatbuffer_verifier_options(&limits),
                    &bytes[footer_start..bytes.len() - 10],
                )
                .expect("footer");
                footer
                    .recordBatches()
                    .expect("record batch blocks")
                    .iter()
                    .find_map(|block| {
                        let block = file_block_spec(*block, bytes.len(), &limits).ok()?;
                        let metadata_end = block.offset.checked_add(block.metadata_length)?;
                        let message =
                            encapsulated_message(&bytes[block.offset..metadata_end], &limits)
                                .ok()?;
                        compressed_buffer_specs(&message, block.body_length)
                            .ok()?
                            .first()
                            .and_then(|buffer| {
                                block
                                    .offset
                                    .checked_add(block.metadata_length)?
                                    .checked_add(buffer.offset)
                            })
                    })
                    .expect("compressed file buffer")
            }
            TestContainer::Stream => {
                let mut offset = 0_usize;
                loop {
                    let first: [u8; 4] = bytes[offset..offset + 4]
                        .try_into()
                        .expect("stream framing");
                    offset += 4;
                    let metadata_length = if first == [0xff; 4] {
                        let length: [u8; 4] = bytes[offset..offset + 4]
                            .try_into()
                            .expect("stream continuation length");
                        offset += 4;
                        usize::try_from(u32::from_le_bytes(length)).expect("metadata length")
                    } else {
                        usize::try_from(u32::from_le_bytes(first)).expect("metadata length")
                    };
                    assert_ne!(metadata_length, 0, "expected a compressed IPC message");
                    let metadata_end = offset + metadata_length;
                    let message = root_as_message_with_opts(
                        &flatbuffer_verifier_options(&limits),
                        &bytes[offset..metadata_end],
                    )
                    .expect("stream message");
                    let body_length = usize::try_from(message.bodyLength()).expect("body length");
                    let body_start = metadata_end;
                    if let Some(buffer) = compressed_buffer_specs(&message, body_length)
                        .expect("compressed buffer metadata")
                        .first()
                    {
                        break body_start + buffer.offset;
                    }
                    offset = body_start + body_length;
                }
            }
        };
        bytes[target..target + 8].copy_from_slice(&declared_bytes.to_le_bytes());
    }

    fn stream_without_record_batches(bytes: &[u8]) -> (Vec<u8>, Vec<usize>) {
        let limits = ArrowIpcLimits::default();
        let mut filtered = Vec::with_capacity(bytes.len());
        let mut dictionary_body_bytes = Vec::new();
        let mut offset = 0_usize;
        loop {
            let frame_start = offset;
            let first: [u8; 4] = bytes[offset..offset + 4]
                .try_into()
                .expect("stream framing");
            offset += 4;
            let metadata_length = if first == [0xff; 4] {
                let length: [u8; 4] = bytes[offset..offset + 4]
                    .try_into()
                    .expect("stream continuation length");
                offset += 4;
                usize::try_from(u32::from_le_bytes(length)).expect("metadata length")
            } else {
                usize::try_from(u32::from_le_bytes(first)).expect("metadata length")
            };
            if metadata_length == 0 {
                filtered.extend_from_slice(&bytes[frame_start..offset]);
                assert_eq!(offset, bytes.len(), "end marker must terminate the stream");
                break;
            }
            let metadata_end = offset.checked_add(metadata_length).expect("metadata range");
            let message = root_as_message_with_opts(
                &flatbuffer_verifier_options(&limits),
                &bytes[offset..metadata_end],
            )
            .expect("stream message");
            let body_length = usize::try_from(message.bodyLength()).expect("body length");
            let frame_end = metadata_end.checked_add(body_length).expect("frame range");
            if message.header_type() == MessageHeader::DictionaryBatch {
                dictionary_body_bytes.push(body_length);
            }
            if message.header_type() != MessageHeader::RecordBatch {
                filtered.extend_from_slice(&bytes[frame_start..frame_end]);
            }
            offset = frame_end;
        }
        (filtered, dictionary_body_bytes)
    }

    #[test]
    fn reads_file_and_stream_with_none_lz4_and_zstd() {
        for container in [TestContainer::File, TestContainer::Stream] {
            for compression in [
                None,
                Some(CompressionType::LZ4_FRAME),
                Some(CompressionType::ZSTD),
            ] {
                let bytes = encode(container, compression);
                let source =
                    ArrowIpcSource::open(&bytes, ArrowIpcOptions::default()).expect("open fixture");
                assert_eq!(source.batch_count(), 2);
                assert_eq!(
                    source.metadata().extent().rows(),
                    AxisExtent::Exact { value: 3 }
                );
                assert!(source.metadata().capabilities().typed_values());
                assert_eq!(
                    source.container(),
                    match container {
                        TestContainer::File => ResolvedArrowIpcContainer::File,
                        TestContainer::Stream => ResolvedArrowIpcContainer::Stream,
                    }
                );
            }
        }
    }

    #[test]
    fn rejects_tensor_stream_messages_with_a_structured_error() {
        assert_stream_metadata_unsupported(tensor_message_metadata(), true);
    }

    #[test]
    fn rejects_sparse_tensor_stream_messages_with_a_structured_error() {
        assert_stream_metadata_unsupported(sparse_tensor_message_metadata(), true);
    }

    #[test]
    fn rejects_non_native_endian_stream_schemas_with_a_structured_error() {
        assert_stream_metadata_unsupported(opposite_endian_schema_metadata(), false);
    }

    #[test]
    fn rejects_declared_decompression_bombs_without_poisoning_the_runtime() {
        let limits = ArrowIpcLimits::default();
        let declared_bytes =
            i64::try_from(limits.max_decoded_bytes).expect("default decoded limit fits i64") + 1;
        let mut runtime = ArrowIpcRuntime::default();

        for container in [TestContainer::File, TestContainer::Stream] {
            for compression in [CompressionType::LZ4_FRAME, CompressionType::ZSTD] {
                let mut bytes = encode(container, Some(compression));
                replace_first_compressed_prefix(&mut bytes, container, declared_bytes);
                let error = runtime
                    .open_source(&bytes, ArrowIpcOptions::default())
                    .expect_err("declared decompression bomb must be rejected before decoding");
                assert_eq!(error.code(), ErrorCode::ResourceLimit);
                assert_eq!(runtime.source_count(), 0);
                assert_eq!(runtime.retained_bytes(), 0);
            }
        }

        let valid = encode(TestContainer::Stream, None);
        let source = runtime
            .open_source(&valid, ArrowIpcOptions::default())
            .expect("valid source must still open after rejected bombs");
        assert!(runtime.close_source(source));
        assert_eq!(runtime.retained_bytes(), 0);
    }

    fn every_builtin_nonempty_sample() -> Vec<(&'static str, ArrayRef)> {
        let float16 = arrow_cast::cast(
            &Float32Array::from(vec![Some(1.5), None, Some(-0.0)]),
            &DataType::Float16,
        )
        .expect("float16 sample");

        let mut fixed_binary = FixedSizeBinaryBuilder::new(4);
        fixed_binary
            .append_value([0x00, 0x01, 0xfe, 0xff])
            .expect("fixed binary value");
        fixed_binary.append_null();
        fixed_binary
            .append_value([0x10, 0x20, 0x30, 0x40])
            .expect("fixed binary value");

        let mut list = ListBuilder::new(StringBuilder::new());
        list.values().append_value("alpha");
        list.values().append_value("β");
        list.append(true);
        list.append(false);
        list.values().append_value("中文");
        list.append(true);

        let mut list_view = ListViewBuilder::new(StringBuilder::new());
        list_view.append_value([Some("view-a"), Some("视图")]);
        list_view.append_null();
        list_view.append_value([Some("view-z")]);

        let mut fixed_list = FixedSizeListBuilder::new(StringBuilder::new(), 2);
        fixed_list.values().append_value("fixed-a");
        fixed_list.values().append_value("fixed-b");
        fixed_list.append(true);
        fixed_list.values().append_null();
        fixed_list.values().append_null();
        fixed_list.append(false);
        fixed_list.values().append_value("固定");
        fixed_list.values().append_value("list");
        fixed_list.append(true);

        let mut large_list = LargeListBuilder::new(StringBuilder::new());
        large_list.values().append_value("large-a");
        large_list.values().append_value("大");
        large_list.append(true);
        large_list.append(false);
        large_list.values().append_value("large-z");
        large_list.append(true);

        let mut large_list_view = LargeListViewBuilder::new(StringBuilder::new());
        large_list_view.append_value([Some("large-view-a"), Some("大视图")]);
        large_list_view.append_null();
        large_list_view.append_value([Some("large-view-z")]);

        let struct_fields = vec![
            Field::new("text", DataType::Utf8, true),
            Field::new("number", DataType::Int64, true),
        ]
        .into();
        let struct_array = StructArray::try_new(
            struct_fields,
            vec![
                Arc::new(StringArray::from(vec![
                    Some("struct-a"),
                    None,
                    Some("结构"),
                ])) as ArrayRef,
                Arc::new(Int64Array::from(vec![Some(10), None, Some(-20)])) as ArrayRef,
            ],
            Some(NullBuffer::from(vec![true, false, true])),
        )
        .expect("struct sample");

        let union_fields = UnionFields::try_new(
            vec![7, 9],
            vec![
                Field::new("number", DataType::Int32, true),
                Field::new("text", DataType::Utf8, true),
            ],
        )
        .expect("union fields");
        let union_array = UnionArray::try_new(
            union_fields,
            [7_i8, 9, 7].into_iter().collect::<ScalarBuffer<_>>(),
            Some([0_i32, 0, 1].into_iter().collect::<ScalarBuffer<_>>()),
            vec![
                Arc::new(Int32Array::from(vec![Some(42), Some(-7)])) as ArrayRef,
                Arc::new(StringArray::from(vec![None::<&str>])) as ArrayRef,
            ],
        )
        .expect("dense union sample");

        let dictionary: DictionaryArray<Int32Type> = vec![Some("dictionary-a"), None, Some("字典")]
            .into_iter()
            .collect();

        let mut map = MapBuilder::new(None, StringBuilder::new(), Int64Builder::new());
        map.keys().append_value("first");
        map.values().append_value(1);
        map.append(true).expect("map row");
        map.append(false).expect("null map row");
        map.keys().append_value("中文");
        map.values().append_value(-2);
        map.append(true).expect("map row");

        let run_ends = Int32Array::from(vec![1, 2, 3]);
        let run_values = StringArray::from(vec![Some("run-a"), None, Some("运行")]);
        let runs = RunArray::<Int32Type>::try_new(&run_ends, &run_values).expect("run sample");

        vec![
            ("null", Arc::new(NullArray::new(3))),
            (
                "boolean",
                Arc::new(BooleanArray::from(vec![Some(true), None, Some(false)])),
            ),
            (
                "int8",
                Arc::new(Int8Array::from(vec![Some(-8), None, Some(8)])),
            ),
            (
                "int16",
                Arc::new(Int16Array::from(vec![Some(-16), None, Some(16)])),
            ),
            (
                "int32",
                Arc::new(Int32Array::from(vec![Some(-32), None, Some(32)])),
            ),
            (
                "int64",
                Arc::new(Int64Array::from(vec![
                    Some(-9_007_199_254_740_993),
                    None,
                    Some(9_007_199_254_740_993),
                ])),
            ),
            (
                "uint8",
                Arc::new(UInt8Array::from(vec![Some(8), None, Some(u8::MAX)])),
            ),
            (
                "uint16",
                Arc::new(UInt16Array::from(vec![Some(16), None, Some(u16::MAX)])),
            ),
            (
                "uint32",
                Arc::new(UInt32Array::from(vec![Some(32), None, Some(u32::MAX)])),
            ),
            (
                "uint64",
                Arc::new(UInt64Array::from(vec![Some(64), None, Some(u64::MAX)])),
            ),
            ("float16", float16),
            (
                "float32",
                Arc::new(Float32Array::from(vec![
                    Some(f32::NAN),
                    None,
                    Some(f32::INFINITY),
                ])),
            ),
            (
                "float64",
                Arc::new(Float64Array::from(vec![
                    Some(f64::NEG_INFINITY),
                    None,
                    Some(-0.0),
                ])),
            ),
            (
                "timestamp",
                Arc::new(
                    TimestampNanosecondArray::from(vec![
                        Some(1_704_067_200_123_456_789),
                        None,
                        Some(0),
                    ])
                    .with_timezone("Asia/Shanghai"),
                ),
            ),
            (
                "date32",
                Arc::new(Date32Array::from(vec![Some(19_723), None, Some(0)])),
            ),
            (
                "date64",
                Arc::new(Date64Array::from(vec![
                    Some(1_704_067_200_000),
                    None,
                    Some(0),
                ])),
            ),
            (
                "time32",
                Arc::new(Time32MillisecondArray::from(vec![
                    Some(12_345),
                    None,
                    Some(86_399_999),
                ])),
            ),
            (
                "time64",
                Arc::new(Time64MicrosecondArray::from(vec![
                    Some(12_345_678),
                    None,
                    Some(86_399_999_999),
                ])),
            ),
            (
                "duration",
                Arc::new(DurationSecondArray::from(vec![
                    Some(-3_600),
                    None,
                    Some(86_400),
                ])),
            ),
            (
                "interval",
                Arc::new(IntervalMonthDayNanoArray::from(vec![
                    Some(IntervalMonthDayNanoType::make_value(1, 2, 3_000)),
                    None,
                    Some(IntervalMonthDayNanoType::make_value(-2, -3, -4_000)),
                ])),
            ),
            (
                "binary",
                Arc::new(BinaryArray::from(vec![
                    Some(&b"\x00\xff"[..]),
                    None,
                    Some(&b"\x10\x20"[..]),
                ])),
            ),
            ("fixed-size-binary", Arc::new(fixed_binary.finish())),
            (
                "large-binary",
                Arc::new(LargeBinaryArray::from(vec![
                    Some(&b"large-a"[..]),
                    None,
                    Some(&b"\x00large-z"[..]),
                ])),
            ),
            (
                "binary-view",
                Arc::new(BinaryViewArray::from(vec![
                    Some(&b"view-a"[..]),
                    None,
                    Some(&b"\x00view-z"[..]),
                ])),
            ),
            (
                "utf8",
                Arc::new(StringArray::from(vec![Some("text-a"), None, Some("中文")])),
            ),
            (
                "large-utf8",
                Arc::new(LargeStringArray::from(vec![
                    Some("large-text-a"),
                    None,
                    Some("大文本"),
                ])),
            ),
            (
                "utf8-view",
                Arc::new(StringViewArray::from(vec![
                    Some("view-text-a"),
                    None,
                    Some("视图文本"),
                ])),
            ),
            ("list", Arc::new(list.finish())),
            ("list-view", Arc::new(list_view.finish())),
            ("fixed-size-list", Arc::new(fixed_list.finish())),
            ("large-list", Arc::new(large_list.finish())),
            ("large-list-view", Arc::new(large_list_view.finish())),
            ("struct", Arc::new(struct_array)),
            ("union", Arc::new(union_array)),
            ("dictionary", Arc::new(dictionary)),
            (
                "decimal32",
                Arc::new(
                    Decimal32Array::from(vec![Some(12_345), None, Some(-6_789)])
                        .with_precision_and_scale(9, 2)
                        .expect("decimal32 metadata"),
                ),
            ),
            (
                "decimal64",
                Arc::new(
                    Decimal64Array::from(vec![Some(123_456_789), None, Some(-987_654_321)])
                        .with_precision_and_scale(18, -2)
                        .expect("decimal64 metadata"),
                ),
            ),
            (
                "decimal128",
                Arc::new(
                    Decimal128Array::from(vec![
                        Some(12_345_678_901_234_567_890_i128),
                        None,
                        Some(-987_654_321_i128),
                    ])
                    .with_precision_and_scale(38, 4)
                    .expect("decimal128 metadata"),
                ),
            ),
            (
                "decimal256",
                Arc::new(
                    Decimal256Array::from(vec![
                        Some(i256::from_i128(12_345_678_901_234_567_890_i128)),
                        None,
                        Some(i256::from_i128(-987_654_321_i128)),
                    ])
                    .with_precision_and_scale(76, 8)
                    .expect("decimal256 metadata"),
                ),
            ),
            ("map", Arc::new(map.finish())),
            ("run-end-encoded", Arc::new(runs)),
        ]
    }

    fn stable_display_values(array: &dyn Array) -> Vec<Option<String>> {
        display_array(array, 16 * 1024)
            .expect("stable display values")
            .iter()
            .map(|value| value.map(str::to_owned))
            .collect()
    }

    #[test]
    fn every_arrow_59_builtin_type_has_a_native_and_display_descriptor() {
        let samples = every_builtin_nonempty_sample();
        assert_eq!(samples.len(), 41, "Arrow 59.1.0 has 41 built-in types");

        let expected_displays = samples
            .iter()
            .map(|(name, array)| {
                assert_eq!(array.len(), 3, "{name}");
                let logical_nulls = array
                    .logical_nulls()
                    .unwrap_or_else(|| panic!("{name} must expose its middle logical null"));
                assert!(logical_nulls.is_null(1), "{name}");

                let display = stable_display_values(array.as_ref());
                assert_eq!(display.len(), 3, "{name}");
                if *name == "null" {
                    assert_eq!(display, vec![None, None, None], "{name}");
                } else {
                    assert!(display[0].is_some(), "{name}");
                    assert!(display[1].is_none(), "{name}");
                    assert!(display[2].is_some(), "{name}");
                }

                let data_type = array.data_type();
                let expected = model_data_type(data_type).expect("model data type");
                let normalized =
                    normalize_array_parts(vec![array.slice(0, 2), array.slice(2, 1)], data_type)
                        .unwrap_or_else(|error| panic!("slice/concat {name}: {error}"));
                assert_eq!(normalized.len(), 3, "{name}");
                assert_eq!(
                    stable_display_values(normalized.as_ref()),
                    display,
                    "{name}"
                );

                let mut pool = BufferPoolBuilder::new(1024 * 1024);
                let native = descriptor_from_array(normalized.as_ref(), None, &mut pool)
                    .unwrap_or_else(|error| panic!("native descriptor {name}: {error}"));
                assert_eq!(native.data_type(), &expected, "{name}: {data_type:?}");
                assert_eq!(native.len(), 3, "{name}: {data_type:?}");
                display
            })
            .collect::<Vec<_>>();

        let schema = Arc::new(ArrowSchema::new(
            samples
                .iter()
                .map(|(name, array)| Field::new(*name, array.data_type().clone(), true))
                .collect::<Vec<_>>(),
        ));
        let batch = RecordBatch::try_new(
            schema.clone(),
            samples.iter().map(|(_, array)| array.clone()).collect(),
        )
        .expect("all-type nonempty record batch");
        let batches = [batch.slice(0, 2), batch.slice(2, 1)];

        for container in [TestContainer::File, TestContainer::Stream] {
            let mut bytes = Vec::new();
            match container {
                TestContainer::File => {
                    let mut writer =
                        FileWriter::try_new(&mut bytes, &schema).expect("all-type file writer");
                    for batch in &batches {
                        writer.write(batch).expect("all-type file batch");
                    }
                    writer.finish().expect("all-type file finish");
                }
                TestContainer::Stream => {
                    let mut writer =
                        StreamWriter::try_new(&mut bytes, &schema).expect("all-type stream writer");
                    for batch in &batches {
                        writer.write(batch).expect("all-type stream batch");
                    }
                    writer.finish().expect("all-type stream finish");
                }
            }
            let source = ArrowIpcSource::open(&bytes, ArrowIpcOptions::default())
                .expect("all-type IPC source");
            assert_eq!(source.metadata().schema().len(), 41);
            assert_eq!(source.batch_count(), 2);
            let typed = source
                .read_range(RangeRequest::new(0, 3, 0, 41).expect("all-type range"))
                .expect("all-type typed batch");
            assert_eq!(typed.columns().len(), 41);

            for (index, (name, sample)) in samples.iter().enumerate() {
                let expected_type = model_data_type(sample.data_type()).expect("model data type");
                let typed_column = &typed.columns()[index];
                assert_eq!(typed_column.native().data_type(), &expected_type, "{name}");
                assert_eq!(typed_column.native().len(), 3, "{name}");
                assert_eq!(typed_column.display().len(), 3, "{name}");

                let decoded = normalize_array_parts(
                    source
                        .batches
                        .iter()
                        .map(|batch| batch.column(index).clone())
                        .collect(),
                    sample.data_type(),
                )
                .unwrap_or_else(|error| panic!("decoded slice/concat {name}: {error}"));
                assert_eq!(decoded.data_type(), sample.data_type(), "{name}");
                assert_eq!(
                    stable_display_values(decoded.as_ref()),
                    expected_displays[index],
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn buffer_pool_hash_index_deduplicates_a_max_width_schema_linearly() {
        const BUFFER_COUNT: usize = 16_384;
        let values = (0..BUFFER_COUNT)
            .map(|index| u32::try_from(index).expect("buffer index").to_le_bytes())
            .collect::<Vec<_>>();
        let mut pool = BufferPoolBuilder::new(BUFFER_COUNT * std::mem::size_of::<u32>());

        for (index, value) in values.iter().enumerate() {
            let slice = pool.intern(value).expect("unique buffer");
            assert_eq!(
                slice.buffer_index(),
                u32::try_from(index).expect("public buffer index")
            );
        }
        for (index, value) in values.iter().enumerate().rev() {
            let slice = pool.intern(value).expect("deduplicated buffer");
            assert_eq!(
                slice.buffer_index(),
                u32::try_from(index).expect("public buffer index")
            );
        }

        assert_eq!(pool.finish().len(), BUFFER_COUNT);
    }

    #[test]
    fn nonempty_run_end_encoded_values_round_trip_and_retain_their_native_encoding() {
        let run_ends = Int32Array::from(vec![2, 3, 5]);
        let values = StringArray::from(vec![Some("alpha"), None, Some("中文")]);
        let run_array = RunArray::<Int32Type>::try_new(&run_ends, &values).expect("run array");
        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "runs",
            run_array.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(run_array)])
            .expect("run-end record batch");

        for container in [TestContainer::File, TestContainer::Stream] {
            let mut bytes = Vec::new();
            match container {
                TestContainer::File => {
                    let mut writer = FileWriter::try_new(&mut bytes, &schema).expect("file writer");
                    writer.write(&batch).expect("run-end file batch");
                    writer.finish().expect("run-end file finish");
                }
                TestContainer::Stream => {
                    let mut writer =
                        StreamWriter::try_new(&mut bytes, &schema).expect("stream writer");
                    writer.write(&batch).expect("run-end stream batch");
                    writer.finish().expect("run-end stream finish");
                }
            }
            let source =
                ArrowIpcSource::open(&bytes, ArrowIpcOptions::default()).expect("run-end source");
            let typed = source
                .read_range(RangeRequest::new(0, 5, 0, 1).expect("run-end range"))
                .expect("run-end typed batch");
            let ArrayLayout::RunEndEncoded { run_ends, values } =
                typed.columns()[0].native().layout()
            else {
                panic!("run-end native encoding was flattened")
            };
            assert_eq!(run_ends.len(), 3);
            assert_eq!(values.len(), 3);
            let display =
                display_array(source.batches[0].column(0).as_ref(), 1024).expect("run-end display");
            assert_eq!(
                display.iter().collect::<Vec<_>>(),
                vec![
                    Some("alpha"),
                    Some("alpha"),
                    None,
                    Some("中文"),
                    Some("中文"),
                ]
            );
        }
    }

    #[test]
    fn schema_metadata_field_and_nesting_limits_are_enforced() {
        let metadata_schema = Arc::new(ArrowSchema::new_with_metadata(
            Vec::<Field>::new(),
            HashMap::from([("oversized".to_owned(), "x".repeat(256))]),
        ));
        let metadata_error = ArrowIpcSource::from_batches(
            ResolvedArrowIpcContainer::Stream,
            metadata_schema,
            Vec::new(),
            ArrowIpcOptions {
                limits: ArrowIpcLimits {
                    max_metadata_bytes: 64,
                    ..ArrowIpcLimits::default()
                },
                ..ArrowIpcOptions::default()
            },
        )
        .expect_err("oversized schema metadata must fail");
        assert_eq!(metadata_error.code(), ErrorCode::ResourceLimit);

        let field_schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "root",
            DataType::Struct(
                vec![
                    Field::new("a", DataType::Int32, false),
                    Field::new("b", DataType::Int32, false),
                ]
                .into(),
            ),
            false,
        )]));
        let field_error = ArrowIpcSource::from_batches(
            ResolvedArrowIpcContainer::Stream,
            field_schema,
            Vec::new(),
            ArrowIpcOptions {
                limits: ArrowIpcLimits {
                    max_fields: 2,
                    ..ArrowIpcLimits::default()
                },
                ..ArrowIpcOptions::default()
            },
        )
        .expect_err("recursive field count must include struct children");
        assert_eq!(field_error.code(), ErrorCode::ResourceLimit);

        let mut nested = DataType::Utf8;
        for level in 0..4 {
            nested = DataType::List(Arc::new(Field::new(format!("level-{level}"), nested, true)));
        }
        let nesting_schema = Arc::new(ArrowSchema::new(vec![Field::new("root", nested, true)]));
        let nesting_error = ArrowIpcSource::from_batches(
            ResolvedArrowIpcContainer::Stream,
            nesting_schema,
            Vec::new(),
            ArrowIpcOptions {
                limits: ArrowIpcLimits {
                    max_nesting_depth: 3,
                    ..ArrowIpcLimits::default()
                },
                ..ArrowIpcOptions::default()
            },
        )
        .expect_err("deep schema must fail before decoding values");
        assert_eq!(nesting_error.code(), ErrorCode::ResourceLimit);
    }

    #[test]
    fn incremental_stream_reports_an_indexed_prefix_before_eof() {
        let bytes = encode(TestContainer::Stream, Some(CompressionType::LZ4_FRAME));
        let options = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            limits: ArrowIpcLimits {
                stream_chunk_bytes: 11,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let mut operation =
            ArrowIpcOpenOperation::new(bytes.len(), options).expect("stream operation");
        let mut saw_progress = false;
        while let Some(action) = operation.next_action().expect("stream action") {
            let start = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            let eof = end == bytes.len();
            let opened = operation
                .feed(action.offset, &bytes[start..end], eof)
                .expect("stream bytes");
            if let Some(metadata) = operation.metadata().expect("progress metadata") {
                assert!(!eof, "indexed-prefix metadata must precede EOF");
                assert!(matches!(
                    metadata.extent().rows(),
                    AxisExtent::AtLeast { .. }
                ));
                assert_eq!(
                    metadata.capabilities().random_access(),
                    RandomAccess::IndexedPrefix
                );
                saw_progress = true;
                break;
            }
            assert!(opened.is_none());
        }
        assert!(
            saw_progress,
            "stream schema must yield progressive metadata"
        );
    }

    #[test]
    fn published_stream_prefix_keeps_its_handles_and_becomes_exact_at_eof() {
        let bytes = encode(TestContainer::Stream, Some(CompressionType::LZ4_FRAME));
        let options = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            limits: ArrowIpcLimits {
                stream_chunk_bytes: 11,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let mut operation =
            ArrowIpcOpenOperation::new(bytes.len(), options).expect("stream operation");
        let mut runtime = ArrowIpcRuntime::default();
        let mut source_handle = None;
        let mut table = None;
        let mut saw_readable_prefix = false;

        while let Some(action) = operation.next_action().expect("stream action") {
            let start = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            let eof = end == bytes.len();
            if let Some(opened) = operation
                .feed(action.offset, &bytes[start..end], eof)
                .expect("stream bytes")
            {
                let source = source_handle.expect("stream schema was published before EOF");
                runtime
                    .replace_incremental_source(source, opened)
                    .expect("replace final stream source");
                break;
            }

            let Some(prefix) = operation.stream_prefix().expect("stream prefix") else {
                continue;
            };
            let rows = prefix
                .metadata()
                .extent()
                .rows()
                .value()
                .expect("prefix row extent");
            let current_source = match source_handle {
                Some(source) => {
                    runtime
                        .replace_incremental_source(source, prefix)
                        .expect("replace indexed stream prefix");
                    source
                }
                None => {
                    let source = runtime
                        .open_incremental_source(prefix)
                        .expect("register indexed stream prefix");
                    source_handle = Some(source);
                    source
                }
            };
            let table_handle = *table.get_or_insert_with(|| {
                runtime
                    .open_table(current_source, "table-0")
                    .expect("open table from indexed stream prefix")
            });
            let metadata = runtime.metadata(table_handle).expect("prefix metadata");
            assert!(matches!(
                metadata.extent().rows(),
                AxisExtent::AtLeast { .. }
            ));
            assert_eq!(
                metadata.capabilities().random_access(),
                RandomAccess::IndexedPrefix
            );
            if rows > 0 {
                let batch = runtime
                    .read_range(
                        table_handle,
                        RangeRequest::new(0, 1, 0, 1).expect("prefix range"),
                    )
                    .expect("read decoded stream prefix");
                assert_eq!(batch.range().row_count(), 1);
                saw_readable_prefix = true;
            }
        }

        let source = source_handle.expect("registered stream source");
        let table = table.expect("opened stream table");
        assert!(
            saw_readable_prefix,
            "a decoded prefix must be readable before EOF"
        );
        let metadata = runtime.metadata(table).expect("exact final metadata");
        assert!(matches!(metadata.extent().rows(), AxisExtent::Exact { .. }));
        assert_eq!(metadata.capabilities().random_access(), RandomAccess::Full);
        assert!(runtime.close_table(table));
        assert!(runtime.close_source(source));
    }

    #[test]
    fn stream_deltas_append_each_batch_once_and_finalize_in_place() {
        let bytes = encode(TestContainer::Stream, Some(CompressionType::LZ4_FRAME));
        let options = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            limits: ArrowIpcLimits {
                stream_chunk_bytes: 11,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let mut operation =
            ArrowIpcOpenOperation::new(bytes.len(), options).expect("stream operation");
        let mut runtime = ArrowIpcRuntime::default();
        let mut source = None;
        let mut published_batches = 0_usize;
        let mut delta_batch_visits = 0_usize;

        loop {
            let action = operation
                .next_action()
                .expect("stream action")
                .expect("stream remains active");
            let start = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            let completed = operation
                .feed_owned(
                    action.offset,
                    bytes[start..end].to_vec(),
                    end == bytes.len(),
                )
                .expect("stream ingress");
            if let Some(completed) = completed {
                let handle = match source {
                    Some(handle) => {
                        let delta = operation
                            .take_completed_stream_delta(completed)
                            .expect("EOF delta");
                        assert_eq!(delta.batch_start(), published_batches);
                        assert!(delta.is_exact());
                        published_batches += delta.batch_count();
                        delta_batch_visits += delta.batch_count();
                        runtime
                            .append_incremental_stream(handle, delta)
                            .expect("append EOF delta");
                        handle
                    }
                    None => runtime
                        .open_incremental_source(completed)
                        .expect("register one-chunk stream"),
                };
                source = Some(handle);
                break;
            }
            let Some(delta) = operation.take_stream_delta().expect("stream delta") else {
                continue;
            };
            assert_eq!(delta.batch_start(), published_batches);
            assert!(!delta.is_exact());
            published_batches += delta.batch_count();
            delta_batch_visits += delta.batch_count();
            source = Some(match source {
                Some(handle) => {
                    runtime
                        .append_incremental_stream(handle, delta)
                        .expect("append stream delta");
                    handle
                }
                None => runtime
                    .open_incremental_stream(delta)
                    .expect("register first stream delta"),
            });
        }

        assert_eq!(published_batches, fixture_batches().len());
        assert_eq!(
            delta_batch_visits,
            fixture_batches().len(),
            "delta publication must visit each new batch once, not each full prefix"
        );
        let source = source.expect("published stream source");
        let table = runtime.open_table(source, "table-0").expect("open table");
        assert_eq!(
            runtime
                .metadata(table)
                .expect("exact metadata")
                .extent()
                .rows(),
            AxisExtent::exact(3).expect("extent")
        );
        assert_eq!(
            runtime
                .read_range(table, RangeRequest::new(0, 3, 0, 1).expect("range"))
                .expect("read finalized stream")
                .range()
                .row_count(),
            3
        );
    }

    #[test]
    fn file_open_batches_record_metadata_ranges() {
        let bytes = encode(TestContainer::File, Some(CompressionType::ZSTD));
        let mut operation =
            ArrowIpcOpenOperation::new(bytes.len(), ArrowIpcOptions::default()).expect("file open");
        let mut saw_metadata_batch = false;
        let source = loop {
            let actions = operation.next_actions(32, u64::MAX).expect("file actions");
            assert!(!actions.is_empty());
            if actions.len() > 1 {
                saw_metadata_batch = true;
                assert!(
                    actions.len() > fixture_batches().len(),
                    "dictionary and record metadata should share the batch"
                );
            }
            let ingress = actions
                .into_iter()
                .map(|action| {
                    let start = usize::try_from(action.offset).expect("action offset");
                    let end = usize::try_from(action.offset + action.length).expect("action end");
                    (
                        action.offset,
                        bytes[start..end].to_vec(),
                        end == bytes.len(),
                    )
                })
                .collect();
            if let Some(source) = operation
                .feed_many_owned(ingress)
                .expect("feed file action batch")
            {
                break source;
            }
        };
        assert!(
            saw_metadata_batch,
            "record metadata must share one ABI step"
        );
        assert_eq!(
            source.metadata().extent().rows(),
            AxisExtent::exact(3).expect("extent")
        );
    }

    #[test]
    fn stream_limits_apply_to_record_blocks_after_the_schema() {
        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "payload",
            DataType::Utf8,
            false,
        )]));
        let payload = "x".repeat(16 * 1024);
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(StringArray::from(vec![payload]))],
        )
        .expect("large record batch");
        let mut bytes = Vec::new();
        let mut writer = StreamWriter::try_new(&mut bytes, &schema).expect("stream writer");
        writer.write(&batch).expect("large record batch write");
        writer.finish().expect("stream finish");

        let options = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            limits: ArrowIpcLimits {
                max_block_bytes: 4 * 1024,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let error = ArrowIpcSource::open(&bytes, options)
            .expect_err("record body must respect the stream block limit");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert!(error.message().contains("Stream block"));
    }

    #[test]
    fn incremental_stream_counts_multiple_uncompressed_dictionaries_without_records() {
        const VALUE_BYTES: usize = 12 * 1024;

        let dictionary_type =
            DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8));
        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("left", dictionary_type.clone(), false),
            Field::new("middle", dictionary_type.clone(), false),
            Field::new("right", dictionary_type, false),
        ]));
        let left_value = format!("left-{}", "l".repeat(VALUE_BYTES));
        let middle_value = format!("middle-{}", "m".repeat(VALUE_BYTES));
        let right_value = format!("right-{}", "r".repeat(VALUE_BYTES));
        let left: DictionaryArray<Int32Type> =
            vec![Some(left_value.as_str())].into_iter().collect();
        let middle: DictionaryArray<Int32Type> =
            vec![Some(middle_value.as_str())].into_iter().collect();
        let right: DictionaryArray<Int32Type> =
            vec![Some(right_value.as_str())].into_iter().collect();
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(left), Arc::new(middle), Arc::new(right)],
        )
        .expect("dictionary batch");
        let mut encoded = Vec::new();
        let mut writer =
            StreamWriter::try_new(&mut encoded, &schema).expect("dictionary stream writer");
        writer.write(&batch).expect("dictionary stream batch");
        writer.finish().expect("dictionary stream finish");
        drop(writer);

        // A legal Stream may define dictionaries without ever publishing a
        // record batch. Such dictionaries still live in StreamDecoder's map.
        let (bytes, dictionary_body_bytes) = stream_without_record_batches(&encoded);
        assert_eq!(dictionary_body_bytes.len(), 3);
        let largest_dictionary = *dictionary_body_bytes
            .iter()
            .max()
            .expect("largest dictionary body");
        let dictionary_total: usize = dictionary_body_bytes.iter().sum();
        let memory_budget_bytes = largest_dictionary
            .checked_mul(2)
            .and_then(|value| value.checked_add(2 * 1024))
            .expect("memory budget");
        assert!(largest_dictionary < memory_budget_bytes);
        assert!(dictionary_total > memory_budget_bytes);

        let mut limits =
            ArrowIpcLimits::from_memory_budget(memory_budget_bytes).expect("low dictionary limits");
        limits.max_source_bytes = bytes.len();
        limits.max_metadata_bytes = 4 * 1024;
        limits.max_block_bytes = memory_budget_bytes;
        limits.stream_chunk_bytes = 1024;
        limits.validate().expect("custom dictionary limits");
        let mut operation = ArrowIpcOpenOperation::new(
            bytes.len(),
            ArrowIpcOptions {
                container: ArrowIpcContainer::Stream,
                limits,
                ..ArrowIpcOptions::default()
            },
        )
        .expect("incremental dictionary stream");

        let error = loop {
            let action = operation
                .next_action()
                .expect("stream action")
                .expect("stream remains active");
            let start = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            match operation.feed_owned(
                action.offset,
                bytes[start..end].to_vec(),
                end == bytes.len(),
            ) {
                Ok(None) => {}
                Ok(Some(_)) => panic!("dictionary-only stream exceeded its memory budget"),
                Err(error) => break error,
            }
        };
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert!(error.message().contains("peak-memory"));
    }

    #[test]
    fn incremental_stream_releases_shared_ingress_buffers_under_low_budget() {
        const MEMORY_BUDGET_BYTES: usize = 1024 * 1024;

        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test/performance/fixtures/arrow/m4-stream-none.arrows");
        if !path.exists() {
            // Repository performance fixtures are intentionally not included
            // in published source archives.
            return;
        }
        let bytes = fs::read(path).expect("committed progressive Stream fixture");
        let mut limits =
            ArrowIpcLimits::from_memory_budget(MEMORY_BUDGET_BYTES).expect("stream limits");
        limits.max_source_bytes = bytes.len();
        limits.max_output_bytes = 256 * 1024;
        limits.max_metadata_bytes = 32 * 1024;
        limits.max_block_bytes = 256 * 1024;
        limits.stream_chunk_bytes = 64 * 1024;
        limits.max_display_cell_bytes = 64 * 1024;
        limits.validate().expect("browser-equivalent stream limits");

        let mut operation = ArrowIpcOpenOperation::new(
            bytes.len(),
            ArrowIpcOptions {
                container: ArrowIpcContainer::Stream,
                limits,
                ..ArrowIpcOptions::default()
            },
        )
        .expect("incremental Stream open");
        let source = loop {
            let action = operation
                .next_action()
                .expect("stream action")
                .expect("stream remains active");
            let start = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            if let Some(source) = operation
                .feed_owned(
                    action.offset,
                    bytes[start..end].to_vec(),
                    end == bytes.len(),
                )
                .expect("compact decoded batches must fit the operation budget")
            {
                break source;
            }
        };

        assert_eq!(source.container(), ResolvedArrowIpcContainer::Stream);
        assert_eq!(
            source.metadata().extent().rows(),
            AxisExtent::exact(512).unwrap()
        );
    }

    #[test]
    fn stream_dictionary_delta_and_replacement_decode_to_logical_values() {
        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "value",
            DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)),
            true,
        )]));

        let mut delta_builder = StringDictionaryBuilder::<Int32Type>::new();
        delta_builder.append("a").expect("delta a");
        delta_builder.append("b").expect("delta b");
        let first_delta = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(delta_builder.finish_preserve_values())],
        )
        .expect("first delta batch");
        delta_builder.append("a").expect("reused delta a");
        delta_builder.append("d").expect("new delta d");
        let second_delta = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(delta_builder.finish_preserve_values())],
        )
        .expect("second delta batch");
        let mut delta_bytes = Vec::new();
        let delta_options =
            IpcWriteOptions::default().with_dictionary_handling(DictionaryHandling::Delta);
        let mut delta_writer =
            StreamWriter::try_new_with_options(&mut delta_bytes, &schema, delta_options)
                .expect("delta writer");
        delta_writer.write(&first_delta).expect("first delta write");
        delta_writer
            .write(&second_delta)
            .expect("second delta write");
        delta_writer.finish().expect("delta finish");
        let delta_source =
            ArrowIpcSource::open(&delta_bytes, ArrowIpcOptions::default()).expect("delta source");
        let delta_display =
            display_array(delta_source.batches[1].column(0).as_ref(), 1024).expect("delta display");
        assert_eq!(delta_display.value(0), "a");
        assert_eq!(delta_display.value(1), "d");

        let first_replacement: DictionaryArray<Int32Type> =
            vec![Some("old"), Some("value")].into_iter().collect();
        let second_replacement: DictionaryArray<Int32Type> =
            vec![Some("new"), Some("dictionary")].into_iter().collect();
        let first_replacement =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(first_replacement)])
                .expect("first replacement batch");
        let second_replacement =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(second_replacement)])
                .expect("second replacement batch");
        let mut replacement_bytes = Vec::new();
        let mut replacement_writer =
            StreamWriter::try_new(&mut replacement_bytes, &schema).expect("replacement writer");
        replacement_writer
            .write(&first_replacement)
            .expect("first replacement write");
        replacement_writer
            .write(&second_replacement)
            .expect("second replacement write");
        replacement_writer.finish().expect("replacement finish");
        let replacement_source =
            ArrowIpcSource::open(&replacement_bytes, ArrowIpcOptions::default())
                .expect("replacement source");
        let replacement_display =
            display_array(replacement_source.batches[1].column(0).as_ref(), 1024)
                .expect("replacement display");
        assert_eq!(replacement_display.value(0), "new");
        assert_eq!(replacement_display.value(1), "dictionary");
    }

    #[test]
    fn display_text_is_stable_for_special_floats_binary_decimal_temporal_and_controls() {
        let floats =
            Float64Array::from(vec![f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0, 1.5]);
        let display = display_array(&floats, 1024).expect("float display");
        assert_eq!(display.value(0), "NaN");
        assert_eq!(display.value(1), "Infinity");
        assert_eq!(display.value(2), "-Infinity");
        assert_eq!(display.value(3), "-0");
        assert_eq!(display.value(4), "1.5");

        let binary = BinaryArray::from(vec![Some(&b"\x00\xaf"[..])]);
        let display = display_array(&binary, 1024).expect("binary display");
        assert_eq!(display.value(0), "0x00af");

        let decimal = Decimal128Array::from(vec![12_340_i128])
            .with_precision_and_scale(12, 3)
            .expect("decimal metadata");
        let display = display_array(&decimal, 1024).expect("decimal display");
        assert_eq!(display.value(0), "12.340");

        let timestamp = TimestampMicrosecondArray::from(vec![1_704_067_200_123_456_i64])
            .with_timezone("Asia/Shanghai");
        let display = display_array(&timestamp, 1024).expect("timestamp display");
        assert_eq!(display.value(0), "2024-01-01T08:00:00.123456+08:00");

        let mut list = ListBuilder::new(StringBuilder::new());
        list.values().append_value("line\nbreak\tvalue");
        list.append(true);
        let nested = list.finish();
        let display = display_array(&nested, 1024).expect("nested display");
        assert!(!display.value(0).contains('\n'));
        assert!(!display.value(0).contains('\t'));
        assert!(display.value(0).contains("\\n"));
        assert!(display.value(0).contains("\\t"));
    }

    #[test]
    fn oversized_nested_display_is_bounded_deterministic_and_explicitly_truncated() {
        const MAX_CELL_BYTES: usize = 64;

        let mut list = ListBuilder::new(StringBuilder::new());
        for index in 0..128 {
            list.values()
                .append_value(format!("東京 line {index}\nwith a tab\t"));
        }
        list.append(true);
        let nested = list.finish();
        assert_eq!(nested.value(0).len(), 128);

        let first = display_array(&nested, MAX_CELL_BYTES).expect("bounded nested display");
        let second = display_array(&nested, MAX_CELL_BYTES).expect("deterministic nested display");
        let value = first.value(0);
        assert_eq!(value, second.value(0));
        assert!(value.len() <= MAX_CELL_BYTES);
        assert!(value.ends_with(NESTED_DISPLAY_TRUNCATION_SUFFIX));
        assert!(!value.contains('\n'));
        assert!(!value.contains('\t'));
        assert!(std::str::from_utf8(value.as_bytes()).is_ok());
        assert_eq!(nested.value(0).len(), 128, "native list values stay intact");

        let structural_bytes = 2 * std::mem::size_of::<i32>() + 1;
        let exact_total_limit = structural_bytes + value.len();
        let bounded = display_array_with_total_limit(&nested, MAX_CELL_BYTES, exact_total_limit)
            .expect("display fits exact total limit");
        assert_eq!(bounded.value(0), value);

        let shortened =
            display_array_with_total_limit(&nested, MAX_CELL_BYTES, exact_total_limit - 1)
                .expect("display text may shrink to fit the aggregate budget");
        assert!(shortened.value(0).len() <= value.len());
        assert!(std::str::from_utf8(shortened.value(0).as_bytes()).is_ok());

        let tiny_remaining_total = structural_bytes + 4;
        let tiny = display_array_with_total_limit(&nested, MAX_CELL_BYTES, tiny_remaining_total)
            .expect("nested formatting may use a tiny deterministic preview budget");
        assert!(tiny.value(0).len() <= 4);
        assert!(std::str::from_utf8(tiny.value(0).as_bytes()).is_ok());
    }

    #[test]
    fn oversized_scalar_display_is_utf8_truncated_without_changing_native_data() {
        const MAX_CELL_BYTES: usize = 64;
        let scalar = StringArray::from(vec!["x".repeat(MAX_CELL_BYTES + 1)]);

        let display = display_array(&scalar, MAX_CELL_BYTES).expect("bounded scalar display");
        assert!(display.value(0).ends_with(NESTED_DISPLAY_TRUNCATION_SUFFIX));
        assert!(display.value(0).len() <= MAX_CELL_BYTES);
        assert_eq!(scalar.value(0).len(), MAX_CELL_BYTES + 1);
    }

    #[test]
    fn display_only_batch_omits_native_buffers_and_bounds_large_cells() {
        let value = "x".repeat(128 * 1024);
        let array: ArrayRef = Arc::new(StringArray::from(vec![value]));
        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "value",
            DataType::Utf8,
            false,
        )]));
        let range = RangeRequest::new(0, 1, 0, 1).expect("range");
        let limits = ArrowIpcLimits {
            max_decoded_bytes: 1024 * 1024,
            max_output_bytes: 32 * 1024,
            max_display_cell_bytes: 1024 * 1024,
            ..ArrowIpcLimits::default()
        };

        let error = encode_batch(
            &schema,
            vec![(0, array.clone())],
            range,
            true,
            &limits,
            ArrowBatchMode::Typed,
        )
        .expect_err("the native string cannot fit the output pool");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "typed-batch-output");

        let display = encode_batch(
            &schema,
            vec![(0, array)],
            range,
            true,
            &limits,
            ArrowBatchMode::DisplayOnly,
        )
        .expect("bounded display-only output");
        let column = &display.columns()[0];
        assert_eq!(column.native().data_type(), &TableDataType::Null);
        assert!(matches!(column.native().layout(), ArrayLayout::Null));
        assert_eq!(column.native().len(), 1);
        assert!(
            display
                .buffers()
                .iter()
                .map(|buffer| buffer.data().len())
                .sum::<usize>()
                <= DISPLAY_ONLY_MAX_CELL_BYTES + 16
        );
    }

    #[test]
    fn incremental_open_never_requests_a_full_file_or_stream_source() {
        let file = encode(TestContainer::File, Some(CompressionType::ZSTD));
        let mut file_open =
            ArrowIpcOpenOperation::new(file.len(), ArrowIpcOptions::default()).expect("file open");
        let first = file_open
            .next_action()
            .expect("file action")
            .expect("file magic action");
        assert_eq!(first.offset, 0);
        assert_eq!(first.length, ARROW_MAGIC.len() as u64);
        assert!(first.length < file.len() as u64);

        let mut saw_trailer = false;
        let file_source = loop {
            let action = file_open
                .next_action()
                .expect("file action")
                .expect("file open remains active");
            assert!(action.length < file.len() as u64);
            saw_trailer |=
                action.length == 10 && action.offset + action.length == file.len() as u64;
            let offset = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            let eof = end == file.len();
            if let Some(source) = file_open
                .feed(action.offset, &file[offset..end], eof)
                .expect("feed file action")
            {
                break source;
            }
        };
        assert!(saw_trailer);
        assert_eq!(file_source.container(), ResolvedArrowIpcContainer::File);

        let mut runtime = ArrowIpcRuntime::default();
        let source = runtime
            .open_incremental_source(file_source)
            .expect("register indexed file");
        let table = runtime.open_table(source, "table-0").expect("open table");
        let read = runtime
            .begin_read(table, RangeRequest::new(0, 1, 0, 1).expect("range"))
            .expect("begin file read");
        assert!(matches!(read, ArrowReadStart::File(_)));

        let stream = encode(TestContainer::Stream, Some(CompressionType::LZ4_FRAME));
        let stream_options = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            limits: ArrowIpcLimits {
                stream_chunk_bytes: 7,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let mut stream_open =
            ArrowIpcOpenOperation::new(stream.len(), stream_options).expect("stream open");
        let mut action_count = 0;
        let stream_source = loop {
            let action = stream_open
                .next_action()
                .expect("stream action")
                .expect("stream open remains active");
            action_count += 1;
            assert!(action.length <= 7);
            assert!(action.length < stream.len() as u64);
            let offset = usize::try_from(action.offset).expect("action offset");
            let end = usize::try_from(action.offset + action.length).expect("action end");
            let eof = end == stream.len();
            if let Some(source) = stream_open
                .feed(action.offset, &stream[offset..end], eof)
                .expect("feed stream action")
            {
                break source;
            }
        };
        assert!(action_count > 1);
        assert_eq!(stream_source.container(), ResolvedArrowIpcContainer::Stream);
    }

    #[test]
    fn incremental_file_releases_wide_blocks_and_view_buffers_under_low_budget() {
        const BATCH_COUNT: usize = 10;
        const PAYLOAD_BYTES: usize = 12 * 1024;
        const MEMORY_BUDGET_BYTES: usize = 64 * 1024;

        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("selected", DataType::Utf8View, false),
            Field::new("ignored-payload", DataType::Binary, false),
        ]));
        let mut bytes = Vec::new();
        let mut writer = FileWriter::try_new(&mut bytes, &schema).expect("file writer");
        for index in 0..BATCH_COUNT {
            let selected = format!("selected-{index:02}-{}", "v".repeat(48));
            let payload = vec![u8::try_from(index).expect("payload byte"); PAYLOAD_BYTES];
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(StringViewArray::from(vec![Some(selected.as_str())])),
                    Arc::new(BinaryArray::from(vec![Some(payload.as_slice())])),
                ],
            )
            .expect("wide view batch");
            writer.write(&batch).expect("wide view file batch");
        }
        writer.finish().expect("wide view file finish");
        drop(writer);

        let mut limits =
            ArrowIpcLimits::from_memory_budget(MEMORY_BUDGET_BYTES).expect("memory limits");
        // The Worker owns the full source outside WASM, so an incremental File
        // may be larger than the operation's decoded-memory ceiling.
        limits.max_source_bytes = bytes.len();
        let options = ArrowIpcOptions {
            container: ArrowIpcContainer::File,
            limits: limits.clone(),
            ..ArrowIpcOptions::default()
        };
        let mut open =
            ArrowIpcOpenOperation::new(bytes.len(), options).expect("incremental file open");
        let source = loop {
            let action = open
                .next_action()
                .expect("open action")
                .expect("file open remains active");
            let start = usize::try_from(action.offset).expect("open offset");
            let end = usize::try_from(action.offset + action.length).expect("open end");
            if let Some(source) = open
                .feed(action.offset, &bytes[start..end], end == bytes.len())
                .expect("open bytes")
            {
                break source;
            }
        };

        let ArrowReadStart::File(mut read) = source
            .begin_read(RangeRequest::new(0, BATCH_COUNT as u64, 0, 1).expect("projected range"))
            .expect("begin projected File read")
        else {
            panic!("non-empty File range must request record blocks")
        };
        let mut required_ingress = 0_usize;
        let batch = loop {
            let action = read
                .next_action()
                .expect("read action")
                .expect("File read remains active");
            let start = usize::try_from(action.offset).expect("read offset");
            let end = usize::try_from(action.offset + action.length).expect("read end");
            required_ingress = required_ingress
                .checked_add(end - start)
                .expect("required ingress total");
            let result = read
                .feed_owned(
                    action.offset,
                    bytes[start..end].to_vec(),
                    end == bytes.len(),
                )
                .expect("feed projected File block");
            if let Some(batch) = result {
                break batch;
            }
            assert!(read.decoded_bytes < MEMORY_BUDGET_BYTES / 4);
            assert!(
                read.decoded
                    .iter()
                    .all(|(_, batch)| batch.get_array_memory_size() < 4 * 1024),
                "detached Utf8View batches must not retain the wide IPC block"
            );
        };

        assert!(
            required_ingress > MEMORY_BUDGET_BYTES,
            "the regression must span more encoded block bytes than the budget"
        );
        assert_eq!(batch.range().row_count(), BATCH_COUNT as u64);
        assert_eq!(batch.columns().len(), 1);
        assert!(read.decoded.is_empty());
        assert_eq!(read.decoded_bytes, 0);
    }

    #[test]
    fn preserves_recursive_schema_and_encoded_native_layouts() {
        let source = ArrowIpcSource::open(
            &encode(TestContainer::File, Some(CompressionType::ZSTD)),
            ArrowIpcOptions::default(),
        )
        .expect("open fixture");
        let columns = source.metadata().schema().columns();
        assert_eq!(columns[0].data_type(), &TableDataType::Int64);
        assert_eq!(
            columns[1].data_type(),
            &TableDataType::Decimal128 {
                precision: 12,
                scale: 3
            }
        );
        assert!(matches!(
            columns[3].data_type(),
            TableDataType::Dictionary { .. }
        ));
        assert!(matches!(columns[4].data_type(), TableDataType::List { .. }));

        let batch = source
            .read_range(RangeRequest::new(1, 2, 0, 5).expect("range"))
            .expect("cross-batch range");
        assert_eq!(batch.layout_version(), 1);
        assert!(batch.complete());
        assert_eq!(batch.columns().len(), 5);
        assert!(matches!(
            batch.columns()[3].native().layout(),
            ArrayLayout::Dictionary { .. }
        ));
        assert!(matches!(
            batch.columns()[4].native().layout(),
            ArrayLayout::List { .. }
        ));
        assert!(!batch.buffers().is_empty());
    }

    #[test]
    fn truncates_overrun_ranges_and_rejects_cell_bombs() {
        let bytes = encode(TestContainer::Stream, None);
        let options = ArrowIpcOptions {
            limits: ArrowIpcLimits {
                max_range_cells: 10,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let source = ArrowIpcSource::open(&bytes, options).expect("open fixture");
        let batch = source
            .read_range(RangeRequest::new(2, 10, 4, 1).expect("range"))
            .expect("truncated range");
        assert_eq!(batch.range().row_count(), 1);
        assert!(!batch.complete());

        let error = source
            .read_range(RangeRequest::new(0, 3, 0, 5).expect("range"))
            .expect_err("cell limit");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
    }

    #[test]
    fn low_budget_failures_release_state_and_allow_smaller_follow_up_work() {
        let bytes = encode(TestContainer::Stream, Some(CompressionType::ZSTD));
        let mut runtime = ArrowIpcRuntime::default();
        let decoded_tight = ArrowIpcOptions {
            limits: ArrowIpcLimits {
                max_decoded_bytes: 1,
                max_output_bytes: 1,
                max_metadata_bytes: 1,
                max_block_bytes: 1,
                stream_chunk_bytes: 1,
                max_display_cell_bytes: 1,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let error = runtime
            .open_source(&bytes, decoded_tight)
            .expect_err("decoded budget must reject the source");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);

        let output_tight = ArrowIpcOptions {
            limits: ArrowIpcLimits {
                max_output_bytes: 128,
                ..ArrowIpcLimits::default()
            },
            ..ArrowIpcOptions::default()
        };
        let source = runtime
            .open_source(&bytes, output_tight)
            .expect("source after failed open");
        let table = runtime.open_table(source, "table-0").expect("table");
        let error = runtime
            .read_range(table, RangeRequest::new(0, 3, 0, 5).expect("wide range"))
            .expect_err("wide output must exceed the batch budget");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "typed-batch-output");
        let narrow = runtime
            .read_range(table, RangeRequest::new(0, 1, 0, 1).expect("narrow range"))
            .expect("smaller read after a budget failure");
        assert_eq!(narrow.columns().len(), 1);
        assert!(runtime.close_source(source));
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn rejects_truncation_and_wrong_forced_container_without_poisoning_runtime() {
        let valid = encode(TestContainer::File, None);
        let mut runtime = ArrowIpcRuntime::default();
        let error = runtime
            .open_source(&valid[..valid.len() - 7], ArrowIpcOptions::default())
            .expect_err("truncated file must fail");
        assert_eq!(error.code(), ErrorCode::ParseFailed);
        assert_eq!(runtime.source_count(), 0);

        let wrong = ArrowIpcOptions {
            container: ArrowIpcContainer::Stream,
            ..ArrowIpcOptions::default()
        };
        assert!(runtime.open_source(&valid, wrong).is_err());
        assert_eq!(runtime.source_count(), 0);

        let source = runtime
            .open_source(&valid, ArrowIpcOptions::default())
            .expect("subsequent valid source");
        let table = runtime.open_table(source, "table-0").expect("table");
        assert_eq!(runtime.table_count(), 1);
        runtime
            .read_range(table, RangeRequest::new(0, 1, 0, 1).expect("range"))
            .expect("read after failures");
    }

    #[test]
    fn close_source_releases_child_tables_and_retained_budget() {
        let bytes = encode(TestContainer::Stream, Some(CompressionType::LZ4_FRAME));
        let mut runtime = ArrowIpcRuntime::new(ArrowRuntimeConfig {
            memory_budget_bytes: 64 * 1024 * 1024,
            max_sources: 2,
        })
        .expect("runtime");
        let source = runtime
            .open_source(
                &bytes,
                ArrowIpcOptions {
                    limits: ArrowIpcLimits::from_memory_budget(64 * 1024 * 1024)
                        .expect("test memory budget"),
                    ..ArrowIpcOptions::default()
                },
            )
            .expect("source");
        let table = runtime.open_table(source, "table-0").expect("table");
        assert!(runtime.retained_bytes() > 0);
        assert!(runtime.close_source(source));
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.table_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
        assert_eq!(
            runtime
                .metadata(table)
                .expect_err("child table must be closed")
                .code(),
            ErrorCode::HandleClosed
        );
        assert!(!runtime.close_source(source));
        runtime.shutdown();
    }

    #[test]
    fn empty_schema_and_zero_batch_stream_are_supported() {
        let schema = Arc::new(ArrowSchema::empty());
        let mut bytes = Vec::new();
        let mut writer = StreamWriter::try_new(&mut bytes, &schema).expect("writer");
        writer.finish().expect("finish");
        let source = ArrowIpcSource::open(&bytes, ArrowIpcOptions::default()).expect("source");
        assert_eq!(source.batch_count(), 0);
        assert!(source.metadata().schema().is_empty());
        let batch = source
            .read_range(RangeRequest::new(0, 0, 0, 0).expect("range"))
            .expect("empty range");
        assert!(batch.complete());
        assert!(batch.columns().is_empty());
    }

    #[test]
    fn extension_metadata_wraps_the_storage_type() {
        let mut metadata = HashMap::new();
        metadata.insert(
            super::EXTENSION_NAME_KEY.to_owned(),
            "example.uuid".to_owned(),
        );
        metadata.insert(
            super::EXTENSION_METADATA_KEY.to_owned(),
            "revision=1".to_owned(),
        );
        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("custom", DataType::Utf8, true).with_metadata(metadata),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(StringArray::from(vec![Some("值")]))],
        )
        .expect("batch");
        let mut bytes = Vec::new();
        let mut writer = FileWriter::try_new(&mut bytes, &schema).expect("writer");
        writer.write(&batch).expect("write");
        writer.finish().expect("finish");

        let source = ArrowIpcSource::open(&bytes, ArrowIpcOptions::default()).expect("source");
        assert_eq!(
            source.metadata().schema().columns()[0].data_type(),
            &TableDataType::Extension {
                name: "example.uuid".to_owned(),
                metadata: Some("revision=1".to_owned()),
                storage: Box::new(TableDataType::Utf8),
            }
        );
    }

    #[test]
    fn opens_the_pinned_apache_cross_language_nested_file_fixture() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test/fixtures/arrow/v1/apache-arrow-1.0.0-generated-nested.arrow");
        if !path.exists() {
            // Repository integration fixtures are intentionally not included in
            // published source archives.
            return;
        }
        let bytes = fs::read(path).expect("read Apache Arrow integration fixture");
        let source = ArrowIpcSource::open(&bytes, ArrowIpcOptions::default())
            .expect("open Apache Arrow integration fixture");
        assert!(source.batch_count() > 0);
        assert!(!source.metadata().schema().is_empty());
        let columns = u64::try_from(source.metadata().schema().len()).expect("column count");
        let batch = source
            .read_range(RangeRequest::new(0, 8, 0, columns).expect("range"))
            .expect("read nested integration fixture range");
        assert_eq!(
            batch.columns().len(),
            usize::try_from(columns).expect("usize")
        );
        assert!(!batch.buffers().is_empty());
    }

    #[test]
    fn opens_the_committed_m4_playground_fixture_with_required_types() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/arrow/v1/m4-sample.arrow");
        if !path.exists() {
            return;
        }
        let bytes = fs::read(path).expect("read M4 Playground fixture");
        let source = ArrowIpcSource::open(&bytes, ArrowIpcOptions::default())
            .expect("open M4 Playground fixture");
        let types = source
            .metadata()
            .schema()
            .columns()
            .iter()
            .map(|column| column.data_type())
            .collect::<Vec<_>>();
        assert!(types.contains(&&TableDataType::Int64));
        assert!(
            types
                .iter()
                .any(|value| matches!(value, TableDataType::Decimal128 { .. }))
        );
        assert!(
            types
                .iter()
                .any(|value| matches!(value, TableDataType::Timestamp { .. }))
        );
        assert!(
            types
                .iter()
                .any(|value| matches!(value, TableDataType::Dictionary { .. }))
        );
        assert!(types.iter().any(|value| matches!(
            value,
            TableDataType::List { .. } | TableDataType::Struct { .. }
        )));
    }
}
