//! Thin WebAssembly wrapper for the range-driven Parquet adapter.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use tabulark::model::{RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::parquet::{
    ParquetLimits, ParquetOpenOperation, ParquetOptions, ParquetReadBytesAction,
    ParquetReadOperation, ParquetReadStart, ParquetRuntime, ParquetRuntimeConfig,
    ParquetSourceHandle, ParquetTableHandle,
};
use tabulark::protocol::{
    ADAPTER_API_VERSION, BATCH_LAYOUT_VERSION, PARQUET_ADAPTER_ID, PROTOCOL_VERSION,
};
use tabulark::{ErrorCode, TabularkError};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

struct PendingRead {
    operation: ParquetReadOperation,
    source: ParquetSourceHandle,
    table: ParquetTableHandle,
}

enum PendingOperation {
    Open(Box<ParquetOpenOperation>),
    Read(Box<PendingRead>),
}

struct State {
    runtime: ParquetRuntime,
    limits: ParquetLimits,
    next_operation: u32,
    operations: HashMap<u32, PendingOperation>,
    table_sources: HashMap<ParquetTableHandle, ParquetSourceHandle>,
}

impl State {
    fn allocate_operation(&mut self) -> std::result::Result<u32, JsValue> {
        let operation = self.next_operation;
        self.next_operation = self.next_operation.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet operation handle space exhausted",
            ))
        })?;
        Ok(operation)
    }
}

/// Official Parquet runtime implementing adapter ABI v2.
#[wasm_bindgen]
pub struct WasmRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates an empty Parquet adapter runtime.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            ParquetRuntimeConfig::default()
        } else {
            from_js(config)?
        };
        let limits =
            ParquetLimits::from_memory_budget(config.memory_budget_bytes).map_err(error_to_js)?;
        Ok(Self {
            state: RefCell::new(State {
                runtime: ParquetRuntime::new(config).map_err(error_to_js)?,
                limits,
                next_operation: 1,
                operations: HashMap::new(),
                table_sources: HashMap::new(),
            }),
        })
    }

    /// Returns Worker protocol version three.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        PROTOCOL_VERSION
    }

    /// Returns official adapter ABI version two.
    #[wasm_bindgen(js_name = adapterApiVersion)]
    pub fn adapter_api_version(&self) -> u32 {
        ADAPTER_API_VERSION
    }

    /// Returns private typed-buffer layout version one.
    #[wasm_bindgen(js_name = batchLayoutVersion)]
    pub fn batch_layout_version(&self) -> u32 {
        BATCH_LAYOUT_VERSION
    }

    /// Returns the frozen official adapter ID.
    #[wasm_bindgen(js_name = adapterId)]
    pub fn adapter_id(&self) -> String {
        PARQUET_ADAPTER_ID.to_owned()
    }

    /// Starts footer-first source discovery.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        let source_length = safe_u64(source_length, "sourceLength")?;
        let options = if options.is_null() || options.is_undefined() {
            ParquetOptions::default()
        } else {
            from_js(options)?
        };
        let mut state = self.state.borrow_mut();
        let operation = ParquetOpenOperation::new(source_length, options, state.limits.clone())
            .map_err(error_to_js)?;
        let action = operation.next_action().ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Parquet open produced no initial byte action",
            ))
        })?;
        let handle = state.allocate_operation()?;
        let result = operation_action(handle, action)?;
        state
            .operations
            .insert(handle, PendingOperation::Open(Box::new(operation)));
        Ok(result)
    }

    /// Supplies one exact source range to an open or range-read operation.
    #[wasm_bindgen(js_name = continueOperation)]
    pub fn continue_operation(
        &self,
        operation_handle: u32,
        absolute_offset: f64,
        bytes: Uint8Array,
        eof: bool,
    ) -> std::result::Result<JsValue, JsValue> {
        let absolute_offset = safe_u64(absolute_offset, "absoluteOffset")?;
        let owned = bytes.to_vec();
        let mut state = self.state.borrow_mut();
        let pending = state.operations.remove(&operation_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Parquet operation handle is closed",
            ))
        })?;
        match pending {
            PendingOperation::Open(mut operation) => {
                match operation
                    .feed_owned(absolute_offset, owned, eof)
                    .map_err(error_to_js)?
                {
                    Some(source) => {
                        let source_length = source.source_length();
                        let metadata = source.metadata().clone();
                        let source = state.runtime.open_source(source).map_err(error_to_js)?;
                        complete_open(source, &metadata, source_length)
                    }
                    None => {
                        let action = operation.next_action().ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "Parquet open stopped without a source or byte action",
                            ))
                        })?;
                        let result = operation_action(operation_handle, action)?;
                        state
                            .operations
                            .insert(operation_handle, PendingOperation::Open(operation));
                        Ok(result)
                    }
                }
            }
            PendingOperation::Read(mut pending) => {
                match pending
                    .operation
                    .feed_owned(absolute_offset, owned, eof)
                    .map_err(error_to_js)?
                {
                    Some(batch) => complete_batch(&batch),
                    None => {
                        let action = pending.operation.next_action().ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "Parquet read stopped without a batch or byte action",
                            ))
                        })?;
                        let result = operation_action(operation_handle, action)?;
                        state
                            .operations
                            .insert(operation_handle, PendingOperation::Read(pending));
                        Ok(result)
                    }
                }
            }
        }
    }

    /// Opens the source's single logical table.
    #[wasm_bindgen(js_name = openTable)]
    pub fn open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let source = ParquetSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        let table = state
            .runtime
            .open_table(source, &table_id)
            .map_err(error_to_js)?;
        let metadata = match state.runtime.metadata(table) {
            Ok(metadata) => metadata.clone(),
            Err(error) => {
                state.runtime.close_table(table);
                return Err(error_to_js(error));
            }
        };
        let result = Object::new();
        set(
            &result,
            "tableHandle",
            JsValue::from_f64(f64::from(table.get())),
        )?;
        set(&result, "metadata", to_js(&metadata)?)?;
        state.table_sources.insert(table, source);
        Ok(result.into())
    }

    /// Returns exact metadata for an open table.
    pub fn metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let metadata = state
            .runtime
            .metadata(ParquetTableHandle::from_raw(table_handle))
            .map_err(error_to_js)?;
        to_js(metadata)
    }

    /// Returns no static presentation for Parquet tables.
    pub fn presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        state
            .runtime
            .metadata(ParquetTableHandle::from_raw(table_handle))
            .map_err(error_to_js)?;
        Ok(JsValue::NULL)
    }

    /// Returns no range presentation for Parquet tables.
    #[wasm_bindgen(js_name = readPresentationRange)]
    pub fn read_presentation_range(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let _: RangeRequest = from_js(request)?;
        self.presentation(table_handle)
    }

    /// Starts a row-group and top-level-column projected range read.
    #[wasm_bindgen(js_name = beginRead)]
    pub fn begin_read(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request)?;
        let table = ParquetTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        let source = *state.table_sources.get(&table).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Parquet table handle is closed",
            ))
        })?;
        match state
            .runtime
            .begin_read(table, request)
            .map_err(error_to_js)?
        {
            ParquetReadStart::Complete(batch) => complete_batch(&batch),
            ParquetReadStart::Pending(operation) => {
                let action = operation.next_action().ok_or_else(|| {
                    error_to_js(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Parquet range read produced no initial byte action",
                    ))
                })?;
                let handle = state.allocate_operation()?;
                let result = operation_action(handle, action)?;
                state.operations.insert(
                    handle,
                    PendingOperation::Read(Box::new(PendingRead {
                        operation: *operation,
                        source,
                        table,
                    })),
                );
                Ok(result)
            }
        }
    }

    /// Cancels and releases one pending operation.
    #[wasm_bindgen(js_name = cancelOperation)]
    pub fn cancel_operation(&self, operation_handle: u32) -> bool {
        self.state
            .borrow_mut()
            .operations
            .remove(&operation_handle)
            .is_some()
    }

    /// Idempotently closes a table and its in-flight reads.
    #[wasm_bindgen(js_name = closeTable)]
    pub fn close_table(&self, table_handle: u32) -> bool {
        let table = ParquetTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        state.table_sources.remove(&table);
        state.operations.retain(
            |_, operation| !matches!(operation, PendingOperation::Read(read) if read.table == table),
        );
        state.runtime.close_table(table)
    }

    /// Idempotently closes a source, its tables, and child reads.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let source = ParquetSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        state.operations.retain(
            |_, operation| !matches!(operation, PendingOperation::Read(read) if read.source == source),
        );
        state.table_sources.retain(|_, owner| *owner != source);
        state.runtime.close_source(source)
    }

    /// Releases every operation, table, and source.
    pub fn shutdown(&self) {
        let mut state = self.state.borrow_mut();
        state.operations.clear();
        state.table_sources.clear();
        state.runtime.shutdown();
    }
}

fn operation_action(
    operation_handle: u32,
    action: ParquetReadBytesAction,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    let action_value = Object::new();
    set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &action_value,
        "offset",
        safe_integer_js(action.offset, "Parquet action offset")?,
    )?;
    set(
        &action_value,
        "length",
        safe_integer_js(action.length, "Parquet action length")?,
    )?;
    set(&result, "action", action_value.into())?;
    Ok(result.into())
}

fn complete_open(
    source: ParquetSourceHandle,
    metadata: &TableMetadata,
    source_length: u64,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("open-complete"))?;
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(&result, "metadata", to_js(metadata)?)?;
    let table = Object::new();
    set(&table, "id", JsValue::from_str("table-0"))?;
    set(&table, "name", JsValue::from_str(metadata.name()))?;
    let tables = Array::new();
    tables.push(&table);
    set(&result, "tables", tables.into())?;
    let progress = Object::new();
    set(
        &progress,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(
        &progress,
        "bytesScanned",
        safe_integer_js(source_length, "Parquet source length")?,
    )?;
    set(
        &progress,
        "rowsDiscovered",
        safe_integer_js(
            metadata.extent().rows().value().unwrap_or(0),
            "Parquet row count",
        )?,
    )?;
    set(&progress, "done", JsValue::from_bool(true))?;
    set(&result, "progress", progress.into())?;
    Ok(result.into())
}

fn complete_batch(batch: &TypedTableBatch) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "kind", JsValue::from_str("read-complete"))?;
    set(&result, "batch", batch_to_js(batch)?)?;
    Ok(result.into())
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

fn safe_integer_js(value: u64, field: &str) -> std::result::Result<JsValue, JsValue> {
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

fn from_js<T>(value: JsValue) -> std::result::Result<T, JsValue>
where
    T: for<'de> serde::Deserialize<'de>,
{
    serde_wasm_bindgen::from_value(value).map_err(|error| {
        error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "invalid Parquet WebAssembly method payload",
            )
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
                "failed to serialize Parquet WebAssembly result",
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
        .unwrap_or_else(|_| JsValue::from_str("Tabulark Parquet runtime failure"))
}
