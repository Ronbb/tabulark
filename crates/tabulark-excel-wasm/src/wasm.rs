//! Thin wasm-bindgen boundary for the range-backed Excel runtime.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use tabulark::model::{BATCH_LAYOUT_VERSION, RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::protocol::{
    ADAPTER_API_VERSION, AdapterAction, AdapterActionResult, AdapterOperationCursor,
    EXCEL_ADAPTER_ID, MAX_OPERATION_RANGES_PER_STEP, PROTOCOL_VERSION,
};
use tabulark::resource::{ResourceCategory, ResourceLedger};
use tabulark::{ErrorCode, Result, TabularkError};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

use crate::presentation::{TablePresentation, TablePresentationRange};
use crate::range::{
    CompactXlsError, HostRange, IndexedRanges, RangeSheetDescriptor, RawZipEntry,
    ZipDirectoryIndex, build_compact_xlsx, compact_xls, parse_central_directory,
    parse_end_of_central_directory, parse_workbook_descriptors, tail_range,
    workbook_relationships_path,
};
use crate::{
    ExcelFormat, ExcelFormatHint, ExcelLimits, ExcelOptions, ExcelRuntime, ExcelRuntimeConfig,
    ExcelSheetVisibility, ExcelSourceHandle, ExcelTableHandle,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WasmConfig {
    memory_budget_bytes: usize,
    max_sources: usize,
    max_range_cells: u64,
    max_batch_bytes: usize,
}

impl Default for WasmConfig {
    fn default() -> Self {
        let config = ExcelRuntimeConfig::default();
        Self {
            memory_budget_bytes: config.memory_budget_bytes,
            max_sources: config.max_sources,
            max_range_cells: config.limits.max_range_cells,
            max_batch_bytes: config.limits.max_batch_bytes,
        }
    }
}

struct PendingOpen {
    options: ExcelOptions,
    source_length: u64,
    indexed: IndexedRanges,
    phase: OpenPhase,
}

struct TrackedOpen {
    cursor: AdapterOperationCursor,
    pending: PendingOpen,
    expected: Vec<HostRange>,
}

enum OpenPhase {
    Detect,
    XlsxCentral,
    XlsxWorkbook(EntryFetch),
    XlsIndex,
}

struct EntryFetch {
    paths: Vec<String>,
    next: usize,
    entries: Vec<RawZipEntry>,
    index: ZipDirectoryIndex,
}

struct PendingOpenTable {
    source_handle: u32,
    table_id: String,
    cursor: AdapterOperationCursor,
    expected: Vec<HostRange>,
    fetch: Option<EntryFetch>,
}

enum TrackedOperation {
    Open(TrackedOpen),
    OpenTable(PendingOpenTable),
}

struct RangeSource {
    options: ExcelOptions,
    indexed: IndexedRanges,
    kind: RangeSourceKind,
    tables: Vec<RangeSheetDescriptor>,
    inner_sources: Vec<ExcelSourceHandle>,
}

enum RangeSourceKind {
    Xlsx {
        index: ZipDirectoryIndex,
        workbook_entries: Vec<RawZipEntry>,
    },
    Xls {
        compact: Vec<u8>,
    },
}

struct State {
    runtime: ExcelRuntime,
    max_range_cells: u64,
    max_presentation_bytes: usize,
    operation_budget_bytes: u64,
    ledger: ResourceLedger,
    next_operation: u32,
    next_source: u32,
    operations: HashMap<u32, TrackedOperation>,
    range_sources: HashMap<u32, RangeSource>,
    table_sources: HashMap<ExcelTableHandle, (u32, ExcelSourceHandle)>,
}

impl State {
    fn allocate_operation(&mut self) -> std::result::Result<u32, JsValue> {
        let operation = self.next_operation;
        self.next_operation = self.next_operation.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel operation handle space exhausted",
            ))
        })?;
        Ok(operation)
    }

    fn allocate_source(&mut self) -> std::result::Result<u32, JsValue> {
        let source = self.next_source;
        self.next_source = self.next_source.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel range source handle space exhausted",
            ))
        })?;
        Ok(source)
    }
}

/// Dedicated Excel runtime artifact implementing official adapter ABI v3.
#[wasm_bindgen]
pub struct WasmRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates an empty range-backed Excel adapter runtime.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            WasmConfig::default()
        } else {
            from_js(config, "invalid Excel WebAssembly runtime config")?
        };
        if config.memory_budget_bytes == 0
            || config.max_sources == 0
            || config.max_range_cells == 0
            || config.max_batch_bytes == 0
        {
            return Err(error_to_js(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel runtime resource limits must be greater than zero",
            )));
        }
        let mut limits = ExcelLimits::default();
        limits.max_source_bytes = limits.max_source_bytes.min(config.memory_budget_bytes);
        limits.max_range_cells = config.max_range_cells;
        limits.max_batch_bytes = config.max_batch_bytes.min(config.memory_budget_bytes);
        let runtime = ExcelRuntime::new(ExcelRuntimeConfig {
            memory_budget_bytes: config.memory_budget_bytes,
            // Range sources are counted by the Worker.  The native registry
            // uses one compact source per concurrently opened worksheet so
            // independent table handles do not share a mutable Calamine
            // cursor; the byte ledger remains the actual admission control.
            max_sources: config.max_sources.max(512),
            limits,
        })
        .map_err(error_to_js)?;
        let max_range_cells = config.max_range_cells;
        let max_presentation_bytes = config.max_batch_bytes;
        let operation_budget_bytes = u64::try_from(config.memory_budget_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel operation budget exceeds u64",
            ))
        })?;
        Ok(Self {
            state: RefCell::new(State {
                runtime,
                max_range_cells,
                max_presentation_bytes,
                operation_budget_bytes,
                ledger: ResourceLedger::new(operation_budget_bytes).map_err(error_to_js)?,
                next_operation: 1,
                next_source: 1,
                operations: HashMap::new(),
                range_sources: HashMap::new(),
                table_sources: HashMap::new(),
            }),
        })
    }

    /// Returns the Worker protocol version.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        PROTOCOL_VERSION
    }

    /// Returns the official adapter ABI version.
    #[wasm_bindgen(js_name = adapterApiVersion)]
    pub fn adapter_api_version(&self) -> u32 {
        ADAPTER_API_VERSION
    }

    /// Returns common typed-buffer layout version one.
    #[wasm_bindgen(js_name = batchLayoutVersion)]
    pub fn batch_layout_version(&self) -> u32 {
        BATCH_LAYOUT_VERSION
    }

    /// Returns the frozen official adapter ID.
    #[wasm_bindgen(js_name = adapterId)]
    pub fn adapter_id(&self) -> String {
        EXCEL_ADAPTER_ID.to_owned()
    }

    /// Returns the private adapter-owned resource ledger snapshot.
    #[wasm_bindgen(js_name = resourceSnapshot)]
    pub fn resource_snapshot(&self) -> std::result::Result<JsValue, JsValue> {
        let wasm_memory_pages = current_wasm_memory_pages();
        let mut state = self.state.borrow_mut();
        let persistent = u64::try_from(state.runtime.retained_bytes()).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel retained-byte estimate exceeds u64",
            ))
        })?;
        let indexed = state
            .range_sources
            .values()
            .try_fold(0_u64, |total, source| {
                total
                    .checked_add(source.indexed.retained_bytes())
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::ResourceLimit,
                            "Excel indexed-range accounting overflows",
                        ))
                    })
            })?;
        let persistent = persistent.checked_add(indexed).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel persistent accounting overflows",
            ))
        })?;
        let active = state
            .operations
            .len()
            .checked_mul(std::mem::size_of::<TrackedOperation>())
            .and_then(|bytes| u64::try_from(bytes).ok())
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel active-operation estimate overflows",
                ))
            })?;
        state
            .ledger
            .replace(ResourceCategory::Persistent, persistent)
            .map_err(error_to_js)?;
        state
            .ledger
            .replace(ResourceCategory::ActiveOperation, active)
            .map_err(error_to_js)?;
        state.ledger.observe_wasm_memory_pages(wasm_memory_pages);
        to_js(&state.ledger.snapshot())
    }

    /// Begins a bounded range-backed workbook open.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        let source_length = safe_u64(source_length, "sourceLength")?;
        let options = if options.is_null() || options.is_undefined() {
            ExcelOptions::default()
        } else {
            from_js(options, "invalid Excel adapter options")?
        };
        let mut state = self.state.borrow_mut();
        const MAX_EXCEL_SOURCE_BYTES: u64 = 1_u64 << 31;
        if source_length > MAX_EXCEL_SOURCE_BYTES {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel source exceeds the 2 GiB product limit",
                )
                .with_detail("resource", "source-bytes")
                .with_detail("requiredBytes", source_length)
                .with_detail("availableBytes", MAX_EXCEL_SOURCE_BYTES),
            ));
        }
        if source_length < 8 {
            return Err(error_to_js(TabularkError::new(
                ErrorCode::ParseFailed,
                "Excel source is too short to contain a supported signature",
            )));
        }
        let operation = state.allocate_operation()?;
        let mut cursor = AdapterOperationCursor::new();
        // Signature first: XLS never needs the ZIP tail, so an exact-2-GiB
        // sparse CFB does not retain an irrelevant final window in WASM.
        let expected = vec![HostRange::new(0, 8, source_length).map_err(error_to_js)?];
        let result = read_ranges_step(
            operation,
            &mut cursor,
            &expected,
            state.operation_budget_bytes,
        )?;
        state.operations.insert(
            operation,
            TrackedOperation::Open(TrackedOpen {
                cursor,
                pending: PendingOpen {
                    options,
                    source_length,
                    indexed: IndexedRanges::new(source_length),
                    phase: OpenPhase::Detect,
                },
                expected,
            }),
        );
        Ok(result)
    }

    /// Supplies revision-matched source ranges and advances the operation.
    #[wasm_bindgen(js_name = continueOperation)]
    pub fn continue_operation(
        &self,
        operation_handle: u32,
        operation_revision: f64,
        results: Array,
    ) -> std::result::Result<JsValue, JsValue> {
        let operation_revision = safe_u64(operation_revision, "operationRevision")?;
        let results = operation_results(results)?;
        let descriptors = results
            .iter()
            .map(|result| result.descriptor)
            .collect::<Vec<_>>();
        let mut state = self.state.borrow_mut();
        {
            let tracked = state.operations.get_mut(&operation_handle).ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::HandleClosed,
                    "Excel operation handle is closed",
                ))
            })?;
            // A rejected revision/result must leave the handle registered so
            // the host can still issue exactly one explicit cancellation.
            tracked
                .cursor_mut()
                .validate_results(operation_revision, &descriptors)
                .map_err(error_to_js)?;
        }
        let mut tracked = state
            .operations
            .remove(&operation_handle)
            .expect("validated Excel operation remains registered");
        let applied = match &mut tracked {
            TrackedOperation::Open(open) => {
                apply_indexed_results(&mut open.pending.indexed, &open.expected, results)
            }
            TrackedOperation::OpenTable(open) => {
                let Some(source) = state.range_sources.get_mut(&open.source_handle) else {
                    state.operations.insert(operation_handle, tracked);
                    return Err(error_to_js(TabularkError::new(
                        ErrorCode::HandleClosed,
                        "Excel range source was closed during worksheet open",
                    )));
                };
                apply_indexed_results(&mut source.indexed, &open.expected, results)
            }
        };
        if let Err(error) = applied {
            state.operations.insert(operation_handle, tracked);
            return Err(error_to_js(error));
        }
        let advanced = match &mut tracked {
            TrackedOperation::Open(open) => advance_open(&mut state, operation_handle, open),
            TrackedOperation::OpenTable(open) => {
                advance_open_table(&mut state, operation_handle, open)
            }
        }?;
        match advanced {
            OperationAdvance::Pending(value) => {
                state.operations.insert(operation_handle, tracked);
                Ok(value)
            }
            OperationAdvance::Complete(value) => Ok(value),
        }
    }

    /// Opens one already-indexed logical worksheet table synchronously.
    #[wasm_bindgen(js_name = openTable)]
    pub fn open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        open_indexed_table(&mut state, source_handle, &table_id)
    }

    /// Starts a range-backed worksheet-open operation.
    #[wasm_bindgen(js_name = beginOpenTable)]
    pub fn begin_open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        let source = state.range_sources.get(&source_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Excel range source handle is closed",
            ))
        })?;
        if !source.tables.iter().any(|table| table.id == table_id) {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel dataset does not contain the requested worksheet",
                )
                .with_detail("tableId", table_id),
            ));
        }
        match &source.kind {
            RangeSourceKind::Xls { .. } => {
                drop(state);
                let opened = self.open_table(source_handle, table_id)?;
                complete_value(operation, "open-table", "table", opened)
            }
            RangeSourceKind::Xlsx {
                index,
                workbook_entries,
            } => {
                let target = source
                    .tables
                    .iter()
                    .find(|table| table.id == table_id)
                    .expect("validated worksheet remains indexed");
                let workbook_path = index.workbook_path().ok_or_else(|| {
                    error_to_js(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "XLSX workbook entry is missing",
                    ))
                })?;
                let relationships_path = workbook_relationships_path(workbook_path);
                let mut paths = vec![
                    "[Content_Types].xml".to_owned(),
                    workbook_path.to_owned(),
                    relationships_path,
                ];
                for optional in [
                    "_rels/.rels",
                    "xl/styles.xml",
                    "xl/sharedStrings.xml",
                    "xl/theme/theme1.xml",
                ] {
                    if index.entry(optional).is_some() {
                        paths.push(optional.to_owned());
                    }
                }
                paths.push(target.path.clone());
                paths.sort();
                paths.dedup();
                let mut fetch = EntryFetch {
                    paths,
                    next: 0,
                    entries: workbook_entries.clone(),
                    index: index.clone(),
                };
                fetch.skip_loaded();
                let mut pending = PendingOpenTable {
                    source_handle,
                    table_id,
                    cursor: AdapterOperationCursor::new(),
                    expected: Vec::new(),
                    fetch: Some(fetch),
                };
                let advanced = advance_open_table(&mut state, operation, &mut pending)?;
                match advanced {
                    OperationAdvance::Pending(value) => {
                        state
                            .operations
                            .insert(operation, TrackedOperation::OpenTable(pending));
                        Ok(value)
                    }
                    OperationAdvance::Complete(value) => Ok(value),
                }
            }
        }
    }

    /// Returns the exact metadata for an opened worksheet.
    pub fn metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let metadata = state
            .runtime
            .metadata(ExcelTableHandle::from_raw(table_handle))
            .map_err(error_to_js)?;
        to_js(metadata)
    }

    /// Starts and completes an ABI-v3 metadata operation.
    #[wasm_bindgen(js_name = beginMetadata)]
    pub fn begin_metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let metadata = self.metadata(table_handle)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(operation, "metadata", "metadata", metadata)
    }

    /// Returns the worksheet's static presentation envelope.
    pub fn presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let table = ExcelTableHandle::from_raw(table_handle);
        let metadata = state.runtime.metadata(table).map_err(error_to_js)?;
        let presentation = state.runtime.presentation(table).map_err(error_to_js)?;
        presentation_value(metadata, &presentation)
    }

    /// Starts and completes an ABI-v3 static-presentation operation.
    #[wasm_bindgen(js_name = beginPresentation)]
    pub fn begin_presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let table = ExcelTableHandle::from_raw(table_handle);
        let (presentation, warning) = {
            let state = self.state.borrow();
            let metadata = state.runtime.metadata(table).map_err(error_to_js)?;
            match state.runtime.presentation(table) {
                Ok(presentation) => {
                    let required = presentation
                        .output_reservation_bytes()
                        .map_err(error_to_js)?;
                    if required > state.max_presentation_bytes {
                        (
                            JsValue::NULL,
                            Some(presentation_limit_warning(
                                metadata.table_id(),
                                required,
                                state.max_presentation_bytes,
                            )?),
                        )
                    } else {
                        (presentation_value(metadata, &presentation)?, None)
                    }
                }
                Err(error) if error.code() == ErrorCode::ResourceLimit => (
                    JsValue::NULL,
                    Some(presentation_limit_warning(
                        metadata.table_id(),
                        state.max_presentation_bytes.saturating_add(1),
                        state.max_presentation_bytes,
                    )?),
                ),
                Err(error) => return Err(error_to_js(error)),
            }
        };
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        let result = complete_value(operation, "presentation", "presentation", presentation)?;
        if let Some(warning) = warning {
            let warnings = Array::new();
            warnings.push(&warning);
            Reflect::set(&result, &JsValue::from_str("warnings"), &warnings).map(|_| ())?;
        }
        Ok(result)
    }

    /// Returns a range-aligned static style, merge, and sparse layout grid.
    #[wasm_bindgen(js_name = readPresentationRange)]
    pub fn read_presentation_range(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request, "invalid Excel presentation range")?;
        let state = self.state.borrow();
        let table = ExcelTableHandle::from_raw(table_handle);
        let metadata = state.runtime.metadata(table).map_err(error_to_js)?;
        let cells = request.cell_count().map_err(error_to_js)?;
        if cells > state.max_range_cells {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel presentation range exceeds the configured cell limit",
                )
                .with_detail("resource", "presentation-range-cells")
                .with_detail("required", cells)
                .with_detail("available", state.max_range_cells),
            ));
        }
        let schema_columns = u64::try_from(metadata.schema().len()).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel schema column count exceeds the supported integer range",
            ))
        })?;
        if request.column_end().map_err(error_to_js)? > schema_columns {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::InvalidRange,
                    "requested presentation columns exceed the Excel worksheet schema",
                )
                .with_detail("schemaColumns", schema_columns),
            ));
        }
        let presentation = state
            .runtime
            .read_presentation_range(table, request)
            .map_err(error_to_js)?;
        presentation_range_value(metadata, request, &presentation)
    }

    /// Starts and completes an ABI-v3 range-presentation operation.
    #[wasm_bindgen(js_name = beginPresentationRange)]
    pub fn begin_presentation_range(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let presentation = self.read_presentation_range(table_handle, request)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(
            operation,
            "presentation-range",
            "presentation",
            presentation,
        )
    }

    /// Reads a logical display-string batch and completes synchronously.
    #[wasm_bindgen(js_name = beginRead)]
    pub fn begin_read(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request, "invalid Excel range request")?;
        let mut state = self.state.borrow_mut();
        let batch = state
            .runtime
            .read_range(ExcelTableHandle::from_raw(table_handle), request)
            .and_then(|batch| batch.into_typed())
            .map_err(error_to_js)?;
        let operation = state.allocate_operation()?;
        let mut cursor = AdapterOperationCursor::new();
        let revision = cursor.complete_revision().map_err(error_to_js)?;
        complete_batch(operation, revision, &batch)
    }

    /// Cancels and releases a pending range-backed operation.
    #[wasm_bindgen(js_name = cancelOperation)]
    pub fn cancel_operation(&self, operation_handle: u32) -> bool {
        self.state
            .borrow_mut()
            .operations
            .remove(&operation_handle)
            .is_some()
    }

    /// Idempotently closes one worksheet.
    #[wasm_bindgen(js_name = closeTable)]
    pub fn close_table(&self, table_handle: u32) -> bool {
        let mut state = self.state.borrow_mut();
        let table = ExcelTableHandle::from_raw(table_handle);
        let closed = state.runtime.close_table(table);
        if let Some((range_source, inner_source)) = state.table_sources.remove(&table) {
            state.runtime.close_source(inner_source);
            if let Some(source) = state.range_sources.get_mut(&range_source) {
                source
                    .inner_sources
                    .retain(|candidate| *candidate != inner_source);
            }
        }
        closed
    }

    /// Idempotently closes a workbook and every child worksheet.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(source) = state.range_sources.remove(&source_handle) else {
            return false;
        };
        let tables = state
            .table_sources
            .iter()
            .filter_map(|(table, (owner, _))| (*owner == source_handle).then_some(*table))
            .collect::<Vec<_>>();
        for table in tables {
            state.runtime.close_table(table);
            state.table_sources.remove(&table);
        }
        for inner in source.inner_sources {
            state.runtime.close_source(inner);
        }
        true
    }

    /// Releases every pending operation, source, and table.
    pub fn shutdown(&self) {
        let mut state = self.state.borrow_mut();
        state.operations.clear();
        state.range_sources.clear();
        state.table_sources.clear();
        state.runtime.shutdown();
        state.ledger.release_all();
    }
}

enum OperationAdvance {
    Pending(JsValue),
    Complete(JsValue),
}

impl TrackedOperation {
    fn cursor_mut(&mut self) -> &mut AdapterOperationCursor {
        match self {
            Self::Open(operation) => &mut operation.cursor,
            Self::OpenTable(operation) => &mut operation.cursor,
        }
    }
}

fn apply_indexed_results(
    indexed: &mut IndexedRanges,
    expected: &[HostRange],
    results: Vec<OwnedActionResult>,
) -> Result<()> {
    for result in results {
        let index = usize::try_from(result.descriptor.action_index).map_err(|_| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel action result index exceeds usize",
            )
        })?;
        let range = expected.get(index).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel action result index is outside the issued step",
            )
        })?;
        let eof_expected = range.end() == indexed.source_length();
        if result.descriptor.eof != eof_expected {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel action result EOF flag does not match its range",
            )
            .with_detail("actionIndex", index)
            .with_detail("expectedEof", eof_expected));
        }
        indexed.insert(range, result.bytes)?;
    }
    Ok(())
}

impl EntryFetch {
    fn skip_loaded(&mut self) {
        while self.next < self.paths.len()
            && self
                .entries
                .iter()
                .any(|entry| entry.name() == self.paths[self.next])
        {
            self.next += 1;
        }
    }
}

enum FetchAdvance {
    Need(HostRange),
    Complete,
}

fn advance_entry_fetch(indexed: &IndexedRanges, fetch: &mut EntryFetch) -> Result<FetchAdvance> {
    loop {
        fetch.skip_loaded();
        let Some(path) = fetch.paths.get(fetch.next) else {
            return Ok(FetchAdvance::Complete);
        };
        let entry = fetch.index.entry(path).cloned().ok_or_else(|| {
            TabularkError::new(ErrorCode::ParseFailed, "XLSX required ZIP entry is missing")
                .with_detail("entry", path.clone())
        })?;
        let header_range = RawZipEntry::header_range(&entry, indexed.source_length())?;
        let Some(header) = indexed.bytes(&header_range) else {
            return indexed
                .first_missing(&header_range)?
                .map(FetchAdvance::Need)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "XLSX local header is indexed but unavailable",
                    )
                });
        };
        let data_range = RawZipEntry::data_range(&entry, header, indexed.source_length())?;
        let Some(data) = indexed.bytes(&data_range) else {
            return indexed
                .first_missing(&data_range)?
                .map(FetchAdvance::Need)
                .ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "XLSX entry data is indexed but unavailable",
                    )
                });
        };
        fetch.entries.push(RawZipEntry::new(entry, data.to_vec())?);
        fetch.next += 1;
    }
}

fn advance_open(
    state: &mut State,
    operation_handle: u32,
    operation: &mut TrackedOpen,
) -> std::result::Result<OperationAdvance, JsValue> {
    loop {
        match &mut operation.pending.phase {
            OpenPhase::Detect => {
                let signature_range =
                    HostRange::new(0, 8, operation.pending.source_length).map_err(error_to_js)?;
                let signature = operation
                    .pending
                    .indexed
                    .bytes(&signature_range)
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RangeNotIndexed,
                            "Excel container signature is not indexed",
                        ))
                    })?;
                if signature == [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] {
                    ensure_range_format_hint(operation.pending.options.format, ExcelFormat::Xls)?;
                    operation.pending.phase = OpenPhase::XlsIndex;
                    continue;
                }
                if !signature.starts_with(b"PK") {
                    return Err(error_to_js(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "source does not have a supported Excel container signature",
                    )));
                }
                ensure_range_format_hint(operation.pending.options.format, ExcelFormat::Xlsx)?;
                let tail_range =
                    tail_range(operation.pending.source_length).map_err(error_to_js)?;
                let Some(tail) = operation.pending.indexed.bytes(&tail_range) else {
                    let missing = operation
                        .pending
                        .indexed
                        .first_missing(&tail_range)
                        .map_err(error_to_js)?
                        .ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "XLSX tail is indexed but unavailable",
                            ))
                        })?;
                    return issue_open_ranges(state, operation_handle, operation, vec![missing]);
                };
                let location = parse_end_of_central_directory(
                    tail,
                    tail_range.offset,
                    operation.pending.source_length,
                )
                .map_err(error_to_js)?;
                if operation.pending.indexed.bytes(&location.range).is_none() {
                    let missing = operation
                        .pending
                        .indexed
                        .first_missing(&location.range)
                        .map_err(error_to_js)?
                        .ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "XLSX central directory is indexed but unavailable",
                            ))
                        })?;
                    operation.pending.phase = OpenPhase::XlsxCentral;
                    return issue_open_ranges(state, operation_handle, operation, vec![missing]);
                }
                operation.pending.phase = OpenPhase::XlsxCentral;
            }
            OpenPhase::XlsxCentral => {
                let tail_range =
                    tail_range(operation.pending.source_length).map_err(error_to_js)?;
                let tail = operation
                    .pending
                    .indexed
                    .bytes(&tail_range)
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RangeNotIndexed,
                            "XLSX ZIP tail is not indexed",
                        ))
                    })?;
                let location = parse_end_of_central_directory(
                    tail,
                    tail_range.offset,
                    operation.pending.source_length,
                )
                .map_err(error_to_js)?;
                let central = operation
                    .pending
                    .indexed
                    .bytes(&location.range)
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RangeNotIndexed,
                            "XLSX central directory is not indexed",
                        ))
                    })?;
                let index = parse_central_directory(
                    central,
                    location.entries,
                    operation.pending.source_length,
                )
                .map_err(error_to_js)?;
                let workbook = index.workbook_path().ok_or_else(|| {
                    error_to_js(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "XLSX workbook entry is missing",
                    ))
                })?;
                let relationships = workbook_relationships_path(workbook);
                if index.entry("[Content_Types].xml").is_none()
                    || index.entry(&relationships).is_none()
                {
                    return Err(error_to_js(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "XLSX package is missing required workbook metadata",
                    )));
                }
                operation.pending.phase = OpenPhase::XlsxWorkbook(EntryFetch {
                    paths: vec![workbook.to_owned(), relationships],
                    next: 0,
                    entries: Vec::new(),
                    index,
                });
            }
            OpenPhase::XlsxWorkbook(fetch) => {
                match advance_entry_fetch(&operation.pending.indexed, fetch).map_err(error_to_js)? {
                    FetchAdvance::Need(range) => {
                        return issue_open_ranges(state, operation_handle, operation, vec![range]);
                    }
                    FetchAdvance::Complete => {}
                }
                let index = fetch.index.clone();
                let workbook_path = index.workbook_path().expect("validated XLSX workbook path");
                let relationships_path = workbook_relationships_path(workbook_path);
                let workbook = fetch
                    .entries
                    .iter()
                    .find(|entry| entry.name() == workbook_path)
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RuntimeFailure,
                            "indexed XLSX workbook entry was lost",
                        ))
                    })?
                    .decode()
                    .map_err(error_to_js)?;
                let relationships = fetch
                    .entries
                    .iter()
                    .find(|entry| entry.name() == relationships_path)
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RuntimeFailure,
                            "indexed XLSX relationships entry was lost",
                        ))
                    })?
                    .decode()
                    .map_err(error_to_js)?;
                let tables =
                    parse_workbook_descriptors(&workbook, &relationships, &relationships_path)
                        .map_err(error_to_js)?;
                let source_handle = state.allocate_source()?;
                let revision = operation.cursor.complete_revision().map_err(error_to_js)?;
                let retained = operation.pending.indexed.retained_bytes();
                let source = RangeSource {
                    options: operation.pending.options.clone(),
                    indexed: std::mem::replace(
                        &mut operation.pending.indexed,
                        IndexedRanges::new(operation.pending.source_length),
                    ),
                    kind: RangeSourceKind::Xlsx {
                        index,
                        workbook_entries: fetch.entries.clone(),
                    },
                    tables: tables.clone(),
                    inner_sources: Vec::new(),
                };
                state.range_sources.insert(source_handle, source);
                return complete_range_open(
                    operation_handle,
                    revision,
                    source_handle,
                    retained,
                    &tables,
                )
                .map(OperationAdvance::Complete);
            }
            OpenPhase::XlsIndex => match compact_xls(&operation.pending.indexed) {
                Err(CompactXlsError::Missing(range)) => {
                    return issue_open_ranges(state, operation_handle, operation, vec![range]);
                }
                Err(CompactXlsError::Fatal(error)) => return Err(error_to_js(error)),
                Ok(compact) => {
                    let inner = state
                        .runtime
                        .open_source(compact.clone(), operation.pending.options.clone())
                        .map_err(error_to_js)?;
                    let listed = state
                        .runtime
                        .list_tables(inner)
                        .map_err(error_to_js)?
                        .to_vec();
                    state.runtime.close_source(inner);
                    let tables = listed
                        .into_iter()
                        .map(|table| RangeSheetDescriptor {
                            id: table.id().to_owned(),
                            name: table.name().to_owned(),
                            visibility: table.visibility(),
                            path: String::new(),
                        })
                        .collect::<Vec<_>>();
                    let source_handle = state.allocate_source()?;
                    let revision = operation.cursor.complete_revision().map_err(error_to_js)?;
                    let retained = operation
                        .pending
                        .indexed
                        .retained_bytes()
                        .checked_add(u64::try_from(compact.len()).unwrap_or(u64::MAX))
                        .ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "XLS retained-byte accounting overflows",
                            ))
                        })?;
                    state.range_sources.insert(
                        source_handle,
                        RangeSource {
                            options: operation.pending.options.clone(),
                            indexed: std::mem::replace(
                                &mut operation.pending.indexed,
                                IndexedRanges::new(operation.pending.source_length),
                            ),
                            kind: RangeSourceKind::Xls { compact },
                            tables: tables.clone(),
                            inner_sources: Vec::new(),
                        },
                    );
                    return complete_range_open(
                        operation_handle,
                        revision,
                        source_handle,
                        retained,
                        &tables,
                    )
                    .map(OperationAdvance::Complete);
                }
            },
        }
    }
}

fn issue_open_ranges(
    state: &State,
    operation_handle: u32,
    operation: &mut TrackedOpen,
    ranges: Vec<HostRange>,
) -> std::result::Result<OperationAdvance, JsValue> {
    operation.expected = ranges;
    read_ranges_step(
        operation_handle,
        &mut operation.cursor,
        &operation.expected,
        state.operation_budget_bytes,
    )
    .map(OperationAdvance::Pending)
}

fn advance_open_table(
    state: &mut State,
    operation_handle: u32,
    operation: &mut PendingOpenTable,
) -> std::result::Result<OperationAdvance, JsValue> {
    let fetch = operation.fetch.as_mut().ok_or_else(|| {
        error_to_js(TabularkError::new(
            ErrorCode::RuntimeFailure,
            "Excel worksheet operation lost its ZIP fetch state",
        ))
    })?;
    let fetch_advance = {
        let source = state
            .range_sources
            .get(&operation.source_handle)
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::HandleClosed,
                    "Excel range source handle is closed",
                ))
            })?;
        advance_entry_fetch(&source.indexed, fetch).map_err(error_to_js)?
    };
    if let FetchAdvance::Need(range) = fetch_advance {
        operation.expected = vec![range];
        let value = read_ranges_step(
            operation_handle,
            &mut operation.cursor,
            &operation.expected,
            state.operation_budget_bytes,
        )?;
        return Ok(OperationAdvance::Pending(value));
    }

    let (compact, options) = {
        let source = state
            .range_sources
            .get(&operation.source_handle)
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::HandleClosed,
                    "Excel range source handle is closed",
                ))
            })?;
        let selected = source
            .tables
            .iter()
            .find(|table| table.id == operation.table_id)
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel dataset does not contain the requested worksheet",
                ))
            })?;
        (
            build_compact_xlsx(&fetch.entries, &source.tables, &selected.path)
                .map_err(error_to_js)?,
            source.options.clone(),
        )
    };
    let table = open_compact_table(
        state,
        operation.source_handle,
        &operation.table_id,
        compact,
        options,
    )?;
    let revision = operation.cursor.complete_revision().map_err(error_to_js)?;
    complete_value_with_revision(operation_handle, revision, "open-table", "table", table)
        .map(OperationAdvance::Complete)
}

fn open_indexed_table(
    state: &mut State,
    source_handle: u32,
    table_id: &str,
) -> std::result::Result<JsValue, JsValue> {
    let (compact, options) = {
        let source = state.range_sources.get(&source_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Excel range source handle is closed",
            ))
        })?;
        if !source.tables.iter().any(|table| table.id == table_id) {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel dataset does not contain the requested worksheet",
                )
                .with_detail("tableId", table_id),
            ));
        }
        match &source.kind {
            RangeSourceKind::Xls { compact } => (compact.clone(), source.options.clone()),
            RangeSourceKind::Xlsx { .. } => {
                return Err(error_to_js(
                    TabularkError::new(
                        ErrorCode::RangeNotIndexed,
                        "XLSX worksheet has not been indexed by an open-table operation",
                    )
                    .with_detail("tableId", table_id),
                ));
            }
        }
    };
    open_compact_table(state, source_handle, table_id, compact, options)
}

fn open_compact_table(
    state: &mut State,
    range_source: u32,
    table_id: &str,
    compact: Vec<u8>,
    options: ExcelOptions,
) -> std::result::Result<JsValue, JsValue> {
    let inner_source = state
        .runtime
        .open_source(compact, options)
        .map_err(error_to_js)?;
    let opened = match state.runtime.open_table(inner_source, table_id) {
        Ok(opened) => opened,
        Err(error) => {
            state.runtime.close_source(inner_source);
            return Err(error_to_js(error));
        }
    };
    let value = (|| {
        let value = Object::new();
        set(
            &value,
            "tableHandle",
            JsValue::from_f64(f64::from(opened.table_handle.get())),
        )?;
        set(&value, "metadata", to_js(&opened.metadata)?)?;
        set(&value, "warnings", to_js(&opened.warnings)?)?;
        Ok::<_, JsValue>(value.into())
    })();
    if value.is_err() {
        state.runtime.close_table(opened.table_handle);
        state.runtime.close_source(inner_source);
        return value;
    }
    let source = state.range_sources.get_mut(&range_source).ok_or_else(|| {
        state.runtime.close_table(opened.table_handle);
        state.runtime.close_source(inner_source);
        error_to_js(TabularkError::new(
            ErrorCode::HandleClosed,
            "Excel range source closed while its worksheet was opening",
        ))
    })?;
    source.inner_sources.push(inner_source);
    state
        .table_sources
        .insert(opened.table_handle, (range_source, inner_source));
    value
}

fn ensure_range_format_hint(
    hint: ExcelFormatHint,
    actual: ExcelFormat,
) -> std::result::Result<(), JsValue> {
    let matches = matches!(hint, ExcelFormatHint::Auto)
        || matches!((hint, actual), (ExcelFormatHint::Xls, ExcelFormat::Xls))
        || matches!((hint, actual), (ExcelFormatHint::Xlsx, ExcelFormat::Xlsx));
    if matches {
        return Ok(());
    }
    Err(error_to_js(
        TabularkError::new(
            ErrorCode::ParseFailed,
            "Excel source format does not match the requested format",
        )
        .with_detail(
            "actualFormat",
            match actual {
                ExcelFormat::Xls => "xls",
                ExcelFormat::Xlsx => "xlsx",
            },
        ),
    ))
}

fn provisional_metadata(
    descriptor: &RangeSheetDescriptor,
) -> std::result::Result<JsValue, JsValue> {
    let metadata = Object::new();
    set(&metadata, "tableId", JsValue::from_str(&descriptor.id))?;
    set(&metadata, "name", JsValue::from_str(&descriptor.name))?;
    set(&metadata, "revision", JsValue::from_f64(0.0))?;
    let extent = Object::new();
    let rows = Object::new();
    set(&rows, "kind", JsValue::from_str("unknown"))?;
    let columns = Object::new();
    set(&columns, "kind", JsValue::from_str("exact"))?;
    set(&columns, "value", JsValue::from_f64(0.0))?;
    set(&extent, "rows", rows.into())?;
    set(&extent, "columns", columns.into())?;
    set(&metadata, "extent", extent.into())?;
    let schema = Object::new();
    set(&schema, "version", JsValue::from_f64(0.0))?;
    set(&schema, "columns", Array::new().into())?;
    set(&metadata, "schema", schema.into())?;
    let capabilities = Object::new();
    set(
        &capabilities,
        "randomAccess",
        JsValue::from_str("indexed-prefix"),
    )?;
    set(&capabilities, "typedValues", JsValue::from_bool(false))?;
    set(&capabilities, "search", JsValue::from_bool(false))?;
    set(&capabilities, "sort", JsValue::from_bool(false))?;
    set(&capabilities, "filter", JsValue::from_bool(false))?;
    set(&capabilities, "multiTable", JsValue::from_bool(true))?;
    set(&metadata, "capabilities", capabilities.into())?;
    Ok(metadata.into())
}

fn range_descriptors_to_js(
    descriptors: &[RangeSheetDescriptor],
) -> std::result::Result<JsValue, JsValue> {
    let result = Array::new();
    for descriptor in descriptors {
        let value = Object::new();
        set(&value, "id", JsValue::from_str(&descriptor.id))?;
        set(&value, "name", JsValue::from_str(&descriptor.name))?;
        set(
            &value,
            "visibility",
            JsValue::from_str(visibility_name(descriptor.visibility)),
        )?;
        result.push(&value);
    }
    Ok(result.into())
}

fn complete_range_open(
    operation_handle: u32,
    operation_revision: u64,
    source_handle: u32,
    retained_bytes: u64,
    descriptors: &[RangeSheetDescriptor],
) -> std::result::Result<JsValue, JsValue> {
    let first = descriptors.first().ok_or_else(|| {
        error_to_js(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "Excel workbook contains no worksheet tables",
        ))
    })?;
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("complete"))?;
    set(&result, "operationKind", JsValue::from_str("open"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(
        &result,
        "operationRevision",
        safe_u64_js(operation_revision, "Excel operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source_handle)),
    )?;
    set(
        &result,
        "retainedBytes",
        safe_u64_js(retained_bytes, "Excel retained bytes")?,
    )?;
    set(&result, "tables", range_descriptors_to_js(descriptors)?)?;
    set(&result, "metadata", provisional_metadata(first)?)?;
    set(&result, "warnings", Array::new().into())?;
    let progress = Object::new();
    set(
        &progress,
        "sourceHandle",
        JsValue::from_f64(f64::from(source_handle)),
    )?;
    set(
        &progress,
        "bytesScanned",
        safe_u64_js(retained_bytes, "Excel progress bytes scanned")?,
    )?;
    set(&progress, "rowsDiscovered", JsValue::from_f64(0.0))?;
    set(&progress, "done", JsValue::from_bool(true))?;
    set(&result, "progress", progress.into())?;
    Ok(result.into())
}

fn read_ranges_step(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    ranges: &[HostRange],
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    let actions = ranges
        .iter()
        .enumerate()
        .map(|(index, range)| {
            let index = u32::try_from(index).map_err(|_| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel action index exceeds u32",
                ))
            })?;
            Ok(AdapterAction::indexed_read_bytes(
                index,
                range.offset,
                range.length,
            ))
        })
        .collect::<std::result::Result<Vec<_>, JsValue>>()?;
    let revision = cursor
        .issue(actions, operation_budget_bytes)
        .map_err(error_to_js)?;
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("pending"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(
        &result,
        "operationRevision",
        safe_u64_js(revision, "Excel operation revision")?,
    )?;
    let actions = Array::new();
    for (index, range) in ranges.iter().enumerate() {
        let action = Object::new();
        set(&action, "kind", JsValue::from_str("read-bytes"))?;
        set(
            &action,
            "actionIndex",
            safe_integer_js(index, "Excel action index")?,
        )?;
        set(
            &action,
            "offset",
            safe_u64_js(range.offset, "Excel action offset")?,
        )?;
        set(
            &action,
            "length",
            safe_u64_js(range.length, "Excel action length")?,
        )?;
        actions.push(&action);
    }
    set(&result, "actions", actions.into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    Ok(result.into())
}

fn complete_batch(
    operation_handle: u32,
    operation_revision: u64,
    batch: &TypedTableBatch,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("complete"))?;
    set(&result, "operationKind", JsValue::from_str("read"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(
        &result,
        "operationRevision",
        safe_u64_js(operation_revision, "Excel operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set(&result, "batch", batch_to_js(batch)?)?;
    set(&result, "warnings", Array::new().into())?;
    Ok(result.into())
}

fn complete_value(
    operation_handle: u32,
    operation_kind: &str,
    field: &str,
    value: JsValue,
) -> std::result::Result<JsValue, JsValue> {
    let mut cursor = AdapterOperationCursor::new();
    let revision = cursor.complete_revision().map_err(error_to_js)?;
    complete_value_with_revision(operation_handle, revision, operation_kind, field, value)
}

fn complete_value_with_revision(
    operation_handle: u32,
    revision: u64,
    operation_kind: &str,
    field: &str,
    value: JsValue,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("complete"))?;
    set(&result, "operationKind", JsValue::from_str(operation_kind))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(
        &result,
        "operationRevision",
        safe_u64_js(revision, "Excel operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set(&result, field, value)?;
    Ok(result.into())
}

struct OwnedActionResult {
    descriptor: AdapterActionResult,
    bytes: Vec<u8>,
}

fn operation_results(results: Array) -> std::result::Result<Vec<OwnedActionResult>, JsValue> {
    let count = usize::try_from(results.length()).map_err(|_| {
        error_to_js(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel result count exceeds usize",
        ))
    })?;
    if count > MAX_OPERATION_RANGES_PER_STEP {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel operation supplied too many source results",
            )
            .with_detail("resultCount", count)
            .with_detail("maxResultCount", MAX_OPERATION_RANGES_PER_STEP),
        ));
    }
    let mut parsed = Vec::with_capacity(count);
    for index in 0..results.length() {
        let value = results.get(index);
        if !value.is_object() {
            return Err(invalid_operation_result(index, "result must be an object"));
        }
        let action_index = result_number(&value, "actionIndex", index)?;
        let action_index = u32::try_from(action_index)
            .map_err(|_| invalid_operation_result(index, "actionIndex exceeds u32"))?;
        let offset = result_number(&value, "offset", index)?;
        let bytes = Reflect::get(&value, &JsValue::from_str("bytes"))
            .map_err(|_| invalid_operation_result(index, "bytes getter failed"))?
            .dyn_into::<Uint8Array>()
            .map_err(|_| invalid_operation_result(index, "bytes must be a Uint8Array"))?;
        let eof = Reflect::get(&value, &JsValue::from_str("eof"))
            .map_err(|_| invalid_operation_result(index, "eof getter failed"))?
            .as_bool()
            .ok_or_else(|| invalid_operation_result(index, "eof must be a boolean"))?;
        let owned = bytes.to_vec();
        let length = u64::try_from(owned.len())
            .map_err(|_| invalid_operation_result(index, "byte length exceeds u64"))?;
        parsed.push(OwnedActionResult {
            descriptor: AdapterActionResult {
                action_index,
                offset,
                length,
                eof,
            },
            bytes: owned,
        });
    }
    Ok(parsed)
}

fn result_number(value: &JsValue, field: &str, index: u32) -> std::result::Result<u64, JsValue> {
    let number = Reflect::get(value, &JsValue::from_str(field))
        .map_err(|_| invalid_operation_result(index, "numeric field getter failed"))?
        .as_f64()
        .ok_or_else(|| invalid_operation_result(index, "numeric field must be a number"))?;
    safe_u64(number, field)
}

fn invalid_operation_result(index: u32, reason: &str) -> JsValue {
    error_to_js(
        TabularkError::new(ErrorCode::InvalidArgument, "invalid Excel operation result")
            .with_detail("resultIndex", index)
            .with_detail("reason", reason),
    )
}

#[cfg(target_arch = "wasm32")]
fn current_wasm_memory_pages() -> u64 {
    let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
    let buffer: js_sys::ArrayBuffer = memory.buffer().unchecked_into();
    u64::from(buffer.byte_length()).div_ceil(64 * 1024)
}

#[cfg(not(target_arch = "wasm32"))]
const fn current_wasm_memory_pages() -> u64 {
    0
}

fn presentation_value(
    metadata: &TableMetadata,
    presentation: &TablePresentation,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("spreadsheet-v1"))?;
    set(&result, "tableId", JsValue::from_str(metadata.table_id()))?;
    set(
        &result,
        "revision",
        safe_integer_js(
            usize::try_from(metadata.revision()).map_err(|_| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel revision exceeds the supported integer range",
                ))
            })?,
            "Excel presentation revision",
        )?,
    )?;
    set(
        &result,
        "visibility",
        JsValue::from_str(visibility_name(presentation.visibility)),
    )?;
    set(
        &result,
        "frozenRows",
        safe_u64_js(presentation.frozen_rows, "Excel frozen row count")?,
    )?;
    set(
        &result,
        "frozenColumns",
        safe_u64_js(presentation.frozen_columns, "Excel frozen column count")?,
    )?;
    set(&result, "rows", to_js(&presentation.rows)?)?;
    set(&result, "columns", to_js(&presentation.columns)?)?;
    set(&result, "styles", to_js(&presentation.styles)?)?;
    Ok(result.into())
}

fn presentation_limit_warning(
    table_id: &str,
    required_bytes: usize,
    available_bytes: usize,
) -> std::result::Result<JsValue, JsValue> {
    let warning = Object::new();
    set(
        &warning,
        "kind",
        JsValue::from_str("presentation-resource-limit"),
    )?;
    set(
        &warning,
        "message",
        JsValue::from_str(
            "spreadsheet presentation exceeded its resource budget; table data remains available",
        ),
    )?;
    set(&warning, "tableId", JsValue::from_str(table_id))?;
    set(
        &warning,
        "resource",
        JsValue::from_str("presentation-output"),
    )?;
    set(
        &warning,
        "requiredBytes",
        safe_integer_js(required_bytes, "Excel presentation required bytes")?,
    )?;
    set(
        &warning,
        "availableBytes",
        safe_integer_js(available_bytes, "Excel presentation available bytes")?,
    )?;
    Ok(warning.into())
}

fn presentation_range_value(
    metadata: &TableMetadata,
    request: RangeRequest,
    presentation: &TablePresentationRange,
) -> std::result::Result<JsValue, JsValue> {
    request.validate_public().map_err(error_to_js)?;
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("spreadsheet-v1"))?;
    set(&result, "tableId", JsValue::from_str(metadata.table_id()))?;
    set(
        &result,
        "revision",
        JsValue::from_f64(metadata.revision() as f64),
    )?;
    set(&result, "range", to_js(&request)?)?;
    set(&result, "styleIds", to_js(&presentation.style_ids)?)?;
    set(&result, "mergedCells", to_js(&presentation.merged_cells)?)?;
    set(&result, "rows", to_js(&presentation.rows)?)?;
    set(&result, "columns", to_js(&presentation.columns)?)?;
    Ok(result.into())
}

fn visibility_name(visibility: ExcelSheetVisibility) -> &'static str {
    match visibility {
        ExcelSheetVisibility::Visible => "visible",
        ExcelSheetVisibility::Hidden => "hidden",
        ExcelSheetVisibility::VeryHidden => "very-hidden",
    }
}

fn batch_to_js(batch: &TypedTableBatch) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(
        &result,
        "layoutVersion",
        JsValue::from_f64(f64::from(batch.layout_version())),
    )?;
    set(&result, "tableId", JsValue::from_str(batch.table_id()))?;
    set(
        &result,
        "revision",
        JsValue::from_f64(batch.revision() as f64),
    )?;
    set(
        &result,
        "schemaVersion",
        JsValue::from_f64(batch.schema_version() as f64),
    )?;
    set(&result, "range", to_js(&batch.range())?)?;
    set(&result, "complete", JsValue::from_bool(batch.complete()))?;
    let buffers = Array::new();
    for buffer in batch.buffers() {
        buffers.push(&Uint8Array::from(buffer.data()));
    }
    set(&result, "buffers", buffers.into())?;
    set(&result, "columns", to_js(batch.columns())?)?;
    Ok(result.into())
}

fn set(object: &Object, key: &str, value: JsValue) -> std::result::Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value).map(|_| ())
}

fn safe_u64(value: f64, field: &str) -> std::result::Result<u64, JsValue> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || value > tabulark::model::MAX_SAFE_INTEGER as f64
    {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                format!("{field} must be a non-negative supported safe integer"),
            )
            .with_detail("field", field),
        ));
    }
    Ok(value as u64)
}

fn safe_integer_js(value: usize, field: &str) -> std::result::Result<JsValue, JsValue> {
    let value = u64::try_from(value).map_err(|_| {
        error_to_js(TabularkError::new(
            ErrorCode::ResourceLimit,
            format!("{field} exceeds the supported integer range"),
        ))
    })?;
    if value > tabulark::model::MAX_SAFE_INTEGER {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                format!("{field} exceeds the JavaScript safe integer range"),
            )
            .with_detail("value", value.to_string()),
        ));
    }
    Ok(JsValue::from_f64(value as f64))
}

fn safe_u64_js(value: u64, field: &str) -> std::result::Result<JsValue, JsValue> {
    if value > tabulark::model::MAX_SAFE_INTEGER {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                format!("{field} exceeds the JavaScript safe integer range"),
            )
            .with_detail("value", value.to_string()),
        ));
    }
    Ok(JsValue::from_f64(value as f64))
}

fn from_js<T>(value: JsValue, message: &str) -> std::result::Result<T, JsValue>
where
    T: for<'de> Deserialize<'de>,
{
    serde_wasm_bindgen::from_value(value).map_err(|error| {
        error_to_js(
            TabularkError::new(ErrorCode::InvalidArgument, message)
                .with_detail("reason", error.to_string()),
        )
    })
}

fn to_js<T>(value: &T) -> std::result::Result<JsValue, JsValue>
where
    T: Serialize + ?Sized,
{
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true);
    value.serialize(&serializer).map_err(|error| {
        error_to_js(
            TabularkError::new(
                ErrorCode::RuntimeFailure,
                "failed to serialize Excel WebAssembly method result",
            )
            .with_detail("reason", error.to_string()),
        )
    })
}

fn error_to_js(error: TabularkError) -> JsValue {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true);
    error
        .serialize(&serializer)
        .unwrap_or_else(|_| JsValue::from_str("Tabulark Excel runtime failure"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const XLSX: &[u8] = include_bytes!("../../../test/fixtures/excel/v1/tabulark-ooxml.xlsx");

    #[test]
    fn entry_fetch_excludes_the_indexed_signature_from_its_header_action() {
        let fixture_tail = tail_range(XLSX.len() as u64).unwrap();
        let central = parse_end_of_central_directory(
            &XLSX[fixture_tail.offset as usize..fixture_tail.end() as usize],
            fixture_tail.offset,
            XLSX.len() as u64,
        )
        .unwrap();
        let index = parse_central_directory(
            &XLSX[central.range.offset as usize..central.range.end() as usize],
            central.entries,
            1_u64 << 31,
        )
        .unwrap();
        let mut indexed = IndexedRanges::new(1_u64 << 31);
        let signature = HostRange::new(0, 8, indexed.source_length()).unwrap();
        indexed.insert(&signature, XLSX[..8].to_vec()).unwrap();
        let mut fetch = EntryFetch {
            paths: vec!["[Content_Types].xml".to_owned()],
            next: 0,
            entries: Vec::new(),
            index,
        };

        let FetchAdvance::Need(action) = advance_entry_fetch(&indexed, &mut fetch).unwrap() else {
            panic!("the ZIP entry header should require one source action");
        };
        assert_eq!(action, HostRange::new(8, 22, 1_u64 << 31).unwrap());
    }
}
