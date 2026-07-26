//! Core types for Tabulark.
//!
//! This crate supplies protocol-v4 model types, the delimited runtime, and an
//! opt-in Apache Arrow IPC adapter. Its public API remains experimental while
//! the built-in adapter ABI is validated before a stable release.

pub mod error;
pub mod model;
pub mod protocol;
pub mod resource;

#[cfg(feature = "arrow")]
pub mod arrow;

#[cfg(feature = "csv")]
pub mod csv;

#[cfg(feature = "parquet")]
pub mod parquet;

#[cfg(feature = "csv")]
pub mod runtime;

#[cfg(feature = "wasm")]
mod wasm;

pub use error::{ErrorCode, Result, TabularkError};
pub use model::{
    ArrayDescriptor, ArrayLayout, AxisExtent, BATCH_LAYOUT_VERSION, BatchBuffer, BitmapSlice,
    BufferSlice, Capabilities, ColumnSchema, IntervalUnit, MAX_DATA_TYPE_NESTING_DEPTH,
    RandomAccess, RangeRequest, ReturnedRange, Schema, StringColumnBatch, TableBatch,
    TableDataType, TableExtent, TableField, TableMetadata, TimeUnit, TypedColumnBatch,
    TypedTableBatch, UnionArray, UnionField, UnionMode,
};

#[cfg(feature = "wasm")]
pub use wasm::WasmRuntime;

/// The current maturity of the experimental M4 API.
pub const PROJECT_STATUS: &str = "pre-alpha";

/// The number of rows and columns exposed by a table.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct TableShape {
    rows: u64,
    columns: u64,
}

impl TableShape {
    /// Creates shape metadata for a table.
    #[must_use]
    pub const fn new(rows: u64, columns: u64) -> Self {
        Self { rows, columns }
    }

    /// Returns the number of rows.
    #[must_use]
    pub const fn rows(self) -> u64 {
        self.rows
    }

    /// Returns the number of columns.
    #[must_use]
    pub const fn columns(self) -> u64 {
        self.columns
    }

    /// Returns `true` when the table has no addressable cells.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.rows == 0 || self.columns == 0
    }

    /// Returns the cell count, or `None` when multiplication overflows.
    #[must_use]
    pub const fn checked_cell_count(self) -> Option<u64> {
        self.rows.checked_mul(self.columns)
    }
}

#[cfg(test)]
mod tests {
    use super::TableShape;

    #[test]
    fn reports_shape_metadata() {
        let shape = TableShape::new(12, 4);

        assert_eq!(shape.rows(), 12);
        assert_eq!(shape.columns(), 4);
        assert_eq!(shape.checked_cell_count(), Some(48));
        assert!(!shape.is_empty());
    }

    #[test]
    fn treats_a_zero_dimension_as_empty() {
        assert!(TableShape::new(0, 4).is_empty());
        assert!(TableShape::new(4, 0).is_empty());
    }

    #[test]
    fn detects_cell_count_overflow() {
        assert_eq!(TableShape::new(u64::MAX, 2).checked_cell_count(), None);
    }
}
