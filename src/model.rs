//! Format-independent table metadata, ranges, and columnar batches.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TableShape;
use crate::error::{ErrorCode, Result, TabularkError};

/// The largest integer that can cross a JavaScript `number` boundary exactly.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Progressive knowledge about the length of one table axis.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AxisExtent {
    /// The final length is known.
    Exact {
        /// The exact axis length.
        value: u64,
    },
    /// At least this many positions have been discovered.
    AtLeast {
        /// The discovered lower bound.
        value: u64,
    },
    /// No useful bound is known yet.
    Unknown,
}

impl AxisExtent {
    /// Creates an exact extent after validating the JavaScript-safe boundary.
    pub fn exact(value: u64) -> Result<Self> {
        validate_safe_integer("extent", value)?;
        Ok(Self::Exact { value })
    }

    /// Creates a discovered lower bound after validating the public boundary.
    pub fn at_least(value: u64) -> Result<Self> {
        validate_safe_integer("extent", value)?;
        Ok(Self::AtLeast { value })
    }

    /// Returns the known value when this extent has one.
    #[must_use]
    pub const fn value(self) -> Option<u64> {
        match self {
            Self::Exact { value } | Self::AtLeast { value } => Some(value),
            Self::Unknown => None,
        }
    }

    /// Returns whether this extent is final.
    #[must_use]
    pub const fn is_exact(self) -> bool {
        matches!(self, Self::Exact { .. })
    }
}

/// Progressive row and column bounds for a table.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExtent {
    rows: AxisExtent,
    columns: AxisExtent,
}

impl TableExtent {
    /// Creates table extent metadata.
    #[must_use]
    pub const fn new(rows: AxisExtent, columns: AxisExtent) -> Self {
        Self { rows, columns }
    }

    /// Creates an exact extent from the legacy exact table shape.
    #[must_use]
    pub const fn from_shape(shape: TableShape) -> Self {
        Self {
            rows: AxisExtent::Exact {
                value: shape.rows(),
            },
            columns: AxisExtent::Exact {
                value: shape.columns(),
            },
        }
    }

    /// Returns row extent information.
    #[must_use]
    pub const fn rows(self) -> AxisExtent {
        self.rows
    }

    /// Returns column extent information.
    #[must_use]
    pub const fn columns(self) -> AxisExtent {
        self.columns
    }

    /// Converts final bounds to a legacy shape.
    #[must_use]
    pub const fn exact_shape(self) -> Option<TableShape> {
        match (self.rows, self.columns) {
            (AxisExtent::Exact { value: rows }, AxisExtent::Exact { value: columns }) => {
                Some(TableShape::new(rows, columns))
            }
            _ => None,
        }
    }
}

/// Logical value types understood by the common table model.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum LogicalType {
    /// Type has not been determined.
    Unknown,
    /// UTF-8 text.
    Utf8,
    /// Boolean value.
    Boolean,
    /// Signed 64-bit integer.
    Int64,
    /// IEEE-754 double precision number.
    Float64,
    /// Arbitrary precision decimal text.
    Decimal,
    /// Calendar date.
    Date,
    /// Date and time.
    Datetime,
    /// Uninterpreted bytes.
    Binary,
}

/// Schema metadata for one logical column.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    id: String,
    name: String,
    index: u64,
    logical_type: LogicalType,
    nullable: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    extensions: BTreeMap<String, Value>,
}

impl ColumnSchema {
    /// Creates column metadata with no format-specific extensions.
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        index: u64,
        logical_type: LogicalType,
        nullable: bool,
    ) -> Result<Self> {
        validate_safe_integer("column index", index)?;
        let id = id.into();
        if id.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "column id must not be empty",
            ));
        }
        Ok(Self {
            id,
            name: name.into(),
            index,
            logical_type,
            nullable,
            extensions: BTreeMap::new(),
        })
    }

    /// Adds or replaces a namespaced format-specific metadata value.
    pub fn insert_extension(&mut self, key: impl Into<String>, value: Value) -> Result<()> {
        let key = key.into();
        if !key.contains(':') {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "column extension keys must be namespaced with ':'",
            ));
        }
        self.extensions.insert(key, value);
        Ok(())
    }

    /// Returns the stable column ID.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the display name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the zero-based logical index.
    #[must_use]
    pub const fn index(&self) -> u64 {
        self.index
    }

    /// Returns the logical value type.
    #[must_use]
    pub const fn logical_type(&self) -> LogicalType {
        self.logical_type
    }

    /// Returns whether missing values may occur.
    #[must_use]
    pub const fn nullable(&self) -> bool {
        self.nullable
    }

    /// Returns format-specific metadata.
    #[must_use]
    pub const fn extensions(&self) -> &BTreeMap<String, Value> {
        &self.extensions
    }
}

/// Versioned ordered column schema.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    version: u64,
    columns: Vec<ColumnSchema>,
}

impl Schema {
    /// Creates a schema snapshot.
    pub fn new(version: u64, columns: Vec<ColumnSchema>) -> Result<Self> {
        validate_safe_integer("schema version", version)?;
        for (expected, column) in columns.iter().enumerate() {
            let expected = u64::try_from(expected).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "too many schema columns")
            })?;
            if column.index != expected {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "schema column indexes must be contiguous and ordered",
                ));
            }
        }
        Ok(Self { version, columns })
    }

    /// Returns the schema version.
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    /// Returns ordered column metadata.
    #[must_use]
    pub fn columns(&self) -> &[ColumnSchema] {
        &self.columns
    }

    /// Returns the number of columns.
    #[must_use]
    pub fn len(&self) -> usize {
        self.columns.len()
    }

    /// Returns whether the schema contains no columns.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.columns.is_empty()
    }
}

/// Random access currently available for a table.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RandomAccess {
    /// Only the indexed prefix can be addressed.
    IndexedPrefix,
    /// Any row can be addressed.
    Full,
}

/// Optional operations and representations exposed by a table.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    random_access: RandomAccess,
    typed_values: bool,
    search: bool,
    sort: bool,
    filter: bool,
    multi_table: bool,
}

impl Capabilities {
    /// Creates the baseline CSV/TSV capabilities.
    #[must_use]
    pub const fn delimited(random_access: RandomAccess) -> Self {
        Self {
            random_access,
            typed_values: false,
            search: false,
            sort: false,
            filter: false,
            multi_table: false,
        }
    }

    /// Returns the random range access level.
    #[must_use]
    pub const fn random_access(&self) -> RandomAccess {
        self.random_access
    }

    /// Returns whether native typed values are available.
    #[must_use]
    pub const fn typed_values(&self) -> bool {
        self.typed_values
    }
}

/// Immutable metadata snapshot for a logical table.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMetadata {
    table_id: String,
    name: String,
    revision: u64,
    extent: TableExtent,
    schema: Schema,
    capabilities: Capabilities,
}

impl TableMetadata {
    /// Creates a table metadata snapshot.
    #[must_use]
    pub fn new(
        table_id: impl Into<String>,
        name: impl Into<String>,
        revision: u64,
        extent: TableExtent,
        schema: Schema,
        capabilities: Capabilities,
    ) -> Self {
        Self {
            table_id: table_id.into(),
            name: name.into(),
            revision,
            extent,
            schema,
            capabilities,
        }
    }

    /// Returns the stable table ID.
    #[must_use]
    pub fn table_id(&self) -> &str {
        &self.table_id
    }

    /// Returns the display name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the immutable table revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    /// Returns progressive table bounds.
    #[must_use]
    pub const fn extent(&self) -> TableExtent {
        self.extent
    }

    /// Returns the current schema snapshot.
    #[must_use]
    pub const fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Returns optional table capabilities.
    #[must_use]
    pub const fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }
}

/// A zero-based rectangular table range using start and count coordinates.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeRequest {
    row_start: u64,
    row_count: u64,
    column_start: u64,
    column_count: u64,
}

impl RangeRequest {
    /// Creates and validates a range request.
    pub fn new(
        row_start: u64,
        row_count: u64,
        column_start: u64,
        column_count: u64,
    ) -> Result<Self> {
        let request = Self {
            row_start,
            row_count,
            column_start,
            column_count,
        };
        request.validate_public()?;
        Ok(request)
    }

    /// Returns the first requested row.
    #[must_use]
    pub const fn row_start(self) -> u64 {
        self.row_start
    }

    /// Returns the number of requested rows.
    #[must_use]
    pub const fn row_count(self) -> u64 {
        self.row_count
    }

    /// Returns the first requested column.
    #[must_use]
    pub const fn column_start(self) -> u64 {
        self.column_start
    }

    /// Returns the number of requested columns.
    #[must_use]
    pub const fn column_count(self) -> u64 {
        self.column_count
    }

    /// Returns the exclusive row end, or an error on overflow.
    pub fn row_end(self) -> Result<u64> {
        checked_end("row", self.row_start, self.row_count)
    }

    /// Returns the exclusive column end, or an error on overflow.
    pub fn column_end(self) -> Result<u64> {
        checked_end("column", self.column_start, self.column_count)
    }

    /// Returns the requested cell count, or an error on overflow.
    pub fn cell_count(self) -> Result<u64> {
        self.row_count
            .checked_mul(self.column_count)
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::InvalidRange, "range cell count overflows u64")
            })
    }

    /// Validates safe-integer and half-open range invariants.
    pub fn validate_public(self) -> Result<()> {
        validate_safe_integer("row start", self.row_start)?;
        validate_safe_integer("row count", self.row_count)?;
        validate_safe_integer("column start", self.column_start)?;
        validate_safe_integer("column count", self.column_count)?;
        self.row_end()?;
        self.column_end()?;
        Ok(())
    }
}

/// The actual zero-based rectangular range returned in a batch.
pub type ReturnedRange = RangeRequest;

/// One UTF-8 column encoded as data, offsets, and a validity bitmap.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StringColumnBatch {
    column_id: String,
    data: Vec<u8>,
    offsets: Vec<u32>,
    validity: Vec<u8>,
}

impl StringColumnBatch {
    /// Creates and validates a string column batch.
    pub fn new(
        column_id: impl Into<String>,
        data: Vec<u8>,
        offsets: Vec<u32>,
        validity: Vec<u8>,
    ) -> Result<Self> {
        if offsets.is_empty() || offsets[0] != 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "string offsets must start with zero",
            ));
        }
        if !offsets.windows(2).all(|pair| pair[0] <= pair[1]) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "string offsets must be monotonic",
            ));
        }
        if usize::try_from(*offsets.last().unwrap_or(&0)).ok() != Some(data.len()) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "the final string offset must equal the data length",
            ));
        }
        let values = offsets.len() - 1;
        if validity.len() != values.div_ceil(8) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "validity bitmap length does not match the value count",
            ));
        }
        if std::str::from_utf8(&data).is_err() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "string column data must be valid UTF-8",
            ));
        }
        Ok(Self {
            column_id: column_id.into(),
            data,
            offsets,
            validity,
        })
    }

    /// Returns the column ID.
    #[must_use]
    pub fn column_id(&self) -> &str {
        &self.column_id
    }

    /// Returns concatenated UTF-8 bytes.
    #[must_use]
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// Returns the value offsets.
    #[must_use]
    pub fn offsets(&self) -> &[u32] {
        &self.offsets
    }

    /// Returns the little-endian validity bitmap.
    #[must_use]
    pub fn validity(&self) -> &[u8] {
        &self.validity
    }

    /// Returns the number of values in the column.
    #[must_use]
    pub fn len(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    /// Returns whether the column contains no values.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Decodes one value without allocating when it is present.
    #[must_use]
    pub fn value(&self, index: usize) -> Option<Option<&str>> {
        if index >= self.len() {
            return None;
        }
        if self.validity[index / 8] & (1 << (index % 8)) == 0 {
            return Some(None);
        }
        let start = usize::try_from(self.offsets[index]).ok()?;
        let end = usize::try_from(self.offsets[index + 1]).ok()?;
        Some(std::str::from_utf8(&self.data[start..end]).ok())
    }
}

/// A bounded, column-oriented table range response.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBatch {
    table_id: String,
    revision: u64,
    schema_version: u64,
    range: ReturnedRange,
    complete: bool,
    columns: Vec<StringColumnBatch>,
}

impl TableBatch {
    /// Creates a range batch.
    #[must_use]
    pub fn new(
        table_id: impl Into<String>,
        revision: u64,
        schema_version: u64,
        range: ReturnedRange,
        complete: bool,
        columns: Vec<StringColumnBatch>,
    ) -> Self {
        Self {
            table_id: table_id.into(),
            revision,
            schema_version,
            range,
            complete,
            columns,
        }
    }

    /// Returns the table ID.
    #[must_use]
    pub fn table_id(&self) -> &str {
        &self.table_id
    }

    /// Returns the immutable table revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    /// Returns the schema version used to encode this batch.
    #[must_use]
    pub const fn schema_version(&self) -> u64 {
        self.schema_version
    }

    /// Returns the actual returned range.
    #[must_use]
    pub const fn range(&self) -> ReturnedRange {
        self.range
    }

    /// Returns whether every requested row was available.
    #[must_use]
    pub const fn complete(&self) -> bool {
        self.complete
    }

    /// Returns encoded columns in logical order.
    #[must_use]
    pub fn columns(&self) -> &[StringColumnBatch] {
        &self.columns
    }
}

fn validate_safe_integer(label: &str, value: u64) -> Result<()> {
    if value > MAX_SAFE_INTEGER {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            format!("{label} exceeds the JavaScript safe integer limit"),
        )
        .with_detail("value", value.to_string()));
    }
    Ok(())
}

fn checked_end(label: &str, start: u64, count: u64) -> Result<u64> {
    let end = start.checked_add(count).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::InvalidRange,
            format!("{label} range overflows u64"),
        )
    })?;
    if end > MAX_SAFE_INTEGER {
        return Err(TabularkError::new(
            ErrorCode::InvalidRange,
            format!("{label} range end exceeds the JavaScript safe integer limit"),
        ));
    }
    Ok(end)
}

#[cfg(test)]
mod tests {
    use super::{AxisExtent, RangeRequest, StringColumnBatch, TableExtent};
    use crate::TableShape;

    #[test]
    fn exact_extent_round_trips_legacy_shape() {
        let extent = TableExtent::from_shape(TableShape::new(12, 4));

        assert_eq!(extent.exact_shape(), Some(TableShape::new(12, 4)));
        assert!(extent.rows().is_exact());
        assert_eq!(extent.columns().value(), Some(4));
    }

    #[test]
    fn rejects_a_range_outside_javascript_safe_integers() {
        assert!(RangeRequest::new(super::MAX_SAFE_INTEGER, 1, 0, 1).is_err());
    }

    #[test]
    fn distinguishes_missing_and_empty_strings() {
        let column =
            StringColumnBatch::new("c0", b"value".to_vec(), vec![0, 0, 5], vec![0b0000_0010])
                .expect("valid column");

        assert_eq!(column.value(0), Some(None));
        assert_eq!(column.value(1), Some(Some("value")));
        assert_eq!(column.value(2), None);
    }

    #[test]
    fn serializes_axis_extent_as_a_tagged_union() {
        let value = serde_json::to_value(AxisExtent::at_least(42).expect("safe extent"))
            .expect("serialize extent");

        assert_eq!(value, serde_json::json!({"kind": "at-least", "value": 42}));
    }
}
