//! Structured errors shared by the native and WebAssembly runtimes.

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Stable machine-readable error codes used by every public boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[non_exhaustive]
pub enum ErrorCode {
    /// A supplied argument is malformed or internally inconsistent.
    InvalidArgument,
    /// A requested row or column range is invalid.
    InvalidRange,
    /// A requested row has not been indexed yet.
    RangeNotIndexed,
    /// A configured memory, field, column, or batch limit was exceeded.
    ResourceLimit,
    /// Work was cancelled by the caller.
    Cancelled,
    /// A source or range handle does not exist or has been closed.
    HandleClosed,
    /// The peer uses an unsupported protocol version.
    ProtocolIncompatible,
    /// Strict parsing rejected malformed source data.
    ParseFailed,
    /// A runtime failed in a way that invalidates pending work.
    RuntimeFailure,
    /// The requested operation is unavailable in this runtime.
    UnsupportedRuntime,
    /// The input uses a well-formed format feature that this build does not implement.
    UnsupportedFeature,
}

/// A serializable error with a stable code and optional structured details.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabularkError {
    code: ErrorCode,
    message: String,
    retryable: bool,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    details: Map<String, Value>,
}

impl TabularkError {
    /// Creates a new non-retryable error without implementation details.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: Map::new(),
        }
    }

    /// Marks this error as safe to retry after external state changes.
    #[must_use]
    pub const fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// Adds a JSON-compatible detail value.
    #[must_use]
    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }

    /// Returns the stable error code.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the safe, user-presentable error message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns whether retrying can succeed after more data or state changes.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        self.retryable
    }

    /// Returns structured, implementation-independent error details.
    #[must_use]
    pub const fn details(&self) -> &Map<String, Value> {
        &self.details
    }
}

impl Display for TabularkError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl Error for TabularkError {}

/// Result type used throughout the crate.
pub type Result<T> = std::result::Result<T, TabularkError>;
