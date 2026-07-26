//! Versioned, serializable messages for the Worker boundary.
//!
//! Rust traits and JavaScript classes are deliberately absent from this module.
//! Its tagged DTOs are the compatibility boundary between a Worker facade and
//! the data runtime.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::error::{ErrorCode, Result, TabularkError};
use crate::model::{MAX_SAFE_INTEGER, RangeRequest, TableMetadata, TypedTableBatch};

/// The original Worker protocol retained only for migration diagnostics.
pub const LEGACY_PROTOCOL_VERSION: u32 = 1;

/// Worker protocol v2 retained only for migration-fixture diagnostics.
pub const PROTOCOL_V2_VERSION: u32 = 2;

/// The immediately previous Worker protocol retained for migration diagnostics.
pub const PREVIOUS_PROTOCOL_VERSION: u32 = 3;

/// The only Worker protocol version implemented by this crate.
pub const PROTOCOL_VERSION: u32 = 4;

/// The Rust adapter ABI version implemented by official adapters.
pub const ADAPTER_API_VERSION: u32 = 3;

/// Maximum source ranges one ABI-v3 operation step can issue.
pub const MAX_OPERATION_RANGES_PER_STEP: usize = 32;

/// The common typed-buffer descriptor version implemented by official adapters.
pub use crate::model::BATCH_LAYOUT_VERSION;

/// Stable ID of the official CSV/TSV adapter.
pub const DELIMITED_ADAPTER_ID: &str = "tabulark:delimited";

/// Stable ID of the official Apache Arrow IPC adapter.
pub const ARROW_IPC_ADAPTER_ID: &str = "tabulark:arrow-ipc";

/// Stable ID of the official Apache Parquet adapter.
pub const PARQUET_ADAPTER_ID: &str = "tabulark:parquet";

/// Stable ID of the official Excel workbook adapter.
pub const EXCEL_ADAPTER_ID: &str = "tabulark:excel";

/// One bounded source-range request issued by an official adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AdapterAction {
    /// Read exactly `length` bytes beginning at absolute `offset`.
    ReadBytes {
        /// Step-local identifier used to reject missing or duplicate results.
        action_index: u32,
        /// Absolute byte offset in the Worker-owned source.
        offset: u64,
        /// Exact number of bytes requested.
        length: u64,
    },
}

impl AdapterAction {
    /// Creates a bounded byte-range action.
    #[must_use]
    pub const fn read_bytes(offset: u64, length: u64) -> Self {
        Self::ReadBytes {
            action_index: 0,
            offset,
            length,
        }
    }

    /// Creates an indexed bounded byte-range action for a batched step.
    #[must_use]
    pub const fn indexed_read_bytes(action_index: u32, offset: u64, length: u64) -> Self {
        Self::ReadBytes {
            action_index,
            offset,
            length,
        }
    }

    /// Returns the step-local action identifier.
    #[must_use]
    pub const fn action_index(self) -> u32 {
        match self {
            Self::ReadBytes { action_index, .. } => action_index,
        }
    }

    /// Returns the requested absolute byte offset.
    #[must_use]
    pub const fn offset(self) -> u64 {
        match self {
            Self::ReadBytes { offset, .. } => offset,
        }
    }

    /// Returns the exact requested byte length.
    #[must_use]
    pub const fn length(self) -> u64 {
        match self {
            Self::ReadBytes { length, .. } => length,
        }
    }

    /// Returns the checked exclusive range end.
    pub fn end(self) -> Result<u64> {
        self.offset().checked_add(self.length()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "adapter source action range overflows u64",
            )
            .with_detail("actionIndex", self.action_index())
            .with_detail("offset", self.offset())
            .with_detail("length", self.length())
        })
    }
}

/// Metadata for one Worker response to an ABI-v3 source action.
///
/// Bytes stay outside the serializable DTO and cross the WebAssembly boundary
/// as transferable typed arrays. This descriptor is sufficient to validate
/// range identity, completeness, duplicates, and stale revisions first.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterActionResult {
    /// Step-local action identifier copied from [`AdapterAction`].
    pub action_index: u32,
    /// Absolute offset of the supplied bytes.
    pub offset: u64,
    /// Number of supplied bytes.
    pub length: u64,
    /// Whether this response reaches the physical source end.
    pub eof: bool,
}

/// Top-level ABI-v3 operation lifecycle state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterStepKind {
    /// More CPU work or Worker-owned source ranges are required.
    Pending,
    /// Readable state was published, but the operation is not terminal.
    Progress,
    /// The operation produced its terminal result and released its handle.
    Complete,
}

/// ABI-v3 operation step shared by open, table, read, and presentation work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStep {
    /// Explicit operation lifecycle state.
    pub kind: AdapterStepKind,
    /// Opaque operation handle.
    pub operation_handle: u32,
    /// Monotonic operation-local revision. The first issued step is revision 1.
    pub operation_revision: u64,
    /// Zero to 32 Worker-owned source ranges requested by this step.
    pub actions: Vec<AdapterAction>,
    /// True when the empty action list is an intentional cooperative CPU yield.
    pub cooperative_yield: bool,
    /// Adapter-specific progress or completion payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl AdapterStep {
    /// Creates and validates one operation step against its byte budget.
    pub fn new(
        kind: AdapterStepKind,
        operation_handle: u32,
        operation_revision: u64,
        actions: Vec<AdapterAction>,
        cooperative_yield: bool,
        payload: Option<Value>,
        operation_budget_bytes: u64,
    ) -> Result<Self> {
        validate_operation_actions(&actions, operation_budget_bytes)?;
        if operation_revision == 0 || operation_revision > MAX_SAFE_INTEGER {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "operation revision must be a positive JavaScript safe integer",
            )
            .with_detail("operationRevision", operation_revision.to_string()));
        }
        if kind == AdapterStepKind::Complete && (!actions.is_empty() || cooperative_yield) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "a complete operation step cannot request more work",
            ));
        }
        if kind != AdapterStepKind::Complete && actions.is_empty() && !cooperative_yield {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "a non-terminal operation step must request I/O or an explicit cooperative yield",
            ));
        }
        if !actions.is_empty() && cooperative_yield {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "an operation step cannot request I/O and a cooperative yield together",
            ));
        }
        Ok(Self {
            kind,
            operation_handle,
            operation_revision,
            actions,
            cooperative_yield,
            payload,
        })
    }
}

/// Revision and outstanding-action validator embedded by an ABI-v3 operation.
#[derive(Clone, Debug, Default)]
pub struct AdapterOperationCursor {
    revision: u64,
    outstanding: Vec<AdapterAction>,
    awaiting_results: bool,
}

impl AdapterOperationCursor {
    /// Creates a cursor before its first step is issued.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            revision: 0,
            outstanding: Vec::new(),
            awaiting_results: false,
        }
    }

    /// Issues the next monotonic revision and records all expected ranges.
    pub fn issue(
        &mut self,
        actions: Vec<AdapterAction>,
        operation_budget_bytes: u64,
    ) -> Result<u64> {
        if self.awaiting_results {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "operation already has outstanding source actions",
            ));
        }
        validate_operation_actions(&actions, operation_budget_bytes)?;
        let revision = self.revision.checked_add(1).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation revision space is exhausted",
            )
        })?;
        if revision > MAX_SAFE_INTEGER {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation revision exceeds the JavaScript safe integer range",
            ));
        }
        self.revision = revision;
        self.outstanding = actions;
        self.awaiting_results = true;
        Ok(revision)
    }

    /// Advances to a terminal step that requests no result set.
    pub fn complete_revision(&mut self) -> Result<u64> {
        if self.awaiting_results {
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "operation cannot complete with outstanding source actions",
            ));
        }
        let revision = self.revision.checked_add(1).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation revision space is exhausted",
            )
        })?;
        if revision > MAX_SAFE_INTEGER {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation revision exceeds the JavaScript safe integer range",
            ));
        }
        self.revision = revision;
        Ok(revision)
    }

    /// Validates one complete Worker result set. State advances only after all
    /// results match, so a malformed response cannot consume the valid step.
    pub fn validate_results(
        &mut self,
        operation_revision: u64,
        results: &[AdapterActionResult],
    ) -> Result<()> {
        if operation_revision != self.revision {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "operation result revision is missing, stale, or out of order",
            )
            .with_detail("expectedOperationRevision", self.revision)
            .with_detail("actualOperationRevision", operation_revision));
        }
        if !self.awaiting_results {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "operation revision has already consumed its result set",
            )
            .with_detail("operationRevision", operation_revision));
        }
        if results.len() != self.outstanding.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "operation result set is missing or contains extra source ranges",
            )
            .with_detail("expectedResults", self.outstanding.len())
            .with_detail("actualResults", results.len()));
        }

        let mut seen = HashSet::with_capacity(results.len());
        for result in results {
            if !seen.insert(result.action_index) {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "operation result set contains a duplicate source range",
                )
                .with_detail("actionIndex", result.action_index));
            }
            let expected = self
                .outstanding
                .iter()
                .copied()
                .find(|action| action.action_index() == result.action_index)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::InvalidArgument,
                        "operation result references an unknown source range",
                    )
                    .with_detail("actionIndex", result.action_index)
                })?;
            let actual_end = result.offset.checked_add(result.length).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "operation result source range overflows u64",
                )
                .with_detail("actionIndex", result.action_index)
            })?;
            if expected.offset() != result.offset
                || expected.length() != result.length
                || expected.end()? != actual_end
            {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "operation result does not match its requested source range",
                )
                .with_detail("actionIndex", result.action_index)
                .with_detail("expectedOffset", expected.offset())
                .with_detail("expectedLength", expected.length())
                .with_detail("actualOffset", result.offset)
                .with_detail("actualLength", result.length));
            }
        }
        self.outstanding.clear();
        self.awaiting_results = false;
        Ok(())
    }

    /// Returns the most recently issued revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

/// Validates action count, unique IDs, safe-integer boundaries, checked ends,
/// and aggregate bytes for one operation step.
pub fn validate_operation_actions(
    actions: &[AdapterAction],
    operation_budget_bytes: u64,
) -> Result<u64> {
    if actions.len() > MAX_OPERATION_RANGES_PER_STEP {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "operation step requests too many source ranges",
        )
        .with_detail("rangeCount", actions.len())
        .with_detail("maxRangeCount", MAX_OPERATION_RANGES_PER_STEP));
    }
    let mut ids = HashSet::with_capacity(actions.len());
    let mut total = 0_u64;
    for action in actions {
        if !ids.insert(action.action_index()) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "operation step contains a duplicate source action ID",
            )
            .with_detail("actionIndex", action.action_index()));
        }
        if action.offset() > MAX_SAFE_INTEGER
            || action.length() > MAX_SAFE_INTEGER
            || action.end()? > MAX_SAFE_INTEGER
        {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation source range exceeds the JavaScript safe integer boundary",
            )
            .with_detail("actionIndex", action.action_index()));
        }
        total = total.checked_add(action.length()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "operation step source byte total overflows u64",
            )
        })?;
    }
    if total > operation_budget_bytes {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "operation step exceeds its source byte budget",
        )
        .with_detail("requestedBytes", total)
        .with_detail("operationBudgetBytes", operation_budget_bytes));
    }
    Ok(total)
}

/// Performs the explicit 32-bit WebAssembly `usize` boundary conversion used
/// by synthetic ABI tests without allocating a source of that size.
pub fn checked_wasm32_usize(value: u64, field: &str) -> Result<usize> {
    let narrowed = u32::try_from(value).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "value exceeds the wasm32 usize range",
        )
        .with_detail("field", field)
        .with_detail("value", value.to_string())
    })?;
    usize::try_from(narrowed).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "wasm32 usize value is unavailable on this validation target",
        )
        .with_detail("field", field)
    })
}

/// Stable logical-table identity published while an adapter opens a source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterTableDescriptor {
    /// Stable logical table ID within the opened source.
    pub id: String,
    /// User-facing table name.
    pub name: String,
}

/// Progressive counters published by an adapter open operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProgress {
    /// Numeric source handle owned by the adapter runtime.
    pub source_handle: u32,
    /// Source bytes examined so far.
    pub bytes_scanned: u64,
    /// Logical rows discovered so far.
    pub rows_discovered: u64,
    /// Whether source discovery has reached a terminal state.
    pub done: bool,
}

/// Rejects every protocol other than the current breaking version.
pub fn ensure_protocol_version(actual: u32) -> Result<()> {
    if actual != PROTOCOL_VERSION {
        return Err(TabularkError::new(
            ErrorCode::ProtocolIncompatible,
            "the peer uses an unsupported Worker protocol version",
        )
        .with_detail("expectedProtocolVersion", PROTOCOL_VERSION)
        .with_detail("actualProtocolVersion", actual));
    }
    Ok(())
}

fn deserialize_protocol_version<'de, D>(deserializer: D) -> std::result::Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    ensure_protocol_version(version).map_err(D::Error::custom)?;
    Ok(version)
}

/// A request sent to the runtime.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    #[serde(deserialize_with = "deserialize_protocol_version")]
    protocol_version: u32,
    request_id: String,
    #[serde(flatten)]
    request: Request,
}

impl RequestEnvelope {
    /// Creates a versioned request envelope.
    #[must_use]
    pub fn new(request_id: impl Into<String>, request: Request) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            request,
        }
    }

    /// Returns the sender's protocol version.
    #[must_use]
    pub const fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    /// Returns the opaque request ID.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the request operation and payload.
    #[must_use]
    pub const fn request(&self) -> &Request {
        &self.request
    }
}

/// Worker operations supported by protocol version four.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "op", content = "payload", rename_all = "camelCase")]
#[non_exhaustive]
pub enum Request {
    /// Negotiate protocol compatibility and runtime features.
    Hello(HelloRequest),
    /// Open a physical source as a dataset session.
    OpenSource(OpenSourceRequest),
    /// Enumerate logical tables in a dataset.
    ListTables(DatasetRequest),
    /// Open one logical table.
    OpenTable(OpenTableRequest),
    /// Get the latest progressive table metadata.
    GetMetadata(TableRequest),
    /// Get static spreadsheet presentation metadata, when the table has it.
    GetPresentation(TableRequest),
    /// Read range-aligned spreadsheet styles, merges, and sparse layout data.
    ReadPresentationRange(ReadPresentationRangeRequest),
    /// Read a bounded rectangular table range.
    ReadRange(ReadRangeRequest),
    /// Best-effort cancellation of an outstanding request.
    Cancel(CancelRequest),
    /// Release one table handle.
    CloseTable(TableRequest),
    /// Release a dataset and all of its tables.
    CloseSource(DatasetRequest),
    /// Dispose the runtime instance.
    Shutdown,
}

/// Payload for the protocol handshake.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    /// Optional application identifier for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    /// Frozen built-in adapters enabled for this engine instance.
    #[serde(default)]
    pub adapters: Vec<AdapterRegistration>,
    /// Engine-wide resource budget from which adapter limits are derived.
    #[serde(default)]
    pub memory_budget_bytes: u64,
}

/// Internal registration for one frozen official adapter descriptor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRegistration {
    /// Stable built-in adapter ID.
    pub id: String,
    /// Package-relative artifact URL resolved by the official JS descriptor.
    pub module_url: String,
}

/// Payload for opening a source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSourceRequest {
    /// Explicit adapter ID; automatic adapter selection is intentionally absent.
    pub adapter_id: String,
    /// Adapter-specific JSON options validated by the selected adapter.
    #[serde(default)]
    pub options: Value,
}

/// Payload that identifies a dataset session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRequest {
    /// Opaque dataset handle.
    pub dataset_handle: String,
}

/// Payload that identifies a logical table.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRequest {
    /// Opaque table handle.
    pub table_handle: String,
}

/// Payload for opening a table from a dataset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTableRequest {
    /// Opaque parent dataset handle.
    pub dataset_handle: String,
    /// Stable logical table ID from `listTables`.
    pub table_id: String,
}

/// Payload for reading a table range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRangeRequest {
    /// Opaque table handle.
    pub table_handle: String,
    /// Requested zero-based, half-open range.
    pub range: RangeRequest,
}

/// Payload for reading presentation data aligned with a table range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPresentationRangeRequest {
    /// Opaque table handle.
    pub table_handle: String,
    /// Requested zero-based, half-open presentation range.
    pub range: RangeRequest,
}

/// Payload for cancellation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    /// Request ID to cancel.
    pub target_request_id: String,
}

/// A successful or failed response matched to one request ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    #[serde(deserialize_with = "deserialize_protocol_version")]
    protocol_version: u32,
    request_id: String,
    #[serde(flatten)]
    response: Response,
}

impl ResponseEnvelope {
    /// Creates a successful response.
    #[must_use]
    pub fn success(request_id: impl Into<String>, result: ResponseResult) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            response: Response::Success { result },
        }
    }

    /// Creates a structured failed response.
    #[must_use]
    pub fn failure(request_id: impl Into<String>, error: TabularkError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            response: Response::Failure { error },
        }
    }

    /// Returns the opaque request ID.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the producer's protocol version.
    #[must_use]
    pub const fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    /// Returns the response payload.
    #[must_use]
    pub const fn response(&self) -> &Response {
        &self.response
    }
}

/// Success or structured error response body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Response {
    /// A successful operation response.
    Success {
        /// Operation-specific result.
        result: ResponseResult,
    },
    /// A failed operation response.
    Failure {
        /// Stable structured error.
        error: TabularkError,
    },
}

/// Successful operation payloads.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
#[non_exhaustive]
pub enum ResponseResult {
    /// Handshake result.
    Hello(HelloResponse),
    /// Newly-created dataset session.
    Dataset(DatasetDescriptor),
    /// Logical table descriptors.
    Tables(Vec<TableDescriptor>),
    /// Newly-opened table handle and its first metadata snapshot.
    Table(TableDescriptor),
    /// Latest table metadata.
    Metadata(TableMetadata),
    /// Static table presentation, or `null` for non-spreadsheet adapters.
    Presentation(Option<Value>),
    /// Range-aligned presentation, or `null` for non-spreadsheet adapters.
    PresentationRange(Option<Value>),
    /// A bounded columnar range batch.
    Batch(TypedTableBatch),
    /// An idempotent close, cancel, or shutdown acknowledgement.
    Acknowledged,
}

/// Handshake result and implementation capabilities.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    /// The accepted protocol version.
    #[serde(deserialize_with = "deserialize_protocol_version")]
    pub protocol_version: u32,
    /// The accepted private adapter ABI version.
    pub adapter_api_version: u32,
    /// The accepted generic batch layout version.
    pub batch_layout_version: u32,
    /// Official adapter IDs frozen for this engine instance.
    pub adapters: Vec<String>,
    /// Whether range batches can carry transferable binary buffers.
    pub transferable_batches: bool,
}

/// A source-backed dataset session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetDescriptor {
    /// Opaque dataset session handle.
    pub dataset_handle: String,
}

/// Identifies a logical table without exposing implementation state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescriptor {
    /// Stable table ID within the dataset revision.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Opaque table handle when the descriptor represents an opened table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_handle: Option<String>,
}

/// An unsolicited Worker event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    /// Protocol version used by the event producer.
    #[serde(deserialize_with = "deserialize_protocol_version")]
    pub protocol_version: u32,
    /// Optional request that initiated the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Dataset that owns this event. Required for dataset and table events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_handle: Option<String>,
    /// Table handle when the event targets one opened table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_handle: Option<String>,
    /// Logical table ID when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_id: Option<String>,
    /// Event type and payload.
    #[serde(flatten)]
    pub event: RuntimeEvent,
}

/// Events that can arrive between request responses.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
#[non_exhaustive]
pub enum RuntimeEvent {
    /// Bytes and rows discovered while scanning a source.
    Progress(ProgressEvent),
    /// A new table metadata snapshot.
    Metadata(TableMetadata),
    /// A recoverable source diagnostic.
    Warning(WarningEvent),
    /// A dataset or table was closed.
    Closed(ClosedEvent),
    /// A fatal runtime failure.
    RuntimeError(TabularkError),
}

/// Progressive scan counters.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// Opaque source handle.
    pub source_handle: String,
    /// Logical table whose discovery advanced, when already known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_id: Option<String>,
    /// Metadata revision associated with these counters, when already known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    /// Bytes accepted from the source.
    pub bytes_scanned: u64,
    /// Data rows discovered so far.
    pub rows_discovered: u64,
    /// Whether end-of-file has been reached.
    pub done: bool,
}

/// A safe diagnostic message emitted in lenient mode.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningEvent {
    /// Opaque source or table handle.
    pub handle: String,
    /// Stable warning kind.
    pub kind: String,
    /// Safe diagnostic message.
    pub message: String,
    /// Source byte offset when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_offset: Option<u64>,
    /// Zero-based logical data row when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u64>,
}

/// A lifecycle event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEvent {
    /// Opaque closed handle.
    pub handle: String,
    /// Handle category, such as `source` or `table`.
    pub kind: String,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::{
        ADAPTER_API_VERSION, ARROW_IPC_ADAPTER_ID, AdapterAction, AdapterActionResult,
        AdapterOperationCursor, AdapterStep, AdapterStepKind, BATCH_LAYOUT_VERSION,
        DELIMITED_ADAPTER_ID, EXCEL_ADAPTER_ID, EventEnvelope, HelloRequest,
        LEGACY_PROTOCOL_VERSION, MAX_OPERATION_RANGES_PER_STEP, PARQUET_ADAPTER_ID,
        PREVIOUS_PROTOCOL_VERSION, PROTOCOL_V2_VERSION, PROTOCOL_VERSION,
        ReadPresentationRangeRequest, Request, RequestEnvelope, ResponseEnvelope, ResponseResult,
        checked_wasm32_usize, ensure_protocol_version, validate_operation_actions,
    };
    use crate::error::ErrorCode;
    use crate::model::RangeRequest;

    #[test]
    fn request_wire_shape_is_flat_and_versioned() {
        let request = RequestEnvelope::new(
            "request-1",
            Request::Hello(HelloRequest {
                client_name: Some("test".into()),
                adapters: vec![],
                memory_budget_bytes: 268_435_456,
            }),
        );

        assert_eq!(
            serde_json::to_value(request).expect("serialize request"),
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": "request-1",
                "op": "hello",
                "payload": {
                    "clientName": "test",
                    "adapters": [],
                    "memoryBudgetBytes": 268435456
                }
            })
        );
    }

    #[test]
    fn shared_v1_golden_fixtures_remain_historical_evidence() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v1");
        if !root.exists() {
            // Published source archives need not include repository-only fixtures.
            return;
        }

        for name in [
            "hello-request.json",
            "open-source-request.json",
            "read-range-request.json",
            "hello-response.json",
            "close-response.json",
            "invalid-range-response.json",
            "metadata-event.json",
            "warning-event.json",
        ] {
            let source = fs::read_to_string(root.join(name)).expect("read protocol fixture");
            let fixture: serde_json::Value =
                serde_json::from_str(&source).expect("parse fixture JSON");
            assert_eq!(
                fixture["protocolVersion"], LEGACY_PROTOCOL_VERSION,
                "fixture {name} is no longer protocol v1 evidence"
            );
        }
    }

    #[test]
    fn historical_protocols_are_rejected_at_every_rust_envelope_boundary() {
        for historical in [
            LEGACY_PROTOCOL_VERSION,
            PROTOCOL_V2_VERSION,
            PREVIOUS_PROTOCOL_VERSION,
        ] {
            let error = ensure_protocol_version(historical)
                .expect_err("historical protocol must be rejected");
            assert_eq!(error.code(), ErrorCode::ProtocolIncompatible);
            assert_eq!(error.details()["expectedProtocolVersion"], PROTOCOL_VERSION);
            assert_eq!(error.details()["actualProtocolVersion"], historical);
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v1");
        if !root.exists() {
            return;
        }
        let request = fs::read_to_string(root.join("hello-request.json")).expect("request");
        assert!(serde_json::from_str::<RequestEnvelope>(&request).is_err());
        let response = fs::read_to_string(root.join("hello-response.json")).expect("response");
        assert!(serde_json::from_str::<ResponseEnvelope>(&response).is_err());
        let event = fs::read_to_string(root.join("warning-event.json")).expect("event");
        assert!(serde_json::from_str::<EventEnvelope>(&event).is_err());
    }

    #[test]
    fn shared_v2_golden_fixtures_remain_historical_evidence() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v2");
        if !root.exists() {
            return;
        }

        for name in [
            "hello-request.json",
            "open-arrow-request.json",
            "hello-response.json",
            "metadata-event.json",
        ] {
            let source = fs::read_to_string(root.join(name)).expect("read protocol fixture");
            let fixture: serde_json::Value =
                serde_json::from_str(&source).expect("parse fixture JSON");
            assert_eq!(fixture["protocolVersion"], PROTOCOL_V2_VERSION);
        }
    }

    #[test]
    fn shared_v3_golden_fixtures_remain_historical_evidence() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v3");
        if !root.exists() {
            return;
        }
        for entry in fs::read_dir(root).expect("read v3 fixture directory") {
            let path = entry.expect("v3 fixture entry").path();
            if path
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                let source = fs::read_to_string(&path).expect("read v3 fixture");
                let fixture: serde_json::Value =
                    serde_json::from_str(&source).expect("parse v3 fixture");
                assert_eq!(fixture["protocolVersion"], PREVIOUS_PROTOCOL_VERSION);
            }
        }
    }

    #[test]
    fn adapter_and_layout_versions_are_independent_of_protocol_v4() {
        assert_eq!(PROTOCOL_VERSION, 4);
        assert_eq!(ADAPTER_API_VERSION, 3);
        assert_eq!(BATCH_LAYOUT_VERSION, 1);
        assert_eq!(DELIMITED_ADAPTER_ID, "tabulark:delimited");
        assert_eq!(ARROW_IPC_ADAPTER_ID, "tabulark:arrow-ipc");
        assert_eq!(PARQUET_ADAPTER_ID, "tabulark:parquet");
        assert_eq!(EXCEL_ADAPTER_ID, "tabulark:excel");
    }

    #[test]
    fn adapter_v3_steps_have_one_state_revision_and_action_array() {
        let step = AdapterStep::new(
            AdapterStepKind::Pending,
            7,
            1,
            vec![AdapterAction::indexed_read_bytes(0, 1024, 4096)],
            false,
            None,
            4096,
        )
        .expect("valid adapter step");

        assert_eq!(
            serde_json::to_value(step).expect("serialize adapter step"),
            serde_json::json!({
                "kind": "pending",
                "operationHandle": 7,
                "operationRevision": 1,
                "actions": [{
                    "kind": "read-bytes",
                    "actionIndex": 0,
                    "offset": 1024,
                    "length": 4096
                }],
                "cooperativeYield": false
            })
        );
    }

    #[test]
    fn operation_cursor_rejects_missing_duplicate_stale_and_out_of_bounds_results() {
        let mut cursor = AdapterOperationCursor::new();
        let actions = vec![
            AdapterAction::indexed_read_bytes(0, 0, 4),
            AdapterAction::indexed_read_bytes(1, 16, 2),
        ];
        let revision = cursor.issue(actions, 6).expect("issue ranges");
        assert_eq!(revision, 1);

        let first = AdapterActionResult {
            action_index: 0,
            offset: 0,
            length: 4,
            eof: false,
        };
        let second = AdapterActionResult {
            action_index: 1,
            offset: 16,
            length: 2,
            eof: true,
        };
        for malformed in [vec![first], vec![first, first]] {
            assert_eq!(
                cursor
                    .validate_results(revision, &malformed)
                    .expect_err("malformed result set")
                    .code(),
                ErrorCode::InvalidArgument
            );
        }
        let out_of_bounds = AdapterActionResult {
            length: 3,
            ..second
        };
        assert_eq!(
            cursor
                .validate_results(revision, &[first, out_of_bounds])
                .expect_err("out-of-bounds result")
                .code(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            cursor
                .validate_results(revision + 1, &[first, second])
                .expect_err("future result")
                .code(),
            ErrorCode::InvalidArgument
        );
        cursor
            .validate_results(revision, &[first, second])
            .expect("exact result set");
        let next = cursor
            .issue(vec![AdapterAction::indexed_read_bytes(0, 18, 1)], 1)
            .expect("next revision");
        assert_eq!(next, 2);
        assert_eq!(
            cursor
                .validate_results(revision, &[])
                .expect_err("stale result")
                .code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn operation_action_limits_are_checked_without_allocating_large_sources() {
        let too_many = (0..=MAX_OPERATION_RANGES_PER_STEP)
            .map(|index| AdapterAction::indexed_read_bytes(index as u32, index as u64, 1))
            .collect::<Vec<_>>();
        assert_eq!(
            validate_operation_actions(&too_many, u64::MAX)
                .expect_err("range count")
                .code(),
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            validate_operation_actions(
                &[AdapterAction::indexed_read_bytes(0, u64::MAX, 2)],
                u64::MAX,
            )
            .expect_err("offset overflow")
            .code(),
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            validate_operation_actions(&[AdapterAction::indexed_read_bytes(0, 0, 7)], 6,)
                .expect_err("operation budget")
                .code(),
            ErrorCode::ResourceLimit
        );

        let above_exact_product_limit = (1_u64 << 31) + 1;
        assert_eq!(
            validate_operation_actions(
                &[AdapterAction::indexed_read_bytes(
                    0,
                    above_exact_product_limit,
                    1,
                )],
                1,
            )
            .expect("u64 ABI preserves offsets above the product limit"),
            1
        );
        assert!(checked_wasm32_usize(1_u64 << 31, "sourceLength").is_ok());
        assert!(checked_wasm32_usize(above_exact_product_limit, "offset").is_ok());
        assert_eq!(
            checked_wasm32_usize(1_u64 << 32, "offset")
                .expect_err("wasm32 usize overflow")
                .code(),
            ErrorCode::ResourceLimit
        );
        assert!(
            validate_operation_actions(
                &[AdapterAction::indexed_read_bytes(
                    0,
                    crate::model::MAX_SAFE_INTEGER,
                    0,
                )],
                0,
            )
            .is_ok()
        );
        assert_eq!(
            validate_operation_actions(
                &[AdapterAction::indexed_read_bytes(
                    0,
                    crate::model::MAX_SAFE_INTEGER,
                    1,
                )],
                1,
            )
            .expect_err("safe-integer end overflow")
            .code(),
            ErrorCode::ResourceLimit
        );
    }

    #[test]
    fn adapter_v3_supports_an_explicit_no_io_yield() {
        let step = AdapterStep::new(AdapterStepKind::Pending, 9, 1, vec![], true, None, 0)
            .expect("cooperative yield");
        assert!(step.actions.is_empty());
        assert!(step.cooperative_yield);
    }

    #[test]
    fn protocol_v4_carries_nullable_presentation_queries() {
        let range = RangeRequest::new(4, 2, 3, 1).expect("range");
        let request = RequestEnvelope::new(
            "presentation-1",
            Request::ReadPresentationRange(ReadPresentationRangeRequest {
                table_handle: "table-handle".into(),
                range,
            }),
        );
        assert_eq!(
            serde_json::to_value(request).expect("serialize request"),
            serde_json::json!({
                "protocolVersion": 4,
                "requestId": "presentation-1",
                "op": "readPresentationRange",
                "payload": {
                    "tableHandle": "table-handle",
                    "range": {
                        "rowStart": 4,
                        "rowCount": 2,
                        "columnStart": 3,
                        "columnCount": 1
                    }
                }
            })
        );

        let response =
            ResponseEnvelope::success("presentation-1", ResponseResult::PresentationRange(None));
        assert_eq!(
            serde_json::to_value(response).expect("serialize response"),
            serde_json::json!({
                "protocolVersion": 4,
                "requestId": "presentation-1",
                "status": "success",
                "result": {
                    "kind": "presentationRange",
                    "data": null
                }
            })
        );
    }
}
