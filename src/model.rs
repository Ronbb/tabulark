//! Format-independent table metadata, ranges, and columnar batches.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TableShape;
use crate::error::{ErrorCode, Result, TabularkError};

/// The largest integer that can cross a JavaScript `number` boundary exactly.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The typed-buffer batch descriptor version implemented by this crate.
pub const BATCH_LAYOUT_VERSION: u32 = 1;

/// Maximum recursive schema depth accepted by the shared model.
pub const MAX_DATA_TYPE_NESTING_DEPTH: usize = 64;

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

/// Time resolution used by Arrow temporal data types.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeUnit {
    /// Whole seconds.
    Second,
    /// Thousandths of a second.
    Millisecond,
    /// Millionths of a second.
    Microsecond,
    /// Billionths of a second.
    Nanosecond,
}

/// Calendar interval representation used by Arrow interval arrays.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntervalUnit {
    /// A signed count of whole months.
    YearMonth,
    /// Signed day and millisecond components.
    DayTime,
    /// Signed month, day, and nanosecond components.
    MonthDayNano,
}

/// Physical representation used by an Arrow union array.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnionMode {
    /// Every child has the same logical length as the union.
    Sparse,
    /// A type ID and child offset select each value.
    Dense,
}

/// One recursively nested field in a complex table data type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableField {
    name: String,
    data_type: TableDataType,
    nullable: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    metadata: BTreeMap<String, String>,
}

impl TableField {
    /// Creates nested field metadata without custom key/value metadata.
    #[must_use]
    pub fn new(name: impl Into<String>, data_type: TableDataType, nullable: bool) -> Self {
        Self {
            name: name.into(),
            data_type,
            nullable,
            metadata: BTreeMap::new(),
        }
    }

    /// Adds or replaces one Arrow field metadata entry.
    pub fn insert_metadata(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.metadata.insert(key.into(), value.into());
    }

    /// Returns the field name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the recursively described field type.
    #[must_use]
    pub const fn data_type(&self) -> &TableDataType {
        &self.data_type
    }

    /// Returns whether this field can contain null values.
    #[must_use]
    pub const fn nullable(&self) -> bool {
        self.nullable
    }

    /// Returns arbitrary Arrow field metadata.
    #[must_use]
    pub const fn metadata(&self) -> &BTreeMap<String, String> {
        &self.metadata
    }
}

/// A child field and its signed Arrow union type ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnionField {
    type_id: i8,
    field: TableField,
}

impl UnionField {
    /// Creates a union child descriptor.
    #[must_use]
    pub const fn new(type_id: i8, field: TableField) -> Self {
        Self { type_id, field }
    }

    /// Returns the signed Arrow type ID.
    #[must_use]
    pub const fn type_id(&self) -> i8 {
        self.type_id
    }

    /// Returns the field selected by this type ID.
    #[must_use]
    pub const fn field(&self) -> &TableField {
        &self.field
    }
}

/// Recursive table data types, including every built-in `arrow-schema` 59.1.0
/// `DataType` variant.
///
/// `Unknown` supports progressively discovered non-Arrow schemas. `Extension`
/// preserves an unrecognised Arrow extension while its storage type remains
/// fully readable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[non_exhaustive]
pub enum TableDataType {
    /// Type has not been determined yet.
    Unknown,
    /// Arrow null type.
    Null,
    /// Boolean values.
    Boolean,
    /// Signed 8-bit integers.
    Int8,
    /// Signed 16-bit integers.
    Int16,
    /// Signed 32-bit integers.
    Int32,
    /// Signed 64-bit integers.
    Int64,
    /// Unsigned 8-bit integers.
    UInt8,
    /// Unsigned 16-bit integers.
    UInt16,
    /// Unsigned 32-bit integers.
    UInt32,
    /// Unsigned 64-bit integers.
    UInt64,
    /// IEEE-754 binary16 values.
    Float16,
    /// IEEE-754 binary32 values.
    Float32,
    /// IEEE-754 binary64 values.
    Float64,
    /// Unix epoch values at one resolution, with optional timezone metadata.
    Timestamp {
        /// Timestamp resolution.
        unit: TimeUnit,
        /// IANA name or fixed offset; absence means an unspecified timezone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timezone: Option<String>,
    },
    /// Signed days since the Unix epoch.
    Date32,
    /// Signed milliseconds since the Unix epoch.
    Date64,
    /// Signed 32-bit time-of-day values.
    Time32 {
        /// Time resolution.
        unit: TimeUnit,
    },
    /// Signed 64-bit time-of-day values.
    Time64 {
        /// Time resolution.
        unit: TimeUnit,
    },
    /// Signed elapsed-time values.
    Duration {
        /// Duration resolution.
        unit: TimeUnit,
    },
    /// Calendar intervals.
    Interval {
        /// Interval representation.
        unit: IntervalUnit,
    },
    /// Variable-width opaque bytes with 32-bit offsets.
    Binary,
    /// Fixed-width opaque bytes.
    FixedSizeBinary {
        /// Bytes stored for each logical value.
        byte_width: i32,
    },
    /// Variable-width opaque bytes with 64-bit offsets.
    LargeBinary,
    /// Variable-width opaque bytes using the Arrow view layout.
    BinaryView,
    /// UTF-8 strings with 32-bit offsets.
    Utf8,
    /// UTF-8 strings with 64-bit offsets.
    LargeUtf8,
    /// UTF-8 strings using the Arrow view layout.
    Utf8View,
    /// Variable-length lists with 32-bit offsets.
    List {
        /// List element field.
        field: Box<TableField>,
    },
    /// Variable-length lists using the 32-bit Arrow view layout.
    ListView {
        /// List element field.
        field: Box<TableField>,
    },
    /// Fixed-length lists.
    FixedSizeList {
        /// List element field.
        field: Box<TableField>,
        /// Number of child values per list value.
        list_size: i32,
    },
    /// Variable-length lists with 64-bit offsets.
    LargeList {
        /// List element field.
        field: Box<TableField>,
    },
    /// Variable-length lists using the 64-bit Arrow view layout.
    LargeListView {
        /// List element field.
        field: Box<TableField>,
    },
    /// A fixed collection of named child fields.
    Struct {
        /// Struct child fields in logical order.
        fields: Vec<TableField>,
    },
    /// Sparse or dense tagged union values.
    Union {
        /// Union children and their signed type IDs.
        fields: Vec<UnionField>,
        /// Sparse or dense physical layout.
        mode: UnionMode,
    },
    /// Integer keys indexing a separate values array.
    Dictionary {
        /// Dictionary key type.
        #[serde(rename = "indexType")]
        key: Box<TableDataType>,
        /// Logical dictionary value type.
        #[serde(rename = "valueType")]
        value: Box<TableDataType>,
    },
    /// Exact 32-bit decimals.
    Decimal32 {
        /// Total number of decimal digits.
        precision: u8,
        /// Number of fractional decimal digits; may be negative.
        scale: i8,
    },
    /// Exact 64-bit decimals.
    Decimal64 {
        /// Total number of decimal digits.
        precision: u8,
        /// Number of fractional decimal digits; may be negative.
        scale: i8,
    },
    /// Exact 128-bit decimals.
    Decimal128 {
        /// Total number of decimal digits.
        precision: u8,
        /// Number of fractional decimal digits; may be negative.
        scale: i8,
    },
    /// Exact 256-bit decimals.
    Decimal256 {
        /// Total number of decimal digits.
        precision: u8,
        /// Number of fractional decimal digits; may be negative.
        scale: i8,
    },
    /// Arrow map values represented by a list of entry structs.
    Map {
        /// Entry struct field.
        #[serde(rename = "entries")]
        field: Box<TableField>,
        /// Whether keys are declared sorted.
        keys_sorted: bool,
    },
    /// Arrow run-end encoded values.
    RunEndEncoded {
        /// Run-end integer field.
        run_ends: Box<TableField>,
        /// Encoded logical value field.
        values: Box<TableField>,
    },
    /// An Arrow extension not interpreted by Tabulark.
    Extension {
        /// Canonical extension name.
        name: String,
        /// Opaque canonical extension metadata.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<String>,
        /// Recursively readable Arrow storage type.
        #[serde(rename = "storageType")]
        storage: Box<TableDataType>,
    },
}

impl TableDataType {
    /// Returns the recursive type depth, counting this value as depth one.
    #[must_use]
    pub fn nesting_depth(&self) -> usize {
        let field_depth = |field: &TableField| field.data_type.nesting_depth();
        let child_depth = match self {
            Self::List { field }
            | Self::ListView { field }
            | Self::FixedSizeList { field, .. }
            | Self::LargeList { field }
            | Self::LargeListView { field }
            | Self::Map { field, .. } => field_depth(field),
            Self::Struct { fields } => fields.iter().map(field_depth).max().unwrap_or(0),
            Self::Union { fields, .. } => fields
                .iter()
                .map(|field| field_depth(&field.field))
                .max()
                .unwrap_or(0),
            Self::Dictionary { key, value } => key.nesting_depth().max(value.nesting_depth()),
            Self::RunEndEncoded { run_ends, values } => {
                field_depth(run_ends).max(field_depth(values))
            }
            Self::Extension { storage, .. } => storage.nesting_depth(),
            _ => 0,
        };
        1_usize.saturating_add(child_depth)
    }
}

/// Schema metadata for one logical column.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    id: String,
    name: String,
    index: u64,
    data_type: TableDataType,
    nullable: bool,
    #[serde(
        default,
        rename = "metadata",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    extensions: BTreeMap<String, Value>,
}

impl ColumnSchema {
    /// Creates column metadata with an exact recursive type and no
    /// format-specific extensions.
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        index: u64,
        data_type: TableDataType,
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
            data_type,
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

    /// Returns the exact recursive column type.
    #[must_use]
    pub const fn data_type(&self) -> &TableDataType {
        &self.data_type
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

    /// Creates capabilities for an adapter that exposes exact typed values.
    #[must_use]
    pub const fn typed(random_access: RandomAccess) -> Self {
        Self {
            random_access,
            typed_values: true,
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

/// One transferable byte buffer in a typed batch's deduplicated buffer pool.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct BatchBuffer {
    data: Vec<u8>,
}

impl BatchBuffer {
    /// Creates one owned buffer-pool entry.
    #[must_use]
    pub const fn new(data: Vec<u8>) -> Self {
        Self { data }
    }

    /// Returns the transferable bytes.
    #[must_use]
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// Consumes this entry and returns its bytes.
    #[must_use]
    pub fn into_data(self) -> Vec<u8> {
        self.data
    }
}

/// A byte-aligned view into one entry in a typed batch buffer pool.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferSlice {
    #[serde(rename = "buffer")]
    buffer_index: u32,
    byte_offset: u64,
    byte_length: u64,
}

impl BufferSlice {
    /// Creates a buffer slice after validating its JavaScript-safe coordinates.
    pub fn new(buffer_index: u32, byte_offset: u64, byte_length: u64) -> Result<Self> {
        validate_safe_integer("buffer byte offset", byte_offset)?;
        validate_safe_integer("buffer byte length", byte_length)?;
        checked_end("buffer byte", byte_offset, byte_length)?;
        Ok(Self {
            buffer_index,
            byte_offset,
            byte_length,
        })
    }

    /// Returns the zero-based buffer-pool index.
    #[must_use]
    pub const fn buffer_index(self) -> u32 {
        self.buffer_index
    }

    /// Returns the first referenced byte.
    #[must_use]
    pub const fn byte_offset(self) -> u64 {
        self.byte_offset
    }

    /// Returns the number of referenced bytes.
    #[must_use]
    pub const fn byte_length(self) -> u64 {
        self.byte_length
    }

    fn byte_end(self) -> Result<u64> {
        checked_end("buffer byte", self.byte_offset, self.byte_length)
    }
}

/// A bit-aligned bitmap view into one byte-aligned buffer slice.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitmapSlice {
    buffer: BufferSlice,
    bit_offset: u64,
}

impl BitmapSlice {
    /// Creates a bitmap view.
    pub fn new(buffer: BufferSlice, bit_offset: u64) -> Result<Self> {
        validate_safe_integer("bitmap bit offset", bit_offset)?;
        Ok(Self { buffer, bit_offset })
    }

    /// Returns the byte-aligned backing slice.
    #[must_use]
    pub const fn buffer(self) -> BufferSlice {
        self.buffer
    }

    /// Returns the first referenced bit within the backing slice.
    #[must_use]
    pub const fn bit_offset(self) -> u64 {
        self.bit_offset
    }
}

/// The physical buffer layout for one recursive native array descriptor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "encoding", rename_all = "kebab-case")]
#[non_exhaustive]
pub enum ArrayLayout {
    /// An array with no value buffers.
    Null,
    /// Bit-packed boolean values.
    Bitmap {
        /// Boolean value bits.
        values: BitmapSlice,
    },
    /// Fixed-width primitive, decimal, temporal, interval, or binary values.
    FixedWidth {
        /// Consecutive little-endian values.
        values: BufferSlice,
    },
    /// Variable-width binary or UTF-8 values.
    VariableWidth {
        /// Consecutive signed 32-bit or 64-bit offsets.
        offsets: BufferSlice,
        /// Concatenated value bytes.
        values: BufferSlice,
    },
    /// Arrow binary-view or UTF-8-view values.
    View {
        /// Consecutive Arrow view records.
        views: BufferSlice,
        /// Buffers addressed by non-inline view records.
        buffers: Vec<BufferSlice>,
    },
    /// Variable-size list or map values.
    List {
        /// Consecutive signed 32-bit or 64-bit child offsets.
        offsets: BufferSlice,
        /// Recursively described child array.
        values: Box<ArrayDescriptor>,
    },
    /// List-view values with independent offsets and sizes.
    ListView {
        /// Consecutive signed 32-bit or 64-bit child offsets.
        offsets: BufferSlice,
        /// Consecutive signed 32-bit or 64-bit child sizes.
        sizes: BufferSlice,
        /// Recursively described child array.
        values: Box<ArrayDescriptor>,
    },
    /// Fixed-size list values.
    FixedSizeList {
        /// Recursively described child array.
        values: Box<ArrayDescriptor>,
    },
    /// Struct values with children in schema order.
    Struct {
        /// Recursively described child arrays.
        fields: Vec<ArrayDescriptor>,
    },
    /// Sparse or dense union values.
    Union {
        /// Signed type ID for every logical value.
        type_ids: BufferSlice,
        /// Dense child offsets; absent for a sparse union.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offsets: Option<BufferSlice>,
        /// Child arrays paired with their signed type IDs.
        fields: Vec<UnionArray>,
    },
    /// Dictionary keys and dictionary values, retaining the source encoding.
    Dictionary {
        /// Integer keys for logical values.
        keys: Box<ArrayDescriptor>,
        /// Dictionary values addressed by the keys.
        values: Box<ArrayDescriptor>,
    },
    /// Run ends and run values, retaining the source encoding.
    RunEndEncoded {
        /// Signed integer run-end array.
        run_ends: Box<ArrayDescriptor>,
        /// Logical value for each run.
        values: Box<ArrayDescriptor>,
    },
}

/// One union child array paired with its signed Arrow type ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnionArray {
    type_id: i8,
    values: ArrayDescriptor,
}

impl UnionArray {
    /// Creates a union child array descriptor.
    #[must_use]
    pub const fn new(type_id: i8, values: ArrayDescriptor) -> Self {
        Self { type_id, values }
    }

    /// Returns the signed Arrow type ID.
    #[must_use]
    pub const fn type_id(&self) -> i8 {
        self.type_id
    }

    /// Returns the child values.
    #[must_use]
    pub const fn values(&self) -> &ArrayDescriptor {
        &self.values
    }
}

/// A recursive native array descriptor referencing a shared buffer pool.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrayDescriptor {
    data_type: TableDataType,
    length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    validity: Option<BitmapSlice>,
    #[serde(flatten)]
    layout: ArrayLayout,
}

impl ArrayDescriptor {
    /// Creates a recursive array descriptor.
    pub fn new(
        data_type: TableDataType,
        length: u64,
        validity: Option<BitmapSlice>,
        layout: ArrayLayout,
    ) -> Result<Self> {
        validate_safe_integer("array length", length)?;
        if data_type.nesting_depth() > MAX_DATA_TYPE_NESTING_DEPTH {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "array data type exceeds the maximum nesting depth",
            )
            .with_detail("nestingDepth", data_type.nesting_depth())
            .with_detail("maxNestingDepth", MAX_DATA_TYPE_NESTING_DEPTH));
        }
        Ok(Self {
            data_type,
            length,
            validity,
            layout,
        })
    }

    /// Returns the logical type of the array.
    #[must_use]
    pub const fn data_type(&self) -> &TableDataType {
        &self.data_type
    }

    /// Returns the number of logical values.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.length
    }

    /// Returns whether this array has no logical values.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.length == 0
    }

    /// Returns the optional null validity bitmap.
    #[must_use]
    pub const fn validity(&self) -> Option<BitmapSlice> {
        self.validity
    }

    /// Returns the physical buffer layout.
    #[must_use]
    pub const fn layout(&self) -> &ArrayLayout {
        &self.layout
    }
}

/// Native and display representations of one logical typed batch column.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedColumnBatch {
    column_id: String,
    native: ArrayDescriptor,
    display: ArrayDescriptor,
}

impl TypedColumnBatch {
    /// Creates a typed column whose display representation is stable UTF-8.
    pub fn new(
        column_id: impl Into<String>,
        native: ArrayDescriptor,
        display: ArrayDescriptor,
    ) -> Result<Self> {
        let column_id = column_id.into();
        if column_id.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "typed batch column id must not be empty",
            ));
        }
        if native.len() != display.len() {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "native and display arrays must have equal lengths",
            ));
        }
        if display.data_type() != &TableDataType::Utf8
            || !matches!(display.layout(), ArrayLayout::VariableWidth { .. })
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "display arrays must use the UTF-8 variable-width layout",
            ));
        }
        Ok(Self {
            column_id,
            native,
            display,
        })
    }

    /// Returns the stable schema column ID.
    #[must_use]
    pub fn column_id(&self) -> &str {
        &self.column_id
    }

    /// Returns the exact native representation.
    #[must_use]
    pub const fn native(&self) -> &ArrayDescriptor {
        &self.native
    }

    /// Returns the normalized UTF-8 display representation.
    #[must_use]
    pub const fn display(&self) -> &ArrayDescriptor {
        &self.display
    }
}

/// A typed-buffer layout v1 batch with a shared transferable buffer pool.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedTableBatch {
    layout_version: u32,
    table_id: String,
    revision: u64,
    schema_version: u64,
    range: ReturnedRange,
    complete: bool,
    buffers: Vec<BatchBuffer>,
    columns: Vec<TypedColumnBatch>,
}

impl TypedTableBatch {
    /// Creates and validates one typed-buffer layout v1 range batch.
    pub fn new(
        table_id: impl Into<String>,
        revision: u64,
        schema_version: u64,
        range: ReturnedRange,
        complete: bool,
        buffers: Vec<BatchBuffer>,
        columns: Vec<TypedColumnBatch>,
    ) -> Result<Self> {
        range.validate_public()?;
        validate_safe_integer("batch revision", revision)?;
        validate_safe_integer("batch schema version", schema_version)?;
        if u64::try_from(columns.len()).ok() != Some(range.column_count()) {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "typed batch column count does not match its returned range",
            ));
        }
        for column in &columns {
            if column.native.len() != range.row_count() {
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "typed batch array length does not match its returned range",
                )
                .with_detail("columnId", column.column_id.clone()));
            }
            validate_array_buffers(&column.native, &buffers)?;
            validate_array_buffers(&column.display, &buffers)?;
        }
        Ok(Self {
            layout_version: BATCH_LAYOUT_VERSION,
            table_id: table_id.into(),
            revision,
            schema_version,
            range,
            complete,
            buffers,
            columns,
        })
    }

    /// Returns the typed-buffer layout version.
    #[must_use]
    pub const fn layout_version(&self) -> u32 {
        self.layout_version
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

    /// Returns the schema version used by the descriptors.
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

    /// Returns the shared transferable buffer pool.
    #[must_use]
    pub fn buffers(&self) -> &[BatchBuffer] {
        &self.buffers
    }

    /// Returns typed columns in logical order.
    #[must_use]
    pub fn columns(&self) -> &[TypedColumnBatch] {
        &self.columns
    }
}

fn validate_array_buffers(array: &ArrayDescriptor, buffers: &[BatchBuffer]) -> Result<()> {
    if let Some(validity) = array.validity {
        validate_bitmap(validity, array.length, buffers)?;
    }
    match &array.layout {
        ArrayLayout::Null => {}
        ArrayLayout::Bitmap { values } => validate_bitmap(*values, array.length, buffers)?,
        ArrayLayout::FixedWidth { values } => validate_buffer(*values, buffers)?,
        ArrayLayout::VariableWidth { offsets, values } => {
            validate_buffer(*offsets, buffers)?;
            validate_buffer(*values, buffers)?;
        }
        ArrayLayout::View {
            views,
            buffers: view_buffers,
        } => {
            validate_buffer(*views, buffers)?;
            for buffer in view_buffers {
                validate_buffer(*buffer, buffers)?;
            }
        }
        ArrayLayout::List { offsets, values } => {
            validate_buffer(*offsets, buffers)?;
            validate_array_buffers(values, buffers)?;
        }
        ArrayLayout::ListView {
            offsets,
            sizes,
            values,
        } => {
            validate_buffer(*offsets, buffers)?;
            validate_buffer(*sizes, buffers)?;
            validate_array_buffers(values, buffers)?;
        }
        ArrayLayout::FixedSizeList { values } => validate_array_buffers(values, buffers)?,
        ArrayLayout::Struct { fields } => {
            for field in fields {
                validate_array_buffers(field, buffers)?;
            }
        }
        ArrayLayout::Union {
            type_ids,
            offsets,
            fields,
        } => {
            validate_buffer(*type_ids, buffers)?;
            if let Some(offsets) = offsets {
                validate_buffer(*offsets, buffers)?;
            }
            for field in fields {
                validate_array_buffers(&field.values, buffers)?;
            }
        }
        ArrayLayout::Dictionary { keys, values } => {
            validate_array_buffers(keys, buffers)?;
            validate_array_buffers(values, buffers)?;
        }
        ArrayLayout::RunEndEncoded { run_ends, values } => {
            validate_array_buffers(run_ends, buffers)?;
            validate_array_buffers(values, buffers)?;
        }
    }
    Ok(())
}

fn validate_bitmap(bitmap: BitmapSlice, length: u64, buffers: &[BatchBuffer]) -> Result<()> {
    validate_buffer(bitmap.buffer, buffers)?;
    let available_bits =
        bitmap.buffer.byte_length.checked_mul(8).ok_or_else(|| {
            TabularkError::new(ErrorCode::InvalidArgument, "bitmap size overflows")
        })?;
    let required_bits = bitmap
        .bit_offset
        .checked_add(length)
        .ok_or_else(|| TabularkError::new(ErrorCode::InvalidArgument, "bitmap range overflows"))?;
    if required_bits > available_bits {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "bitmap slice is shorter than its logical array",
        ));
    }
    Ok(())
}

fn validate_buffer(slice: BufferSlice, buffers: &[BatchBuffer]) -> Result<()> {
    let buffer = buffers.get(slice.buffer_index as usize).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::InvalidArgument,
            "buffer slice references a missing pool entry",
        )
        .with_detail("bufferIndex", slice.buffer_index)
    })?;
    let byte_end = slice.byte_end()?;
    if usize::try_from(byte_end)
        .ok()
        .is_none_or(|end| end > buffer.data.len())
    {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "buffer slice exceeds its pool entry",
        )
        .with_detail("bufferIndex", slice.buffer_index)
        .with_detail("byteEnd", byte_end)
        .with_detail("bufferLength", buffer.data.len()));
    }
    Ok(())
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

    /// Converts a legacy UTF-8 batch into common typed-buffer layout v1.
    ///
    /// Delimited input has UTF-8 native values and therefore shares its
    /// native descriptor with the display descriptor.  Pool entries are
    /// deduplicated by bytes so repeated offsets, validity maps, or values do
    /// not become extra transferable buffers.
    pub fn to_typed(&self) -> Result<TypedTableBatch> {
        let mut buffers = Vec::new();
        let mut buffers_by_fingerprint = HashMap::<u64, Vec<u32>>::new();
        let mut columns = Vec::with_capacity(self.columns.len());

        for column in &self.columns {
            let values = intern_batch_buffer(
                &mut buffers,
                &mut buffers_by_fingerprint,
                column.data().to_vec(),
            )?;
            let mut offset_bytes = Vec::with_capacity(column.offsets().len().saturating_mul(4));
            for offset in column.offsets() {
                offset_bytes.extend_from_slice(&offset.to_le_bytes());
            }
            let offsets =
                intern_batch_buffer(&mut buffers, &mut buffers_by_fingerprint, offset_bytes)?;
            let validity_buffer = intern_batch_buffer(
                &mut buffers,
                &mut buffers_by_fingerprint,
                column.validity().to_vec(),
            )?;
            let length = u64::try_from(column.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "delimited batch row count exceeds the public range",
                )
            })?;
            let validity = Some(BitmapSlice::new(validity_buffer, 0)?);
            let descriptor = ArrayDescriptor::new(
                TableDataType::Utf8,
                length,
                validity,
                ArrayLayout::VariableWidth { offsets, values },
            )?;
            columns.push(TypedColumnBatch::new(
                column.column_id(),
                descriptor.clone(),
                descriptor,
            )?);
        }

        TypedTableBatch::new(
            self.table_id.clone(),
            self.revision,
            self.schema_version,
            self.range,
            self.complete,
            buffers,
            columns,
        )
    }
}

fn intern_batch_buffer(
    buffers: &mut Vec<BatchBuffer>,
    buffers_by_fingerprint: &mut HashMap<u64, Vec<u32>>,
    bytes: Vec<u8>,
) -> Result<BufferSlice> {
    let length = u64::try_from(bytes.len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "typed batch buffer length exceeds the public range",
        )
    })?;
    let fingerprint = batch_buffer_fingerprint(&bytes);
    if let Some(candidates) = buffers_by_fingerprint.get(&fingerprint) {
        for index in candidates {
            if let Some(buffer) = buffers.get(*index as usize) {
                if buffer.data() == bytes.as_slice() {
                    return BufferSlice::new(*index, 0, length);
                }
            }
        }
    }
    let index = u32::try_from(buffers.len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "typed batch contains too many buffer-pool entries",
        )
    })?;
    buffers.push(BatchBuffer::new(bytes));
    buffers_by_fingerprint
        .entry(fingerprint)
        .or_default()
        .push(index);
    BufferSlice::new(index, 0, length)
}

fn batch_buffer_fingerprint(bytes: &[u8]) -> u64 {
    // A fixed FNV-1a hash is deterministic across browser and native builds.
    // Collisions are compared byte-for-byte by `intern_batch_buffer`.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^ (bytes.len() as u64).rotate_left(32)
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
    use std::collections::BTreeSet;

    use super::{
        ArrayDescriptor, ArrayLayout, AxisExtent, BATCH_LAYOUT_VERSION, BatchBuffer, BitmapSlice,
        BufferSlice, ColumnSchema, IntervalUnit, RangeRequest, StringColumnBatch, TableBatch,
        TableDataType, TableExtent, TableField, TimeUnit, TypedColumnBatch, TypedTableBatch,
        UnionField, UnionMode,
    };
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

    #[test]
    fn models_all_41_arrow_59_builtin_data_types() {
        let item = || Box::new(TableField::new("item", TableDataType::Utf8, true));
        let built_ins = vec![
            TableDataType::Null,
            TableDataType::Boolean,
            TableDataType::Int8,
            TableDataType::Int16,
            TableDataType::Int32,
            TableDataType::Int64,
            TableDataType::UInt8,
            TableDataType::UInt16,
            TableDataType::UInt32,
            TableDataType::UInt64,
            TableDataType::Float16,
            TableDataType::Float32,
            TableDataType::Float64,
            TableDataType::Timestamp {
                unit: TimeUnit::Nanosecond,
                timezone: Some("Asia/Shanghai".into()),
            },
            TableDataType::Date32,
            TableDataType::Date64,
            TableDataType::Time32 {
                unit: TimeUnit::Millisecond,
            },
            TableDataType::Time64 {
                unit: TimeUnit::Microsecond,
            },
            TableDataType::Duration {
                unit: TimeUnit::Second,
            },
            TableDataType::Interval {
                unit: IntervalUnit::MonthDayNano,
            },
            TableDataType::Binary,
            TableDataType::FixedSizeBinary { byte_width: 16 },
            TableDataType::LargeBinary,
            TableDataType::BinaryView,
            TableDataType::Utf8,
            TableDataType::LargeUtf8,
            TableDataType::Utf8View,
            TableDataType::List { field: item() },
            TableDataType::ListView { field: item() },
            TableDataType::FixedSizeList {
                field: item(),
                list_size: 3,
            },
            TableDataType::LargeList { field: item() },
            TableDataType::LargeListView { field: item() },
            TableDataType::Struct {
                fields: vec![*item()],
            },
            TableDataType::Union {
                fields: vec![UnionField::new(7, *item())],
                mode: UnionMode::Dense,
            },
            TableDataType::Dictionary {
                key: Box::new(TableDataType::Int32),
                value: Box::new(TableDataType::Utf8),
            },
            TableDataType::Decimal32 {
                precision: 9,
                scale: 2,
            },
            TableDataType::Decimal64 {
                precision: 18,
                scale: -2,
            },
            TableDataType::Decimal128 {
                precision: 38,
                scale: 4,
            },
            TableDataType::Decimal256 {
                precision: 76,
                scale: 8,
            },
            TableDataType::Map {
                field: Box::new(TableField::new(
                    "entries",
                    TableDataType::Struct {
                        fields: vec![
                            TableField::new("key", TableDataType::Utf8, false),
                            TableField::new("value", TableDataType::Int64, true),
                        ],
                    },
                    false,
                )),
                keys_sorted: false,
            },
            TableDataType::RunEndEncoded {
                run_ends: Box::new(TableField::new("run_ends", TableDataType::Int32, false)),
                values: item(),
            },
        ];

        assert_eq!(built_ins.len(), 41);
        let kinds = built_ins
            .iter()
            .map(|data_type| {
                serde_json::to_value(data_type).expect("serialize type")["type"]
                    .as_str()
                    .expect("kind")
                    .to_owned()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(kinds.len(), 41, "every built-in must have a distinct tag");
    }

    #[test]
    fn schema_uses_recursive_data_type() {
        let column =
            ColumnSchema::new("c0", "value", 0, TableDataType::Utf8, true).expect("typed column");
        assert_eq!(column.data_type(), &TableDataType::Utf8);
        let encoded = serde_json::to_value(&column).expect("serialize column");
        assert_eq!(encoded["dataType"], serde_json::json!({"type": "utf8"}));
        assert!(encoded.get("logicalType").is_none());

        let extension = TableDataType::Extension {
            name: "example.uuid".into(),
            metadata: Some("v1".into()),
            storage: Box::new(TableDataType::FixedSizeBinary { byte_width: 16 }),
        };
        let typed =
            ColumnSchema::new("c1", "uuid", 1, extension.clone(), false).expect("typed column");
        assert_eq!(typed.data_type(), &extension);
    }

    #[test]
    fn typed_batch_reuses_and_bounds_checks_buffer_pool_entries() {
        let buffers = vec![
            BatchBuffer::new(vec![0b0000_0001]),
            BatchBuffer::new(7_i64.to_le_bytes().to_vec()),
            BatchBuffer::new([0_u32.to_le_bytes(), 1_u32.to_le_bytes()].concat()),
            BatchBuffer::new(b"7".to_vec()),
        ];
        let validity =
            BitmapSlice::new(BufferSlice::new(0, 0, 1).expect("validity"), 0).expect("bitmap");
        let native = ArrayDescriptor::new(
            TableDataType::Int64,
            1,
            Some(validity),
            ArrayLayout::FixedWidth {
                values: BufferSlice::new(1, 0, 8).expect("native values"),
            },
        )
        .expect("native descriptor");
        let display = ArrayDescriptor::new(
            TableDataType::Utf8,
            1,
            Some(validity),
            ArrayLayout::VariableWidth {
                offsets: BufferSlice::new(2, 0, 8).expect("display offsets"),
                values: BufferSlice::new(3, 0, 1).expect("display values"),
            },
        )
        .expect("display descriptor");
        let column = TypedColumnBatch::new("c0", native, display).expect("typed column");
        let batch = TypedTableBatch::new(
            "table-0",
            0,
            1,
            RangeRequest::new(0, 1, 0, 1).expect("range"),
            true,
            buffers,
            vec![column],
        )
        .expect("typed batch");

        assert_eq!(batch.layout_version(), BATCH_LAYOUT_VERSION);
        assert_eq!(batch.buffers().len(), 4);
        assert_eq!(batch.columns()[0].native().validity(), Some(validity));
        assert_eq!(batch.columns()[0].display().validity(), Some(validity));

        let bad_display = ArrayDescriptor::new(
            TableDataType::Utf8,
            1,
            None,
            ArrayLayout::VariableWidth {
                offsets: BufferSlice::new(99, 0, 0).expect("missing offsets"),
                values: BufferSlice::new(99, 0, 0).expect("missing values"),
            },
        )
        .expect("descriptor permits deferred pool validation");
        let bad_native = ArrayDescriptor::new(
            TableDataType::Int64,
            1,
            None,
            ArrayLayout::FixedWidth {
                values: BufferSlice::new(99, 0, 0).expect("missing native values"),
            },
        )
        .expect("descriptor");
        let bad_column =
            TypedColumnBatch::new("c0", bad_native, bad_display).expect("column shape");
        assert!(
            TypedTableBatch::new(
                "table-0",
                0,
                1,
                RangeRequest::new(0, 1, 0, 1).expect("range"),
                true,
                Vec::new(),
                vec![bad_column],
            )
            .is_err()
        );
    }

    #[test]
    fn delimited_batches_use_the_common_typed_buffer_layout() {
        let strings =
            StringColumnBatch::new("c0", b"same".to_vec(), vec![0, 4, 4], vec![0b0000_0001])
                .expect("string column");
        let duplicate =
            StringColumnBatch::new("c1", b"same".to_vec(), vec![0, 4, 4], vec![0b0000_0001])
                .expect("duplicate string column");
        let legacy = TableBatch::new(
            "table-0",
            0,
            1,
            RangeRequest::new(0, 2, 0, 2).expect("range"),
            true,
            vec![strings, duplicate],
        );

        let typed = legacy.to_typed().expect("typed batch");
        assert_eq!(typed.layout_version(), BATCH_LAYOUT_VERSION);
        assert_eq!(typed.columns().len(), 2);
        assert_eq!(
            typed.buffers().len(),
            3,
            "identical CSV buffers are interned"
        );
        for column in typed.columns() {
            assert_eq!(column.native(), column.display());
            assert_eq!(column.native().data_type(), &TableDataType::Utf8);
            assert!(matches!(
                column.native().layout(),
                ArrayLayout::VariableWidth { .. }
            ));
        }
    }
}
