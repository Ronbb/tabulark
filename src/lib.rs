//! Core types for Tabulark.
//!
//! This crate supplies the model, version-one Worker protocol, CSV/TSV runtime,
//! and WebAssembly bridge for the M0-M2 local CSV/TSV prototype. Its public API
//! is experimental and may change while M3 hardening and M4 adapter validation
//! are completed.

pub mod error;
pub mod model;
pub mod protocol;

#[cfg(feature = "csv")]
pub mod csv;

#[cfg(feature = "csv")]
pub mod runtime;

#[cfg(feature = "wasm")]
mod wasm;

pub use error::{ErrorCode, Result, TabularkError};
pub use model::{
    AxisExtent, Capabilities, ColumnSchema, LogicalType, RandomAccess, RangeRequest, ReturnedRange,
    Schema, StringColumnBatch, TableBatch, TableExtent, TableMetadata,
};

#[cfg(feature = "wasm")]
pub use wasm::WasmRuntime;

/// The current maturity of the experimental M0-M2 API.
pub const PROJECT_STATUS: &str = "prototype";

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
