//! Native foundation for the official XLS/XLSX adapter.
//!
//! The eventual WebAssembly facade can remain thin: this crate owns signature
//! recognition, bounded workbook staging, worksheet lifecycle, and conversion
//! to Tabulark's logical UTF-8 batches. File extensions are never consulted.

use std::collections::HashMap;
use std::fmt::Display;
use std::io::{Cursor, Read};
use std::path::PathBuf;

use calamine::{Data, ExcelDateTime, Range, Reader, Sheet, SheetType, SheetVisible, Xls, Xlsx};
use quick_xml::Reader as XmlReader;
use quick_xml::events::{BytesStart as XmlBytesStart, Event as XmlEvent};
use serde::{Deserialize, Serialize};
use tabulark::model::{
    AxisExtent, Capabilities, ColumnSchema, RandomAccess, RangeRequest, Schema, StringColumnBatch,
    TableBatch, TableDataType, TableExtent, TableMetadata,
};
use tabulark::{ErrorCode, Result, TabularkError};
use zip::ZipArchive;

mod presentation;
mod wasm;

use presentation::{TablePresentation, TablePresentationRange, WorkbookPresentation};

pub use wasm::WasmRuntime;

/// Stable ID of the official Excel adapter.
pub const EXCEL_ADAPTER_ID: &str = "tabulark:excel";

const CFB_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const ZIP_LOCAL_FILE_SIGNATURE: [u8; 4] = *b"PK\x03\x04";
const ZIP_EMPTY_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const ZIP_SPANNED_SIGNATURE: [u8; 4] = *b"PK\x07\x08";
const XLSX_WORKBOOK_CONTENT_TYPE: &[u8] =
    b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

/// Supported workbook formats after structural validation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExcelFormat {
    /// Excel 97-2003 BIFF8 in an OLE compound file.
    Xls,
    /// Office Open XML SpreadsheetML.
    Xlsx,
}

/// Caller-provided format constraint. Detection still comes from source bytes.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExcelFormatHint {
    /// Accept either supported signature.
    #[default]
    Auto,
    /// Require a BIFF8 XLS source.
    Xls,
    /// Require an XLSX source.
    Xlsx,
}

/// Shallow physical container recognized from the source signature.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ExcelContainer {
    /// OLE Compound File Binary container, used by XLS and encrypted OOXML.
    CompoundFile,
    /// ZIP container, used by XLSX and several explicitly unsupported formats.
    Zip,
}

/// XLSX worksheet visibility state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExcelSheetVisibility {
    /// Normally visible worksheet.
    Visible,
    /// Worksheet hidden through workbook UI.
    Hidden,
    /// Worksheet only revealable through workbook metadata or automation.
    VeryHidden,
}

/// Logical worksheet exposed by one Excel dataset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelTableDescriptor {
    id: String,
    name: String,
    workbook_ordinal: usize,
    visibility: ExcelSheetVisibility,
}

impl ExcelTableDescriptor {
    /// Returns the stable worksheet ID (`sheet-{worksheet ordinal}`).
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the workbook-provided worksheet name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the sheet position among every workbook sheet type.
    #[must_use]
    pub const fn workbook_ordinal(&self) -> usize {
        self.workbook_ordinal
    }

    /// Returns the workbook visibility state.
    #[must_use]
    pub const fn visibility(&self) -> ExcelSheetVisibility {
        self.visibility
    }
}

/// Stable diagnostic categories emitted while opening a workbook or table.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExcelWarningKind {
    /// A non-worksheet sheet was intentionally omitted.
    SkippedSheet,
    /// A formula has no cached result and is surfaced as null.
    MissingFormulaCache,
}

/// Recoverable Excel diagnostic.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelWarning {
    kind: ExcelWarningKind,
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    table_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column: Option<u64>,
}

impl ExcelWarning {
    /// Returns the stable warning category.
    #[must_use]
    pub const fn kind(&self) -> ExcelWarningKind {
        self.kind
    }

    /// Returns the safe diagnostic text.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the logical worksheet ID, when applicable.
    #[must_use]
    pub fn table_id(&self) -> Option<&str> {
        self.table_id.as_deref()
    }

    /// Returns the zero-based worksheet row, when applicable.
    #[must_use]
    pub const fn row(&self) -> Option<u64> {
        self.row
    }

    /// Returns the zero-based worksheet column, when applicable.
    #[must_use]
    pub const fn column(&self) -> Option<u64> {
        self.column
    }
}

/// Public Excel adapter options. Extensions never participate in detection.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExcelOptions {
    /// Optional signature constraint.
    pub format: ExcelFormatHint,
    /// Source label retained only for diagnostics and host display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

/// Defensive format and batch limits applied before adapter-owned allocation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExcelLimits {
    /// Maximum staged source bytes for one workbook.
    pub max_source_bytes: usize,
    /// Maximum ZIP entries in an XLSX container.
    pub max_zip_entries: usize,
    /// Maximum declared uncompressed bytes for one ZIP entry.
    pub max_zip_entry_bytes: u64,
    /// Maximum aggregate declared uncompressed bytes in an XLSX container.
    pub max_zip_uncompressed_bytes: u64,
    /// Maximum entries in an XLS compound file.
    pub max_cfb_entries: usize,
    /// Maximum aggregate declared bytes across XLS compound streams.
    pub max_cfb_stream_bytes: u64,
    /// Maximum logical worksheets exposed by one source.
    pub max_worksheets: usize,
    /// Maximum physical rows in one worksheet.
    pub max_worksheet_rows: u64,
    /// Maximum physical columns in one worksheet.
    pub max_worksheet_columns: u64,
    /// Maximum rectangular cells in one opened worksheet extent.
    pub max_worksheet_cells: u64,
    /// Maximum cells in one range request.
    pub max_range_cells: u64,
    /// Maximum encoded UTF-8 batch bytes.
    pub max_batch_bytes: usize,
    /// Maximum recoverable warnings retained per table open.
    pub max_warnings: usize,
    /// Maximum deduplicated static styles retained from one workbook.
    pub max_styles: usize,
    /// Maximum merged regions retained from one worksheet.
    pub max_merged_cells: usize,
    /// Maximum sparse row or column layout entries retained per axis.
    pub max_layout_entries: usize,
    /// Maximum explicitly styled cells retained per worksheet.
    pub max_styled_cells: usize,
}

impl Default for ExcelLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: 128 * 1024 * 1024,
            max_zip_entries: 10_000,
            max_zip_entry_bytes: 64 * 1024 * 1024,
            max_zip_uncompressed_bytes: 512 * 1024 * 1024,
            max_cfb_entries: 10_000,
            max_cfb_stream_bytes: 512 * 1024 * 1024,
            max_worksheets: 1_024,
            max_worksheet_rows: 1_048_576,
            max_worksheet_columns: 16_384,
            max_worksheet_cells: 16_000_000,
            max_range_cells: 250_000,
            max_batch_bytes: 32 * 1024 * 1024,
            max_warnings: 1_024,
            max_styles: 65_536,
            max_merged_cells: 100_000,
            max_layout_entries: 100_000,
            max_styled_cells: 1_000_000,
        }
    }
}

impl ExcelLimits {
    fn validate(&self) -> Result<()> {
        if self.max_source_bytes == 0
            || self.max_zip_entries == 0
            || self.max_zip_entry_bytes == 0
            || self.max_zip_uncompressed_bytes == 0
            || self.max_cfb_entries == 0
            || self.max_cfb_stream_bytes == 0
            || self.max_worksheets == 0
            || self.max_worksheet_rows == 0
            || self.max_worksheet_columns == 0
            || self.max_worksheet_cells == 0
            || self.max_range_cells == 0
            || self.max_batch_bytes == 0
            || self.max_warnings == 0
            || self.max_styles == 0
            || self.max_merged_cells == 0
            || self.max_layout_entries == 0
            || self.max_styled_cells == 0
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel resource limits must be greater than zero",
            ));
        }
        if self.max_worksheet_rows > 1_048_576 || self.max_worksheet_columns > 16_384 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel worksheet limits exceed the supported XLSX grid",
            )
            .with_detail("maxWorksheetRows", self.max_worksheet_rows)
            .with_detail("maxWorksheetColumns", self.max_worksheet_columns));
        }
        Ok(())
    }
}

/// Aggregate lifecycle limits for the native Excel registry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExcelRuntimeConfig {
    /// Aggregate staged workbook budget across all open sources.
    pub memory_budget_bytes: usize,
    /// Maximum concurrently open workbook sources.
    pub max_sources: usize,
    /// Per-workbook and per-range limits.
    pub limits: ExcelLimits,
}

impl Default for ExcelRuntimeConfig {
    fn default() -> Self {
        Self {
            memory_budget_bytes: 256 * 1024 * 1024,
            max_sources: 8,
            limits: ExcelLimits::default(),
        }
    }
}

/// Opaque Excel source handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ExcelSourceHandle(u32);

impl ExcelSourceHandle {
    /// Reconstructs a handle received across a trusted adapter boundary.
    #[must_use]
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }

    /// Returns the numeric handle value.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Opaque opened worksheet handle.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ExcelTableHandle(u32);

impl ExcelTableHandle {
    /// Reconstructs a handle received across a trusted adapter boundary.
    #[must_use]
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }

    /// Returns the numeric handle value.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Result of opening one worksheet.
#[derive(Clone, Debug)]
pub struct ExcelTableOpenResult {
    /// New table handle.
    pub table_handle: ExcelTableHandle,
    /// Exact logical metadata for the worksheet grid.
    pub metadata: TableMetadata,
    /// Formula-cache warnings discovered while opening the table.
    pub warnings: Vec<ExcelWarning>,
}

/// Recognizes the physical container from magic bytes only.
pub fn recognize_excel_container(bytes: &[u8]) -> Result<ExcelContainer> {
    if bytes.starts_with(&CFB_SIGNATURE) {
        return Ok(ExcelContainer::CompoundFile);
    }
    if bytes.starts_with(&ZIP_LOCAL_FILE_SIGNATURE)
        || bytes.starts_with(&ZIP_EMPTY_SIGNATURE)
        || bytes.starts_with(&ZIP_SPANNED_SIGNATURE)
    {
        return Ok(ExcelContainer::Zip);
    }
    Err(TabularkError::new(
        ErrorCode::ParseFailed,
        "source does not have a supported Excel container signature",
    ))
}

/// Detects and structurally validates XLS BIFF8 or XLSX using source bytes.
pub fn detect_excel_format(bytes: &[u8]) -> Result<ExcelFormat> {
    detect_excel_format_with_limits(bytes, &ExcelLimits::default())
}

fn detect_excel_format_with_limits(bytes: &[u8], limits: &ExcelLimits) -> Result<ExcelFormat> {
    Ok(inspect_excel_source(bytes, limits, usize::MAX)?.format)
}

#[derive(Clone, Copy, Debug)]
struct ExcelInspection {
    format: ExcelFormat,
    reserved_bytes: usize,
}

fn inspect_excel_source(
    bytes: &[u8],
    limits: &ExcelLimits,
    available_bytes: usize,
) -> Result<ExcelInspection> {
    limits.validate()?;
    if bytes.len() > limits.max_source_bytes {
        return Err(resource_limit(
            "staging",
            bytes.len(),
            limits.max_source_bytes,
            "Excel source exceeds the configured staging limit",
        ));
    }
    match recognize_excel_container(bytes)? {
        ExcelContainer::CompoundFile => {
            let reserved_bytes = validate_biff8_container(bytes, limits, available_bytes)?;
            Ok(ExcelInspection {
                format: ExcelFormat::Xls,
                reserved_bytes,
            })
        }
        ExcelContainer::Zip => {
            let reserved_bytes = validate_xlsx_container(bytes, limits, available_bytes)?;
            Ok(ExcelInspection {
                format: ExcelFormat::Xlsx,
                reserved_bytes,
            })
        }
    }
}

/// Native handle registry shared by tests and the eventual thin WASM facade.
pub struct ExcelRuntime {
    config: ExcelRuntimeConfig,
    next_handle: u32,
    retained_bytes: usize,
    sources: HashMap<ExcelSourceHandle, ExcelSource>,
    tables: HashMap<ExcelTableHandle, OpenTable>,
}

impl ExcelRuntime {
    /// Creates an empty runtime.
    pub fn new(config: ExcelRuntimeConfig) -> Result<Self> {
        config.limits.validate()?;
        if config.memory_budget_bytes == 0 || config.max_sources == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel runtime resource limits must be greater than zero",
            ));
        }
        if config.limits.max_source_bytes > config.memory_budget_bytes {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel source limit must not exceed the runtime memory budget",
            )
            .with_detail("maxSourceBytes", config.limits.max_source_bytes)
            .with_detail("memoryBudgetBytes", config.memory_budget_bytes));
        }
        Ok(Self {
            config,
            next_handle: 1,
            retained_bytes: 0,
            sources: HashMap::new(),
            tables: HashMap::new(),
        })
    }

    /// Stages, validates, and opens one workbook. Failed opens consume no handle.
    pub fn open_source(
        &mut self,
        bytes: Vec<u8>,
        options: ExcelOptions,
    ) -> Result<ExcelSourceHandle> {
        if self.sources.len() >= self.config.max_sources {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel runtime has reached its open-source limit",
            )
            .with_detail("resource", "open-sources")
            .with_detail("required", self.sources.len().saturating_add(1))
            .with_detail("available", self.config.max_sources));
        }
        let available_bytes = self
            .config
            .memory_budget_bytes
            .checked_sub(self.retained_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Excel memory reservations exceed the runtime budget",
                )
            })?;
        // Inspect declarations before Calamine or the presentation parser can
        // decompress an entry or reserve workbook-owned storage.
        let inspection = inspect_excel_source(&bytes, &self.config.limits, available_bytes)?;
        let source = ExcelSource::open(
            bytes,
            options,
            &self.config.limits,
            inspection,
            available_bytes,
        )?;
        let retained_bytes = self
            .retained_bytes
            .checked_add(source.reserved_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel source memory reservation overflows",
                )
            })?;
        if retained_bytes > self.config.memory_budget_bytes {
            return Err(resource_limit(
                "staging",
                retained_bytes,
                self.config.memory_budget_bytes,
                "Excel runtime exceeds its aggregate staging budget",
            ));
        }

        let handle = ExcelSourceHandle(self.allocate_handle()?);
        self.retained_bytes = retained_bytes;
        self.sources.insert(handle, source);
        Ok(handle)
    }

    /// Returns the detected source format.
    pub fn source_format(&self, source: ExcelSourceHandle) -> Result<ExcelFormat> {
        Ok(self.source(source)?.format)
    }

    /// Returns the optional caller-provided source label.
    pub fn source_name(&self, source: ExcelSourceHandle) -> Result<Option<&str>> {
        Ok(self.source(source)?.source_name.as_deref())
    }

    /// Lists logical worksheets in workbook order.
    pub fn list_tables(&self, source: ExcelSourceHandle) -> Result<&[ExcelTableDescriptor]> {
        Ok(&self.source(source)?.tables)
    }

    /// Returns source-level warnings, including skipped non-worksheet sheets.
    pub fn source_warnings(&self, source: ExcelSourceHandle) -> Result<&[ExcelWarning]> {
        Ok(&self.source(source)?.warnings)
    }

    /// Opens a worksheet on demand and computes its exact UTF-8 schema.
    pub fn open_table(
        &mut self,
        source: ExcelSourceHandle,
        table_id: &str,
    ) -> Result<ExcelTableOpenResult> {
        let declared_shape = self
            .sources
            .get(&source)
            .ok_or_else(|| closed_handle("source"))?
            .declared_shape(table_id, &self.config.limits)?;
        let declared_reservation = worksheet_reservation(declared_shape)?;
        let available_bytes = self
            .config
            .memory_budget_bytes
            .checked_sub(self.retained_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Excel memory reservations exceed the runtime budget",
                )
            })?;
        ensure_reservation_budget(
            "worksheet-open-working-set",
            declared_reservation.open_bytes,
            available_bytes,
            "Excel worksheet parse working set exceeds the available memory budget",
        )?;
        let prepared = self
            .sources
            .get_mut(&source)
            .ok_or_else(|| closed_handle("source"))?
            .prepare_table(table_id, &self.config.limits)?;
        let reservation = prepared.reservation;
        ensure_reservation_budget(
            "worksheet-open-working-set",
            reservation.open_bytes,
            available_bytes,
            "Excel worksheet parse working set exceeds the available memory budget",
        )?;
        let table_handle = ExcelTableHandle(self.allocate_handle()?);
        self.retained_bytes = self
            .retained_bytes
            .checked_add(reservation.retained_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel opened-worksheet memory reservation overflows",
                )
            })?;
        self.tables.insert(
            table_handle,
            OpenTable {
                source,
                descriptor: prepared.descriptor,
                metadata: prepared.metadata.clone(),
                shape: prepared.shape,
                range: prepared.range,
                reserved_bytes: reservation.retained_bytes,
            },
        );
        Ok(ExcelTableOpenResult {
            table_handle,
            metadata: prepared.metadata,
            warnings: prepared.warnings,
        })
    }

    /// Returns immutable metadata for an opened worksheet.
    pub fn metadata(&self, table: ExcelTableHandle) -> Result<&TableMetadata> {
        self.tables
            .get(&table)
            .map(|table| &table.metadata)
            .ok_or_else(|| closed_handle("table"))
    }

    /// Returns the workbook descriptor for an opened worksheet.
    pub fn table_descriptor(&self, table: ExcelTableHandle) -> Result<&ExcelTableDescriptor> {
        self.tables
            .get(&table)
            .map(|table| &table.descriptor)
            .ok_or_else(|| closed_handle("table"))
    }

    pub(crate) fn presentation(&self, table: ExcelTableHandle) -> Result<TablePresentation> {
        let open = self
            .tables
            .get(&table)
            .ok_or_else(|| closed_handle("table"))?;
        let source = self
            .sources
            .get(&open.source)
            .ok_or_else(|| closed_handle("source"))?;
        Ok(source.presentation.table(&open.descriptor))
    }

    pub(crate) fn read_presentation_range(
        &self,
        table: ExcelTableHandle,
        request: RangeRequest,
    ) -> Result<TablePresentationRange> {
        let open = self
            .tables
            .get(&table)
            .ok_or_else(|| closed_handle("table"))?;
        validate_range_request(request, open.shape, &self.config.limits)?;
        let source = self
            .sources
            .get(&open.source)
            .ok_or_else(|| closed_handle("source"))?;
        source.presentation.range(&open.descriptor, request)
    }

    /// Reads a bounded display-string range from an opened worksheet.
    pub fn read_range(
        &mut self,
        table: ExcelTableHandle,
        request: RangeRequest,
    ) -> Result<TableBatch> {
        request.validate_public()?;
        let cells = usize::try_from(request.cell_count()?).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel read working-set cell count exceeds the supported integer range",
            )
        })?;
        let mask_bytes = cells
            .checked_mul(std::mem::size_of::<bool>() + std::mem::size_of::<Option<usize>>())
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel read working-set reservation overflows",
                )
            })?;
        let available_bytes = self
            .config
            .memory_budget_bytes
            .checked_sub(self.retained_bytes)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Excel memory reservations exceed the runtime budget",
                )
            })?;
        ensure_reservation_budget(
            "range-mask-working-set",
            mask_bytes,
            available_bytes,
            "Excel range mask working set exceeds the available memory budget",
        )?;
        let max_batch_bytes = self
            .config
            .limits
            .max_batch_bytes
            .min(available_bytes.saturating_sub(mask_bytes));
        if max_batch_bytes == 0 {
            return Err(resource_limit(
                "batch",
                1,
                0,
                "Excel range response has no available memory budget",
            ));
        }
        let open = self
            .tables
            .get(&table)
            .ok_or_else(|| closed_handle("table"))?;
        let source = self
            .sources
            .get(&open.source)
            .ok_or_else(|| closed_handle("source"))?;
        source.read_range(open, request, &self.config.limits, max_batch_bytes)
    }

    /// Idempotently closes one worksheet handle.
    pub fn close_table(&mut self, table: ExcelTableHandle) -> bool {
        let Some(table) = self.tables.remove(&table) else {
            return false;
        };
        self.retained_bytes = self.retained_bytes.saturating_sub(table.reserved_bytes);
        true
    }

    /// Idempotently closes one source and cascades to every child table.
    pub fn close_source(&mut self, source: ExcelSourceHandle) -> bool {
        let Some(source_value) = self.sources.remove(&source) else {
            return false;
        };
        let mut released_bytes = source_value.reserved_bytes;
        self.tables.retain(|_, table| {
            if table.source == source {
                released_bytes = released_bytes.saturating_add(table.reserved_bytes);
                false
            } else {
                true
            }
        });
        self.retained_bytes = self.retained_bytes.saturating_sub(released_bytes);
        true
    }

    /// Releases every source and table.
    pub fn shutdown(&mut self) {
        self.tables.clear();
        self.sources.clear();
        self.retained_bytes = 0;
    }

    /// Returns currently reserved source, decompression, and parse bytes.
    #[must_use]
    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// Returns the number of open sources.
    #[must_use]
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Returns the number of open table handles.
    #[must_use]
    pub fn table_count(&self) -> usize {
        self.tables.len()
    }

    fn source(&self, source: ExcelSourceHandle) -> Result<&ExcelSource> {
        self.sources
            .get(&source)
            .ok_or_else(|| closed_handle("source"))
    }

    fn allocate_handle(&mut self) -> Result<u32> {
        let handle = self.next_handle;
        self.next_handle = self.next_handle.checked_add(1).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel runtime handle space exhausted",
            )
        })?;
        Ok(handle)
    }
}

impl Default for ExcelRuntime {
    fn default() -> Self {
        Self::new(ExcelRuntimeConfig::default()).expect("default Excel runtime config is valid")
    }
}

struct ExcelSource {
    format: ExcelFormat,
    source_name: Option<String>,
    reserved_bytes: usize,
    workbook: Workbook,
    tables: Vec<ExcelTableDescriptor>,
    warnings: Vec<ExcelWarning>,
    presentation: WorkbookPresentation,
}

impl ExcelSource {
    fn open(
        bytes: Vec<u8>,
        options: ExcelOptions,
        limits: &ExcelLimits,
        inspection: ExcelInspection,
        available_bytes: usize,
    ) -> Result<Self> {
        let format = inspection.format;
        ensure_format_hint(options.format, format)?;
        let presentation = WorkbookPresentation::parse(format, &bytes, limits)?;
        // BIFF8 inspection already includes a conservative presentation
        // estimate derived from Workbook records. XLSX inspection accounts for
        // compressed/decompressed XML, so add the actual retained Rust
        // collections and string capacities after bounded parsing.
        let reserved_bytes = if format == ExcelFormat::Xlsx {
            inspection
                .reserved_bytes
                .checked_add(presentation.retained_bytes()?)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel XLSX presentation reservation overflows",
                    )
                })?
        } else {
            inspection.reserved_bytes
        };
        if format == ExcelFormat::Xlsx {
            ensure_reservation_budget(
                "xlsx-presentation-working-set",
                reserved_bytes,
                available_bytes,
                "Excel XLSX source, parse, and retained presentation exceed the available memory budget",
            )?;
        }
        let workbook = match format {
            ExcelFormat::Xls => Workbook::Xls(
                Xls::new(Cursor::new(bytes)).map_err(|error| workbook_open_error(format, error))?,
            ),
            ExcelFormat::Xlsx => Workbook::Xlsx(
                Xlsx::new(Cursor::new(bytes))
                    .map_err(|error| workbook_open_error(format, error))?,
            ),
        };
        let (tables, warnings) = describe_tables(workbook.sheets_metadata(), limits)?;
        if tables.is_empty() {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "Excel workbook contains no worksheet tables",
            ));
        }
        Ok(Self {
            format,
            source_name: options.source_name,
            reserved_bytes,
            workbook,
            tables,
            warnings,
            presentation,
        })
    }

    fn descriptor(&self, table_id: &str) -> Result<ExcelTableDescriptor> {
        self.tables
            .iter()
            .find(|table| table.id == table_id)
            .cloned()
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel dataset does not contain the requested worksheet",
                )
                .with_detail("tableId", table_id)
            })
    }

    fn declared_shape(&self, table_id: &str, limits: &ExcelLimits) -> Result<SheetShape> {
        let descriptor = self.descriptor(table_id)?;
        let (rows, columns) = self.presentation.dimensions(&descriptor).unwrap_or((0, 0));
        validate_sheet_shape(rows, columns, limits)
    }

    fn prepare_table(&mut self, table_id: &str, limits: &ExcelLimits) -> Result<PreparedTable> {
        let descriptor = self.descriptor(table_id)?;
        let range = self.workbook.worksheet_range(&descriptor.name)?;
        let shape = sheet_shape(&range, self.presentation.dimensions(&descriptor), limits)?;
        let metadata = build_metadata(&descriptor, shape)?;
        let formulas = self.workbook.worksheet_formula(&descriptor.name)?;
        let reservation = worksheet_reservation_with_contents(shape, &range, &formulas)?;
        let warnings =
            missing_formula_cache_warnings(&descriptor, &range, &formulas, limits.max_warnings);
        Ok(PreparedTable {
            descriptor,
            metadata,
            warnings,
            shape,
            range,
            reservation,
        })
    }

    fn read_range(
        &self,
        table: &OpenTable,
        request: RangeRequest,
        limits: &ExcelLimits,
        max_batch_bytes: usize,
    ) -> Result<TableBatch> {
        validate_range_request(request, table.shape, limits)?;
        let returned_rows = if request.row_start() >= table.shape.rows {
            0
        } else {
            request
                .row_count()
                .min(table.shape.rows - request.row_start())
        };
        let returned_range = RangeRequest::new(
            request.row_start(),
            returned_rows,
            request.column_start(),
            request.column_count(),
        )?;
        let complete = returned_rows == request.row_count();
        let merged_non_anchor = self
            .presentation
            .merged_non_anchor_mask(&table.descriptor, returned_range)?;
        let range = &table.range;
        let column_count = usize::try_from(request.column_count()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel range column count exceeds the supported integer range",
            )
        })?;
        let mut builders = Vec::with_capacity(column_count);
        let column_start = usize::try_from(request.column_start()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel range column start exceeds the supported integer range",
            )
        })?;
        for column in &table.metadata.schema().columns()[column_start..column_start + column_count]
        {
            builders.push(StringColumnBuilder::new(column.id()));
        }

        let mut batch_bytes = column_count
            .checked_mul(std::mem::size_of::<u32>())
            .ok_or_else(|| batch_limit_error(max_batch_bytes))?;
        if batch_bytes > max_batch_bytes {
            return Err(batch_limit_error(max_batch_bytes));
        }
        for row_delta in 0..returned_rows {
            let row_offset = usize::try_from(row_delta).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel range row offset exceeds the supported integer range",
                )
            })?;
            let row = request.row_start().checked_add(row_delta).ok_or_else(|| {
                TabularkError::new(ErrorCode::InvalidRange, "Excel row coordinate overflows")
            })?;
            let row = u32::try_from(row).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel row coordinate exceeds the supported worksheet grid",
                )
            })?;
            for (column_delta, builder) in builders.iter_mut().enumerate() {
                let mask_index = row_offset
                    .checked_mul(column_count)
                    .and_then(|value| value.checked_add(column_delta))
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Excel merged-cell mask index overflows",
                        )
                    })?;
                let suppress_value = *merged_non_anchor.get(mask_index).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ParseFailed,
                        "Excel merged-cell mask does not align with the returned range",
                    )
                })?;
                let column_delta = u64::try_from(column_delta).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel column coordinate exceeds the supported integer range",
                    )
                })?;
                let column = request
                    .column_start()
                    .checked_add(column_delta)
                    .ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::InvalidRange,
                            "Excel column coordinate overflows",
                        )
                    })?;
                let column = u32::try_from(column).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel column coordinate exceeds the supported worksheet grid",
                    )
                })?;
                let value = if suppress_value {
                    None
                } else {
                    range.get_value((row, column)).and_then(display_string)
                };
                builder.append(value.as_deref(), &mut batch_bytes, max_batch_bytes)?;
            }
        }
        let columns = builders
            .into_iter()
            .map(StringColumnBuilder::finish)
            .collect::<Result<Vec<_>>>()?;
        Ok(TableBatch::new(
            &table.descriptor.id,
            table.metadata.revision(),
            table.metadata.schema().version(),
            returned_range,
            complete,
            columns,
        ))
    }
}

enum Workbook {
    Xls(Xls<Cursor<Vec<u8>>>),
    Xlsx(Xlsx<Cursor<Vec<u8>>>),
}

impl Workbook {
    fn sheets_metadata(&self) -> &[Sheet] {
        match self {
            Self::Xls(workbook) => workbook.sheets_metadata(),
            Self::Xlsx(workbook) => workbook.sheets_metadata(),
        }
    }

    fn worksheet_range(&mut self, name: &str) -> Result<Range<Data>> {
        match self {
            Self::Xls(workbook) => workbook
                .worksheet_range(name)
                .map_err(|error| worksheet_error(ExcelFormat::Xls, name, error)),
            Self::Xlsx(workbook) => workbook
                .worksheet_range(name)
                .map_err(|error| worksheet_error(ExcelFormat::Xlsx, name, error)),
        }
    }

    fn worksheet_formula(&mut self, name: &str) -> Result<Range<String>> {
        match self {
            Self::Xls(workbook) => workbook
                .worksheet_formula(name)
                .map_err(|error| worksheet_error(ExcelFormat::Xls, name, error)),
            Self::Xlsx(workbook) => workbook
                .worksheet_formula(name)
                .map_err(|error| worksheet_error(ExcelFormat::Xlsx, name, error)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SheetShape {
    rows: u64,
    columns: u64,
}

struct OpenTable {
    source: ExcelSourceHandle,
    descriptor: ExcelTableDescriptor,
    metadata: TableMetadata,
    shape: SheetShape,
    range: Range<Data>,
    reserved_bytes: usize,
}

struct PreparedTable {
    descriptor: ExcelTableDescriptor,
    metadata: TableMetadata,
    warnings: Vec<ExcelWarning>,
    shape: SheetShape,
    range: Range<Data>,
    reservation: WorksheetReservation,
}

#[derive(Clone, Copy, Debug)]
struct WorksheetReservation {
    retained_bytes: usize,
    open_bytes: usize,
}

fn describe_tables(
    sheets: &[Sheet],
    limits: &ExcelLimits,
) -> Result<(Vec<ExcelTableDescriptor>, Vec<ExcelWarning>)> {
    let mut tables = Vec::new();
    let mut warnings = Vec::new();
    for (workbook_ordinal, sheet) in sheets.iter().enumerate() {
        if sheet.typ == SheetType::WorkSheet {
            if tables.len() >= limits.max_worksheets {
                return Err(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel workbook exceeds the configured worksheet limit",
                )
                .with_detail("resource", "worksheets")
                .with_detail("required", tables.len().saturating_add(1))
                .with_detail("available", limits.max_worksheets));
            }
            let worksheet_ordinal = tables.len();
            tables.push(ExcelTableDescriptor {
                id: format!("sheet-{worksheet_ordinal}"),
                name: sheet.name.clone(),
                workbook_ordinal,
                visibility: match sheet.visible {
                    SheetVisible::Visible => ExcelSheetVisibility::Visible,
                    SheetVisible::Hidden => ExcelSheetVisibility::Hidden,
                    SheetVisible::VeryHidden => ExcelSheetVisibility::VeryHidden,
                },
            });
        } else {
            if warnings.len() < limits.max_warnings {
                warnings.push(ExcelWarning {
                    kind: ExcelWarningKind::SkippedSheet,
                    message: format!(
                        "sheet '{}' is a {} and is not exposed as a table",
                        sheet.name,
                        sheet_type_name(sheet.typ)
                    ),
                    table_id: None,
                    row: None,
                    column: None,
                });
            }
        }
    }
    Ok((tables, warnings))
}

fn sheet_type_name(sheet_type: SheetType) -> &'static str {
    match sheet_type {
        SheetType::WorkSheet => "worksheet",
        SheetType::DialogSheet => "dialog sheet",
        SheetType::MacroSheet => "macro sheet",
        SheetType::ChartSheet => "chart sheet",
        SheetType::Vba => "VBA module",
    }
}

fn sheet_shape(
    range: &Range<Data>,
    presentation_dimensions: Option<(u64, u64)>,
    limits: &ExcelLimits,
) -> Result<SheetShape> {
    let (mut rows, mut columns) = match range.end() {
        Some((row, column)) => (u64::from(row) + 1, u64::from(column) + 1),
        None => (0, 0),
    };
    if let Some((presentation_rows, presentation_columns)) = presentation_dimensions {
        rows = rows.max(presentation_rows);
        columns = columns.max(presentation_columns);
    }
    validate_sheet_shape(rows, columns, limits)
}

fn validate_sheet_shape(rows: u64, columns: u64, limits: &ExcelLimits) -> Result<SheetShape> {
    if rows > limits.max_worksheet_rows {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet exceeds the configured row limit",
        )
        .with_detail("resource", "worksheet-rows")
        .with_detail("required", rows)
        .with_detail("available", limits.max_worksheet_rows));
    }
    if columns > limits.max_worksheet_columns {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet exceeds the configured column limit",
        )
        .with_detail("resource", "worksheet-columns")
        .with_detail("required", columns)
        .with_detail("available", limits.max_worksheet_columns));
    }
    let cells = rows.checked_mul(columns).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet cell extent overflows",
        )
    })?;
    if cells > limits.max_worksheet_cells {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet exceeds the configured rectangular cell limit",
        )
        .with_detail("resource", "worksheet-cells")
        .with_detail("required", cells)
        .with_detail("available", limits.max_worksheet_cells));
    }
    Ok(SheetShape { rows, columns })
}

fn worksheet_reservation(shape: SheetShape) -> Result<WorksheetReservation> {
    let cells = usize::try_from(shape.rows.checked_mul(shape.columns).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet cell reservation overflows",
        )
    })?)
    .map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet cell reservation exceeds the supported integer range",
        )
    })?;
    // Calamine materializes dense Range<Data> and Range<String> values while
    // opening a sheet.  The formula range is temporary; the data range stays
    // attached to the table handle until close.
    let retained_bytes = cells
        .checked_mul(std::mem::size_of::<Data>())
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel worksheet data reservation overflows",
            )
        })?;
    let formula_bytes = cells
        .checked_mul(std::mem::size_of::<String>())
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel worksheet formula reservation overflows",
            )
        })?;
    let open_bytes = retained_bytes.checked_add(formula_bytes).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet open reservation overflows",
        )
    })?;
    Ok(WorksheetReservation {
        retained_bytes,
        open_bytes,
    })
}

fn worksheet_reservation_with_contents(
    shape: SheetShape,
    values: &Range<Data>,
    formulas: &Range<String>,
) -> Result<WorksheetReservation> {
    let reservation = worksheet_reservation(shape)?;
    // `size_of::<Data>()` and `size_of::<String>()` cover only the inline
    // vector slots. Calamine-owned strings allocate their UTF-8 payloads on
    // the heap, including one clone per shared-string cell. Count the actual
    // capacities before retaining the data range so repeated strings cannot
    // escape the global reservation ledger.
    let value_heap_bytes = values
        .used_cells()
        .try_fold(0_usize, |bytes, (_, _, value)| {
            let capacity = match value {
                Data::String(value) | Data::DateTimeIso(value) | Data::DurationIso(value) => {
                    value.capacity()
                }
                Data::Int(_)
                | Data::Float(_)
                | Data::Bool(_)
                | Data::DateTime(_)
                | Data::Error(_)
                | Data::Empty => 0,
            };
            bytes.checked_add(capacity).ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel worksheet value-string reservation overflows",
                )
            })
        })?;
    let formula_heap_bytes =
        formulas
            .used_cells()
            .try_fold(0_usize, |bytes, (_, _, formula)| {
                bytes.checked_add(formula.capacity()).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel worksheet formula-string reservation overflows",
                    )
                })
            })?;
    let retained_bytes = reservation
        .retained_bytes
        .checked_add(value_heap_bytes)
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel retained worksheet reservation overflows",
            )
        })?;
    let open_bytes = reservation
        .open_bytes
        .checked_add(value_heap_bytes)
        .and_then(|bytes| bytes.checked_add(formula_heap_bytes))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel worksheet open string reservation overflows",
            )
        })?;
    Ok(WorksheetReservation {
        retained_bytes,
        open_bytes,
    })
}

fn build_metadata(descriptor: &ExcelTableDescriptor, shape: SheetShape) -> Result<TableMetadata> {
    let column_capacity = usize::try_from(shape.columns).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel schema column count exceeds the supported integer range",
        )
    })?;
    let mut columns = Vec::with_capacity(column_capacity);
    for index in 0..shape.columns {
        columns.push(ColumnSchema::new(
            format!("c{index}"),
            excel_column_name(index)?,
            index,
            TableDataType::Utf8,
            true,
        )?);
    }
    Ok(TableMetadata::new(
        &descriptor.id,
        &descriptor.name,
        0,
        TableExtent::new(
            AxisExtent::exact(shape.rows)?,
            AxisExtent::exact(shape.columns)?,
        ),
        Schema::new(0, columns)?,
        Capabilities::spreadsheet(RandomAccess::Full),
    ))
}

fn excel_column_name(index: u64) -> Result<String> {
    let mut value = index.checked_add(1).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel column name index overflows",
        )
    })?;
    let mut reverse = Vec::new();
    while value > 0 {
        let remainder = (value - 1) % 26;
        reverse.push(b'A' + u8::try_from(remainder).expect("base-26 remainder fits u8"));
        value = (value - 1) / 26;
    }
    reverse.reverse();
    String::from_utf8(reverse).map_err(|_| {
        TabularkError::new(
            ErrorCode::RuntimeFailure,
            "failed to construct an Excel column name",
        )
    })
}

fn missing_formula_cache_warnings(
    descriptor: &ExcelTableDescriptor,
    values: &Range<Data>,
    formulas: &Range<String>,
    max_warnings: usize,
) -> Vec<ExcelWarning> {
    let mut warnings = Vec::new();
    let start = formulas.start().unwrap_or((0, 0));
    for (relative_row, relative_column, formula) in formulas.used_cells() {
        let Ok(relative_row) = u32::try_from(relative_row) else {
            continue;
        };
        let Ok(relative_column) = u32::try_from(relative_column) else {
            continue;
        };
        let Some(row) = start.0.checked_add(relative_row) else {
            continue;
        };
        let Some(column) = start.1.checked_add(relative_column) else {
            continue;
        };
        if formula.is_empty() || !is_empty_cell(values.get_value((row, column))) {
            continue;
        }
        warnings.push(ExcelWarning {
            kind: ExcelWarningKind::MissingFormulaCache,
            message: "formula has no cached result and is exposed as null".to_owned(),
            table_id: Some(descriptor.id.clone()),
            row: Some(u64::from(row)),
            column: Some(u64::from(column)),
        });
        if warnings.len() == max_warnings {
            break;
        }
    }
    warnings
}

fn is_empty_cell(value: Option<&Data>) -> bool {
    value.is_none_or(|value| matches!(value, Data::Empty))
}

fn validate_range_request(
    request: RangeRequest,
    shape: SheetShape,
    limits: &ExcelLimits,
) -> Result<()> {
    request.validate_public()?;
    let cells = request.cell_count()?;
    if cells > limits.max_range_cells {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel range exceeds the configured cell limit",
        )
        .with_detail("resource", "range-cells")
        .with_detail("required", cells)
        .with_detail("available", limits.max_range_cells));
    }
    let column_end = request.column_end()?;
    if column_end > shape.columns {
        return Err(TabularkError::new(
            ErrorCode::InvalidRange,
            "requested columns exceed the Excel worksheet schema",
        )
        .with_detail("schemaColumns", shape.columns));
    }
    Ok(())
}

fn display_string(value: &Data) -> Option<String> {
    match value {
        Data::Empty => None,
        Data::Int(value) => Some(value.to_string()),
        Data::Float(value) => Some(value.to_string()),
        Data::String(value) => Some(value.clone()),
        Data::Bool(value) => Some(if *value { "TRUE" } else { "FALSE" }.to_owned()),
        Data::DateTime(value) => Some(display_datetime(*value)),
        Data::DateTimeIso(value) | Data::DurationIso(value) => Some(value.clone()),
        Data::Error(value) => Some(value.to_string()),
    }
}

fn display_datetime(value: ExcelDateTime) -> String {
    if value.is_duration() {
        return value.as_f64().to_string();
    }
    let (year, month, day, hour, minute, second, millisecond) = value.to_ymd_hms_milli();
    if hour == 0 && minute == 0 && second == 0 && millisecond == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else if millisecond == 0 {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{millisecond:03}")
    }
}

struct StringColumnBuilder {
    column_id: String,
    data: Vec<u8>,
    offsets: Vec<u32>,
    validity: Vec<u8>,
    values: usize,
}

impl StringColumnBuilder {
    fn new(column_id: &str) -> Self {
        Self {
            column_id: column_id.to_owned(),
            data: Vec::new(),
            offsets: vec![0],
            validity: Vec::new(),
            values: 0,
        }
    }

    fn append(
        &mut self,
        value: Option<&str>,
        batch_bytes: &mut usize,
        max_batch_bytes: usize,
    ) -> Result<()> {
        let validity_growth = usize::from(self.values % 8 == 0);
        let value_bytes = value.map_or(0, str::len);
        let encoded_bytes = std::mem::size_of::<u32>()
            .checked_add(validity_growth)
            .and_then(|bytes| bytes.checked_add(value_bytes))
            .ok_or_else(|| batch_limit_error(max_batch_bytes))?;
        let required = batch_bytes
            .checked_add(encoded_bytes)
            .ok_or_else(|| batch_limit_error(max_batch_bytes))?;
        if required > max_batch_bytes {
            return Err(resource_limit(
                "batch",
                required,
                max_batch_bytes,
                "Excel range response exceeds the configured byte limit",
            ));
        }
        if self.validity.len() <= self.values / 8 {
            self.validity.push(0);
        }
        if let Some(value) = value {
            self.data.extend_from_slice(value.as_bytes());
            self.validity[self.values / 8] |= 1 << (self.values % 8);
        }
        self.offsets
            .push(u32::try_from(self.data.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "one Excel string column exceeds the u32 offset limit",
                )
            })?);
        self.values += 1;
        *batch_bytes = required;
        Ok(())
    }

    fn finish(self) -> Result<StringColumnBatch> {
        StringColumnBatch::new(self.column_id, self.data, self.offsets, self.validity)
    }
}

fn validate_biff8_container(
    bytes: &[u8],
    limits: &ExcelLimits,
    available_bytes: usize,
) -> Result<usize> {
    let mut compound = cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|error| {
        TabularkError::new(ErrorCode::ParseFailed, "invalid Excel compound file")
            .with_detail("reason", error.to_string())
    })?;
    let mut entry_count = 0_usize;
    let mut stream_bytes = 0_u64;
    let mut workbook_path: Option<PathBuf> = None;
    let mut encrypted = false;
    for entry in compound.walk() {
        entry_count = entry_count.checked_add(1).ok_or_else(|| {
            TabularkError::new(ErrorCode::ResourceLimit, "Excel CFB entry count overflows")
        })?;
        if entry_count > limits.max_cfb_entries {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel compound file exceeds the configured entry limit",
            )
            .with_detail("resource", "cfb-entries")
            .with_detail("required", entry_count)
            .with_detail("available", limits.max_cfb_entries));
        }
        if !entry.is_stream() {
            continue;
        }
        stream_bytes = stream_bytes.checked_add(entry.len()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel compound stream size total overflows",
            )
        })?;
        if stream_bytes > limits.max_cfb_stream_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel compound file exceeds the configured stream-byte limit",
            )
            .with_detail("resource", "cfb-stream-bytes")
            .with_detail("requiredBytes", stream_bytes)
            .with_detail("availableBytes", limits.max_cfb_stream_bytes));
        }
        let name = entry.name();
        if name.eq_ignore_ascii_case("EncryptionInfo")
            || name.eq_ignore_ascii_case("EncryptedPackage")
        {
            encrypted = true;
        }
        if workbook_path.is_none()
            && (name.eq_ignore_ascii_case("Workbook") || name.eq_ignore_ascii_case("Book"))
        {
            workbook_path = Some(entry.path().to_owned());
        }
    }
    if encrypted {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "encrypted Excel workbooks are not supported",
        ));
    }
    let stream_bytes = usize::try_from(stream_bytes).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel compound stream size exceeds the supported integer range",
        )
    })?;
    let reserved_bytes = checked_reservation_bytes(bytes.len(), stream_bytes, 0)?;
    ensure_reservation_budget(
        "xls-parse-working-set",
        reserved_bytes,
        available_bytes,
        "Excel XLS source and parse working set exceed the available memory budget",
    )?;
    let workbook_path = workbook_path.ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Excel compound file does not contain a Workbook stream",
        )
    })?;
    let mut workbook = compound.open_stream(workbook_path).map_err(|error| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "failed to open the Excel Workbook stream",
        )
        .with_detail("reason", error.to_string())
    })?;
    let mut bof = [0_u8; 8];
    workbook.read_exact(&mut bof).map_err(|error| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Excel Workbook stream has no complete BOF record",
        )
        .with_detail("reason", error.to_string())
    })?;
    let record_type = u16::from_le_bytes([bof[0], bof[1]]);
    let record_length = u16::from_le_bytes([bof[2], bof[3]]);
    if record_type != 0x0809 || record_length < 4 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "Excel Workbook stream does not begin with a valid BOF record",
        ));
    }
    let biff_version = u16::from_le_bytes([bof[4], bof[5]]);
    if biff_version != 0x0600 {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "only Excel 97-2003 BIFF8 XLS workbooks are supported",
        )
        .with_detail("biffVersion", format!("0x{biff_version:04X}")));
    }
    let mut workbook_bytes = Vec::new();
    workbook_bytes.extend_from_slice(&bof);
    workbook.read_to_end(&mut workbook_bytes).map_err(|error| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "failed to read the complete Excel Workbook stream for preflight",
        )
        .with_detail("reason", error.to_string())
    })?;
    let presentation_bytes = biff8_presentation_reservation(&workbook_bytes, limits)?;
    let reserved_bytes = checked_reservation_bytes(bytes.len(), stream_bytes, presentation_bytes)?;
    ensure_reservation_budget(
        "xls-presentation-working-set",
        reserved_bytes,
        available_bytes,
        "Excel XLS source, parse, and presentation working set exceed the available memory budget",
    )?;
    Ok(reserved_bytes)
}

#[derive(Default)]
struct Biff8PresentationCounts {
    global_style_records: usize,
    fonts: usize,
    number_formats: usize,
    xfs: usize,
    styled_cells: usize,
    layout_entries: usize,
    merged_cells: usize,
}

fn biff8_presentation_reservation(workbook: &[u8], limits: &ExcelLimits) -> Result<usize> {
    // These estimates intentionally exceed the current Rust struct sizes and
    // include HashMap / Vec bucket slack plus cloned strings.  The source and
    // complete Workbook stream are reserved separately by the caller.
    const BYTES_PER_GLOBAL_STYLE_RECORD: usize = 512;
    const BYTES_PER_STYLED_CELL: usize = 96;
    const BYTES_PER_LAYOUT_ENTRY: usize = 96;
    const BYTES_PER_MERGED_REGION: usize = 64;

    let mut counts = Biff8PresentationCounts::default();
    let mut position = 0_usize;
    let mut in_globals = true;
    let mut in_worksheet = false;
    let mut worksheet_styled_cells = 0_usize;
    let mut worksheet_rows = 0_usize;
    let mut worksheet_columns = 0_usize;
    let mut worksheet_merged_cells = 0_usize;

    while let Some((record, data, next)) = next_biff8_preflight_record(workbook, position)? {
        position = next;
        if record == 0x0809 && !in_globals {
            in_worksheet = u16_from_slice(data, 2) == Some(0x0010);
            worksheet_styled_cells = 0;
            worksheet_rows = 0;
            worksheet_columns = 0;
            worksheet_merged_cells = 0;
            continue;
        }
        if record == 0x000A {
            if in_globals {
                in_globals = false;
            } else {
                in_worksheet = false;
            }
            continue;
        }
        if in_globals {
            let style_kind = match record {
                0x0031 => Some(("fonts", &mut counts.fonts)),
                0x041E => Some(("number-formats", &mut counts.number_formats)),
                0x00E0 => Some(("styles", &mut counts.xfs)),
                _ => None,
            };
            if let Some((resource, kind_count)) = style_kind {
                *kind_count = kind_count.checked_add(1).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 style collection count overflows",
                    )
                })?;
                if *kind_count > limits.max_styles {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 workbook exceeds a configured style collection limit",
                    )
                    .with_detail("resource", resource)
                    .with_detail("required", *kind_count)
                    .with_detail("available", limits.max_styles));
                }
                counts.global_style_records =
                    counts.global_style_records.checked_add(1).ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "BIFF8 style record count overflows",
                        )
                    })?;
            }
            continue;
        }
        if !in_worksheet {
            continue;
        }

        let styled = biff8_styled_cells_in_record(record, data)?;
        worksheet_styled_cells = worksheet_styled_cells.checked_add(styled).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 styled-cell count overflows",
            )
        })?;
        if worksheet_styled_cells > limits.max_styled_cells {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 worksheet exceeds the configured styled-cell limit",
            )
            .with_detail("resource", "styled-cells")
            .with_detail("required", worksheet_styled_cells)
            .with_detail("available", limits.max_styled_cells));
        }
        counts.styled_cells = counts.styled_cells.checked_add(styled).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 aggregate styled-cell count overflows",
            )
        })?;

        match record {
            0x0208 if data.len() >= 16 => {
                worksheet_rows = worksheet_rows.checked_add(1).ok_or_else(|| {
                    TabularkError::new(ErrorCode::ResourceLimit, "BIFF8 row layout count overflows")
                })?;
                if worksheet_rows > limits.max_layout_entries {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 worksheet exceeds the configured row-layout limit",
                    )
                    .with_detail("resource", "row-layout-entries")
                    .with_detail("required", worksheet_rows)
                    .with_detail("available", limits.max_layout_entries));
                }
                counts.layout_entries = counts.layout_entries.checked_add(1).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 aggregate layout count overflows",
                    )
                })?;
            }
            0x007D if data.len() >= 10 => {
                let first = usize::from(u16_from_slice(data, 0).unwrap_or(0));
                let last = usize::from(u16_from_slice(data, 2).unwrap_or(0));
                if last < first {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 column layout has an inverted range",
                    ));
                }
                let columns = last - first + 1;
                worksheet_columns = worksheet_columns.checked_add(columns).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 column layout count overflows",
                    )
                })?;
                if worksheet_columns > limits.max_layout_entries {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 worksheet exceeds the configured column-layout limit",
                    )
                    .with_detail("resource", "column-layout-entries")
                    .with_detail("required", worksheet_columns)
                    .with_detail("available", limits.max_layout_entries));
                }
                counts.layout_entries =
                    counts.layout_entries.checked_add(columns).ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "BIFF8 aggregate layout count overflows",
                        )
                    })?;
            }
            0x00E5 if data.len() >= 2 => {
                let declared = usize::from(u16_from_slice(data, 0).unwrap_or(0));
                let available = (data.len() - 2) / 8;
                if declared > available {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 merged-cell record contains fewer regions than declared",
                    ));
                }
                worksheet_merged_cells =
                    worksheet_merged_cells
                        .checked_add(declared)
                        .ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "BIFF8 merged-cell count overflows",
                            )
                        })?;
                if worksheet_merged_cells > limits.max_merged_cells {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 worksheet exceeds the configured merged-cell limit",
                    )
                    .with_detail("resource", "merged-cells")
                    .with_detail("required", worksheet_merged_cells)
                    .with_detail("available", limits.max_merged_cells));
                }
                counts.merged_cells =
                    counts.merged_cells.checked_add(declared).ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "BIFF8 aggregate merged-cell count overflows",
                        )
                    })?;
            }
            _ => {}
        }
    }

    counts
        .global_style_records
        .checked_mul(BYTES_PER_GLOBAL_STYLE_RECORD)
        .and_then(|value| {
            counts
                .styled_cells
                .checked_mul(BYTES_PER_STYLED_CELL)
                .and_then(|bytes| value.checked_add(bytes))
        })
        .and_then(|value| {
            counts
                .layout_entries
                .checked_mul(BYTES_PER_LAYOUT_ENTRY)
                .and_then(|bytes| value.checked_add(bytes))
        })
        .and_then(|value| {
            counts
                .merged_cells
                .checked_mul(BYTES_PER_MERGED_REGION)
                .and_then(|bytes| value.checked_add(bytes))
        })
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 presentation memory reservation overflows",
            )
        })
}

fn biff8_styled_cells_in_record(record: u16, data: &[u8]) -> Result<usize> {
    if matches!(
        record,
        0x0006 | 0x0201 | 0x0203 | 0x0204 | 0x0205 | 0x027E | 0x00D6 | 0x00FD
    ) && data.len() >= 6
    {
        return Ok(1);
    }
    if !matches!(record, 0x00BD | 0x00BE) || data.len() < 6 {
        return Ok(0);
    }
    let first = usize::from(u16_from_slice(data, 2).unwrap_or(0));
    let last = usize::from(u16_from_slice(data, data.len().saturating_sub(2)).unwrap_or(0));
    if last < first {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 multi-cell record has an inverted column range",
        ));
    }
    let declared = last - first + 1;
    let item_width = if record == 0x00BD { 6 } else { 2 };
    let available = (data.len() - 6) / item_width;
    if declared > available {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 multi-cell record contains fewer styles than declared",
        ));
    }
    Ok(declared)
}

fn next_biff8_preflight_record(
    data: &[u8],
    position: usize,
) -> Result<Option<(u16, &[u8], usize)>> {
    if position == data.len() {
        return Ok(None);
    }
    let header_end = position.checked_add(4).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 preflight record header offset overflows",
        )
    })?;
    if header_end > data.len() {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 Workbook stream ends in a truncated record header",
        ));
    }
    let record = u16_from_slice(data, position).unwrap_or(0);
    let length = usize::from(u16_from_slice(data, position + 2).unwrap_or(0));
    let end = header_end.checked_add(length).ok_or_else(|| {
        TabularkError::new(ErrorCode::ParseFailed, "BIFF8 record length overflows")
    })?;
    if end > data.len() {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 Workbook stream ends in a truncated record",
        ));
    }
    Ok(Some((record, &data[header_end..end], end)))
}

fn u16_from_slice(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn validate_xlsx_container(
    bytes: &[u8],
    limits: &ExcelLimits,
    available_bytes: usize,
) -> Result<usize> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| {
        TabularkError::new(ErrorCode::ParseFailed, "invalid XLSX ZIP container")
            .with_detail("reason", error.to_string())
    })?;
    if archive.len() > limits.max_zip_entries {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX archive exceeds the configured entry limit",
        )
        .with_detail("resource", "zip-entries")
        .with_detail("required", archive.len())
        .with_detail("available", limits.max_zip_entries));
    }

    // The first pass uses central-directory declarations only.  Reject the
    // complete source + expansion peak before reading any compressed entry.
    let mut total_uncompressed = 0_u64;
    let mut has_workbook_xml = false;
    let mut has_workbook_bin = false;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "failed to inspect an XLSX ZIP entry",
            )
            .with_detail("reason", error.to_string())
        })?;
        if file.enclosed_name().is_none() {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX archive contains an unsafe entry path",
            ));
        }
        if file.encrypted() {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "encrypted Excel workbooks are not supported",
            ));
        }
        if file.size() > limits.max_zip_entry_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX archive entry exceeds the configured uncompressed-byte limit",
            )
            .with_detail("resource", "zip-entry-bytes")
            .with_detail("entry", file.name())
            .with_detail("requiredBytes", file.size())
            .with_detail("availableBytes", limits.max_zip_entry_bytes));
        }
        total_uncompressed = total_uncompressed.checked_add(file.size()).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX aggregate uncompressed size overflows",
            )
        })?;
        if total_uncompressed > limits.max_zip_uncompressed_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX archive exceeds the configured aggregate uncompressed-byte limit",
            )
            .with_detail("resource", "zip-uncompressed-bytes")
            .with_detail("requiredBytes", total_uncompressed)
            .with_detail("availableBytes", limits.max_zip_uncompressed_bytes));
        }

        let name = file.name().replace('\\', "/");
        has_workbook_xml |= name.eq_ignore_ascii_case("xl/workbook.xml");
        has_workbook_bin |= name.eq_ignore_ascii_case("xl/workbook.bin");
    }

    let total_uncompressed = usize::try_from(total_uncompressed).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX aggregate uncompressed size exceeds the supported integer range",
        )
    })?;
    let base_reservation = checked_reservation_bytes(bytes.len(), total_uncompressed, 0)?;
    ensure_reservation_budget(
        "xlsx-decompression-working-set",
        base_reservation,
        available_bytes,
        "Excel XLSX source and decompression working set exceed the available memory budget",
    )?;

    // Only after the complete declared expansion fits do we decompress the
    // bounded XML entries needed for format/security validation.  Count both
    // declared and actual shared-string slots because Calamine reserves from
    // uniqueCount before parsing any <si> values.
    let mut content_types: Option<Vec<u8>> = None;
    let mut ods_mimetype = false;
    let mut shared_string_slots = 0_usize;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "failed to inspect an XLSX ZIP entry",
            )
            .with_detail("reason", error.to_string())
        })?;
        let name = file.name().replace('\\', "/");
        let normalized_name = name.to_ascii_lowercase();
        let should_scan_xml =
            normalized_name.ends_with(".xml") || normalized_name.ends_with(".rels");
        let should_read = should_scan_xml
            || name.eq_ignore_ascii_case("[Content_Types].xml")
            || name.eq_ignore_ascii_case("mimetype");
        if !should_read {
            continue;
        }
        let capacity = usize::try_from(file.size()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX entry length exceeds the supported integer range",
            )
        })?;
        let mut contents = Vec::with_capacity(capacity);
        file.read_to_end(&mut contents).map_err(|error| {
            TabularkError::new(ErrorCode::ParseFailed, "failed to read an XLSX ZIP entry")
                .with_detail("entry", name.as_str())
                .with_detail("reason", error.to_string())
        })?;
        if should_scan_xml
            && (contains_ascii_case_insensitive(&contents, b"<!DOCTYPE")
                || contains_ascii_case_insensitive(&contents, b"<!ENTITY"))
        {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "XLSX XML document type declarations and external entities are not supported",
            )
            .with_detail("entry", name));
        }
        if name.eq_ignore_ascii_case("[Content_Types].xml") {
            content_types = Some(contents);
        } else if name.eq_ignore_ascii_case("xl/sharedStrings.xml") {
            shared_string_slots = shared_string_slots.max(parse_shared_string_slots(&contents)?);
            let shared_string_bytes = shared_string_slots
                .checked_mul(std::mem::size_of::<String>())
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "XLSX shared-string allocation estimate overflows",
                    )
                })?;
            let reservation =
                checked_reservation_bytes(bytes.len(), total_uncompressed, shared_string_bytes)?;
            ensure_reservation_budget(
                "xlsx-shared-strings",
                reservation,
                available_bytes,
                "Excel XLSX shared strings exceed the available memory budget",
            )?;
        } else if name.eq_ignore_ascii_case("mimetype")
            && contains_ascii_case_insensitive(
                &contents,
                b"application/vnd.oasis.opendocument.spreadsheet",
            )
        {
            ods_mimetype = true;
        }
    }

    if ods_mimetype {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "OpenDocument spreadsheets are not supported by the Excel adapter",
        ));
    }
    if has_workbook_bin {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "XLSB workbooks are not supported",
        ));
    }
    let content_types = content_types.ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "OOXML workbook is missing [Content_Types].xml",
        )
    })?;
    if contains_ascii_case_insensitive(&content_types, b"macroEnabled") {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "macro-enabled OOXML workbooks are not supported",
        ));
    }
    if !has_workbook_xml
        || !contains_ascii_case_insensitive(&content_types, XLSX_WORKBOOK_CONTENT_TYPE)
    {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "ZIP source is not an XLSX SpreadsheetML workbook",
        ));
    }
    let shared_string_bytes = shared_string_slots
        .checked_mul(std::mem::size_of::<String>())
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX shared-string allocation estimate overflows",
            )
        })?;
    let reserved_bytes =
        checked_reservation_bytes(bytes.len(), total_uncompressed, shared_string_bytes)?;
    ensure_reservation_budget(
        "xlsx-parse-working-set",
        reserved_bytes,
        available_bytes,
        "Excel XLSX source and parse working set exceed the available memory budget",
    )?;
    Ok(reserved_bytes)
}

fn parse_shared_string_slots(xml: &[u8]) -> Result<usize> {
    let mut reader = XmlReader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut declared = 0_usize;
    let mut actual = 0_usize;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(XmlEvent::Start(event)) | Ok(XmlEvent::Empty(event)) => {
                match xml_local_name(event.name().as_ref()) {
                    b"sst" => {
                        declared =
                            declared.max(shared_string_unique_count(&event, reader.decoder())?);
                    }
                    b"si" => {
                        actual = actual.checked_add(1).ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "XLSX shared-string count overflows",
                            )
                        })?;
                    }
                    _ => {}
                }
            }
            Ok(XmlEvent::DocType(_)) => {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX XML document type declarations are not supported",
                ));
            }
            Ok(XmlEvent::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "invalid XLSX shared strings XML",
                )
                .with_detail("reason", error.to_string()));
            }
        }
        buffer.clear();
    }
    Ok(declared.max(actual))
}

fn shared_string_unique_count(
    event: &XmlBytesStart<'_>,
    decoder: quick_xml::encoding::Decoder,
) -> Result<usize> {
    for attribute in event.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "invalid XLSX shared-string attribute",
            )
            .with_detail("reason", error.to_string())
        })?;
        if xml_local_name(attribute.key.as_ref()) != b"uniqueCount" {
            continue;
        }
        let value = attribute
            .decode_and_unescape_value(decoder)
            .map_err(|error| {
                TabularkError::new(ErrorCode::ParseFailed, "invalid XLSX shared-string count")
                    .with_detail("reason", error.to_string())
            })?;
        return value.parse::<usize>().map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX shared-string count exceeds the supported integer range",
            )
            .with_detail("resource", "xlsx-shared-strings")
        });
    }
    Ok(0)
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn checked_reservation_bytes(
    source_bytes: usize,
    parse_bytes: usize,
    additional_bytes: usize,
) -> Result<usize> {
    source_bytes
        .checked_add(parse_bytes)
        .and_then(|bytes| bytes.checked_add(additional_bytes))
        .ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel memory reservation estimate overflows",
            )
        })
}

fn ensure_reservation_budget(
    resource: &str,
    required_bytes: usize,
    available_bytes: usize,
    message: &str,
) -> Result<()> {
    if required_bytes > available_bytes {
        return Err(resource_limit(
            resource,
            required_bytes,
            available_bytes,
            message,
        ));
    }
    Ok(())
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn ensure_format_hint(hint: ExcelFormatHint, actual: ExcelFormat) -> Result<()> {
    let matches = match hint {
        ExcelFormatHint::Auto => true,
        ExcelFormatHint::Xls => actual == ExcelFormat::Xls,
        ExcelFormatHint::Xlsx => actual == ExcelFormat::Xlsx,
    };
    if matches {
        return Ok(());
    }
    Err(TabularkError::new(
        ErrorCode::InvalidArgument,
        "Excel format option does not match the detected source signature",
    )
    .with_detail("requestedFormat", format_hint_name(hint))
    .with_detail("detectedFormat", format_name(actual)))
}

fn format_hint_name(hint: ExcelFormatHint) -> &'static str {
    match hint {
        ExcelFormatHint::Auto => "auto",
        ExcelFormatHint::Xls => "xls",
        ExcelFormatHint::Xlsx => "xlsx",
    }
}

fn format_name(format: ExcelFormat) -> &'static str {
    match format {
        ExcelFormat::Xls => "xls",
        ExcelFormat::Xlsx => "xlsx",
    }
}

fn workbook_open_error(format: ExcelFormat, error: impl Display) -> TabularkError {
    let reason = error.to_string();
    if contains_ascii_case_insensitive(reason.as_bytes(), b"password")
        || contains_ascii_case_insensitive(reason.as_bytes(), b"encrypt")
    {
        return TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "encrypted Excel workbooks are not supported",
        );
    }
    TabularkError::new(
        ErrorCode::ParseFailed,
        format!("failed to parse {} workbook", format_name(format)),
    )
    .with_detail("reason", reason)
}

fn worksheet_error(format: ExcelFormat, name: &str, error: impl Display) -> TabularkError {
    TabularkError::new(
        ErrorCode::ParseFailed,
        format!("failed to read {} worksheet", format_name(format)),
    )
    .with_detail("worksheet", name)
    .with_detail("reason", error.to_string())
}

fn closed_handle(kind: &str) -> TabularkError {
    TabularkError::new(
        ErrorCode::HandleClosed,
        format!("Excel {kind} handle is closed"),
    )
}

fn batch_limit_error(available: usize) -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "Excel range response exceeds the configured byte limit",
    )
    .with_detail("resource", "batch")
    .with_detail("requiredBytes", available.saturating_add(1))
    .with_detail("availableBytes", available)
}

fn resource_limit(
    resource: &str,
    required: usize,
    available: usize,
    message: &str,
) -> TabularkError {
    TabularkError::new(ErrorCode::ResourceLimit, message)
        .with_detail("resource", resource)
        .with_detail("requiredBytes", required)
        .with_detail("availableBytes", available)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use calamine::{Cell, Data, ExcelDateTime, ExcelDateTimeType, Range};
    use cfb::Version;
    use tabulark::ErrorCode;
    use tabulark::model::{RangeRequest, StringColumnBatch};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::{
        ExcelContainer, ExcelFormat, ExcelFormatHint, ExcelLimits, ExcelOptions, ExcelRuntime,
        ExcelRuntimeConfig, ExcelSheetVisibility, ExcelWarningKind, SheetShape,
        detect_excel_format, display_datetime, inspect_excel_source, recognize_excel_container,
        worksheet_reservation, worksheet_reservation_with_contents,
    };

    #[test]
    fn recognizes_signatures_without_consulting_a_filename() {
        let xlsx = fixture_xlsx(false);
        assert_eq!(
            recognize_excel_container(&xlsx).expect("ZIP signature"),
            ExcelContainer::Zip
        );
        assert_eq!(detect_excel_format(&xlsx).expect("XLSX"), ExcelFormat::Xlsx);

        let xls = fixture_xls();
        assert_eq!(
            recognize_excel_container(&xls).expect("CFB signature"),
            ExcelContainer::CompoundFile
        );
        assert_eq!(
            detect_excel_format(&xls).expect("XLS BIFF8"),
            ExcelFormat::Xls
        );
    }

    #[test]
    fn exposes_worksheets_in_order_and_preserves_visibility() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(
                fixture_xlsx(false),
                ExcelOptions {
                    format: ExcelFormatHint::Auto,
                    source_name: Some("misleading.xls".to_owned()),
                },
            )
            .expect("open XLSX");

        assert_eq!(
            runtime.source_format(source).expect("format"),
            ExcelFormat::Xlsx
        );
        assert_eq!(
            runtime.source_name(source).expect("name"),
            Some("misleading.xls")
        );
        let tables = runtime.list_tables(source).expect("tables");
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].id(), "sheet-0");
        assert_eq!(tables[0].name(), "Visible");
        assert_eq!(tables[0].visibility(), ExcelSheetVisibility::Visible);
        assert_eq!(tables[1].id(), "sheet-1");
        assert_eq!(tables[1].name(), "Hidden");
        assert_eq!(tables[1].visibility(), ExcelSheetVisibility::Hidden);
    }

    #[test]
    fn first_row_is_data_and_batches_are_display_strings() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(fixture_xlsx(false), ExcelOptions::default())
            .expect("open XLSX");
        let opened = runtime.open_table(source, "sheet-0").expect("open table");
        let metadata = &opened.metadata;
        assert_eq!(metadata.extent().rows().value(), Some(3));
        assert_eq!(metadata.extent().columns().value(), Some(3));
        assert!(!metadata.capabilities().typed_values());
        assert!(metadata.capabilities().multi_table());
        assert_eq!(
            metadata
                .schema()
                .columns()
                .iter()
                .map(|column| column.name())
                .collect::<Vec<_>>(),
            ["A", "B", "C"]
        );
        assert_eq!(opened.warnings.len(), 1);
        assert_eq!(
            opened.warnings[0].kind(),
            ExcelWarningKind::MissingFormulaCache
        );
        assert_eq!(opened.warnings[0].row(), Some(2));
        assert_eq!(opened.warnings[0].column(), Some(2));

        let batch = runtime
            .read_range(
                opened.table_handle,
                RangeRequest::new(0, 4, 0, 3).expect("range"),
            )
            .expect("read range");
        assert_eq!(batch.range().row_count(), 3);
        assert!(!batch.complete());
        assert_eq!(
            decode_column(&batch.columns()[0]),
            vec![Some("Name"), Some("Ada"), None]
        );
        assert_eq!(
            decode_column(&batch.columns()[1]),
            vec![Some("Count"), Some("42"), Some("#DIV/0!")]
        );
        assert_eq!(
            decode_column(&batch.columns()[2]),
            vec![Some("Active"), Some("TRUE"), None]
        );
    }

    #[test]
    fn supports_biff8_xls_through_the_same_table_contract() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(fixture_xls(), ExcelOptions::default())
            .expect("open XLS");
        let opened = runtime.open_table(source, "sheet-0").expect("open table");
        let batch = runtime
            .read_range(
                opened.table_handle,
                RangeRequest::new(0, 1, 0, 1).expect("range"),
            )
            .expect("read XLS");
        assert_eq!(decode_column(&batch.columns()[0]), vec![Some("Xls")]);

        let presentation = runtime
            .presentation(opened.table_handle)
            .expect("BIFF8 presentation");
        assert_eq!(presentation.frozen_rows, 1);
        assert_eq!(presentation.frozen_columns, 1);
        assert_eq!(presentation.rows.len(), 1);
        assert_eq!(presentation.rows[0].index, 0);
        assert_eq!(presentation.rows[0].hidden, Some(true));
        assert_eq!(presentation.columns.len(), 1);
        assert_eq!(presentation.columns[0].index, 0);
        let range = runtime
            .read_presentation_range(
                opened.table_handle,
                RangeRequest::new(0, 1, 0, 1).expect("presentation range"),
            )
            .expect("BIFF8 presentation range");
        assert_eq!(range.merged_cells.len(), 1);
        assert_eq!(range.merged_cells[0].row_start, 0);
        assert_eq!(range.merged_cells[0].column_end, 2);
        assert_eq!(presentation.styles.len(), 1);
        let style = &presentation.styles[0];
        assert_eq!(style.number_format.as_deref(), Some("0.000"));
        assert_eq!(style.horizontal_alignment.as_deref(), Some("center"));
        assert_eq!(style.vertical_alignment.as_deref(), Some("top"));
        assert_eq!(style.wrap_text, Some(true));
        let font = style.font.as_ref().expect("BIFF8 font");
        assert_eq!(font.family.as_deref(), Some("Aptos"));
        assert_eq!(font.size, Some(12.0));
        assert_eq!(font.bold, Some(true));
        assert_eq!(font.italic, Some(true));
        assert_eq!(font.underline, Some(true));
        assert_eq!(
            font.color.as_ref().and_then(|color| color.css.as_deref()),
            Some("#112233")
        );
        assert_eq!(
            style
                .fill_color
                .as_ref()
                .and_then(|color| color.css.as_deref()),
            Some("#FFCC00")
        );
        assert_eq!(
            style
                .borders
                .as_ref()
                .and_then(|borders| borders.left.as_ref())
                .and_then(|side| side.style.as_deref()),
            Some("thin")
        );
        assert_eq!(
            style
                .borders
                .as_ref()
                .and_then(|borders| borders.left.as_ref())
                .and_then(|side| side.color.as_ref())
                .and_then(|color| color.css.as_deref()),
            Some("#445566")
        );
        assert_eq!(range.style_ids[0][0], Some(0));
    }

    #[test]
    fn pinned_biff8_fixture_preserves_indexed_static_style() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(
                include_bytes!("../../../test/fixtures/excel/v1/tabulark-biff8.xls").to_vec(),
                ExcelOptions::default(),
            )
            .expect("open pinned BIFF8 fixture");
        let opened = runtime.open_table(source, "sheet-0").expect("open table");
        let presentation = runtime
            .presentation(opened.table_handle)
            .expect("BIFF8 presentation");
        assert_eq!(presentation.styles.len(), 1);
        let style = &presentation.styles[0];
        assert_eq!(style.number_format.as_deref(), Some("0.000"));
        assert_eq!(
            style
                .fill_color
                .as_ref()
                .and_then(|color| color.css.as_deref()),
            Some("#FFCC00")
        );
        assert_eq!(
            style
                .font
                .as_ref()
                .and_then(|font| font.color.as_ref())
                .and_then(|color| color.css.as_deref()),
            Some("#112233")
        );
        let range = runtime
            .read_presentation_range(
                opened.table_handle,
                RangeRequest::new(0, 1, 0, 1).expect("range"),
            )
            .expect("style range");
        assert_eq!(range.style_ids, vec![vec![Some(0)]]);
    }

    #[test]
    fn preserves_xlsx_layout_merges_and_deduplicated_static_styles() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(fixture_xlsx(false), ExcelOptions::default())
            .expect("open XLSX");
        let opened = runtime.open_table(source, "sheet-0").expect("open table");
        let presentation = runtime
            .presentation(opened.table_handle)
            .expect("XLSX presentation");

        assert_eq!(presentation.frozen_rows, 1);
        assert_eq!(presentation.frozen_columns, 1);
        assert_eq!(presentation.rows.len(), 1);
        assert_eq!(presentation.rows[0].index, 1);
        assert_eq!(presentation.rows[0].hidden, Some(true));
        assert_eq!(presentation.rows[0].size, Some(32.0));
        assert_eq!(presentation.columns.len(), 1);
        assert_eq!(presentation.columns[0].index, 1);
        assert_eq!(presentation.columns[0].hidden, Some(true));
        assert_eq!(
            presentation.styles.len(),
            1,
            "duplicate xfs are deduplicated"
        );
        let style = &presentation.styles[0];
        assert_eq!(style.number_format.as_deref(), Some("0.000"));
        assert_eq!(style.horizontal_alignment.as_deref(), Some("center"));
        assert_eq!(style.vertical_alignment.as_deref(), Some("top"));
        assert_eq!(style.wrap_text, Some(true));
        let font = style.font.as_ref().expect("font");
        assert_eq!(font.family.as_deref(), Some("Aptos"));
        assert_eq!(font.bold, Some(true));
        assert_eq!(
            font.color.as_ref().and_then(|color| color.css.as_deref()),
            Some("#112233")
        );
        assert_eq!(
            style
                .fill_color
                .as_ref()
                .and_then(|color| color.css.as_deref()),
            Some("#FFCC00")
        );
        assert_eq!(
            style
                .borders
                .as_ref()
                .and_then(|borders| borders.left.as_ref())
                .and_then(|side| side.style.as_deref()),
            Some("thin")
        );

        let range = runtime
            .read_presentation_range(
                opened.table_handle,
                RangeRequest::new(0, 3, 0, 3).expect("presentation range"),
            )
            .expect("XLSX presentation range");
        assert_eq!(range.style_ids[1][1], Some(0));
        assert_eq!(range.style_ids[2][1], Some(0));
        assert_eq!(range.rows.len(), 1);
        assert_eq!(range.columns.len(), 1);
        assert_eq!(range.merged_cells.len(), 1);
        assert_eq!(range.merged_cells[0].row_start, 1);
        assert_eq!(range.merged_cells[0].row_end, 3);
        assert_eq!(range.merged_cells[0].column_start, 0);
        assert_eq!(range.merged_cells[0].column_end, 1);
    }

    #[test]
    fn format_hint_is_a_constraint_not_a_detection_mechanism() {
        let mut runtime = ExcelRuntime::default();
        let error = runtime
            .open_source(
                fixture_xlsx(false),
                ExcelOptions {
                    format: ExcelFormatHint::Xls,
                    source_name: Some("really.xls".to_owned()),
                },
            )
            .expect_err("mismatched hint");
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(error.details()["detectedFormat"], "xlsx");
    }

    #[test]
    fn rejects_macro_enabled_ooxml_structurally() {
        let error = detect_excel_format(&fixture_xlsx(true)).expect_err("XLSM unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
    }

    #[test]
    fn rejects_xlsb_ods_unsafe_zip_paths_and_xml_entities_structurally() {
        let xlsb = fixture_zip(&[
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
            ),
            ("xl/workbook.bin", "binary workbook placeholder"),
        ]);
        let error = detect_excel_format(&xlsb).expect_err("XLSB unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);

        let ods = fixture_zip(&[("mimetype", "application/vnd.oasis.opendocument.spreadsheet")]);
        let error = detect_excel_format(&ods).expect_err("ODS unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);

        let unsafe_path = fixture_zip(&[("../xl/workbook.xml", "<workbook/>")]);
        let error = detect_excel_format(&unsafe_path).expect_err("unsafe ZIP path");
        assert_eq!(error.code(), ErrorCode::ParseFailed);

        let entity = fixture_zip(&[
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<!DOCTYPE workbook [<!ENTITY external SYSTEM "file:///etc/passwd">]><workbook>&external;</workbook>"#,
            ),
        ]);
        let error = detect_excel_format(&entity).expect_err("XML entities unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
    }

    #[test]
    fn rejects_pre_biff8_and_encrypted_compound_workbooks() {
        let earlier_biff =
            fixture_cfb(&[("/Workbook", biff_record(0x0809, &[0x00, 0x05, 0x05, 0x00]))]);
        let error = detect_excel_format(&earlier_biff).expect_err("BIFF5 unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
        assert_eq!(error.details()["biffVersion"], "0x0500");

        let encrypted = fixture_cfb(&[
            ("/EncryptionInfo", vec![1, 2, 3, 4]),
            ("/EncryptedPackage", vec![5, 6, 7, 8]),
        ]);
        let error = detect_excel_format(&encrypted).expect_err("encrypted workbook unsupported");
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
    }

    #[test]
    fn formats_both_excel_date_epochs_without_timezone_conversion() {
        let serial = 43_831.0;
        assert_eq!(
            display_datetime(ExcelDateTime::new(
                serial,
                ExcelDateTimeType::DateTime,
                false,
            )),
            "2020-01-01"
        );
        assert_eq!(
            display_datetime(ExcelDateTime::new(
                serial,
                ExcelDateTimeType::DateTime,
                true,
            )),
            "2024-01-02"
        );
    }

    #[test]
    fn rejects_declared_zip_expansion_before_opening_the_workbook() {
        let fixture = fixture_xlsx(false);
        let memory_budget_bytes = fixture.len().saturating_add(1);
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes,
            limits: ExcelLimits {
                max_source_bytes: fixture.len(),
                ..ExcelLimits::default()
            },
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("declared expansion must fit before decompression");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(
            error.details()["resource"],
            "xlsx-decompression-working-set"
        );
        assert!(error.details()["requiredBytes"].is_number());
        assert_eq!(error.details()["availableBytes"], memory_budget_bytes);
        assert_eq!(runtime.source_count(), 0);
    }

    #[test]
    fn rejects_hostile_shared_string_reservation_before_calamine() {
        let fixture = fixture_xlsx_with_shared_string_count("1000000000");
        let memory_budget_bytes = 1024 * 1024;
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes,
            limits: ExcelLimits {
                max_source_bytes: fixture.len(),
                ..ExcelLimits::default()
            },
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("shared-string capacity hint must be preflighted");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "xlsx-shared-strings");
        assert!(error.details()["requiredBytes"].is_number());
        assert_eq!(error.details()["availableBytes"], memory_budget_bytes);
        assert_eq!(runtime.source_count(), 0);
    }

    #[test]
    fn preflights_biff8_style_limits_before_opening_the_workbook() {
        let fixture = fixture_xls();
        let limits = ExcelLimits {
            max_source_bytes: fixture.len(),
            max_styles: 1,
            ..ExcelLimits::default()
        };
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            limits,
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("the second BIFF8 XF must exceed the configured style limit");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "styles");
        assert_eq!(error.details()["required"], 2);
        assert_eq!(error.details()["available"], 1);
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn reserves_biff8_presentation_memory_before_parsing_styles() {
        let fixture = fixture_xls();
        let limits = ExcelLimits {
            max_source_bytes: fixture.len(),
            ..ExcelLimits::default()
        };
        let reservation = inspect_excel_source(&fixture, &limits, usize::MAX)
            .expect("BIFF8 inspection")
            .reserved_bytes;
        assert!(reservation > fixture.len());
        let memory_budget_bytes = reservation.saturating_sub(1);
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes,
            limits,
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("BIFF8 presentation peak must fit before style parsing");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "xls-presentation-working-set");
        assert_eq!(error.details()["requiredBytes"], reservation);
        assert_eq!(error.details()["availableBytes"], memory_budget_bytes);
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn enforces_staging_budget_before_registering_a_source() {
        let fixture = fixture_xlsx(false);
        let limits = ExcelLimits {
            max_source_bytes: fixture.len(),
            ..ExcelLimits::default()
        };
        let reservation = measured_source_reservation(&fixture, &limits);
        let config = ExcelRuntimeConfig {
            memory_budget_bytes: reservation,
            limits,
            ..ExcelRuntimeConfig::default()
        };
        let mut runtime = ExcelRuntime::new(config).expect("runtime");
        let source = runtime
            .open_source(fixture.clone(), ExcelOptions::default())
            .expect("first source");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("second source exceeds aggregate budget");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(
            error.details()["resource"],
            "xlsx-decompression-working-set"
        );
        assert_eq!(runtime.source_count(), 1);
        assert!(runtime.close_source(source));
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn reserves_retained_xlsx_presentation_collections_before_source_registration() {
        let fixture = fixture_xlsx(false);
        let limits = ExcelLimits {
            max_source_bytes: fixture.len(),
            ..ExcelLimits::default()
        };
        let inspection_reservation = inspect_excel_source(&fixture, &limits, usize::MAX)
            .expect("source inspection")
            .reserved_bytes;
        let full_reservation = measured_source_reservation(&fixture, &limits);
        assert!(full_reservation > inspection_reservation);
        let memory_budget_bytes = full_reservation.saturating_sub(1);
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes,
            limits,
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("retained XLSX presentation must fit before source registration");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "xlsx-presentation-working-set");
        assert_eq!(error.details()["requiredBytes"], full_reservation);
        assert_eq!(error.details()["availableBytes"], memory_budget_bytes);
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn reserves_worksheet_parse_memory_before_calamine_dense_ranges() {
        let fixture = fixture_xlsx(false);
        let limits = ExcelLimits {
            max_source_bytes: fixture.len(),
            ..ExcelLimits::default()
        };
        let source_reservation = measured_source_reservation(&fixture, &limits);
        let sheet_reservation = worksheet_reservation(SheetShape {
            rows: 3,
            columns: 3,
        })
        .expect("sheet reservation");
        let memory_budget_bytes = source_reservation
            .checked_add(sheet_reservation.open_bytes)
            .expect("budget")
            .saturating_sub(1);
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes,
            limits,
            ..ExcelRuntimeConfig::default()
        })
        .expect("runtime");
        let source = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect("source");
        let retained_before = runtime.retained_bytes();
        let error = runtime
            .open_table(source, "sheet-0")
            .expect_err("worksheet parse peak must be reserved first");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "worksheet-open-working-set");
        assert_eq!(runtime.retained_bytes(), retained_before);
        assert_eq!(runtime.table_count(), 0);
    }

    #[test]
    fn accounts_for_calamine_value_and_formula_string_heaps() {
        let mut value = String::with_capacity(4_096);
        value.push('x');
        let value_capacity = value.capacity();
        let mut formula = String::with_capacity(2_048);
        formula.push_str("A1");
        let formula_capacity = formula.capacity();
        let values = Range::from_sparse(vec![Cell::new((0, 0), Data::String(value))]);
        let formulas = Range::from_sparse(vec![Cell::new((0, 0), formula)]);
        let shape = SheetShape {
            rows: 1,
            columns: 1,
        };
        let base = worksheet_reservation(shape).expect("base reservation");
        let actual = worksheet_reservation_with_contents(shape, &values, &formulas)
            .expect("content-aware reservation");
        assert_eq!(actual.retained_bytes, base.retained_bytes + value_capacity);
        assert_eq!(
            actual.open_bytes,
            base.open_bytes + value_capacity + formula_capacity
        );
    }

    #[test]
    fn rejects_sparse_but_rectangularly_enormous_worksheet_before_calamine() {
        let fixture = fixture_xlsx_with_dimension(false, "A1:XFD1048576");
        let mut runtime = ExcelRuntime::default();
        let error = runtime
            .open_source(fixture, ExcelOptions::default())
            .expect_err("sparse worksheet extent must be bounded before dense parsing");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(error.details()["resource"], "worksheet-dimensions");
        assert_eq!(runtime.retained_bytes(), 0);
        assert_eq!(runtime.source_count(), 0);
        assert_eq!(runtime.table_count(), 0);
    }

    #[test]
    fn closing_a_source_cascades_and_is_idempotent() {
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(fixture_xlsx(false), ExcelOptions::default())
            .expect("source");
        let table = runtime
            .open_table(source, "sheet-0")
            .expect("table")
            .table_handle;
        assert_eq!(runtime.table_count(), 1);
        assert!(runtime.close_source(source));
        assert!(!runtime.close_source(source));
        assert_eq!(runtime.table_count(), 0);
        assert_eq!(runtime.retained_bytes(), 0);
        let error = runtime.metadata(table).expect_err("table cascaded closed");
        assert_eq!(error.code(), ErrorCode::HandleClosed);
    }

    fn decode_column(column: &StringColumnBatch) -> Vec<Option<&str>> {
        (0..column.len())
            .map(|index| {
                if column.validity()[index / 8] & (1 << (index % 8)) == 0 {
                    return None;
                }
                let start = column.offsets()[index] as usize;
                let end = column.offsets()[index + 1] as usize;
                Some(std::str::from_utf8(&column.data()[start..end]).expect("UTF-8"))
            })
            .collect()
    }

    fn measured_source_reservation(fixture: &[u8], limits: &ExcelLimits) -> usize {
        let mut runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes: usize::MAX,
            limits: limits.clone(),
            ..ExcelRuntimeConfig::default()
        })
        .expect("measurement runtime");
        let source = runtime
            .open_source(fixture.to_vec(), ExcelOptions::default())
            .expect("measurement source");
        let reservation = runtime.retained_bytes();
        assert!(runtime.close_source(source));
        assert_eq!(runtime.retained_bytes(), 0);
        reservation
    }

    fn fixture_xlsx(macro_enabled: bool) -> Vec<u8> {
        fixture_xlsx_with_dimension(macro_enabled, "A1:C3")
    }

    fn fixture_xlsx_with_dimension(macro_enabled: bool, dimension: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        let workbook_type = if macro_enabled {
            "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
        } else {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        };
        add_zip_file(
            &mut zip,
            "[Content_Types].xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="{workbook_type}"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#
            ),
            options,
        );
        add_zip_file(
            &mut zip,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Visible" sheetId="1" r:id="rId1"/>
    <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>
  <fonts count="2">
    <font/>
    <font><name val="Aptos"/><sz val="12"/><b/><color rgb="FF112233"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFCC00"/><bgColor rgb="FF000000"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border/>
    <border><left style="thin"><color rgb="FF445566"/></left><right/><top/><bottom/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="164" fontId="1" fillId="1" borderId="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="1" fillId="1" borderId="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/worksheets/sheet1.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="{dimension}"/>
  <sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews>
  <cols><col min="2" max="2" width="18" hidden="1"/></cols>
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Name</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Count</t></is></c>
      <c r="C1" t="inlineStr"><is><t>Active</t></is></c>
    </row>
    <row r="2" ht="24" hidden="1">
      <c r="A2" t="inlineStr"><is><t>Ada</t></is></c>
      <c r="B2" s="1"><v>42</v></c>
      <c r="C2" t="b"><v>1</v></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>Merged child</t></is></c>
      <c r="B3" s="2" t="e"><v>#DIV/0!</v></c>
      <c r="C3"><f>1+1</f></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>
</worksheet>"#,
            ),
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/worksheets/sheet2.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hidden</t></is></c></row></sheetData>
</worksheet>"#,
            options,
        );
        zip.finish().expect("finish ZIP").into_inner()
    }

    fn fixture_xlsx_with_shared_string_count(unique_count: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        add_zip_file(
            &mut zip,
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/workbook.xml",
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>"#,
            options,
        );
        add_zip_file(
            &mut zip,
            "xl/sharedStrings.xml",
            &format!(
                r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" uniqueCount="{unique_count}"><si><t>x</t></si></sst>"#
            ),
            options,
        );
        zip.finish().expect("finish ZIP").into_inner()
    }

    fn add_zip_file(
        zip: &mut ZipWriter<Cursor<Vec<u8>>>,
        name: &str,
        contents: &str,
        options: SimpleFileOptions,
    ) {
        zip.start_file(name, options).expect("start ZIP entry");
        zip.write_all(contents.as_bytes()).expect("write ZIP entry");
    }

    fn fixture_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        for (name, contents) in entries {
            add_zip_file(&mut zip, name, contents, options);
        }
        zip.finish().expect("finish ZIP").into_inner()
    }

    fn fixture_cfb(streams: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut compound =
            cfb::CompoundFile::create_with_version(Version::V3, cursor).expect("create CFB");
        for (name, contents) in streams {
            let mut stream = compound.create_stream(name).expect("create CFB stream");
            stream.write_all(contents).expect("write CFB stream");
        }
        compound.flush().expect("flush CFB");
        compound.into_inner().into_inner()
    }

    fn fixture_xls() -> Vec<u8> {
        let mut workbook = Vec::new();
        workbook.extend(biff_record(0x0809, &[0x00, 0x06, 0x05, 0x00]));

        // FONT: 12pt bold/italic/underlined Aptos in palette slot 10.
        let mut font = Vec::new();
        font.extend_from_slice(&240_u16.to_le_bytes());
        font.extend_from_slice(&0x0002_u16.to_le_bytes());
        font.extend_from_slice(&10_u16.to_le_bytes());
        font.extend_from_slice(&700_u16.to_le_bytes());
        font.extend_from_slice(&0_u16.to_le_bytes());
        font.extend_from_slice(&[1, 2, 0, 0]);
        font.extend_from_slice(&[5, 1]);
        for unit in "Aptos".encode_utf16() {
            font.extend_from_slice(&unit.to_le_bytes());
        }
        workbook.extend(biff_record(0x0031, &font));

        // A custom palette makes the test assert true BIFF8 indexed colours,
        // rather than merely exercising the default palette fallback.
        let mut palette = Vec::new();
        palette.extend_from_slice(&56_u16.to_le_bytes());
        for index in 0..56_u8 {
            let (red, green, blue) = match index {
                0 => (255, 204, 0),
                1 => (68, 85, 102),
                2 => (17, 34, 51),
                _ => (0, 0, 0),
            };
            palette.extend_from_slice(&[red, green, blue, 0]);
        }
        workbook.extend(biff_record(0x0092, &palette));

        let mut number_format = Vec::new();
        number_format.extend_from_slice(&164_u16.to_le_bytes());
        number_format.extend_from_slice(&5_u16.to_le_bytes());
        number_format.push(0);
        number_format.extend_from_slice(b"0.000");
        workbook.extend(biff_record(0x041E, &number_format));

        // XF 0 is the parent style.  XF 1 is the cell XF used by A1 and
        // explicitly applies every supported property group.
        let mut style_xf = vec![0_u8; 20];
        style_xf[0..2].copy_from_slice(&0_u16.to_le_bytes());
        style_xf[2..4].copy_from_slice(&164_u16.to_le_bytes());
        style_xf[4..6].copy_from_slice(&0x0004_u16.to_le_bytes());
        style_xf[6] = 0x0A;
        style_xf[10..12].copy_from_slice(&1_u16.to_le_bytes());
        style_xf[12..14].copy_from_slice(&9_u16.to_le_bytes());
        style_xf[14..18].copy_from_slice(&(1_u32 << 26).to_le_bytes());
        style_xf[18..20].copy_from_slice(&(8_u16 | (9_u16 << 7)).to_le_bytes());
        workbook.extend(biff_record(0x00E0, &style_xf));

        let mut cell_xf = style_xf.clone();
        cell_xf[4..6].copy_from_slice(&0_u16.to_le_bytes());
        cell_xf[9] = 0x7C;
        workbook.extend(biff_record(0x00E0, &cell_xf));

        let sheet_name = b"Sheet1";
        let bound_sheet_len = 6 + 2 + sheet_name.len();
        let sheet_offset = workbook.len() + 4 + bound_sheet_len + 4;
        let mut bound_sheet = Vec::new();
        bound_sheet.extend_from_slice(&(sheet_offset as u32).to_le_bytes());
        bound_sheet.extend_from_slice(&[0, 0, sheet_name.len() as u8, 0]);
        bound_sheet.extend_from_slice(sheet_name);
        workbook.extend(biff_record(0x0085, &bound_sheet));
        workbook.extend(biff_record(0x000A, &[]));
        workbook.extend(biff_record(0x0809, &[0x00, 0x06, 0x10, 0x00]));
        workbook.extend(biff_record(0x023E, &[0x08, 0x00]));
        workbook.extend(biff_record(
            0x0041,
            &[0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00],
        ));
        let mut row = vec![0_u8; 16];
        row[6..8].copy_from_slice(&360_u16.to_le_bytes());
        row[12..16].copy_from_slice(&0x20_u32.to_le_bytes());
        workbook.extend(biff_record(0x0208, &row));
        let mut column = vec![0_u8; 12];
        column[4..6].copy_from_slice(&2048_u16.to_le_bytes());
        workbook.extend(biff_record(0x007D, &column));
        let mut merged = Vec::new();
        merged.extend_from_slice(&1_u16.to_le_bytes());
        merged.extend_from_slice(&0_u16.to_le_bytes());
        merged.extend_from_slice(&0_u16.to_le_bytes());
        merged.extend_from_slice(&0_u16.to_le_bytes());
        merged.extend_from_slice(&1_u16.to_le_bytes());
        workbook.extend(biff_record(0x00E5, &merged));
        let mut label = Vec::new();
        label.extend_from_slice(&0_u16.to_le_bytes());
        label.extend_from_slice(&0_u16.to_le_bytes());
        label.extend_from_slice(&1_u16.to_le_bytes());
        label.extend_from_slice(&3_u16.to_le_bytes());
        label.push(0);
        label.extend_from_slice(b"Xls");
        workbook.extend(biff_record(0x0204, &label));
        workbook.extend(biff_record(0x000A, &[]));

        let cursor = Cursor::new(Vec::new());
        let mut compound =
            cfb::CompoundFile::create_with_version(Version::V3, cursor).expect("create CFB");
        {
            let mut stream = compound
                .create_stream("/Workbook")
                .expect("Workbook stream");
            stream.write_all(&workbook).expect("write Workbook stream");
        }
        compound.flush().expect("flush CFB");
        compound.into_inner().into_inner()
    }

    fn biff_record(record_type: u16, data: &[u8]) -> Vec<u8> {
        let mut record = Vec::with_capacity(4 + data.len());
        record.extend_from_slice(&record_type.to_le_bytes());
        record.extend_from_slice(&(data.len() as u16).to_le_bytes());
        record.extend_from_slice(data);
        record
    }
}
