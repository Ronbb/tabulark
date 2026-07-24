//! Versioned, serializable messages for the Worker boundary.
//!
//! Rust traits and JavaScript classes are deliberately absent from this module.
//! Its tagged DTOs are the compatibility boundary between a Worker facade and
//! the data runtime.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::TabularkError;
use crate::model::{RangeRequest, TableBatch, TableMetadata};

/// The only Worker protocol version implemented by this crate.
pub const PROTOCOL_VERSION: u32 = 1;

/// A request sent to the runtime.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
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

/// Worker operations supported by protocol version one.
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
}

/// Explicit input format names accepted by the first runtime.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    /// Comma-delimited text.
    Csv,
    /// Tab-delimited text.
    Tsv,
}

/// Payload for opening a source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSourceRequest {
    /// Explicit source format; automatic detection is intentionally absent.
    pub format: SourceFormat,
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
    Batch(TableBatch),
    /// An idempotent close, cancel, or shutdown acknowledgement.
    Acknowledged,
}

/// Handshake result and implementation capabilities.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    /// The accepted protocol version.
    pub protocol_version: u32,
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
    pub protocol_version: u32,
    /// Optional request that initiated the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
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

    use serde::de::DeserializeOwned;

    use super::{
        EventEnvelope, HelloRequest, PROTOCOL_VERSION, Request, RequestEnvelope, ResponseEnvelope,
    };

    #[test]
    fn request_wire_shape_is_flat_and_versioned() {
        let request = RequestEnvelope::new(
            "request-1",
            Request::Hello(HelloRequest {
                client_name: Some("test".into()),
            }),
        );

        assert_eq!(
            serde_json::to_value(request).expect("serialize request"),
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": "request-1",
                "op": "hello",
                "payload": {"clientName": "test"}
            })
        );
    }

    #[test]
    fn shared_v1_golden_fixtures_round_trip_when_present() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/protocol/v1");
        if !root.exists() {
            // Published source archives need not include repository-only fixtures.
            return;
        }

        assert_fixture::<RequestEnvelope>(&root, "hello-request.json");
        assert_fixture::<RequestEnvelope>(&root, "open-source-request.json");
        assert_fixture::<RequestEnvelope>(&root, "read-range-request.json");
        assert_fixture::<ResponseEnvelope>(&root, "hello-response.json");
        assert_fixture::<ResponseEnvelope>(&root, "close-response.json");
        assert_fixture::<ResponseEnvelope>(&root, "invalid-range-response.json");
        assert_fixture::<EventEnvelope>(&root, "metadata-event.json");
    }

    fn assert_fixture<T>(root: &Path, name: &str)
    where
        T: DeserializeOwned + serde::Serialize,
    {
        let source = fs::read_to_string(root.join(name)).expect("read protocol fixture");
        let expected: serde_json::Value =
            serde_json::from_str(&source).expect("parse fixture JSON");
        let decoded: T = serde_json::from_value(expected.clone()).expect("decode protocol DTO");
        let actual = serde_json::to_value(decoded).expect("encode protocol DTO");
        assert_eq!(actual, expected, "fixture {name} drifted from the Rust DTO");
    }
}
