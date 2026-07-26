//! Thin wasm-bindgen boundary for the staged Excel runtime.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use tabulark::model::{BATCH_LAYOUT_VERSION, RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::protocol::{ADAPTER_API_VERSION, EXCEL_ADAPTER_ID, PROTOCOL_VERSION};
use tabulark::{ErrorCode, TabularkError};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::presentation::{TablePresentation, TablePresentationRange};
use crate::{
    ExcelLimits, ExcelOptions, ExcelRuntime, ExcelRuntimeConfig, ExcelSheetVisibility,
    ExcelSourceHandle, ExcelTableDescriptor, ExcelTableHandle,
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
    source_length: usize,
}

struct State {
    runtime: ExcelRuntime,
    max_source_bytes: usize,
    max_range_cells: u64,
    next_operation: u32,
    operations: HashMap<u32, PendingOpen>,
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
}

/// Dedicated Excel runtime artifact implementing official adapter ABI v2.
#[wasm_bindgen]
pub struct WasmRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates an empty staged Excel adapter runtime.
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
            max_sources: config.max_sources,
            limits,
        })
        .map_err(error_to_js)?;
        let max_source_bytes = config
            .memory_budget_bytes
            .min(ExcelLimits::default().max_source_bytes);
        let max_range_cells = config.max_range_cells;
        Ok(Self {
            state: RefCell::new(State {
                runtime,
                max_source_bytes,
                max_range_cells,
                next_operation: 1,
                operations: HashMap::new(),
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

    /// Begins a staged workbook open by requesting the complete source once.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        let source_length = safe_usize(source_length, "sourceLength")?;
        let options = if options.is_null() || options.is_undefined() {
            ExcelOptions::default()
        } else {
            from_js(options, "invalid Excel adapter options")?
        };
        let mut state = self.state.borrow_mut();
        if source_length > state.max_source_bytes {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel source exceeds the configured staging limit",
                )
                .with_detail("resource", "staging")
                .with_detail("requiredBytes", source_length)
                .with_detail("availableBytes", state.max_source_bytes),
            ));
        }
        let operation = state.allocate_operation()?;
        let result = read_bytes_step(operation, 0, source_length)?;
        state.operations.insert(
            operation,
            PendingOpen {
                options,
                source_length,
            },
        );
        Ok(result)
    }

    /// Supplies the one requested staged source and completes the open.
    #[wasm_bindgen(js_name = continueOperation)]
    pub fn continue_operation(
        &self,
        operation_handle: u32,
        absolute_offset: f64,
        bytes: Uint8Array,
        eof: bool,
    ) -> std::result::Result<JsValue, JsValue> {
        let absolute_offset = safe_usize(absolute_offset, "absoluteOffset")?;
        let owned = bytes.to_vec();
        let mut state = self.state.borrow_mut();
        let pending = state.operations.remove(&operation_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Excel operation handle is closed",
            ))
        })?;
        if absolute_offset != 0 || owned.len() != pending.source_length || !eof {
            return Err(error_to_js(
                TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel staged open requires the complete source at offset zero",
                )
                .with_detail("expectedOffset", 0)
                .with_detail("actualOffset", absolute_offset)
                .with_detail("expectedLength", pending.source_length)
                .with_detail("actualLength", owned.len())
                .with_detail("expectedEof", true),
            ));
        }

        let source = state
            .runtime
            .open_source(owned, pending.options)
            .map_err(error_to_js)?;
        match complete_open(&mut state.runtime, source, pending.source_length) {
            Ok(result) => Ok(result),
            Err(error) => {
                state.runtime.close_source(source);
                Err(error)
            }
        }
    }

    /// Opens one logical worksheet table.
    #[wasm_bindgen(js_name = openTable)]
    pub fn open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let source = ExcelSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        let opened = state
            .runtime
            .open_table(source, &table_id)
            .map_err(error_to_js)?;
        let result = (|| {
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
        if result.is_err() {
            state.runtime.close_table(opened.table_handle);
        }
        result
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

    /// Returns the worksheet's static presentation envelope.
    pub fn presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let table = ExcelTableHandle::from_raw(table_handle);
        let metadata = state.runtime.metadata(table).map_err(error_to_js)?;
        let presentation = state.runtime.presentation(table).map_err(error_to_js)?;
        presentation_value(metadata, &presentation)
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
            .and_then(|batch| batch.to_typed())
            .map_err(error_to_js)?;
        let result = Object::new();
        set(&result, "kind", JsValue::from_str("read-complete"))?;
        set(&result, "batch", batch_to_js(&batch)?)?;
        set(&result, "warnings", Array::new().into())?;
        Ok(result.into())
    }

    /// Cancels and releases a pending staged open.
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
        self.state
            .borrow_mut()
            .runtime
            .close_table(ExcelTableHandle::from_raw(table_handle))
    }

    /// Idempotently closes a workbook and every child worksheet.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        self.state
            .borrow_mut()
            .runtime
            .close_source(ExcelSourceHandle::from_raw(source_handle))
    }

    /// Releases every pending operation, source, and table.
    pub fn shutdown(&self) {
        let mut state = self.state.borrow_mut();
        state.operations.clear();
        state.runtime.shutdown();
    }
}

fn complete_open(
    runtime: &mut ExcelRuntime,
    source: ExcelSourceHandle,
    source_length: usize,
) -> std::result::Result<JsValue, JsValue> {
    let descriptors = runtime.list_tables(source).map_err(error_to_js)?.to_vec();
    let first = descriptors.first().ok_or_else(|| {
        error_to_js(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "Excel workbook contains no worksheet tables",
        ))
    })?;
    let opened = runtime
        .open_table(source, first.id())
        .map_err(error_to_js)?;
    let metadata = opened.metadata.clone();
    let mut warnings = runtime
        .source_warnings(source)
        .map_err(error_to_js)?
        .to_vec();
    warnings.extend(opened.warnings);
    runtime.close_table(opened.table_handle);

    let result = Object::new();
    set(&result, "kind", JsValue::from_str("open-complete"))?;
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(&result, "tables", descriptors_to_js(&descriptors)?)?;
    set(&result, "metadata", to_js(&metadata)?)?;
    set(&result, "warnings", to_js(&warnings)?)?;
    let progress = Object::new();
    set(
        &progress,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(
        &progress,
        "bytesScanned",
        safe_integer_js(source_length, "Excel progress bytes scanned")?,
    )?;
    set(
        &progress,
        "rowsDiscovered",
        safe_integer_js(
            usize::try_from(metadata.extent().rows().value().unwrap_or(0)).map_err(|_| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel row count exceeds the supported integer range",
                ))
            })?,
            "Excel progress rows discovered",
        )?,
    )?;
    set(&progress, "done", JsValue::from_bool(true))?;
    set(&result, "progress", progress.into())?;
    Ok(result.into())
}

fn read_bytes_step(
    operation_handle: u32,
    offset: usize,
    length: usize,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    let action = Object::new();
    set(&action, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &action,
        "offset",
        safe_integer_js(offset, "Excel action offset")?,
    )?;
    set(
        &action,
        "length",
        safe_integer_js(length, "Excel action length")?,
    )?;
    set(&result, "action", action.into())?;
    Ok(result.into())
}

fn descriptors_to_js(
    descriptors: &[ExcelTableDescriptor],
) -> std::result::Result<JsValue, JsValue> {
    let result = Array::new();
    for descriptor in descriptors {
        let value = Object::new();
        set(&value, "id", JsValue::from_str(descriptor.id()))?;
        set(&value, "name", JsValue::from_str(descriptor.name()))?;
        set(
            &value,
            "visibility",
            JsValue::from_str(visibility_name(descriptor.visibility())),
        )?;
        result.push(&value);
    }
    Ok(result.into())
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

fn safe_usize(value: f64, field: &str) -> std::result::Result<usize, JsValue> {
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
    usize::try_from(value as u64).map_err(|_| {
        error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                format!("{field} exceeds the supported integer range"),
            )
            .with_detail("field", field),
        )
    })
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
