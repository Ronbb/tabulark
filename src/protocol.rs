//! Versioned, serializable messages for the Worker boundary.
//!
//! Rust traits and JavaScript classes are deliberately absent from this module.
//! Its tagged DTOs are the compatibility boundary between a Worker facade and
//! the data runtime.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, Result, TabularkError};
use crate::model::{RangeRequest, TableMetadata, TypedTableBatch};

/// The historical protocol version retained only for migration diagnostics.
pub const LEGACY_PROTOCOL_VERSION: u32 = 1;

/// The only Worker protocol version implemented by this crate.
pub const PROTOCOL_VERSION: u32 = 2;

/// The Rust adapter ABI version implemented by official adapters.
pub const ADAPTER_API_VERSION: u32 = 1;

/// The common typed-buffer descriptor version implemented by official adapters.
pub use crate::model::BATCH_LAYOUT_VERSION;

/// Stable ID of the official CSV/TSV adapter.
pub const DELIMITED_ADAPTER_ID: &str = "tabulark:delimited";

/// Stable ID of the official Apache Arrow IPC adapter.
pub const ARROW_IPC_ADAPTER_ID: &str = "tabulark:arrow-ipc";

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

/// Worker operations supported by protocol version two.
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
        ADAPTER_API_VERSION, ARROW_IPC_ADAPTER_ID, BATCH_LAYOUT_VERSION, DELIMITED_ADAPTER_ID,
        EventEnvelope, HelloRequest, LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION, Request,
        RequestEnvelope, ResponseEnvelope, ensure_protocol_version,
    };
    use crate::error::ErrorCode;

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
    fn protocol_v1_is_rejected_at_every_rust_envelope_boundary() {
        let error = ensure_protocol_version(LEGACY_PROTOCOL_VERSION)
            .expect_err("protocol v1 must be rejected");
        assert_eq!(error.code(), ErrorCode::ProtocolIncompatible);
        assert_eq!(error.details()["expectedProtocolVersion"], PROTOCOL_VERSION);
        assert_eq!(
            error.details()["actualProtocolVersion"],
            LEGACY_PROTOCOL_VERSION
        );

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
    fn shared_v2_golden_fixtures_round_trip_through_rust_dtos() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v2");
        if !root.exists() {
            return;
        }

        assert_fixture::<RequestEnvelope>(&root, "hello-request.json");
        assert_fixture::<RequestEnvelope>(&root, "open-arrow-request.json");
        assert_fixture::<ResponseEnvelope>(&root, "hello-response.json");
        assert_fixture::<EventEnvelope>(&root, "metadata-event.json");
    }

    #[test]
    fn adapter_and_layout_versions_are_independent_of_protocol_v2() {
        assert_eq!(PROTOCOL_VERSION, 2);
        assert_eq!(ADAPTER_API_VERSION, 1);
        assert_eq!(BATCH_LAYOUT_VERSION, 1);
        assert_eq!(DELIMITED_ADAPTER_ID, "tabulark:delimited");
        assert_eq!(ARROW_IPC_ADAPTER_ID, "tabulark:arrow-ipc");
    }

    fn assert_fixture<T>(root: &Path, name: &str)
    where
        T: serde::de::DeserializeOwned + serde::Serialize,
    {
        let source = fs::read_to_string(root.join(name)).expect("read protocol fixture");
        let fixture = serde_json::from_str::<serde_json::Value>(&source)
            .unwrap_or_else(|error| panic!("parse protocol v2 JSON fixture {name}: {error}"));
        let parsed = serde_json::from_value::<T>(fixture.clone())
            .unwrap_or_else(|error| panic!("parse protocol v2 fixture {name}: {error}"));
        assert_eq!(
            serde_json::to_value(parsed)
                .unwrap_or_else(|error| panic!("serialize protocol v2 fixture {name}: {error}")),
            fixture,
            "protocol v2 fixture {name} must lock the serialized Rust wire shape"
        );
    }
}
